// git.ts — object store, ref graph, tree/commit helpers and packfile codec.
//
// Plain Node 22 stdlib only (node:crypto, node:zlib). No git binary, no deps.
// Every function here is written against the coordinator spec's contract; the
// packfile and pkt-line pieces are implemented from the git wire format as the
// suite's client exercises it, not copied from any kit source.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

import type { Forge, GitObject, RepoRec } from './store.ts';

export type ObjectKind = GitObject['type'];

export const ZERO_SHA = '0'.repeat(40);

/** SHA-1 of `<type> <byte length>\0` followed by the raw object bytes. */
export function sha1Object(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** Store the object under its computed id when absent; always return the id. */
export function storeObject(repo: RepoRec, type: ObjectKind, data: Buffer): string {
  const sha = sha1Object(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

/** Look an object up by id, or undefined when the repo does not hold it. */
export function readObject(repo: RepoRec, sha: string): GitObject | undefined {
  return repo.objects.get(sha);
}

// ---------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------

export interface TreeEntryOut {
  mode: string;
  name: string;
  sha: string;
}

/** Split a raw tree object into its entries, keeping the stored order. */
export function parseTree(data: Buffer): TreeEntryOut[] {
  const entries: TreeEntryOut[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) throw new Error('malformed tree: entry without a mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree: entry without a name terminator');
    entries.push({
      mode: data.subarray(at, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      sha: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    at = nul + 21;
  }
  return entries;
}

/** Git's tree sort: compare names as bytes, a directory as if its name ended in '/'. */
export function sortTreeEntries<T extends { mode: string; name: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(left, right);
  });
}

/** Serialise entries (sorted git-style) into a tree object and store it. */
export function buildTree(
  repo: RepoRec,
  entries: Array<{ mode: string; name: string; sha: string }>,
): string {
  const chunks: Buffer[] = [];
  for (const entry of sortTreeEntries(entries)) {
    chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    chunks.push(Buffer.from(entry.sha, 'hex'));
  }
  return storeObject(repo, 'tree', Buffer.concat(chunks));
}

// ---------------------------------------------------------------------------
// commits
// ---------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  message: string;
}

/** Split a raw commit into its tree, parent list and message body. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (!line) continue;
    const cut = line.indexOf(' ');
    const key = cut < 0 ? line : line.slice(0, cut);
    const value = cut < 0 ? '' : line.slice(cut + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
  }
  return { tree, parents, message };
}

/** Trial-clock epoch seconds, from MAKEFUN_TRIAL_NOW (ISO or epoch seconds). */
export function trialEpochSeconds(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (!raw) return 0;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && raw.trim() !== '') return Math.floor(asNumber);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

const FORGE_IDENTITY = 'ada iversen <adaiversen@example.invalid>';

/** Build a commit with the forge identity and the trial clock, then store it. */
export function makeCommit(
  repo: RepoRec,
  opts: { tree: string; parents: string[]; message: string },
): string {
  const stamp = `${trialEpochSeconds()} +0000`;
  const lines = [`tree ${opts.tree}`];
  for (const parent of opts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${FORGE_IDENTITY} ${stamp}`, `committer ${FORGE_IDENTITY} ${stamp}`, '');
  const body = opts.message.endsWith('\n') || opts.message === '' ? opts.message : `${opts.message}\n`;
  return storeObject(repo, 'commit', Buffer.from(`${lines.join('\n')}\n${body}`, 'utf8'));
}

// ---------------------------------------------------------------------------
// refs and ancestry
// ---------------------------------------------------------------------------

/** Resolve a full refname, a short branch name, a tag name, or HEAD. */
export function resolveRef(repo: RepoRec, ref: string): string | undefined {
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch || 'main'}`);
  if (!ref.startsWith('refs/')) {
    const asBranch = repo.refs.get(`refs/heads/${ref}`);
    if (asBranch) return asBranch;
    return repo.refs.get(`refs/tags/${ref}`);
  }
  return undefined;
}

/** Peel an annotated tag (repeatedly) down to the object it points at. */
export function peelObject(repo: RepoRec, sha: string): string | undefined {
  let current: string | undefined = sha;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const obj = repo.objects.get(current);
    if (!obj) return undefined;
    if (obj.type !== 'tag') return current;
    const text = obj.data.toString('utf8');
    const head = text.split('\n\n')[0];
    const line = head.split('\n').find((entry) => entry.startsWith('object '));
    current = line ? line.slice('object '.length).trim() : undefined;
  }
  return undefined;
}

/** True when anc is desc itself or reachable from desc through parent links. */
export function isAncestor(repo: RepoRec, anc: string, desc: string): boolean {
  const ancCommit = peelObject(repo, anc);
  const descCommit = peelObject(repo, desc);
  if (!ancCommit || !descCommit) return false;
  if (ancCommit === descCommit) return true;
  const visited = new Set<string>([descCommit]);
  const stack = [descCommit];
  while (stack.length) {
    const sha = stack.pop()!;
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancCommit) return true;
      if (!visited.has(parent)) {
        visited.add(parent);
        stack.push(parent);
      }
    }
  }
  return false;
}

