// mcp.ts — Model Context Protocol endpoint for the forge.
//
// JSON-RPC 2.0 over Streamable HTTP at POST /mcp, answering plain
// application/json. Speaks both protocol eras the suite negotiates:
//
//   modern 2026-07-28 — server/discover answers identity, capabilities
//   and supportedVersions in one call; no handshake, no session.
//   legacy 2025-11-25 and earlier — initialize echoes the revision and
//   returns serverInfo + capabilities, then notifications/initialized.
//
// The six tools act on the same Forge store as REST and GraphQL, so a
// repository or issue created here reads back identically over REST.
// tools/list is built once at module load and serialised from that one
// frozen array, so two calls answer byte-for-byte identically.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { Forge, RepoRec, IssueRec, PullRec } from './store.ts';

// ---------------------------------------------------------------------------
// Small shared helpers (auth, replies)
// ---------------------------------------------------------------------------

function bearerIsValid(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected === undefined || expected === '') return true;
  return token === expected;
}

function sendJson(forge: Forge, res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': forge.nextReqId(),
  });
  res.end(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

// ---------------------------------------------------------------------------
// Tool catalogue — built once, frozen, serialised from this one array
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'Name of the repository to create.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Login of the repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'Name of the repository.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Login of the repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'Name of the repository.' }),
        title: Object.freeze({ type: 'string', description: 'Title of the issue.' }),
        body: Object.freeze({ type: 'string', description: 'Body text of the issue.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Login of the repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'Name of the repository.' }),
        state: Object.freeze({ type: 'string', description: 'Issue state to list: open, closed or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Login of the repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'Name of the repository.' }),
        title: Object.freeze({ type: 'string', description: 'Title of the pull request.' }),
        head: Object.freeze({ type: 'string', description: 'Head branch the changes come from.' }),
        base: Object.freeze({ type: 'string', description: 'Base branch the changes go into.' }),
        body: Object.freeze({ type: 'string', description: 'Body text of the pull request.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge an open pull request into its base branch.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Login of the repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'Name of the repository.' }),
        pull_number: Object.freeze({ type: 'integer', description: 'Number of the pull request to merge.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

// ---------------------------------------------------------------------------
// REST-shaped views of store records (what tool results carry as JSON)
// ---------------------------------------------------------------------------

function repoView(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner },
    description: repo.description,
    private: repo.isPrivate,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
  };
}

function issueView(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.userLogin },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullView(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.mergeable,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    user: { login: pull.userLogin },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------
// Store writes
// ---------------------------------------------------------------------------

function openIssue(forge: Forge, repo: RepoRec, title: string, body: string | undefined): IssueRec {
  const now = forge.nowIso();
  const record: IssueRec = {
    id: forge.nextIssueId,
    number: repo.nextIssue,
    title,
    body: body ?? '',
    state: 'open',
    labels: [],
    userLogin: forge.viewerLogin,
    createdSeq: ++repo.seqCounter,
    createdAt: now,
    updatedAt: now,
    comments: [],
  };
  forge.nextIssueId += 1;
  repo.nextIssue += 1;
  repo.issues.push(record);
  repo.issueByNumber.set(record.number, record);
  return record;
}

function openPull(
  forge: Forge,
  repo: RepoRec,
  title: string,
  body: string | undefined,
  headRef: string,
  baseRef: string,
): PullRec | null {
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  if (headSha === undefined) return null;
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? '';
  const now = forge.nowIso();
  const record: PullRec = {
    id: forge.nextPullId,
    number: repo.nextPull,
    title,
    body: body ?? '',
    state: 'open',
    merged: false,
    mergeable: true,
    mergedAt: null,
    mergeCommitSha: null,
    headRef,
    baseRef,
    headSha,
    baseSha,
    userLogin: forge.viewerLogin,
    createdSeq: ++repo.seqCounter,
    createdAt: now,
    updatedAt: now,
  };
  forge.nextPullId += 1;
  repo.nextPull += 1;
  repo.pulls.push(record);
  repo.pullByNumber.set(record.number, record);
  return record;
}

// ---------------------------------------------------------------------------
// Squash merge over repo.objects (same semantics as the REST merge)
// ---------------------------------------------------------------------------

function treeOfCommit(data: Buffer): string | null {
  const match = /^tree ([0-9a-f]{40})$/m.exec(data.toString('utf8'));
  return match === null ? null : match[1] as string;
}

function putObject(repo: RepoRec, type: 'commit' | 'tree' | 'blob' | 'tag', data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  const sha = createHash('sha1').update(header).update(data).digest('hex');
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

/** Squash-merge: one commit carrying the head tree on top of the base tip. */
function squashMerge(forge: Forge, repo: RepoRec, pull: PullRec): string | null {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  if (baseTip === '') return null;
  const headObject = repo.objects.get(pull.headSha);
  if (headObject === undefined || headObject.type !== 'commit') return null;
  const treeSha = treeOfCommit(headObject.data);
  if (treeSha === null) return null;
  const epoch = forge.nowEpoch();
  const identity = `ada iversen <adaiversen@example.invalid> ${epoch} +0000`;
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
  const commitText =
    `tree ${treeSha}\nparent ${baseTip}\nauthor ${identity}\ncommitter ${identity}\n\n${message}`;
  const sha = putObject(repo, 'commit', Buffer.from(commitText, 'utf8'));
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.nowIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = forge.nowIso();
  return sha;
}

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

interface ToolOutcome {
  isError: boolean;
  text: string;
  structured: unknown;
}

function okResult(value: unknown): ToolOutcome {
  return { isError: false, text: JSON.stringify(value), structured: value };
}

function errorResult(message: string): ToolOutcome {
  return { isError: true, text: message, structured: { error: message } };
}

function missingArg(name: string): ToolOutcome {
  return errorResult(`Missing required argument: ${name}`);
}

function repoFromArgs(forge: Forge, args: Record<string, unknown>): RepoRec | null {
  const owner = asString(args['owner']);
  const name = asString(args['repo']);
  if (owner === undefined || name === undefined) return null;
  return forge.getRepo(owner, name) ?? null;
}

function runTool(forge: Forge, name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = asString(args['name']);
      if (repoName === undefined) return missingArg('name');
      const existing = forge.getRepo(forge.viewerLogin, repoName);
      if (existing !== undefined) return okResult(repoView(existing));
      const repo = forge.createRepo(repoName, {
        description: asString(args['description']) ?? '',
        isPrivate: asBool(args['private']) ?? false,
      });
      return okResult(repoView(repo));
    }
    case 'get_repo': {
      const repo = repoFromArgs(forge, args);
      if (repo === null) return errorResult('Repository not found');
      return okResult(repoView(repo));
    }
    case 'create_issue': {
      const repo = repoFromArgs(forge, args);
      if (repo === null) return errorResult('Repository not found');
      const title = asString(args['title']);
      if (title === undefined) return missingArg('title');
      const issue = openIssue(forge, repo, title, asString(args['body']));
      return okResult(issueView(repo, issue));
    }
    case 'list_issues': {
      const repo = repoFromArgs(forge, args);
      if (repo === null) return errorResult('Repository not found');
      const state = asString(args['state']);
      const wanted = state === undefined || state === '' || state === 'all' ? undefined : state;
      const list = repo.issues
        .filter((issue) => wanted === undefined || issue.state === wanted)
        .map((issue) => issueView(repo, issue));
      return okResult(list);
    }
    case 'create_pull_request': {
      const repo = repoFromArgs(forge, args);
      if (repo === null) return errorResult('Repository not found');
      const title = asString(args['title']);
      const head = asString(args['head']);
      const base = asString(args['base']);
      if (title === undefined) return missingArg('title');
      if (head === undefined) return missingArg('head');
      if (base === undefined) return missingArg('base');
      const pull = openPull(forge, repo, title, asString(args['body']), head, base);
      if (pull === null) return errorResult(`Head branch ${head} does not exist`);
      return okResult(pullView(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = repoFromArgs(forge, args);
      if (repo === null) return errorResult('Repository not found');
      const rawNumber = args['pull_number'];
      const number = typeof rawNumber === 'number'
        ? rawNumber
        : typeof rawNumber === 'string' && /^\d+$/.test(rawNumber)
          ? Number.parseInt(rawNumber, 10)
          : undefined;
      if (number === undefined) return missingArg('pull_number');
      const pull = repo.pullByNumber.get(number);
      if (pull === undefined) return errorResult(`Pull request #${number} does not exist`);
      if (pull.merged || pull.state !== 'open') {
        return errorResult(`Pull request #${number} is already ${pull.merged ? 'merged' : 'closed'}`);
      }
      const sha = squashMerge(forge, repo, pull);
      if (sha === null) return errorResult(`Pull request #${number} cannot be merged`);
      return okResult({ merged: true, sha, message: `Pull request #${number} merged` });
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS: readonly string[] = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18']);
const LEGACY_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error['data'] = data;
  return { jsonrpc: '2.0', id, error };
}

function serverIdentity(): Record<string, unknown> {
  return {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  };
}

function discoverResult(): Record<string, unknown> {
  return {
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    serverInfo: serverIdentity(),
    instructions: 'GitHub-compatible git forge: create and read repositories, issues and pull requests.',
    _meta: {
      'io.modelcontextprotocol/serverInfo': serverIdentity(),
    },
  };
}

function dispatchRpc(
  forge: Forge,
  method: string,
  params: Record<string, unknown>,
  id: unknown,
): { reply: Record<string, unknown> | null; status: number; sessionHeader: boolean } {
  switch (method) {
    case 'server/discover':
      return { reply: rpcResult(id, discoverResult()), status: 200, sessionHeader: false };
    case 'initialize': {
      const asked = asString(params['protocolVersion']);
      const negotiated = asked !== undefined && (SUPPORTED_VERSIONS.includes(asked) || LEGACY_VERSIONS.has(asked))
        ? asked
        : '2025-11-25';
      return {
        reply: rpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: serverIdentity(),
        }),
        status: 200,
        sessionHeader: true,
      };
    }
    case 'ping':
      return { reply: rpcResult(id, {}), status: 200, sessionHeader: false };
    case 'tools/list':
      return { reply: rpcResult(id, { tools: TOOLS }), status: 200, sessionHeader: false };
    case 'tools/call': {
      const toolName = asString(params['name']);
      if (toolName === undefined) {
        return { reply: rpcError(id, -32602, 'tools/call needs a tool name'), status: 200, sessionHeader: false };
      }
      if (!TOOL_NAMES.has(toolName)) {
        return { reply: rpcError(id, -32602, `Unknown tool: ${toolName}`), status: 200, sessionHeader: false };
      }
      const args = isRecord(params['arguments']) ? params['arguments'] : {};
      const outcome = runTool(forge, toolName, args);
      return {
        reply: rpcResult(id, {
          content: [{ type: 'text', text: outcome.text }],
          structuredContent: outcome.structured,
          isError: outcome.isError,
        }),
        status: 200,
        sessionHeader: false,
      };
    }
    default:
      return { reply: rpcError(id, -32601, `Method not found: ${method}`), status: 200, sessionHeader: false };
  }
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export async function handleMcp(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): Promise<boolean> {
  // The client closes a legacy session with DELETE; there is nothing to tear down.
  if (req.method === 'DELETE') {
    res.writeHead(200, { 'x-github-request-id': forge.nextReqId() });
    res.end();
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(forge, res, 404, { message: 'Not Found' });
    return true;
  }
  if (!bearerIsValid(req)) {
    sendJson(forge, res, 401, { message: 'Requires authentication' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(forge, res, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }
  if (!isRecord(parsed)) {
    sendJson(forge, res, 400, rpcError(null, -32600, 'Invalid Request'));
    return true;
  }
  const method = typeof parsed['method'] === 'string' ? parsed['method'] : '';
  const id = parsed['id'] === undefined ? null : parsed['id'];
  const params = isRecord(parsed['params']) ? parsed['params'] : {};
  // A notification (no id) never gets a JSON-RPC reply.
  if (id === null && method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': forge.nextReqId() });
    res.end();
    return true;
  }
  if (method === '') {
    sendJson(forge, res, 200, rpcError(id, -32600, 'Invalid Request'));
    return true;
  }
  const { reply, status, sessionHeader } = dispatchRpc(forge, method, params, id);
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': forge.nextReqId(),
  };
  if (sessionHeader) headers['mcp-session-id'] = 'mcp-session-1';
  res.writeHead(status, headers);
  res.end(JSON.stringify(reply));
  return true;
}
