// util.ts — small shared helpers for the HTTP surfaces.
//
// Everything here is deliberately boring: JSON replies that always carry the
// request-id header, base64 helpers for the contents API, path splitting and
// pagination parsing. No business logic lives in this file.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Forge } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** Send a JSON body with the standard headers (content type + request id). */
export function sendJson(
  forge: Forge,
  res: ServerResponse,
  status: number,
  payload: unknown,
  extra: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': forge.nextReqId(),
    ...extra,
  });
  res.end(text);
}

/** Send a status with no body (204). Still carries the request id. */
export function sendEmpty(
  forge: Forge,
  res: ServerResponse,
  status: number,
  extra: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': forge.nextReqId(),
    ...extra,
  });
  res.end();
}

/** Standard error body: {message}. */
export function sendError(
  forge: Forge,
  res: ServerResponse,
  status: number,
  message: string,
): void {
  sendJson(forge, res, status, { message });
}

/** Base64 (standard alphabet) of a UTF-8 string. */
export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Base64 of raw bytes. */
export function b64encodeBytes(data: Buffer): string {
  return data.toString('base64');
}

/** Decode base64, tolerating the whitespace GitHub wraps content with. */
export function b64decode(content: string): Buffer {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** Split a URL pathname into decoded segments, dropping empty pieces. */
export function splitPath(pathname: string): string[] {
  const out: string[] = [];
  for (const piece of pathname.split('/')) {
    if (piece === '') continue;
    try {
      out.push(decodeURIComponent(piece));
    } catch {
      out.push(piece);
    }
  }
  return out;
}

/** Parse a request URL against a dummy base; never throws. */
export function parseUrl(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://forge.local');
  } catch {
    return new URL('/', 'http://forge.local');
  }
}

/** The origin the client reached us on, for absolute pagination links. */
export function requestOrigin(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}

export interface PageParams {
  page: number;
  perPage: number;
}

/** Read ?page= / ?per_page= with GitHub's defaults (page 1, 30 per page). */
export function pageParams(query: URLSearchParams): PageParams {
  const rawPage = Number.parseInt(query.get('page') ?? '1', 10);
  const rawPer = Number.parseInt(query.get('per_page') ?? '30', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const perPage =
    Number.isFinite(rawPer) && rawPer >= 1 ? Math.min(rawPer, 100) : 30;
  return { page, perPage };
}

/** Slice one page out of a list. */
export function paginate<T>(items: readonly T[], page: PageParams): T[] {
  const start = (page.page - 1) * page.perPage;
  return items.slice(start, start + page.perPage);
}

/** A GitHub-style Link header with rel="next", or null when there is no next page. */
export function nextLink(
  req: IncomingMessage,
  path: string,
  query: URLSearchParams,
  page: PageParams,
  total: number,
): string | null {
  if (page.page * page.perPage >= total) return null;
  const next = new URLSearchParams(query);
  next.set('page', String(page.page + 1));
  next.set('per_page', String(page.perPage));
  return `<${requestOrigin(req)}${path}?${next.toString()}>; rel="next"`;
}

/** Parse a request body as JSON. Empty bodies become {}. Throws a
 *  SyntaxError on malformed JSON, which callers turn into a 400. */
export function parseJsonBody(body: Buffer): unknown {
  const text = body.toString('utf8').trim();
  if (text === '') return {};
  return JSON.parse(text);
}
