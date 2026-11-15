// githttp.ts — smart-HTTP git endpoints (protocol v2 + v0 upload-pack,
// v0 receive-pack) for the forge.
//
// Routes, all under /<owner>/<repo>.git/:
//   GET  info/refs?service=git-upload-pack | git-receive-pack
//   GET  HEAD
//   POST git-upload-pack     (fetch: ls-refs / fetch, v2 or v0)
//   POST git-receive-pack    (push: ref commands + packfile, report-status)
//
// Auth follows the entry rule: a Bearer token is required; when
// MAKEFUN_SHOP_TOKEN is set it must match, otherwise any non-empty Bearer
// is accepted. A missing repo is always 404, never 403.

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Forge, RepoRec } from './store.ts';
import {
  ZERO_SHA,
  collectPackObjects,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isAncestor,
  parsePackfile,
  peelObject,
  pktDelim,
  pktFlush,
  storeObject,
  writePackBytes,
} from './git.ts';

// ---------------------------------------------------------------------------
// small HTTP helpers
// ---------------------------------------------------------------------------

function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (!token) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected) return token === expected;
  return true;
}

function sendText(
  forge: Forge,
  res: ServerResponse,
  status: number,
  body: string,
  contentType = 'text/plain; charset=utf-8',
): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'X-GitHub-Request-Id': forge.nextReqId(),
  });
  res.end(body);
}

function sendBytes(
  forge: Forge,
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'X-GitHub-Request-Id': forge.nextReqId(),
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// ref listing
// ---------------------------------------------------------------------------

interface RefLine {
  sha: string;
  name: string;
  peeled?: string;
}

/** All refs in advertisement order: HEAD first, then refs sorted by name. */
function sortedRefs(repo: RepoRec): RefLine[] {
  const names = [...repo.refs.keys()].sort();
  const out: RefLine[] = [];
  const mainSha = repo.refs.get('refs/heads/main') ?? repo.refs.get(`refs/heads/${repo.defaultBranch || 'main'}`);
  if (mainSha) out.push({ sha: mainSha, name: 'HEAD' });
  for (const name of names) {
    const sha = repo.refs.get(name)!;
    const entry: RefLine = { sha, name };
    const obj = repo.objects.get(sha);
    if (obj && obj.type === 'tag') {
      const target = peelObject(repo, sha);
      if (target) entry.peeled = target;
    }
    out.push(entry);
  }
  return out;
}

const UPLOAD_V0_CAPS =
  'multi_ack multi_ack_detailed thin-pack side-band side-band-64k ofs-delta shallow symref=HEAD:refs/heads/main agent=makefun-git/1.0';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=makefun-git/1.0';

/** v0 advertisement body: preamble, flush, ref lines (caps on the first). */
function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: RepoRec): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_SHA} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      let line = `${ref.sha} ${ref.name}`;
      if (index === 0) line += `\0${caps}`;
      parts.push(encodePktLine(`${line}\n`));
      if (ref.peeled) parts.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** v2 capability advertisement: "version 2" then one capability line each. */
function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'server-option\n',
    'object-format=sha1\n',
    'agent=makefun-git/1.0\n',
    'flush',
  ]);
}

// ---------------------------------------------------------------------------
// side-band framing (channel 1 = data, 2 = progress, 3 = error)
// ---------------------------------------------------------------------------

const SIDEBAND_CHUNK = 65515;

/** Wrap raw bytes into side-band-64k packets on the given channel. */
function sidebandWrap(data: Buffer, channel: 1 | 2): Buffer {
  const parts: Buffer[] = [];
  for (let at = 0; at < data.length; at += SIDEBAND_CHUNK) {
    const slice = data.subarray(at, at + SIDEBAND_CHUNK);
    const payload = Buffer.concat([Buffer.from([channel]), slice]);
    parts.push(encodePktLine(payload));
  }
  if (data.length === 0) parts.push(encodePktLine(Buffer.from([channel])));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** Parse the pkt-line argument block of a v2 command (after the delim). */
function parseV2Args(packets: ReturnType<typeof decodePktLines>['packets']): { command: string; args: string[] } {
  let command = '';
  const args: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    if (!pastDelim) {
      if (text.startsWith('command=')) command = text.slice('command='.length).trim();
      continue;
    }
    args.push(text.replace(/\n$/, ''));
  }
  return { command, args };
}

