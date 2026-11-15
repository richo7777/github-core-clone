// graphql.ts — GitHub GraphQL v4 surface for the forge.
//
// A small purpose-built executor for the document subset the conformance
// suite sends: queries and mutations with $variables, field arguments
// (literals and variables), aliases, inline fragments, and the __type /
// __schema introspection probes gh uses for feature detection. No parser
// library; the tokenizer and recursive-descent parser below are written
// for this file only.
//
// The handler shares the Forge store with REST and MCP: issues, pull
// requests and comments created here are the same records the other
// surfaces read back, and global ids are the base64url scheme from the
// coordinator spec (repo:<id>, issue:<repoId>:<number>, pr:<repoId>:<number>).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { Forge, RepoRec, IssueRec, PullRec, CommentRec } from './store.ts';

// ---------------------------------------------------------------------------
// Small shared helpers (auth, replies, global ids)
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

function encodeId(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64url');
}

function decodeId(id: string): string | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

function repoGlobalId(repo: RepoRec): string {
  return encodeId(`repo:${repo.id}`);
}

function issueGlobalId(repo: RepoRec, issue: IssueRec): string {
  return encodeId(`issue:${repo.id}:${issue.number}`);
}

function pullGlobalId(repo: RepoRec, pull: PullRec): string {
  return encodeId(`pr:${repo.id}:${pull.number}`);
}

function commentGlobalId(repo: RepoRec, issue: IssueRec, comment: CommentRec): string {
  return encodeId(`comment:${repo.id}:${issue.number}:${comment.id}`);
}

function repoByNumericId(forge: Forge, numericId: number): RepoRec | undefined {
  for (const repo of forge.repos.values()) {
    if (repo.id === numericId) return repo;
  }
  return undefined;
}

/** Split a decoded global id into its parts, or null when it is not one. */
function splitGlobalId(id: unknown): { kind: string; repoId: number; number: number } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeId(id);
  if (decoded === null) return null;
  const parts = decoded.split(':');
  if (parts.length < 2) return null;
  const kind = parts[0] as string;
  const repoId = Number(parts[1]);
  if (!Number.isInteger(repoId)) return null;
  if (kind === 'repo') return { kind, repoId, number: 0 };
  if (parts.length < 3) return null;
  const number = Number(parts[2]);
  if (!Number.isInteger(number)) return null;
  return { kind, repoId, number };
}

// ---------------------------------------------------------------------------
// Store writes shared with REST/MCP semantics
// ---------------------------------------------------------------------------

