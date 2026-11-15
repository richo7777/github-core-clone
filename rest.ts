// rest.ts — the GitHub REST v3 surface (/api/v3).
//
// One entry point, handleRest(forge, req, res, body). Every reply is JSON
// with X-GitHub-Request-Id (via util.sendJson), auth failures are 401, a
// repository under any owner other than the viewer is 404 (never 403), a
// malformed JSON body is 400 and an unknown route is a JSON 404.
//
// Contents and merges delegate the object-store work to git.ts (written by
// the GIT agent); this file only owns the HTTP shape and the REST semantics
// around it.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  authed,
  type Forge,
  type IssueRec,
  type LabelRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import {
  b64decode,
  b64encodeBytes,
  nextLink,
  pageParams,
  paginate,
  parseJsonBody,
  parseUrl,
  sendEmpty,
  sendError,
  sendJson,
  splitPath,
} from './util.ts';
import {
  countLineChanges,
  diffTrees,
  makeCommit,
  mergeBase,
  parseCommit,
  parseTree,
  readObject,
  readPathAt,
  resolveRef,
  storeObject,
  writePathAt,
} from './git.ts';

/** A control-flow error carrying the HTTP status to answer with. */
class HttpProblem extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const bad = (status: number, message: string): HttpProblem =>
  new HttpProblem(status, message);

type JsonObj = Record<string, unknown>;

function asObject(value: unknown, what: string): JsonObj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw bad(422, `${what} must be a JSON object`);
  }
  return value as JsonObj;
}

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Parse the body, turning a syntax error into a 400. */
function readBody(body: Buffer): JsonObj {
  try {
    return asObject(parseJsonBody(body), 'request body');
  } catch (err) {
    if (err instanceof SyntaxError) throw bad(400, 'Malformed JSON body');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Serialisers (the wire shapes the conformance checks assert)

function userJson(forge: Forge): JsonObj {
  return {
    login: forge.viewerLogin,
    id: forge.viewerId,
    node_id: '',
    avatar_url: '',
    type: 'User',
    site_admin: false,
    name: forge.viewerName,
    email: forge.viewerEmail,
    html_url: '',
    url: '/api/v3/user',
  };
}

function repoJson(forge: Forge, repo: RepoRec): JsonObj {
  const openIssues = repo.issues.filter((issue) => issue.state === 'open').length;
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: forge.viewerId, type: 'User' },
    private: repo.isPrivate,
    html_url: '',
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openIssues,
    size: 0,
    language: null,
    homepage: null,
  };
}

function labelJson(label: LabelRec): JsonObj {
  return {
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function issueJson(forge: Forge, repo: RepoRec, issue: IssueRec): JsonObj {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => {
      const found = repo.labels.get(name);
      return found === undefined
        ? { name, color: 'ededed', description: '' }
        : labelJson(found);
    }),
    user: { login: issue.userLogin, id: forge.viewerId, type: 'User' },
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: null,
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(forge: Forge, repo: RepoRec, issue: IssueRec, comment: IssueRec['comments'][number]): JsonObj {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.userLogin, id: forge.viewerId, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  };
}

/** Resolve the current tip of a branch name (or a raw commit sha). */
function tipOf(repo: RepoRec, ref: string): string | undefined {
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const obj = readObject(repo, ref.toLowerCase());
    if (obj !== undefined && obj.type === 'commit') return ref.toLowerCase();
  }
  return resolveRef(repo, ref);
}

/** The tree sha of a commit, or undefined when the commit is unknown. */
function treeOfCommit(repo: RepoRec, commitSha: string): string | undefined {
  const obj = readObject(repo, commitSha);
  if (obj === undefined || obj.type !== 'commit') return undefined;
  return parseCommit(obj.data).tree;
}

/** Walk a commit's ancestry newest-first (depth-first, first parent first). */
function walkHistory(repo: RepoRec, tip: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = readObject(repo, sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    ordered.push(sha);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) {
      stack.push(parents[i] as string);
    }
  }
  return ordered;
}

/** True when base and head both changed the same path differently since
 *  their merge-base (the conflict rule the merge check relies on). */
