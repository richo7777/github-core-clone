# github-core-clone

A GitHub-compatible git forge in Node 22, standard library only — no
dependencies, no `git` binary, no network beyond the trial harness.

## What it does

- **Git smart HTTP** (`/<owner>/<repo>.git/...`): clone, fetch and push over
  the v0/v2 protocols, with pack generation and parsing in-process.
- **REST v3** (`/api/v3/...`): repositories, branches, commits, contents,
  labels, issues, comments and pull requests (including squash merge with
  merge-base conflict detection).
- **GraphQL v4** (`/api/graphql`): the documents `gh` and
  `github-mcp-server` actually send.
- **MCP** (`/mcp`): streamable-HTTP Model Context Protocol tools over the
  same store.

All state lives in memory in one `Forge` (`store.ts`); the trial clock comes
from `MAKEFUN_TRIAL_NOW` and the bearer token from `MAKEFUN_SHOP_TOKEN`.

## Run it

```sh
node main.ts
```

The process binds an ephemeral port, registers it with the env at
`MAKEFUN_ENV_URL`, and exits once the env reports the trial is done.
`GET /healthz` answers `{"ok": true}` without authentication.

## Layout

- `store.ts` — record shapes, the `Forge`, the trial clock, auth helpers
- `util.ts` — JSON replies, base64, path and pagination helpers
- `rest.ts` — the REST v3 handler
- `git.ts` / `githttp.ts` — the object store and git smart HTTP
- `graphql.ts` / `mcp.ts` — GraphQL v4 and the MCP endpoint
- `app.ts` — routing; `main.ts` — the env lifecycle