function createIssueRecord(forge: Forge, repo: RepoRec, title: string, body: string | undefined): IssueRec {
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

function createPullRecord(
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
// Minimal git-object reading (tree walk + squash commit) over repo.objects
// ---------------------------------------------------------------------------

interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

function parseTreeObject(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

function commitTreeSha(data: Buffer): string | null {
  const text = data.toString('utf8');
  const match = /^tree ([0-9a-f]{40})$/m.exec(text);
  return match === null ? null : match[1] as string;
}

function flattenTree(repo: RepoRec, treeSha: string | undefined, prefix: string, out: Map<string, string>): void {
  if (treeSha === undefined) return;
  const object = repo.objects.get(treeSha);
  if (object === undefined || object.type !== 'tree') return;
  for (const entry of parseTreeObject(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      flattenTree(repo, entry.sha, path, out);
    } else {
      out.set(path, entry.sha);
    }
  }
}

/** Paths whose blob differs between the base tip tree and the head tip tree. */
function changedPaths(repo: RepoRec, baseSha: string, headSha: string): string[] {
  const baseObject = repo.objects.get(baseSha);
  const headObject = repo.objects.get(headSha);
  const baseTree = baseObject !== undefined && baseObject.type === 'commit' ? commitTreeSha(baseObject.data) ?? undefined : undefined;
  const headTree = headObject !== undefined && headObject.type === 'commit' ? commitTreeSha(headObject.data) ?? undefined : undefined;
  const baseFiles = new Map<string, string>();
  const headFiles = new Map<string, string>();
  flattenTree(repo, baseTree, '', baseFiles);
  flattenTree(repo, headTree, '', headFiles);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  const changed: string[] = [];
  for (const path of paths) {
    if (baseFiles.get(path) !== headFiles.get(path)) changed.push(path);
  }
  changed.sort();
  return changed;
}

function storeGitObject(repo: RepoRec, type: 'commit' | 'tree' | 'blob' | 'tag', data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  const sha = createHash('sha1').update(header).update(data).digest('hex');
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

/** Squash-merge a pull request: one commit with the head tree on the base tip. */
function squashMerge(forge: Forge, repo: RepoRec, pull: PullRec): string | null {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  if (baseTip === '') return null;
  const headObject = repo.objects.get(pull.headSha);
  if (headObject === undefined || headObject.type !== 'commit') return null;
  const treeSha = commitTreeSha(headObject.data);
  if (treeSha === null) return null;
  const epoch = forge.nowEpoch();
  const identity = `ada iversen <adaiversen@example.invalid> ${epoch} +0000`;
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
  const commitText =
    `tree ${treeSha}\nparent ${baseTip}\nauthor ${identity}\ncommitter ${identity}\n\n${message}`;
  const sha = storeGitObject(repo, 'commit', Buffer.from(commitText, 'utf8'));
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.nowIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = forge.nowIso();
  return sha;
}

// ---------------------------------------------------------------------------
// GraphQL document lexer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

const PUNCTUATORS = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

class Lexer {
  private pos = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];
    for (;;) {
      const token = this.nextToken();
      tokens.push(token);
      if (token.kind === 'eof') return tokens;
    }
  }

  private nextToken(): Token {
    this.skipIgnored();
    if (this.pos >= this.source.length) return { kind: 'eof', value: '' };
    const ch = this.source[this.pos] as string;
    if (ch === '.' && this.source.startsWith('...', this.pos)) {
      this.pos += 3;
      return { kind: 'punct', value: '...' };
    }
    if (PUNCTUATORS.has(ch)) {
      this.pos += 1;
      return { kind: 'punct', value: ch };
    }
    if (ch === '"') return this.readString();
    if (ch === '-' || (ch >= '0' && ch <= '9')) return this.readNumber();
    if (/[A-Za-z_]/.test(ch)) return this.readName();
    throw new Error(`Unexpected character ${JSON.stringify(ch)} at offset ${this.pos}`);
  }

  private skipIgnored(): void {
    for (;;) {
      while (this.pos < this.source.length) {
        const ch = this.source[this.pos] as string;
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
          this.pos += 1;
        } else {
          break;
        }
      }
      if (this.source[this.pos] === '#') {
        while (this.pos < this.source.length && this.source[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      break;
    }
  }

  private readName(): Token {
    const start = this.pos;
    while (this.pos < this.source.length && /[A-Za-z0-9_]/.test(this.source[this.pos] as string)) this.pos += 1;
    return { kind: 'name', value: this.source.slice(start, this.pos) };
  }

  private readNumber(): Token {
    const start = this.pos;
    if (this.source[this.pos] === '-') this.pos += 1;
    while (this.pos < this.source.length && /[0-9]/.test(this.source[this.pos] as string)) this.pos += 1;
    let isFloat = false;
    if (this.source[this.pos] === '.' && /[0-9]/.test(this.source[this.pos + 1] as string)) {
      isFloat = true;
      this.pos += 1;
      while (this.pos < this.source.length && /[0-9]/.test(this.source[this.pos] as string)) this.pos += 1;
    }
    if (this.source[this.pos] === 'e' || this.source[this.pos] === 'E') {
      isFloat = true;
      this.pos += 1;
      if (this.source[this.pos] === '+' || this.source[this.pos] === '-') this.pos += 1;
      while (this.pos < this.source.length && /[0-9]/.test(this.source[this.pos] as string)) this.pos += 1;
    }
    return { kind: isFloat ? 'float' : 'int', value: this.source.slice(start, this.pos) };
  }

  private readString(): Token {
    // Block strings (""") are read raw; quoted strings honour backslash escapes.
    if (this.source.startsWith('"""', this.pos)) {
      const end = this.source.indexOf('"""', this.pos + 3);
      if (end < 0) throw new Error('Unterminated block string');
      const value = this.source.slice(this.pos + 3, end);
      this.pos = end + 3;
      return { kind: 'string', value };
    }
    this.pos += 1; // opening quote
    let value = '';
    for (;;) {
      if (this.pos >= this.source.length) throw new Error('Unterminated string');
      const ch = this.source[this.pos] as string;
      if (ch === '"') {
        this.pos += 1;
        return { kind: 'string', value };
      }
      if (ch === '\\') {
        const esc = this.source[this.pos + 1] as string;
        const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
        if (esc === 'u') {
          const hex = this.source.slice(this.pos + 2, this.pos + 6);
          value += String.fromCharCode(Number.parseInt(hex, 16));
          this.pos += 6;
        } else if (simple[esc] !== undefined) {
          value += simple[esc] as string;
          this.pos += 2;
        } else {
          throw new Error(`Invalid escape \\${esc}`);
        }
        continue;
      }
      if (ch === '\n') throw new Error('Unterminated string');
      value += ch;
      this.pos += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// GraphQL document parser (subset: operations, fragments, values)
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldSelection {
  kind: 'field';
  alias: string | undefined;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: Selection[];
}

interface FragmentSelection {
  kind: 'fragment';
  typeCondition: string | undefined;
  selections: Selection[];
}

interface SpreadSelection {
  kind: 'spread';
  name: string;
}

type Selection = FieldSelection | FragmentSelection | SpreadSelection;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | undefined;
  variables: Array<{ name: string; defaultValue: ValueNode | undefined }>;
  selections: Selection[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          kind: 'query',
          name: undefined,
          variables: [],
          selections: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        operations.push(this.parseOperation());
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        const def = this.parseFragmentDef();
        fragments.set(def.name, def);
        continue;
      }
      if (token.kind === 'name' && token.value === 'subscription') {
        throw new Error('Subscriptions are not supported');
      }
      throw new Error(`Unexpected token ${token.value} in document`);
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    const kindToken = this.next();
    const kind = kindToken.value as 'query' | 'mutation';
    let name: string | undefined;
    if (this.peek().kind === 'name') name = this.next().value;
    const variables = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseVariableDefs() : [];
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseVariableDefs(): Array<{ name: string; defaultValue: ValueNode | undefined }> {
    this.expectPunct('(');
    const defs: Array<{ name: string; defaultValue: ValueNode | undefined }> = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue(true);
      }
      defs.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  /** Consume a type reference (named, list, non-null); only its shape matters here. */
  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseFragmentDef(): FragmentDef {
    this.next(); // 'fragment'
    const name = this.expectName();
    const on = this.expectName();
    if (on !== 'on') throw new Error('Expected "on" in fragment definition');
    const typeCondition = this.expectName();
    const selections = this.parseSelectionSet();
    return { name, typeCondition, selections };
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        return { kind: 'spread', name: this.next().value };
      }
      return { kind: 'fragment', typeCondition: undefined, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
    this.skipDirectives();
    const selections =
      this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(false) });
    }
    this.expectPunct(')');
    return args;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseValue(isConst: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      if (isConst) throw new Error('Variable in constant value');
      return { kind: 'var', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        items.push(this.parseValue(isConst));
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Unexpected value token ${token.value}`);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`Expected a name, got ${token.value}`);
    return token.value;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`Expected "${value}", got ${token.value}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Schema tables (field lists for validation and introspection)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
    'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'pushedAt', 'url',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt',
    'author', 'comments', 'labels', 'url',
  ],
  PullRequest: [
    'id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName',
    'mergeable', 'files', 'body', 'createdAt', 'updatedAt', 'author',
    'headRefOid', 'baseRefOid', 'mergeCommit', 'additions', 'deletions', 'changedFiles',
  ],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'totalCount', 'pageInfo'],
  PullRequestConnection: ['nodes', 'totalCount', 'pageInfo'],
  PullRequestChangedFileConnection: ['nodes', 'totalCount', 'pageInfo'],
  CommentConnection: ['nodes', 'totalCount', 'pageInfo'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
  Comment: ['id', 'body', 'author'],
  CommentEdge: ['node', 'cursor'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'ofType'],
  __Schema: ['queryType', 'mutationType', 'subscriptionType', 'types', 'directives'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  __InputValue: ['name', 'description'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'LABEL', 'MILESTONE', 'TOPIC'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

const TYPE_KINDS: Record<string, string> = {
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  MergeableState: 'ENUM',
  PullRequestState: 'ENUM',
  PullRequestMergeMethod: 'ENUM',
  RepositoryPermission: 'ENUM',
  IssueOrderField: 'ENUM',
  OrderDirection: 'ENUM',
};

// ---------------------------------------------------------------------------
// Typed values carried through execution
// ---------------------------------------------------------------------------

type TypedValue =
  | { kind: 'Query' }
  | { kind: 'Mutation' }
  | { kind: 'Repository'; repo: RepoRec }
  | { kind: 'Issue'; repo: RepoRec; issue: IssueRec }
  | { kind: 'PullRequest'; repo: RepoRec; pull: PullRec }
  | { kind: 'User'; login: string }
  | { kind: 'Ref'; name: string }
  | { kind: 'IssueConnection'; items: IssueRec[]; repo: RepoRec; totalCount: number; pageInfo: PageInfo }
  | { kind: 'PullRequestConnection'; items: PullRec[]; repo: RepoRec; totalCount: number; pageInfo: PageInfo }
  | { kind: 'ChangedFileConnection'; items: string[]; totalCount: number; pageInfo: PageInfo }
  | { kind: 'CommentConnection'; items: CommentRec[]; totalCount: number; pageInfo: PageInfo }
  | { kind: 'ChangedFile'; path: string }
  | { kind: 'PageInfo'; info: PageInfo }
  | { kind: 'SchemaType'; name: string }
  | { kind: 'SchemaField'; name: string }
  | { kind: 'SchemaEnumValue'; name: string }
  | { kind: 'Schema'; }
  | { kind: 'Comment'; id: string; body: string; login: string }
  | { kind: 'CommentEdge'; comment: { id: string; body: string; login: string } }
  | { kind: 'Payload'; fields: Record<string, TypedValue | null> };

interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

// ---------------------------------------------------------------------------
// Value evaluation (literals + variables)
// ---------------------------------------------------------------------------

function evalValue(node: ValueNode, ctx: ExecContext): unknown {
  switch (node.kind) {
    case 'var': {
      const value = ctx.variables[node.name];
      return value === undefined ? null : value;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => evalValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, ctx);
      return out;
    }
  }
}

function evalArgs(field: FieldSelection, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evalValue(arg.value, ctx);
  return out;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Cursor pagination over an already-ordered list
// ---------------------------------------------------------------------------

function cursorFor(index: number): string {
  return encodeId(`cursor:${index}`);
}

function indexFromCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  const decoded = decodeId(cursor);
  if (decoded === null) return -1;
  const match = /^cursor:(\d+)$/.exec(decoded);
  if (match === null) return -1;
  return Number.parseInt(match[1] as string, 10);
}

function paginate<T>(items: readonly T[], first: number | undefined, after: unknown): { page: T[]; total: number; pageInfo: PageInfo } {
  const start = indexFromCursor(after) + 1;
  const limit = first === undefined || first < 0 ? items.length : first;
  const page = items.slice(start, start + limit);
  const lastIndex = page.length === 0 ? -1 : start + page.length - 1;
  return {
    page: [...page],
    total: items.length,
    pageInfo: {
      hasNextPage: lastIndex >= 0 && lastIndex < items.length - 1,
      hasPreviousPage: start > 0,
      startCursor: page.length === 0 ? null : cursorFor(start),
      endCursor: page.length === 0 ? null : cursorFor(lastIndex),
    },
  };
}

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------

function issueStateName(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateName(pull: PullRec): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function mergeableName(pull: PullRec): string {
  if (pull.mergeable === true) return 'MERGEABLE';
  if (pull.mergeable === false) return 'CONFLICTING';
  return 'UNKNOWN';
}

function orderedIssues(repo: RepoRec, states: string[] | undefined, orderBy: Record<string, unknown> | undefined): IssueRec[] {
  let list = [...repo.issues];
  if (states !== undefined && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const direction = orderBy !== undefined && orderBy['direction'] === 'ASC' ? 1 : -1;
  list.sort((a, b) => {
    const bySeq = (a.createdSeq - b.createdSeq) || (a.number - b.number);
    return direction * bySeq;
  });
  return list;
}

function resolveField(
  source: TypedValue,
  field: FieldSelection,
  ctx: ExecContext,
): TypedValue | TypedValue[] | string | number | boolean | null {
  const forge = ctx.forge;
  const args = evalArgs(field, ctx);
  switch (source.kind) {
    case 'Query': {
      if (field.name === 'viewer') return { kind: 'User', login: forge.viewerLogin };
      if (field.name === 'repository') {
        const owner = asString(args['owner']);
        const name = asString(args['name']);
        if (owner === undefined || name === undefined) return null;
        const repo = forge.getRepo(owner, name);
        return repo === undefined ? null : { kind: 'Repository', repo };
      }
      if (field.name === 'node') {
        const split = splitGlobalId(args['id']);
        if (split === null) return null;
        const repo = repoByNumericId(forge, split.repoId);
        if (repo === undefined) return null;
        if (split.kind === 'repo') return { kind: 'Repository', repo };
        if (split.kind === 'issue') {
          const issue = repo.issueByNumber.get(split.number);
          return issue === undefined ? null : { kind: 'Issue', repo, issue };
        }
        if (split.kind === 'pr') {
          const pull = repo.pullByNumber.get(split.number);
          return pull === undefined ? null : { kind: 'PullRequest', repo, pull };
        }
        return null;
      }
      if (field.name === '__type') {
        const name = asString(args['name']);
        if (name === undefined) return null;
        if (TYPE_FIELDS[name] === undefined && ENUM_VALUES[name] === undefined) return null;
        return { kind: 'SchemaType', name };
      }
      if (field.name === '__schema') return { kind: 'Schema' };
      return null;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args['input'] ?? {}) as Record<string, unknown>;
        const split = splitGlobalId(input['repositoryId']);
        if (split === null || split.kind !== 'repo') return null;
        const repo = repoByNumericId(forge, split.repoId);
        if (repo === undefined) return null;
        const title = asString(input['title']);
        if (title === undefined) return null;
        const issue = createIssueRecord(forge, repo, title, asString(input['body']));
        return {
          kind: 'Payload',
          fields: { issue: { kind: 'Issue', repo, issue } },
        };
      }
      if (field.name === 'closeIssue') {
        const input = (args['input'] ?? {}) as Record<string, unknown>;
        const split = splitGlobalId(input['issueId']);
        if (split === null || split.kind !== 'issue') return null;
        const repo = repoByNumericId(forge, split.repoId);
        const issue = repo?.issueByNumber.get(split.number);
        if (repo === undefined || issue === undefined) return null;
        issue.state = 'closed';
        issue.updatedAt = forge.nowIso();
        return {
          kind: 'Payload',
          fields: { issue: { kind: 'Issue', repo, issue } },
        };
      }
      if (field.name === 'createPullRequest') {
        const input = (args['input'] ?? {}) as Record<string, unknown>;
        const split = splitGlobalId(input['repositoryId']);
        if (split === null || split.kind !== 'repo') return null;
        const repo = repoByNumericId(forge, split.repoId);
        if (repo === undefined) return null;
        const title = asString(input['title']);
        const headRef = asString(input['headRefName']);
        const baseRef = asString(input['baseRefName']);
        if (title === undefined || headRef === undefined || baseRef === undefined) return null;
        const pull = createPullRecord(forge, repo, title, asString(input['body']), headRef, baseRef);
        if (pull === null) {
          ctx.errors.push({ message: `Head branch ${headRef} does not exist` });
          return null;
        }
        return {
          kind: 'Payload',
          fields: { pullRequest: { kind: 'PullRequest', repo, pull } },
        };
      }
      if (field.name === 'mergePullRequest') {
        const input = (args['input'] ?? {}) as Record<string, unknown>;
        const split = splitGlobalId(input['pullRequestId']);
        if (split === null || split.kind !== 'pr') return null;
        const repo = repoByNumericId(forge, split.repoId);
        const pull = repo?.pullByNumber.get(split.number);
        if (repo === undefined || pull === undefined) return null;
        if (pull.merged || pull.state !== 'open') {
          ctx.errors.push({ message: `Pull request #${pull.number} is already ${pull.merged ? 'merged' : 'closed'}` });
          return null;
        }
        const sha = squashMerge(forge, repo, pull);
        if (sha === null) {
          ctx.errors.push({ message: `Pull request #${pull.number} cannot be merged` });
          return null;
        }
        return {
          kind: 'Payload',
          fields: { pullRequest: { kind: 'PullRequest', repo, pull } },
        };
      }
      if (field.name === 'addComment') {
        const input = (args['input'] ?? {}) as Record<string, unknown>;
        const split = splitGlobalId(input['subjectId']);
        if (split === null || split.kind !== 'issue') return null;
        const repo = repoByNumericId(forge, split.repoId);
        const issue = repo?.issueByNumber.get(split.number);
        if (repo === undefined || issue === undefined) return null;
        const body = asString(input['body']);
        if (body === undefined) return null;
        const now = forge.nowIso();
        const comment: CommentRec = {
          id: forge.nextCommentId,
          body,
          userLogin: forge.viewerLogin,
          createdAt: now,
          updatedAt: now,
        };
        forge.nextCommentId += 1;
        issue.comments.push(comment);
        return {
          kind: 'Payload',
          fields: {
            commentEdge: {
              kind: 'CommentEdge',
              comment: { id: commentGlobalId(repo, issue, comment), body, login: forge.viewerLogin },
            },
          },
        };
      }
      return null;
    }
    case 'Repository': {
      const repo = source.repo;
      switch (field.name) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return repo.fullName;
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'createdAt': return repo.createdAt;
        case 'updatedAt': return repo.updatedAt;
        case 'pushedAt': return repo.pushedAt;
        case 'url': return `https://github.com/${repo.fullName}`;
        case 'owner': return { kind: 'User', login: repo.owner };
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip === undefined ? null : { kind: 'Ref', name: repo.defaultBranch };
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'issue': {
          const number = asInt(args['number']);
          if (number === undefined) return null;
          const issue = repo.issueByNumber.get(number);
          return issue === undefined ? null : { kind: 'Issue', repo, issue };
        }
        case 'issues': {
          const states = Array.isArray(args['states'])
            ? (args['states'] as unknown[]).map((state) => String(state))
            : undefined;
          const orderBy = (args['orderBy'] ?? undefined) as Record<string, unknown> | undefined;
          const ordered = orderedIssues(repo, states, orderBy);
          const { page, total, pageInfo } = paginate(ordered, asInt(args['first']), args['after']);
          return { kind: 'IssueConnection', items: page, repo, totalCount: total, pageInfo };
        }
        case 'pullRequests': {
          const ordered = [...repo.pulls].sort((a, b) => (b.createdSeq - a.createdSeq) || (b.number - a.number));
          const { page, total, pageInfo } = paginate(ordered, asInt(args['first']), args['after']);
          return { kind: 'PullRequestConnection', items: page, repo, totalCount: total, pageInfo };
        }
        case 'pullRequest': {
          const number = asInt(args['number']);
          if (number === undefined) return null;
          const pull = repo.pullByNumber.get(number);
          return pull === undefined ? null : { kind: 'PullRequest', repo, pull };
        }
        default: return null;
      }
    }
    case 'Issue': {
      const issue = source.issue;
      switch (field.name) {
        case 'id': return issueGlobalId(source.repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issueStateName(issue.state);
        case 'body': return issue.body;
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
        case 'author': return { kind: 'User', login: issue.userLogin };
        case 'labels': return issue.labels;
        case 'url': return `https://github.com/${source.repo.fullName}/issues/${issue.number}`;
        case 'comments': {
          const { page, total, pageInfo } = paginate(issue.comments, asInt(args['first']), args['after']);
          return { kind: 'CommentConnection', items: page, totalCount: total, pageInfo };
        }
        default: return null;
      }
    }
    case 'PullRequest': {
      const pull = source.pull;
      switch (field.name) {
        case 'id': return pullGlobalId(source.repo, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'state': return pullStateName(pull);
        case 'merged': return pull.merged;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'mergeable': return mergeableName(pull);
        case 'body': return pull.body;
        case 'createdAt': return pull.createdAt;
        case 'updatedAt': return pull.updatedAt;
        case 'author': return { kind: 'User', login: pull.userLogin };
        case 'headRefOid': return pull.headSha;
        case 'baseRefOid': return pull.baseSha;
        case 'mergeCommit': return pull.mergeCommitSha === null ? null : { kind: 'Ref', name: pull.mergeCommitSha };
        case 'additions': return 0;
        case 'deletions': return 0;
        case 'changedFiles': return changedPaths(source.repo, pull.baseSha, pull.headSha).length;
        case 'files': {
          const paths = changedPaths(source.repo, pull.baseSha, pull.headSha);
          const { page, total, pageInfo } = paginate(paths, asInt(args['first']), args['after']);
          return { kind: 'ChangedFileConnection', items: page, totalCount: total, pageInfo };
        }
        default: return null;
      }
    }
    case 'User': {
      if (field.name === 'login') return source.login;
      if (field.name === 'id') return encodeId(`user:${source.login}`);
      if (field.name === 'name') return source.login === 'adaiversen' ? 'ada iversen' : source.login;
      if (field.name === 'email') return source.login === 'adaiversen' ? 'adaiversen@example.invalid' : null;
      return null;
    }
    case 'Ref': {
      if (field.name === 'name') return source.name;
      if (field.name === 'target') return { kind: 'Ref', name: source.name };
      return null;
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') {
        return source.items.map((issue) => ({ kind: 'Issue', repo: source.repo, issue }) as TypedValue);
      }
      if (field.name === 'totalCount') return source.totalCount;
      if (field.name === 'pageInfo') return { kind: 'PageInfo', info: source.pageInfo };
      return null;
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') {
        return source.items.map((pull) => ({ kind: 'PullRequest', repo: source.repo, pull }) as TypedValue);
      }
      if (field.name === 'totalCount') return source.totalCount;
      if (field.name === 'pageInfo') return { kind: 'PageInfo', info: source.pageInfo };
      return null;
    }
    case 'ChangedFileConnection': {
      if (field.name === 'nodes') {
        return source.items.map((path) => ({ kind: 'ChangedFile', path }) as TypedValue);
      }
      if (field.name === 'totalCount') return source.totalCount;
      if (field.name === 'pageInfo') return { kind: 'PageInfo', info: source.pageInfo };
      return null;
    }
    case 'CommentConnection': {
      if (field.name === 'nodes') {
        return source.items.map(
          (comment) => ({ kind: 'Comment', id: String(comment.id), body: comment.body, login: comment.userLogin }) as TypedValue,
        );
      }
      if (field.name === 'totalCount') return source.totalCount;
      if (field.name === 'pageInfo') return { kind: 'PageInfo', info: source.pageInfo };
      return null;
    }
    case 'ChangedFile': {
      if (field.name === 'path') return source.path;
      if (field.name === 'additions') return 0;
      if (field.name === 'deletions') return 0;
      if (field.name === 'changeType') return 'ADDED';
      return null;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return source.info.hasNextPage;
      if (field.name === 'hasPreviousPage') return source.info.hasPreviousPage;
      if (field.name === 'startCursor') return source.info.startCursor;
      if (field.name === 'endCursor') return source.info.endCursor;
      return null;
    }
    case 'SchemaType': {
      if (field.name === 'name') return source.name;
      if (field.name === 'kind') return TYPE_KINDS[source.name] ?? 'OBJECT';
      if (field.name === 'description') return null;
      if (field.name === 'fields') {
        const names = TYPE_FIELDS[source.name];
        if (names === undefined) return null;
        return names.map((name) => ({ kind: 'SchemaField', name }) as TypedValue);
      }
      if (field.name === 'enumValues') {
        const values = ENUM_VALUES[source.name];
        if (values === undefined) return null;
        return values.map((name) => ({ kind: 'SchemaEnumValue', name }) as TypedValue);
      }
      if (field.name === 'ofType') return null;
      return null;
    }
    case 'SchemaField': {
      if (field.name === 'name') return source.name;
      if (field.name === 'description') return null;
      return null;
    }
    case 'SchemaEnumValue': {
      if (field.name === 'name') return source.name;
      if (field.name === 'description') return null;
      return null;
    }
    case 'Schema': {
      if (field.name === 'queryType') return { kind: 'SchemaType', name: 'Query' };
      if (field.name === 'mutationType') return { kind: 'SchemaType', name: 'Mutation' };
      if (field.name === 'subscriptionType') return null;
      if (field.name === 'types') {
        return Object.keys(TYPE_FIELDS).map((name) => ({ kind: 'SchemaType', name }) as TypedValue);
      }
      if (field.name === 'directives') return [];
      return null;
    }
    case 'Comment': {
      if (field.name === 'id') return source.id;
      if (field.name === 'body') return source.body;
      if (field.name === 'author') return { kind: 'User', login: source.login };
      return null;
    }
    case 'CommentEdge': {
      if (field.name === 'node') return { kind: 'Comment', id: source.comment.id, body: source.comment.body, login: source.comment.login };
      if (field.name === 'cursor') return null;
      return null;
    }
    case 'Payload': {
      const value = source.fields[field.name];
      return value === undefined ? null : value;
    }
  }
}

// ---------------------------------------------------------------------------
// Selection execution (validation + shaping)
// ---------------------------------------------------------------------------

function isTypedValue(value: unknown): value is TypedValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof (value as { kind: unknown }).kind === 'string'
  );
}

/** Execute a selection set against a typed value; null when a child field failed. */
function executeSelections(
  source: TypedValue,
  selections: Selection[],
  ctx: ExecContext,
  path: Array<string | number>,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let failed = false;
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const def = ctx.fragments.get(selection.name);
      if (def === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}"`, path });
        failed = true;
        continue;
      }
      const nested = executeSelections(source, def.selections, ctx, path);
      if (nested === null) {
        failed = true;
        continue;
      }
      Object.assign(out, nested);
      continue;
    }
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== source.kind) continue;
      const nested = executeSelections(source, selection.selections, ctx, path);
      if (nested === null) {
        failed = true;
        continue;
      }
      Object.assign(out, nested);
      continue;
    }
    const field = selection;
    const responseName = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[responseName] = source.kind;
      continue;
    }
    const allowed = TYPE_FIELDS[source.kind];
    if (allowed !== undefined && !allowed.includes(field.name)) {
      ctx.errors.push({
        message: `Cannot query field "${field.name}" on type "${source.kind}".`,
        path: [...path, responseName],
      });
      failed = true;
      continue;
    }
    const value = resolveField(source, field, ctx);
    if (value === null) {
      out[responseName] = null;
      continue;
    }
    if (Array.isArray(value)) {
      const shaped: unknown[] = [];
      let itemFailed = false;
      for (const item of value) {
        if (isTypedValue(item)) {
          if (field.selections.length === 0) {
            shaped.push(null);
          } else {
            const nested = executeSelections(item, field.selections, ctx, [...path, responseName]);
            if (nested === null) itemFailed = true;
            shaped.push(nested);
          }
        } else {
          shaped.push(item);
        }
      }
      if (itemFailed) failed = true;
      out[responseName] = shaped;
      continue;
    }
    if (isTypedValue(value)) {
      if (field.selections.length === 0) {
        out[responseName] = {};
        continue;
      }
      const nested = executeSelections(value, field.selections, ctx, [...path, responseName]);
      if (nested === null) {
        failed = true;
        out[responseName] = null;
        continue;
      }
      out[responseName] = nested;
      continue;
    }
    out[responseName] = value;
  }
  return failed ? null : out;
}