function hasMergeConflict(repo: RepoRec, baseTip: string, headSha: string): boolean {
  const base = mergeBase(repo, baseTip, headSha);
  if (base === undefined) return false;
  const baseTree = treeOfCommit(repo, base);
  const baseChanges = new Map(
    diffTrees(repo, baseTree, treeOfCommit(repo, baseTip)).map((entry) => [
      entry.path,
      entry.newSha ?? null,
    ]),
  );
  for (const entry of diffTrees(repo, baseTree, treeOfCommit(repo, headSha))) {
    if (!baseChanges.has(entry.path)) continue;
    const baseNew = baseChanges.get(entry.path);
    const headNew = entry.newSha ?? null;
    if (baseNew !== headNew) return true;
  }
  return false;
}

function pullMergeable(repo: RepoRec, pull: PullRec): boolean {
  if (pull.state !== 'open') return false;
  const baseTip = tipOf(repo, pull.baseRef);
  if (baseTip === undefined) return false;
  return !hasMergeConflict(repo, baseTip, pull.headSha);
}

function pullJson(forge: Forge, repo: RepoRec, pull: PullRec): JsonObj {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: false,
    merged: pull.merged,
    mergeable: pullMergeable(repo, pull),
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: { login: repo.owner, id: forge.viewerId, type: 'User' },
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: { login: repo.owner, id: forge.viewerId, type: 'User' },
    },
    user: { login: pull.userLogin, id: forge.viewerId, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------
// Lookups

/** Load a repo or answer 404. Any owner other than the viewer is 404 too. */
function loadRepo(forge: Forge, owner: string, name: string): RepoRec {
  if (owner !== forge.viewerLogin) throw bad(404, 'Not Found');
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) throw bad(404, 'Not Found');
  return repo;
}

function loadIssue(repo: RepoRec, raw: string): IssueRec {
  const number = Number.parseInt(raw, 10);
  if (!Number.isInteger(number) || number < 1) throw bad(404, 'Not Found');
  const issue = repo.issueByNumber.get(number);
  if (issue === undefined) throw bad(404, 'Not Found');
  return issue;
}

function loadPull(repo: RepoRec, raw: string): PullRec {
  const number = Number.parseInt(raw, 10);
  if (!Number.isInteger(number) || number < 1) throw bad(404, 'Not Found');
  const pull = repo.pullByNumber.get(number);
  if (pull === undefined) throw bad(404, 'Not Found');
  return pull;
}

/** Entries of the tree at `treeSha` (name -> {mode, sha}); empty when unknown. */
function treeEntries(
  repo: RepoRec,
  treeSha: string,
): Array<{ mode: string; name: string; sha: string }> {
  const obj = readObject(repo, treeSha);
  if (obj === undefined || obj.type !== 'tree') return [];
  return parseTree(obj.data);
}

function isDirMode(mode: string): boolean {
  return mode === '40000' || mode.startsWith('04');
}

