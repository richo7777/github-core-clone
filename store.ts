// store.ts — the forge's in-memory store.
//
// Owns the record shapes every surface codes against, the Forge itself, the
// trial clock (MAKEFUN_TRIAL_NOW) and the bearer-token helpers. No I/O here:
// the store is plain data plus a few counters, so the hot paths stay cheap.

import type { IncomingMessage } from 'node:http';

export interface GitObject {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
}

export interface CommentRec {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  comments: CommentRec[];
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean | null;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  userLogin: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface LabelRec {
  name: string;
  color: string;
  description: string;
}

export interface RepoRec {
  id: number;
  name: string;
  owner: string;
  fullName: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: IssueRec[];
  pulls: PullRec[];
  issueByNumber: Map<number, IssueRec>;
  pullByNumber: Map<number, PullRec>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  /** Per-repo monotonic counter backing IssueRec/PullRec.createdSeq. */
  seqCounter: number;
}

/** Parse MAKEFUN_TRIAL_NOW into epoch milliseconds. Accepts an ISO string,
 *  epoch seconds, or epoch milliseconds; falls back to the wall clock only
 *  when the variable is absent or unparsable (local dev, never a trial). */
function trialEpochMs(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw === '') return Date.now();
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return Date.now();
    // >= 1e12 is already milliseconds; anything smaller is seconds.
    return n >= 1e12 ? Math.trunc(n) : Math.trunc(n * 1000);
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

export class Forge {
  repos: Map<string, RepoRec> = new Map();
  nextRepoId = 5000;
  nextIssueId = 1;
  nextPullId = 1;
  nextCommentId = 1;
  reqSeq = 0;
  viewerLogin = 'adaiversen';
  viewerId = 1000;
  viewerName = 'ada iversen';
  viewerEmail = 'adaiversen@example.invalid';

  private readonly trialMs: number;

  constructor() {
    this.trialMs = trialEpochMs();
  }

  /** The trial-now instant as an ISO string; identical on every call. */
  nowIso(): string {
    return new Date(this.trialMs).toISOString();
  }

  /** The trial-now instant as epoch seconds. */
  nowEpoch(): number {
    return Math.floor(this.trialMs / 1000);
  }

  nextReqId(): string {
    return `req-${++this.reqSeq}`;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  createRepo(
    name: string,
    opts: { isPrivate?: boolean; description?: string } = {},
  ): RepoRec {
    const stamp = this.nowIso();
    const repo: RepoRec = {
      id: this.nextRepoId++,
      name,
      owner: this.viewerLogin,
      fullName: `${this.viewerLogin}/${name}`,
      description: opts.description ?? '',
      isPrivate: opts.isPrivate ?? false,
      defaultBranch: 'main',
      createdAt: stamp,
      updatedAt: stamp,
      pushedAt: stamp,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      issueByNumber: new Map(),
      pullByNumber: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      seqCounter: 0,
    };
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }
}

/** The bearer token on a request, or null when the header is absent/malformed. */
export function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? null : (match[1] ?? '').trim() || null;
}

/** True when the request carries the trial token. When MAKEFUN_SHOP_TOKEN is
 *  empty/unset (local dev only) any non-empty bearer token is accepted. */
export function authed(_forge: Forge, req: IncomingMessage): boolean {
  const token = bearerOf(req);
  if (token === null) return false;
  const expected = (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();
  if (expected === '') return true;
  return token === expected;
}