function executeOperation(
  forge: Forge,
  document: Document,
  operation: Operation,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors: Array<{ message: string; path?: Array<string | number> }> } {
  const ctx: ExecContext = { forge, variables, fragments: document.fragments, errors: [] };
  // Fill variable defaults for variables the caller did not send.
  for (const def of operation.variables) {
    if (ctx.variables[def.name] === undefined && def.defaultValue !== undefined) {
      ctx.variables[def.name] = evalValue(def.defaultValue, ctx);
    }
  }
  const root: TypedValue = operation.kind === 'mutation' ? { kind: 'Mutation' } : { kind: 'Query' };
  const data = executeSelections(root, operation.selections, ctx, []);
  return { data, errors: ctx.errors };
}

function runDocument(
  forge: Forge,
  query: unknown,
  variables: Record<string, unknown>,
  operationName: string | undefined,
): { data: Record<string, unknown> | null; errors: Array<{ message: string; path?: Array<string | number> }> } {
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'A GraphQL query document is required' }] };
  }
  let document: Document;
  try {
    document = new Parser(new Lexer(query).tokenize()).parseDocument();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { data: null, errors: [{ message: `GraphQL syntax error: ${message}` }] };
  }
  if (document.operations.length === 0) {
    return { data: null, errors: [{ message: 'The document holds no operation' }] };
  }
  let operation: Operation | undefined;
  if (operationName !== undefined) {
    operation = document.operations.find((op) => op.name === operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}"` }] };
    }
  } else if (document.operations.length === 1) {
    operation = document.operations[0];
  } else {
    return {
      data: null,
      errors: [{ message: 'Multiple operations in one document require an operationName' }],
    };
  }
  return executeOperation(forge, document, operation, { ...variables });
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export async function handleGraphql(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): Promise<boolean> {
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
    sendJson(forge, res, 400, { message: 'Malformed JSON body' });
    return true;
  }
  // GitHub operation batching: a JSON array of {query, variables} answers an
  // array of per-operation envelopes, in request order.
  if (Array.isArray(parsed)) {
    const answers = parsed.map((entry) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        return { data: null, errors: [{ message: 'Each batched entry must be an object with a query' }] };
      }
      const record = entry as Record<string, unknown>;
      const variables = (record['variables'] ?? {}) as Record<string, unknown>;
      const result = runDocument(forge, record['query'], variables, asString(record['operationName']));
      return result.errors.length > 0 ? { data: result.data, errors: result.errors } : { data: result.data };
    });
    sendJson(forge, res, 200, answers);
    return true;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(forge, res, 400, { message: 'The request body must be a JSON object or an array of operations' });
    return true;
  }
  const record = parsed as Record<string, unknown>;
  const variables = (record['variables'] ?? {}) as Record<string, unknown>;
  const result = runDocument(forge, record['query'], variables, asString(record['operationName']));
  if (result.errors.length > 0) {
    sendJson(forge, res, 200, { data: result.data, errors: result.errors });
    return true;
  }
  sendJson(forge, res, 200, { data: result.data });
  return true;
}