/** The tree sha of the directory `dirPath` under `rootTree`, or undefined. */
function dirTreeSha(
  repo: RepoRec,
  rootTree: string,
  dirPath: string,
): string | undefined {
  let current = rootTree;
  if (dirPath === '') return current;
  for (const segment of dirPath.split('/')) {
    const entry = treeEntries(repo, current).find((item) => item.name === segment);
    if (entry === undefined || !isDirMode(entry.mode)) return undefined;
    current = entry.sha;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Repos

function createRepoRoute(
  forge: Forge,
  res: ServerResponse,
  body: JsonObj,
): void {
  const name = asText(body.name).trim();
  if (name === '' || name.length > 100) {
    throw bad(422, 'Repository name is required');
  }
  if (forge.getRepo(forge.viewerLogin, name) !== undefined) {
    throw bad(422, 'Repository already exists');
  }
  const repo = forge.createRepo(name, {
    isPrivate: asBool(body.private, false),
    description: asText(body.description),
  });
  sendJson(forge, res, 201, repoJson(forge, repo));
}

function listUserRepos(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
): void {
  const page = pageParams(query);
  const all: RepoRec[] = [];
  for (const repo of forge.repos.values()) {
    if (repo.owner === forge.viewerLogin) all.push(repo);
  }
  const extra: Record<string, string> = {};
  const link = nextLink(req, '/api/v3/user/repos', query, page, all.length);
  if (link !== null) extra.link = link;
  sendJson(forge, res, 200, paginate(all, page).map((repo) => repoJson(forge, repo)), extra);
}

function repoRoute(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
  body: JsonObj,
): void {
  const method = req.method ?? 'GET';
  if (method === 'GET') {
    sendJson(forge, res, 200, repoJson(forge, loadRepo(forge, owner, name)));
    return;
  }
  if (method === 'PATCH') {
    const repo = loadRepo(forge, owner, name);
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.private === 'boolean') repo.isPrivate = body.private;
    repo.updatedAt = forge.nowIso();
    sendJson(forge, res, 200, repoJson(forge, repo));
    return;
  }
  if (method === 'DELETE') {
    loadRepo(forge, owner, name);
    forge.deleteRepo(owner, name);
    sendEmpty(forge, res, 204);
    return;
  }
  throw bad(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Branches, refs, commits

function listBranches(forge: Forge, res: ServerResponse, repo: RepoRec): void {
  const out: JsonObj[] = [];
  for (const [ref, sha] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    out.push({
      name: ref.slice('refs/heads/'.length),
      commit: { sha, url: '' },
      protected: false,
    });
  }
  sendJson(forge, res, 200, out);
}

function getBranch(
  forge: Forge,
  res: ServerResponse,
  repo: RepoRec,
  branch: string,
): void {
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) throw bad(404, 'Not Found');
  sendJson(forge, res, 200, {
    name: branch,
    commit: { sha, url: '' },
    protected: false,
  });
}

function createRef(
  forge: Forge,
  res: ServerResponse,
  repo: RepoRec,
  body: JsonObj,
): void {
  const ref = asText(body.ref).trim();
  const sha = asText(body.sha).trim().toLowerCase();
  if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
    throw bad(422, 'Invalid ref or sha');
  }
  if (repo.refs.has(ref)) throw bad(422, 'Reference already exists');
  const obj = readObject(repo, sha);
  if (obj === undefined) throw bad(422, 'Unknown object sha');
  repo.refs.set(ref, sha);
  repo.updatedAt = forge.nowIso();
  sendJson(forge, res, 201, {
    ref,
    object: { sha, type: obj.type, url: '' },
  });
}

function getRef(
  forge: Forge,
  res: ServerResponse,
  repo: RepoRec,
  refPath: string,
): void {
  const sha = repo.refs.get(refPath);
  if (sha === undefined) throw bad(404, 'Not Found');
  const obj = readObject(repo, sha);
  sendJson(forge, res, 200, {
    ref: refPath,
    object: { sha, type: obj?.type ?? 'commit', url: '' },
  });
}

function listCommits(
  forge: Forge,
  res: ServerResponse,
  repo: RepoRec,
  query: URLSearchParams,
): void {
  const wanted = query.get('sha');
  const tip =
    wanted === null
      ? repo.refs.get(`refs/heads/${repo.defaultBranch}`)
      : tipOf(repo, wanted);
  if (tip === undefined) {
    sendJson(forge, res, 200, []);
    return;
  }
  const out: JsonObj[] = [];
  for (const sha of walkHistory(repo, tip)) {
    const obj = readObject(repo, sha);
    if (obj === undefined) continue;
    const parsed = parseCommit(obj.data);
    out.push({
      sha,
      commit: {
        // git stores the message with a trailing newline; the API presents
        // it without trailing blank lines, as GitHub does.
        message: parsed.message.replace(/\n+$/, ''),
        author: {
          name: forge.viewerName,
          email: forge.viewerEmail,
          date: forge.nowIso(),
        },
        committer: {
          name: forge.viewerName,
          email: forge.viewerEmail,
          date: forge.nowIso(),
        },
      },
      author: { login: forge.viewerLogin, id: forge.viewerId, type: 'User' },
      committer: { login: forge.viewerLogin, id: forge.viewerId, type: 'User' },
      parents: parsed.parents.map((parent) => ({ sha: parent })),
      url: '',
      html_url: '',
    });
  }
  sendJson(forge, res, 200, out);
}

// ---------------------------------------------------------------------------
// Contents

/** The commit a contents read targets: ?ref= branch/sha, else default branch. */
function contentsTip(repo: RepoRec, query: URLSearchParams): string {
  const ref = query.get('ref');
  const tip = ref === null
    ? repo.refs.get(`refs/heads/${repo.defaultBranch}`)
    : tipOf(repo, ref);
  if (tip === undefined) throw bad(404, 'Not Found');
  return tip;
}

function getContents(
  forge: Forge,
  res: ServerResponse,
  repo: RepoRec,
  path: string,
  query: URLSearchParams,
): void {
  const tip = contentsTip(repo, query);
  const rootTree = treeOfCommit(repo, tip);
  if (rootTree === undefined) throw bad(404, 'Not Found');
  const baseName = path === '' ? '' : (path.split('/').pop() ?? path);

  if (path !== '') {
    const found = readPathAt(repo, rootTree, path);
    // readPathAt also resolves directories (returning the tree object); a
    // contents "file" is a blob only, directories fall through to the listing.
    if (found !== undefined && readObject(repo, found.sha)?.type === 'blob') {
      sendJson(forge, res, 200, {
        type: 'file',
        encoding: 'base64',
        size: found.data.length,
        name: baseName,
        path,
        content: b64encodeBytes(found.data),
        sha: found.sha,
        url: '',
        html_url: '',
        download_url: null,
      });
      return;
    }
  }
  const dirSha = dirTreeSha(repo, rootTree, path);
  if (dirSha === undefined) throw bad(404, 'Not Found');
  const entries = treeEntries(repo, dirSha).map((entry) => ({
    type: isDirMode(entry.mode) ? 'dir' : 'file',
    size: isDirMode(entry.mode)
      ? 0
      : (readObject(repo, entry.sha)?.data.length ?? 0),
    name: entry.name,
    path: path === '' ? entry.name : `${path}/${entry.name}`,
    sha: entry.sha,
    url: '',
    html_url: '',
    download_url: null,
  }));
  sendJson(forge, res, 200, entries);
}

function putContents(
  forge: Forge,
  res: ServerResponse,
  repo: RepoRec,
  path: string,
  body: JsonObj,
): void {
  if (path === '') throw bad(422, 'A file path is required');
  const branch = asText(body.branch, repo.defaultBranch) || repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  if (tip === undefined && repo.refs.size > 0) {
    throw bad(422, 'Branch does not exist');
  }
  if (tip === undefined && branch !== repo.defaultBranch) {
    throw bad(422, 'Branch does not exist');
  }
  const baseTree = tip === undefined ? undefined : treeOfCommit(repo, tip);
  const current =
    baseTree === undefined ? undefined : readPathAt(repo, baseTree, path);
  const givenSha = asText(body.sha).trim().toLowerCase();
  if (givenSha !== '') {
    if (current === undefined || current.sha.toLowerCase() !== givenSha) {
      throw bad(409, 'sha does not match the current file');
    }
  }
  const rawContent = asText(body.content);
  if (rawContent === '') throw bad(422, 'content is required');
  const bytes = b64decode(rawContent);
  const blobSha = storeObject(repo, 'blob', bytes);
  const newTree = writePathAt(repo, baseTree, path, blobSha);
  const message = asText(body.message, 'Update file');
  const commitSha = makeCommit(repo, {
    tree: newTree,
    parents: tip === undefined ? [] : [tip],
    message,
  });
  repo.refs.set(refName, commitSha);
  repo.updatedAt = forge.nowIso();
  repo.pushedAt = forge.nowIso();
  const baseName = path.split('/').pop() ?? path;
  const payload = {
    content: {
      name: baseName,
      path,
      sha: blobSha,
      size: bytes.length,
      type: 'file',
      encoding: 'base64',
      content: b64encodeBytes(bytes),
      url: '',
    },
    commit: { sha: commitSha, message },
  };
  sendJson(forge, res, current === undefined ? 201 : 200, payload);
}

function deleteContents(
  forge: Forge,
  res: ServerResponse,
  repo: RepoRec,
  path: string,
  body: JsonObj,
): void {
  const branch = asText(body.branch, repo.defaultBranch) || repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  if (tip === undefined) throw bad(404, 'Not Found');
  const baseTree = treeOfCommit(repo, tip);
  if (baseTree === undefined) throw bad(404, 'Not Found');
  const current = readPathAt(repo, baseTree, path);
  if (current === undefined) throw bad(404, 'Not Found');
  const givenSha = asText(body.sha).trim().toLowerCase();
  if (givenSha !== '' && current.sha.toLowerCase() !== givenSha) {
    throw bad(409, 'sha does not match the current file');
  }
  const newTree = writePathAt(repo, baseTree, path, null);
  const commitSha = makeCommit(repo, {
    tree: newTree,
    parents: [tip],
    message: asText(body.message, 'Delete file'),
  });
  repo.refs.set(refName, commitSha);
  repo.updatedAt = forge.nowIso();
  repo.pushedAt = forge.nowIso();
  sendJson(forge, res, 200, { commit: { sha: commitSha }, content: null });
}

// ---------------------------------------------------------------------------
// Labels, issues, comments

function createLabel(
  forge: Forge,
  res: ServerResponse,
  repo: RepoRec,
  body: JsonObj,
): void {
  const name = asText(body.name).trim();
  if (name === '') throw bad(422, 'Label name is required');
  const existing = repo.labels.get(name);
  if (existing !== undefined) {
    sendJson(forge, res, 201, labelJson(existing));
    return;
  }
  const label: LabelRec = {
    name,
    color: asText(body.color, 'ededed').replace(/^#/, ''),
    description: asText(body.description),
  };
  repo.labels.set(name, label);
  sendJson(forge, res, 201, labelJson(label));
}

function createIssue(
  forge: Forge,
  res: ServerResponse,
  repo: RepoRec,
  body: JsonObj,
): void {
  const title = asText(body.title).trim();
  if (title === '') throw bad(422, 'Issue title is required');
  const wanted: string[] = Array.isArray(body.labels)
    ? (body.labels as unknown[]).map((item) =>
        typeof item === 'string'
          ? item
          : asText((item as JsonObj | null)?.name),
      )
    : [];
  for (const name of wanted) {
    if (!repo.labels.has(name)) throw bad(422, `Label does not exist: ${name}`);
  }
  const stamp = forge.nowIso();
  const issue: IssueRec = {
    id: forge.nextIssueId++,
    number: repo.nextIssue++,
    title,
    body: asText(body.body),
    state: 'open',
    labels: wanted,
    userLogin: forge.viewerLogin,
    createdSeq: ++repo.seqCounter,
    createdAt: stamp,
    updatedAt: stamp,
    comments: [],
  };
  repo.issues.push(issue);
  repo.issueByNumber.set(issue.number, issue);
  sendJson(forge, res, 201, issueJson(forge, repo, issue));
}

function listIssues(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  repo: RepoRec,
  query: URLSearchParams,
): void {
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  let items = repo.issues.slice();
  if (state !== 'all') items = items.filter((issue) => issue.state === state);
  if (sort === 'created') {
    items.sort((a, b) =>
      direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq,
    );
  }
  const page = pageParams(query);
  const extra: Record<string, string> = {};
  const link = nextLink(
    req,
    `/api/v3/repos/${repo.owner}/${repo.name}/issues`,
    query,
    page,
    items.length,
  );
  if (link !== null) extra.link = link;
  sendJson(
    forge,
    res,
    200,
    paginate(items, page).map((issue) => issueJson(forge, repo, issue)),
    extra,
  );
}

function patchIssue(
  forge: Forge,
  res: ServerResponse,
  repo: RepoRec,
  issue: IssueRec,
  body: JsonObj,
): void {
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
  if (Array.isArray(body.labels)) {
    const wanted = (body.labels as unknown[]).map((item) =>
      typeof item === 'string' ? item : asText((item as JsonObj | null)?.name),
    );
    for (const name of wanted) {
      if (!repo.labels.has(name)) throw bad(422, `Label does not exist: ${name}`);
    }
    issue.labels = wanted;
  }
  issue.updatedAt = forge.nowIso();
  sendJson(forge, res, 200, issueJson(forge, repo, issue));
}

function createComment(
  forge: Forge,
  res: ServerResponse,
  repo: RepoRec,
  issue: IssueRec,
  body: JsonObj,
): void {
  const text = asText(body.body);
  if (text === '') throw bad(422, 'Comment body is required');
  const stamp = forge.nowIso();
  const comment = {
    id: forge.nextCommentId++,
    body: text,
    userLogin: forge.viewerLogin,
    createdAt: stamp,
    updatedAt: stamp,
  };
  repo.nextComment += 1;
  issue.comments.push(comment);
  issue.updatedAt = stamp;
  sendJson(forge, res, 201, commentJson(forge, repo, issue, comment));
}

// ---------------------------------------------------------------------------
// Pull requests

function createPull(
  forge: Forge,
  res: ServerResponse,
  repo: RepoRec,
  body: JsonObj,
): void {
  const headRef = asText(body.head).trim();
  const baseRef = asText(body.base, repo.defaultBranch).trim() || repo.defaultBranch;
  const title = asText(body.title).trim();
  if (headRef === '' || title === '') {
    throw bad(422, 'head and title are required');
  }
  const headSha = tipOf(repo, headRef);
  if (headSha === undefined) throw bad(422, 'Head branch does not exist');
  const baseSha = tipOf(repo, baseRef);
  if (baseSha === undefined) throw bad(422, 'Base branch does not exist');
  const stamp = forge.nowIso();
  const pull: PullRec = {
    id: forge.nextPullId++,
    number: repo.nextPull++,
    title,
    body: asText(body.body),
    state: 'open',
    merged: false,
    mergeable: null,
    mergedAt: null,
    mergeCommitSha: null,
    headRef,
    baseRef,
    headSha,
    baseSha,
    userLogin: forge.viewerLogin,
    createdSeq: ++repo.seqCounter,
    createdAt: stamp,
    updatedAt: stamp,
  };
  pull.mergeable = pullMergeable(repo, pull);
  repo.pulls.push(pull);
  repo.pullByNumber.set(pull.number, pull);
  sendJson(forge, res, 201, pullJson(forge, repo, pull));
}

function listPulls(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  repo: RepoRec,
  query: URLSearchParams,
): void {
  const state = query.get('state') ?? 'open';
  let items = repo.pulls.slice();
  if (state !== 'all') items = items.filter((pull) => pull.state === state);
  items.sort((a, b) => b.createdSeq - a.createdSeq);
  const page = pageParams(query);
  const extra: Record<string, string> = {};
  const link = nextLink(
    req,
    `/api/v3/repos/${repo.owner}/${repo.name}/pulls`,
    query,
    page,
    items.length,
  );
  if (link !== null) extra.link = link;
  sendJson(
    forge,
    res,
    200,
    paginate(items, page).map((pull) => pullJson(forge, repo, pull)),
    extra,
  );
}

function pullFiles(
  forge: Forge,
  res: ServerResponse,
  repo: RepoRec,
  pull: PullRec,
): void {
  const baseTree = treeOfCommit(repo, pull.baseSha);
  const headTree = treeOfCommit(repo, pull.headSha);
  const out: JsonObj[] = [];
  for (const entry of diffTrees(repo, baseTree, headTree)) {
    const oldText =
      entry.oldSha === undefined
        ? ''
        : (readObject(repo, entry.oldSha)?.data.toString('utf8') ?? '');
    const newText =
      entry.newSha === undefined
        ? ''
        : (readObject(repo, entry.newSha)?.data.toString('utf8') ?? '');
    const counts = countLineChanges(oldText, newText);
    out.push({
      filename: entry.path,
      status: entry.status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      sha: entry.newSha ?? entry.oldSha ?? '',
      blob_url: '',
      raw_url: '',
    });
  }
  sendJson(forge, res, 200, out);
}

function mergePull(
  forge: Forge,
  res: ServerResponse,
  repo: RepoRec,
  pull: PullRec,
): void {
  if (pull.state !== 'open' || pull.merged) {
    throw bad(405, 'Pull request is not open');
  }
  const baseTip = tipOf(repo, pull.baseRef);
  if (baseTip === undefined) throw bad(404, 'Not Found');
  if (hasMergeConflict(repo, baseTip, pull.headSha)) {
    throw bad(405, 'Merge conflict');
  }
  const headTree = treeOfCommit(repo, pull.headSha);
  if (headTree === undefined) throw bad(404, 'Not Found');
  const mergeSha = makeCommit(repo, {
    tree: headTree,
    parents: [baseTip],
    message: pull.title,
  });
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  repo.updatedAt = forge.nowIso();
  repo.pushedAt = forge.nowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.nowIso();
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = forge.nowIso();
  sendJson(forge, res, 200, {
    sha: mergeSha,
    merged: true,
    message: 'Pull request successfully merged',
  });
}

// ---------------------------------------------------------------------------
// Dispatcher

export async function handleRest(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): Promise<boolean> {
  try {
    const url = parseUrl(req);
    const segments = splitPath(url.pathname);
    const query = url.searchParams;
    const method = req.method ?? 'GET';

    // Everything under /api/v3 needs a bearer token.
    if (!authed(forge, req)) {
      sendError(forge, res, 401, 'Requires authentication');
      return true;
    }

    // API root.
    if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'v3') {
      if (method !== 'GET') throw bad(404, 'Not Found');
      sendJson(
        forge,
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          current_user_authorizations_html_url: '',
          authorizations_url: '/api/v3/authorizations',
          rate_limit_url: '/api/v3/rate_limit',
          user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return true;
    }

    if (segments.length < 3 || segments[0] !== 'api' || segments[1] !== 'v3') {
      throw bad(404, 'Not Found');
    }

    const section = segments[2] as string;

    // GET /api/v3/meta
    if (section === 'meta' && segments.length === 3) {
      if (method !== 'GET') throw bad(404, 'Not Found');
      sendJson(forge, res, 200, { installed_version: '0.1.0' });
      return true;
    }

    // /api/v3/user...
    if (section === 'user') {
      if (segments.length === 3) {
        if (method !== 'GET') throw bad(404, 'Not Found');
        sendJson(forge, res, 200, userJson(forge));
        return true;
      }
      if (segments[3] === 'repos' && segments.length === 4) {
        if (method === 'POST') {
          createRepoRoute(forge, res, readBody(body));
          return true;
        }
        if (method === 'GET') {
          listUserRepos(forge, req, res, query);
          return true;
        }
        throw bad(404, 'Not Found');
      }
      throw bad(404, 'Not Found');
    }

    // /api/v3/repos/{owner}/{repo}[...]
    if (section === 'repos') {
      const owner = segments[3] ?? '';
      const name = segments[4] ?? '';
      if (owner === '' || name === '' || segments.length < 5) {
        throw bad(404, 'Not Found');
      }
      const tail = segments.slice(5);
      const parsedBody: JsonObj | null =
        method === 'GET' || method === 'HEAD' ? null : readBody(body);

      if (tail.length === 0) {
        repoRoute(forge, req, res, owner, name, parsedBody ?? {});
        return true;
      }

      const repo = loadRepo(forge, owner, name);
      const head = tail[0] as string;

      if (head === 'git' && tail[1] === 'refs') {
        if (method === 'POST' && tail.length === 2) {
          createRef(forge, res, repo, parsedBody ?? {});
          return true;
        }
        if (method === 'GET' && tail.length === 2) {
          const all: JsonObj[] = [];
          for (const [ref, sha] of repo.refs) {
            all.push({ ref, object: { sha, type: 'commit', url: '' } });
          }
          sendJson(forge, res, 200, all);
          return true;
        }
        if (method === 'GET' && tail.length >= 3) {
          getRef(forge, res, repo, `refs/${tail.slice(2).join('/')}`);
          return true;
        }
        throw bad(404, 'Not Found');
      }

      if (head === 'branches') {
        if (method === 'GET' && tail.length === 1) {
          listBranches(forge, res, repo);
          return true;
        }
        if (method === 'GET' && tail.length >= 2) {
          getBranch(forge, res, repo, tail.slice(1).join('/'));
          return true;
        }
        throw bad(404, 'Not Found');
      }

      if (head === 'commits') {
        if (method === 'GET' && tail.length === 1) {
          listCommits(forge, res, repo, query);
          return true;
        }
        throw bad(404, 'Not Found');
      }

      if (head === 'contents') {
        const path = tail.slice(1).join('/');
        if (method === 'GET') {
          getContents(forge, res, repo, path, query);
          return true;
        }
        if (method === 'PUT') {
          putContents(forge, res, repo, path, parsedBody ?? {});
          return true;
        }
        if (method === 'DELETE') {
          deleteContents(forge, res, repo, path, parsedBody ?? {});
          return true;
        }
        throw bad(404, 'Not Found');
      }

      if (head === 'labels') {
        if (method === 'POST' && tail.length === 1) {
          createLabel(forge, res, repo, parsedBody ?? {});
          return true;
        }
        if (method === 'GET' && tail.length === 1) {
          sendJson(
            forge,
            res,
            200,
            [...repo.labels.values()].map((label) => labelJson(label)),
          );
          return true;
        }
        throw bad(404, 'Not Found');
      }

      if (head === 'issues') {
        if (tail.length === 1) {
          if (method === 'POST') {
            createIssue(forge, res, repo, parsedBody ?? {});
            return true;
          }
          if (method === 'GET') {
            listIssues(forge, req, res, repo, query);
            return true;
          }
          throw bad(404, 'Not Found');
        }
        const issue = loadIssue(repo, tail[1] as string);
        if (tail.length === 2) {
          if (method === 'GET') {
            sendJson(forge, res, 200, issueJson(forge, repo, issue));
            return true;
          }
          if (method === 'PATCH') {
            patchIssue(forge, res, repo, issue, parsedBody ?? {});
            return true;
          }
          throw bad(404, 'Not Found');
        }
        if (tail[2] === 'comments' && tail.length === 3) {
          if (method === 'POST') {
            createComment(forge, res, repo, issue, parsedBody ?? {});
            return true;
          }
          if (method === 'GET') {
            sendJson(
              forge,
              res,
              200,
              issue.comments.map((comment) =>
                commentJson(forge, repo, issue, comment),
              ),
            );
            return true;
          }
          throw bad(404, 'Not Found');
        }
        throw bad(404, 'Not Found');
      }

      if (head === 'pulls') {
        if (tail.length === 1) {
          if (method === 'POST') {
            createPull(forge, res, repo, parsedBody ?? {});
            return true;
          }
          if (method === 'GET') {
            listPulls(forge, req, res, repo, query);
            return true;
          }
          throw bad(404, 'Not Found');
        }
        const pull = loadPull(repo, tail[1] as string);
        if (tail.length === 2) {
          if (method === 'GET') {
            sendJson(forge, res, 200, pullJson(forge, repo, pull));
            return true;
          }
          throw bad(404, 'Not Found');
        }
        if (tail[2] === 'files' && tail.length === 3 && method === 'GET') {
          pullFiles(forge, res, repo, pull);
          return true;
        }
        if (tail[2] === 'merge' && tail.length === 3 && method === 'PUT') {
          // The merge body was already parsed (and 400-checked) above;
          // squash is the only method this forge performs.
          mergePull(forge, res, repo, pull);
          return true;
        }
        throw bad(404, 'Not Found');
      }

      throw bad(404, 'Not Found');
    }

    throw bad(404, 'Not Found');
  } catch (err) {
    if (err instanceof HttpProblem) {
      if (!res.headersSent) sendError(forge, res, err.status, err.message);
      return true;
    }
    if (!res.headersSent) sendError(forge, res, 500, 'Internal Server Error');
    return true;
  }
}