/** A common ancestor of a and b: the first one met walking outwards from b. */
export function mergeBase(repo: RepoRec, a: string, b: string): string | undefined {
  const aCommit = peelObject(repo, a);
  const bCommit = peelObject(repo, b);
  if (!aCommit || !bCommit) return undefined;
  const fromA = new Set<string>();
  const stackA = [aCommit];
  while (stackA.length) {
    const sha = stackA.pop()!;
    if (fromA.has(sha)) continue;
    fromA.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stackA.push(parent);
  }
  const visited = new Set<string>();
  const queue = [bCommit];
  while (queue.length) {
    const sha = queue.shift()!;
    if (fromA.has(sha)) return sha;
    if (visited.has(sha)) continue;
    visited.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// paths inside a tree
// ---------------------------------------------------------------------------

/** Read one path out of the tree: returns the leaf object id and its bytes. */
export function readPathAt(
  repo: RepoRec,
  treeSha: string,
  path: string,
): { sha: string; data: Buffer } | undefined {
  const parts = path.split('/').filter((part) => part !== '');
  if (!parts.length) {
    const root = repo.objects.get(treeSha);
    return root ? { sha: treeSha, data: root.data } : undefined;
  }
  let currentSha = treeSha;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = repo.objects.get(currentSha);
    if (!obj || obj.type !== 'tree') return undefined;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === parts[i]);
    if (!entry) return undefined;
    if (i === parts.length - 1) {
      const leaf = repo.objects.get(entry.sha);
      return leaf ? { sha: entry.sha, data: leaf.data } : undefined;
    }
    currentSha = entry.sha;
  }
  return undefined;
}

/**
 * Rewrite one path in a tree (creating intermediate directories as needed).
 * blobSha null deletes the path. Returns the new root tree id.
 */
export function writePathAt(
  repo: RepoRec,
  baseTreeSha: string | undefined,
  path: string,
  blobSha: string | null,
): string {
  const parts = path.split('/').filter((part) => part !== '');
  if (!parts.length) throw new Error('writePathAt needs a non-empty path');

  const rewrite = (treeSha: string | undefined, depth: number): string | undefined => {
    const entries = new Map<string, { mode: string; name: string; sha: string }>();
    if (treeSha) {
      const obj = repo.objects.get(treeSha);
      if (obj && obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) entries.set(entry.name, { ...entry });
      }
    }
    const name = parts[depth];
    if (depth === parts.length - 1) {
      if (blobSha === null) entries.delete(name);
      else {
        const blob = repo.objects.get(blobSha);
        const mode = blob && blob.type === 'tree' ? '40000' : '100644';
        entries.set(name, { mode, name, sha: blobSha });
      }
    } else {
      const child = entries.get(name);
      const next = rewrite(child && child.mode === '40000' ? child.sha : undefined, depth + 1);
      if (next === undefined) entries.delete(name);
      else entries.set(name, { mode: '40000', name, sha: next });
    }
    if (entries.size === 0) return undefined;
    return buildTree(repo, [...entries.values()]);
  };

  const result = rewrite(baseTreeSha, 0);
  if (result === undefined) return buildTree(repo, []);
  return result;
}

/** Delete a path; a convenience wrapper over writePathAt with a null blob. */
export function deletePathAt(repo: RepoRec, baseTreeSha: string | undefined, path: string): string {
  return writePathAt(repo, baseTreeSha, path, null);
}

/** Flatten a tree (recursively) into path -> leaf entry, skipping gitlinks. */
function flattenTree(
  repo: RepoRec,
  treeSha: string | undefined,
  prefix: string,
  out: Map<string, { sha: string; mode: string }>,
): void {
  if (!treeSha) return;
  const obj = repo.objects.get(treeSha);
  if (!obj || obj.type !== 'tree') return;
  for (const entry of parseTree(obj.data)) {
    const full = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') flattenTree(repo, entry.sha, full, out);
    else if (entry.mode !== '160000') out.set(full, { sha: entry.sha, mode: entry.mode });
  }
}