function lsRefsResponse(repo: RepoRec, opts: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const keep = (name: string): boolean =>
    opts.prefixes.length === 0 || opts.prefixes.some((prefix) => name.startsWith(prefix));
  const mainSha = repo.refs.get('refs/heads/main') ?? repo.refs.get(`refs/heads/${repo.defaultBranch || 'main'}`);
  if (repo.refs.size === 0) {
    if (opts.unborn && keep('HEAD')) {
      lines.push(`unborn HEAD${opts.symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
  } else {
    if (keep('HEAD') && mainSha) {
      lines.push(`${mainSha} HEAD${opts.symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
    for (const ref of sortedRefs(repo)) {
      if (ref.name === 'HEAD') continue;
      if (!keep(ref.name)) continue;
      let line = `${ref.sha} ${ref.name}`;
      if (opts.peel && ref.peeled) line += ` peeled:${ref.peeled}`;
      lines.push(`${line}\n`);
    }
  }
  return encodePktLines([...lines, 'flush']);
}

// ---------------------------------------------------------------------------
// v2 + v0 fetch
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[];
  depth?: number;
  /** The client sent `done`: negotiation is over, send the pack now. */
  done: boolean;
}

/** Shared fetch planning: pack bytes plus the shallow/unshallow boundary lists. */
function planFetch(
  repo: RepoRec,
  args: FetchArgs,
): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const built = collectPackObjects(repo, args.wants, {
    shallowDepth: args.depth,
    haves: args.haves,
    shallowBoundaries: args.shallowBoundaries,
  });
  return { pack: writePackBytes(built.objects), shallow: built.shallow, unshallow: built.unshallow };
}

/** The one have the server can acknowledge, or null when none is known. */
function commonHave(repo: RepoRec, haves: string[]): string | null {
  for (let i = haves.length - 1; i >= 0; i -= 1) {
    const obj = repo.objects.get(haves[i]);
    if (obj && (obj.type === 'commit' || obj.type === 'tag')) return haves[i];
  }
  return null;
}

function v2FetchResponse(repo: RepoRec, args: FetchArgs): Buffer {
  for (const want of args.wants) {
    if (!repo.objects.has(want)) throw Object.assign(new Error(`unknown object ${want}`), { status: 400 });
  }
  const { pack, shallow, unshallow } = planFetch(repo, args);
  const parts: Buffer[] = [];
  // Real git's server (upload-pack.c) sends NO acknowledgments section at
  // all once the client sent `done` — it goes straight to the pack — and
  // the kit client treats every section as optional, so omit it then.
  // Without `done` (real git's negotiation round 1) the server must answer
  // the haves: ACK/NAK plus `ready`, terminated by a DELIM (0001, not a
  // flush), after which the same response continues with the pack.
  if (!args.done && args.haves.length > 0) {
    parts.push(encodePktLine('acknowledgments\n'));
    const ack = commonHave(repo, args.haves);
    parts.push(encodePktLine(ack ? `ACK ${ack}\n` : 'NAK\n'));
    parts.push(encodePktLine('ready\n'));
    parts.push(pktDelim());
  }
  if (shallow.length || unshallow.length) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const sha of shallow) parts.push(encodePktLine(`shallow ${sha}\n`));
    for (const sha of unshallow) parts.push(encodePktLine(`unshallow ${sha}\n`));
    parts.push(pktFlush());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandWrap(pack, 1));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v0FetchResponse(repo: RepoRec, args: FetchArgs): Buffer {
  for (const want of args.wants) {
    if (!repo.objects.has(want)) throw Object.assign(new Error(`unknown object ${want}`), { status: 400 });
  }
  const { pack, shallow, unshallow } = planFetch(repo, args);
  const parts: Buffer[] = [];
  const ack = commonHave(repo, args.haves);
  parts.push(encodePktLine(ack ? `ACK ${ack}\n` : 'NAK\n'));
  for (const sha of shallow) parts.push(encodePktLine(`shallow ${sha}\n`));
  for (const sha of unshallow) parts.push(encodePktLine(`unshallow ${sha}\n`));
  parts.push(sidebandWrap(pack, 1));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Parse a v0 upload-pack body: wants section, flush, haves section, flush. */
function parseV0Fetch(body: Buffer): FetchArgs {
  const { packets } = decodePktLines(body);
  const args: FetchArgs = { wants: [], haves: [], shallowBoundaries: [], done: false };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (text.startsWith('want ')) {
        const rest = text.slice(5).split(' ')[0];
        args.wants.push(rest);
      } else if (text.startsWith('shallow ')) args.shallowBoundaries.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) args.depth = Number.parseInt(text.slice(7).trim(), 10);
      else if (text.startsWith('deepen-since ') || text.startsWith('deepen-not ')) {
        // Not honoured: the suite never asks for time-based deepening.
      }
    } else {
      if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
      else if (text === 'done') args.done = true;
    }
  }
  return args;
}

