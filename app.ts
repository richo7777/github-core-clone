// app.ts — the HTTP server: routing only, no business logic.
//
// createApp() builds a node:http server around one Forge. The request body
// is read in full (as a Buffer) before dispatch, every handler is awaited
// inside a guard that answers 500 JSON instead of ever throwing, and an
// unhandled route is a JSON 404. The surface handlers live in their own
// modules (rest.ts, graphql.ts, mcp.ts, githttp.ts) and share the Forge.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { parseUrl, sendError, sendJson, splitPath } from './util.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './githttp.ts';

/** Read the whole request body; resolves with an empty Buffer when none arrives. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const forge = new Forge();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = parseUrl(req);
        const path = url.pathname;
        const method = req.method ?? 'GET';
        const body = await readBody(req);

        // Boot probe: no auth, no body.
        if (method === 'GET' && path === '/healthz') {
          sendJson(forge, res, 200, { ok: true });
          return;
        }

        const segments = splitPath(path);

        // REST v3 (the API root included — handleRest answers it).
        if (segments[0] === 'api' && segments[1] === 'v3') {
          const handled = await handleRest(forge, req, res, body);
          if (!handled) sendError(forge, res, 404, 'Not Found');
          return;
        }

        // GraphQL v4.
        if (segments[0] === 'api' && segments[1] === 'graphql') {
          const handled = await handleGraphql(forge, req, res, body);
          if (!handled) sendError(forge, res, 404, 'Not Found');
          return;
        }

        // MCP over streamable HTTP.
        if (segments[0] === 'mcp') {
          const handled = await handleMcp(forge, req, res, body);
          if (!handled) sendError(forge, res, 404, 'Not Found');
          return;
        }

        // git smart HTTP: /<owner>/<repo>.git/...
        if (
          segments.length >= 2 &&
          segments[1] !== undefined &&
          segments[1].endsWith('.git')
        ) {
          const handled = await handleGit(forge, req, res, body);
          if (!handled) sendError(forge, res, 404, 'Not Found');
          return;
        }

        sendError(forge, res, 404, 'Not Found');
      } catch {
        if (!res.headersSent) {
          try {
            sendError(forge, res, 500, 'Internal Server Error');
          } catch {
            // The socket is already gone; nothing left to do.
          }
        }
      }
    })();
  });
}