/** Compare two trees; every added / modified / removed leaf path, sorted by path. */
export function diffTrees(
  repo: RepoRec,
  oldTree: string | undefined,
  newTree: string | undefined,
): Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldSha?: string; newSha?: string }> {
  const oldMap = new Map<string, { sha: string; mode: string }>();
  const newMap = new Map<string, { sha: string; mode: string }>();
  flattenTree(repo, oldTree, '', oldMap);
  flattenTree(repo, newTree, '', newMap);
  const paths = [...new Set([...oldMap.keys(), ...newMap.keys()])].sort();
  const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldSha?: string; newSha?: string }> = [];
  for (const path of paths) {
    const oldEntry = oldMap.get(path);
    const newEntry = newMap.get(path);
    if (oldEntry && !newEntry) out.push({ path, status: 'removed', oldSha: oldEntry.sha });
    else if (!oldEntry && newEntry) out.push({ path, status: 'added', newSha: newEntry.sha });
    else if (oldEntry && newEntry && oldEntry.sha !== newEntry.sha) {
      out.push({ path, status: 'modified', oldSha: oldEntry.sha, newSha: newEntry.sha });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// line changes
// ---------------------------------------------------------------------------

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Added/deleted line counts between two texts. Common prefix and suffix lines
 * are trimmed first, then a longest-common-subsequence count runs on the
 * (usually small) remainder.
 */
export function countLineChanges(
  oldText: string,
  newText: string,
): { additions: number; deletions: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start += 1;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const a = oldLines.slice(start, oldEnd);
  const b = newLines.slice(start, newEnd);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  // LCS lengths for the middle block; one row at a time keeps memory O(min).
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  let prev = new Array<number>(short.length + 1).fill(0);
  let curr = new Array<number>(short.length + 1).fill(0);
  for (let i = 1; i <= long.length; i += 1) {
    for (let j = 1; j <= short.length; j += 1) {
      curr[j] = long[i - 1] === short[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  const common = prev[short.length];
  return { additions: b.length - common, deletions: a.length - common };
}

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

export type PktItem = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

export const PKT_LINE_MAX = 65520;

/** One data packet: 4 hex length bytes (payload + 4) then the payload. */
export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error(`pkt-line payload ${data.length} bytes exceeds the limit`);
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

/** Flush / delim / response-end control packets. */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Encode a run of data lines and control markers into one buffer. */
export function encodePktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else if (item === 'response-end') parts.push(pktResponseEnd());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * Decode a whole buffer into packets. Throws on a bad length header or a
 * truncated packet; trailing raw bytes (a packfile after the flush) are
 * returned separately so callers can keep them.
 */
export function decodePktLines(
  bytes: Buffer,
): { packets: PktItem[]; trailing: Buffer } {
  const packets: PktItem[] = [];
  let at = 0;
  const hex4 = /^[0-9a-fA-F]{4}$/;
  while (at + 4 <= bytes.length) {
    const head = bytes.subarray(at, at + 4).toString('ascii');
    if (!hex4.test(head)) break;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      at += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      at += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${length}`);
    if (at + length > bytes.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: bytes.subarray(at + 4, at + length) });
    at += length;
  }
  if (at < bytes.length && packets.length === 0) throw new Error('not a pkt-line stream');
  return { packets, trailing: bytes.subarray(at) };
}

/** The text of every data packet, control packets dropped. */
export function pktLinesToText(packets: readonly PktItem[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

// ---------------------------------------------------------------------------
// packfile reading (with delta resolution)
// ---------------------------------------------------------------------------

export interface PackObjectOut {
  type: ObjectKind;
  data: Buffer;
  oid: string;
}

const PACK_TYPE_NAME: Record<number, ObjectKind> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function readPackSizeVarint(buf: Buffer, start: number): { size: number; typeCode: number; next: number } {
  let byte = buf[start];
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let at = start + 1;
  while (byte & 0x80) {
    if (at >= buf.length) throw new Error('pack entry size varint is truncated');
    byte = buf[at++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, typeCode, next: at };
}

function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buf[start];
  let at = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (at >= buf.length) throw new Error('ofs-delta base offset is truncated');
    byte = buf[at++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: at };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (at >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[at++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) return value;
    }
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (at < delta.length) {
    const op = delta[at++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (at >= delta.length) throw new Error('delta copy is truncated');
          copyOffset += delta[at++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (at >= delta.length) throw new Error('delta copy is truncated');
          copySize += delta[at++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy runs past its base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const count = op & 0x7f;
      if (at + count > delta.length) throw new Error('delta insert is truncated');
      if (written + count > targetSize) throw new Error('delta writes past its target');
      delta.copy(out, written, at, at + count);
      at += count;
      written += count;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Parse a packfile (v2/v3) and resolve every entry, including OFS_DELTA and
 * REF_DELTA chains. `resolveBase` supplies objects a thin pack leaves out
 * (looked up in the receiving repo). Verifies the trailer checksum.
 */
export function parsePackfile(
  buf: Buffer,
  options: { resolveBase?: (oid: string) => GitObject | undefined } = {},
): PackObjectOut[] {
  if (buf.length < 32) throw new Error('pack is too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declared = buf.readUInt32BE(8);
  const trailerAt = buf.length - 20;
  const trailer = buf.subarray(trailerAt).toString('hex');
  const computed = createHash('sha1').update(buf.subarray(0, trailerAt)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let at = 12;
  for (let i = 0; i < declared; i += 1) {
    const entryOffset = at;
    const header = readPackSizeVarint(buf, at);
    at = header.next;
    const entry: RawPackEntry = { offset: entryOffset, typeCode: header.typeCode, size: header.size, data: Buffer.alloc(0) };
    if (header.typeCode === 6) {
      const base = readOfsBase(buf, at);
      at = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
      if (base.baseOffset <= 0 || entry.baseOffset < 0) throw new Error('ofs-delta names an invalid base offset');
    } else if (header.typeCode === 7) {
      if (at + 20 > trailerAt) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buf.subarray(at, at + 20).toString('hex');
      at += 20;
    } else if (!PACK_TYPE_NAME[header.typeCode]) {
      throw new Error(`pack entry ${i} has unknown type code ${header.typeCode}`);
    }
    const inflated = inflateSync(buf.subarray(at, trailerAt), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.buffer.length}`);
    }
    entry.data = inflated.buffer;
    at += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (at !== trailerAt) throw new Error('pack has stray bytes before its trailer');

  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): PackObjectOut => {
    const cached = (entry as RawPackEntry & { out?: PackObjectOut }).out;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjectKind;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = PACK_TYPE_NAME[entry.typeCode];
      data = entry.data;
    }
    const out: PackObjectOut = { type, data, oid: sha1Object(type, data) };
    (entry as RawPackEntry & { out?: PackObjectOut }).out = out;
    resolvedByOid.set(out.oid, entry);
    resolving.delete(entry.offset);
    return out;
  };
  return raw.map((entry) => resolve(entry));
}

// ---------------------------------------------------------------------------
// packfile writing
// ---------------------------------------------------------------------------

export interface PackBuildOptions {
  /** Depth limit: 1 means the wanted tips only, no parents. Omit for full. */
  shallowDepth?: number;
  /** Commits the fetcher already holds (their closure is not re-sent). */
  haves?: readonly string[];
  /** The fetcher's current shallow boundary commits (walk stops above them). */
  shallowBoundaries?: readonly string[];
}

export interface PackBuildResult {
  pack: Buffer;
  /** Commits at the depth boundary: still shallow after this fetch. */
  shallow: string[];
  /** Prior boundary commits whose parents are now included. */
  unshallow: string[];
}

/** One object's pack header: type/size varint, git's little-endian-ish form. */
function packObjectHeader(type: ObjectKind, size: number): Buffer {
  const code = { commit: 1, tree: 2, blob: 3, tag: 4 }[type];
  const bytes: number[] = [];
  let rest = size;
  let first = (code << 4) | (rest & 0x0f);
  rest = Math.floor(rest / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Everything reachable from `roots`: commits walk trees + parents, tags peel
 * to their target, trees walk entries (gitlinks skipped). `stopAt` commits
 * are included but their parents are not followed (shallow boundaries).
 */
export function collectReachable(
  repo: RepoRec,
  roots: Iterable<string>,
  options: { stopAt?: ReadonlySet<string>; maxDepth?: number } = {},
): { objects: Map<string, GitObject>; commitDepth: Map<string, number> } {
  const objects = new Map<string, GitObject>();
  const commitDepth = new Map<string, number>();
  // Breadth-first so the first visit of a commit is at its smallest depth;
  // a depth-first walk could meet a commit deep first and then wrongly skip
  // it when it is reached again on a shorter path.
  const queue: Array<{ sha: string; depth: number }> = [];
  for (const root of roots) queue.push({ sha: root, depth: 0 });
  const seenCommits = new Set<string>();
  while (queue.length) {
    const { sha, depth } = queue.shift()!;
    const obj = repo.objects.get(sha);
    if (!obj) continue;
    if (obj.type === 'commit') {
      if (seenCommits.has(sha)) continue;
      seenCommits.add(sha);
      if (options.maxDepth !== undefined && depth > options.maxDepth) continue;
      objects.set(sha, obj);
      commitDepth.set(sha, depth);
      const commit = parseCommit(obj.data);
      if (!options.stopAt?.has(sha)) {
        queue.push({ sha: commit.tree, depth });
        for (const parent of commit.parents) queue.push({ sha: parent, depth: depth + 1 });
      } else {
        queue.push({ sha: commit.tree, depth });
      }
    } else if (obj.type === 'tag') {
      if (objects.has(sha)) continue;
      objects.set(sha, obj);
      const text = obj.data.toString('utf8');
      const line = text.split('\n\n')[0].split('\n').find((entry) => entry.startsWith('object '));
      if (line) queue.push({ sha: line.slice('object '.length).trim(), depth });
    } else if (obj.type === 'tree') {
      if (objects.has(sha)) continue;
      objects.set(sha, obj);
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '160000') continue;
        queue.push({ sha: entry.sha, depth });
      }
    } else {
      objects.set(sha, obj);
    }
  }
  return { objects, commitDepth };
}

/**
 * Decide which objects a fetch sends, honouring depth, haves and the
 * fetcher's shallow boundaries, then serialise them as an undeltified
 * packfile v2 (header PACK, version 2, count, zlib-deflated entries, SHA-1
 * trailer). Undeltified packs are valid and keep generation linear.
 */
export function collectPackObjects(
  repo: RepoRec,
  wantShas: readonly string[],
  opts: PackBuildOptions = {},
): { objects: PackObjectOut[]; shallow: string[]; unshallow: string[] } {
  const boundary = new Set(opts.shallowBoundaries ?? []);
  const maxDepth = opts.shallowDepth === undefined ? undefined : opts.shallowDepth - 1;
  // The wanted walk follows parents up to the depth limit only. It must NOT
  // stop at the fetcher's shallow boundaries: a deepen explicitly asks to go
  // past them (e.g. deepen 2 from a depth-1 clone must deliver the parent).
  // The boundaries only bound the *held* walk below: objects reachable from
  // a have without crossing a boundary are the ones the fetcher already has.
  const wanted = collectReachable(repo, wantShas, { maxDepth });
  const held = (opts.haves ?? []).length
    ? collectReachable(repo, opts.haves, { stopAt: boundary }).objects
    : new Map<string, GitObject>();

  const send: PackObjectOut[] = [];
  for (const [sha, obj] of wanted.objects) {
    if (held.has(sha)) continue;
    send.push({ type: obj.type, data: obj.data, oid: sha });
  }

  const shallow: string[] = [];
  if (opts.shallowDepth !== undefined) {
    for (const [sha, depth] of wanted.commitDepth) {
      if (depth === opts.shallowDepth - 1 && !held.has(sha)) shallow.push(sha);
    }
  }
  const unshallow: string[] = [];
  for (const prior of boundary) {
    const depth = wanted.commitDepth.get(prior);
    if (depth === undefined) continue;
    const obj = repo.objects.get(prior);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    const parentIncluded = parents.some(
      (parent) => wanted.commitDepth.has(parent) && !held.has(parent),
    );
    if (parentIncluded) unshallow.push(prior);
  }
  return { objects: send, shallow, unshallow };
}

/** Serialise already-chosen objects as an undeltified packfile v2. */
export function writePackBytes(objects: readonly PackObjectOut[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const obj of objects) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Build the packfile bytes for a fetch. */
export function buildPackfile(
  repo: RepoRec,
  wantShas: readonly string[],
  opts: PackBuildOptions = {},
): Buffer {
  const { objects } = collectPackObjects(repo, wantShas, opts);
  return writePackBytes(objects);
}

/** The Forge type is re-exported for handlers that only need the shape. */
export type { Forge };