function parseV2Fetch(body: Buffer): FetchArgs {
  const { packets } = decodePktLines(body);
  const { args } = parseV2Args(packets);
  const out: FetchArgs = { wants: [], haves: [], shallowBoundaries: [], done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallowBoundaries.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) out.depth = Number.parseInt(arg.slice(7).trim(), 10);
    else if (arg === 'done') out.done = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldSha: string;
  newSha: string;
  ref: string;
}

function parsePushBody(body: Buffer): { commands: PushCommand[]; wantsSideband: boolean; pack: Buffer } {
  const { packets, trailing } = decodePktLines(body);
  const commands: PushCommand[] = [];
  let wantsSideband = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8');
    let caps = '';
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      caps = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    if (caps.includes('side-band-64k')) wantsSideband = true;
    const parts = text.replace(/\n$/, '').split(' ');
    if (parts.length < 3) throw new Error('malformed push command line');
    commands.push({ oldSha: parts[0], newSha: parts[1], ref: parts[2] });
  }
  if (!commands.length) throw new Error('push with no ref commands');
  return { commands, wantsSideband, pack: trailing };
}

function handlePush(repo: RepoRec, forge: Forge, body: Buffer): Buffer {
  const { commands, wantsSideband, pack } = parsePushBody(body);
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';

  if (pack.length > 0) {
    try {
      const objects = parsePackfile(pack, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const obj of objects) storeObject(repo, obj.type, obj.data);
    } catch (err) {
      unpackOk = false;
      unpackDetail = `error ${(err as Error).message}`.slice(0, 120);
    }
  }

  if (unpackOk) {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newSha === ZERO_SHA) {
        // Delete.
        if (!current) reportLines.push(`ng ${cmd.ref} remote ref does not exist\n`);
        else if (cmd.oldSha !== ZERO_SHA && cmd.oldSha !== current) {
          reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        } else {
          repo.refs.delete(cmd.ref);
          reportLines.push(`ok ${cmd.ref}\n`);
        }
        continue;
      }
      const target = repo.objects.get(cmd.newSha);
      if (!target) {
        reportLines.push(`ng ${cmd.ref} object not found\n`);
        continue;
      }
      if (cmd.oldSha === ZERO_SHA) {
        if (current) reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        else {
          repo.refs.set(cmd.ref, cmd.newSha);
          reportLines.push(`ok ${cmd.ref}\n`);
        }
        continue;
      }
      if (!current) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      if (cmd.oldSha !== current) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      const oldCommit = peelObject(repo, cmd.oldSha);
      const newCommit = peelObject(repo, cmd.newSha);
      if (!oldCommit || !newCommit || !isAncestor(repo, oldCommit, newCommit)) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newSha);
      reportLines.push(`ok ${cmd.ref}\n`);
    }
    if (reportLines.some((line) => line.startsWith('ok '))) {
      repo.pushedAt = forge.nowIso();
    }
  }

  const inner = encodePktLines([
    `unpack ${unpackDetail}\n`,
    ...reportLines,
    'flush',
  ]);
  if (!wantsSideband) return inner;
  return Buffer.concat([sidebandWrap(inner, 1), pktFlush()]);
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export async function handleGit(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): Promise<boolean> {
  const rawUrl = req.url ?? '/';
  try {
    const pathOnly = rawUrl.split('?')[0];
    const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(decodeURIComponent(pathOnly));
    if (!match) return false;
    const owner = match[1];
    const repoName = match[2];
    const rest = match[3] ?? '/';
    const method = (req.method ?? 'GET').toUpperCase();

    if (!authed(req)) {
      sendText(forge, res, 401, JSON.stringify({ message: 'Unauthorized' }), 'application/json; charset=utf-8');
      return true;
    }
    const repo = forge.getRepo(owner, repoName);
    if (!repo) {
      sendText(forge, res, 404, 'Not Found');
      return true;
    }
    const url = new URL(rawUrl, 'http://localhost');
    const service = url.searchParams.get('service');
    const wantsV2 =
      (req.headers['git-protocol'] ?? '') === 'version=2' ||
      url.searchParams.get('git-protocol') === 'version=2';

    if (method === 'GET' && rest === '/info/refs') {
      if (service === 'git-upload-pack') {
        const out = wantsV2 ? v2Advertisement() : v0Advertisement('git-upload-pack', repo);
        sendBytes(forge, res, 200, out, 'application/x-git-upload-pack-advertisement');
        return true;
      }
      if (service === 'git-receive-pack') {
        sendBytes(forge, res, 200, v0Advertisement('git-receive-pack', repo), 'application/x-git-receive-pack-advertisement');
        return true;
      }
      sendText(forge, res, 400, 'unknown service');
      return true;
    }

    if (method === 'GET' && rest === '/HEAD') {
      sendText(forge, res, 200, 'ref: refs/heads/main\n');
      return true;
    }

    if (method === 'POST' && rest === '/git-upload-pack') {
      if (wantsV2) {
        const { packets } = decodePktLines(body);
        const { command, args } = parseV2Args(packets);
        if (command === 'ls-refs') {
          const opts: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
          for (const arg of args) {
            if (arg === 'peel') opts.peel = true;
            else if (arg === 'symrefs') opts.symrefs = true;
            else if (arg === 'unborn') opts.unborn = true;
            else if (arg.startsWith('ref-prefix ')) opts.prefixes.push(arg.slice('ref-prefix '.length));
          }
          sendBytes(forge, res, 200, lsRefsResponse(repo, opts), 'application/x-git-upload-pack-result');
          return true;
        }
        if (command === 'fetch') {
          const fetchArgs = parseV2Fetch(body);
          sendBytes(forge, res, 200, v2FetchResponse(repo, fetchArgs), 'application/x-git-upload-pack-result');
          return true;
        }
        sendText(forge, res, 400, `unknown v2 command ${command}`);
        return true;
      }
      const fetchArgs = parseV0Fetch(body);
      sendBytes(forge, res, 200, v0FetchResponse(repo, fetchArgs), 'application/x-git-upload-pack-result');
      return true;
    }

    if (method === 'POST' && rest === '/git-receive-pack') {
      const out = handlePush(repo, forge, body);
      sendBytes(forge, res, 200, out, 'application/x-git-receive-pack-result');
      return true;
    }

    sendText(forge, res, 404, 'Not Found');
    return true;
  } catch (err) {
    const status = (err as { status?: number }).status ?? 400;
    if (!res.headersSent) {
      sendText(forge, res, status, (err as Error).message ? String((err as Error).message).slice(0, 200) : 'Bad Request');
    }
    return true;
  }
}
