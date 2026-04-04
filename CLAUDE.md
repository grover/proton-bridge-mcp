# proton-bridge-mcp — Claude Code Guide

> **Auto-update rule:** After each session that changes code, patterns, or learnings, update this file.
> Add new findings to "Key Learnings", keep "MCP Tools" and "Milestone Status" accurate.

## What This Is

MCP server bridging ProtonMail via the local Proton Bridge IMAP daemon (`127.0.0.1:1143` by default).
See [project-spec.md](project-spec.md) for milestone roadmap. See [ARCHITECTURE.md](ARCHITECTURE.md) for design detail.

## Pre-commit Checklist

Before every commit:
1. `git fetch origin && git rebase origin/main` — keep the branch current before committing
2. `npm install` — regenerate `package-lock.json` if `package.json` changed; always run to ensure lockfile is in sync
3. `npm run lint` — must pass with zero errors
4. `npm run build` — must compile clean
5. `npm ci` — verify the lockfile is in sync (catches the case where `package.json` was edited without running `npm install`)

CI runs `npm ci`, which fails if `package-lock.json` is out of sync with `package.json`.

## Build & Run

```bash
npm install
npm run build          # compile TypeScript → dist/
npm run dev            # tsx watch (no compile, restarts on change)
npm run lint           # ESLint with type-aware parsing
npm test               # stub — replace with vitest when tests are added

node dist/index.js --verify          # test IMAP connectivity then exit
node dist/index.js \                 # minimum required args
  --bridge-username your@protonmail.com \
  --bridge-password bridge-generated-password \
  --mcp-auth-token your-secret-token \
  --audit-log-path ./audit.jsonl
```

Copy `.env.example` → `.env`. The bridge password comes from the Proton Bridge desktop app
(Account → Mailbox password), **not** your ProtonMail login password.

## CI & Release

### CI (`.github/workflows/ci.yml`)
Runs on every PR and push to `main`. Three parallel jobs: **Lint**, **Build**, **Test**.
- `Lint` and `Build` jobs are non-trivial (type-aware ESLint = tsc runs inside eslint)
- `Test` uses `--if-present`; becomes active once `"test": "vitest run"` is in `package.json`
- `Build` uploads `dist/` as an artifact (SHA-keyed, 7-day retention)
- Concurrency: cancels in-progress PR runs on new push; `main` pushes never cancel each other

Required status checks to configure in GitHub branch protection: **Lint**, **Build**, **Test** (exact `name:` values).

### Release (`.release-it.json` + `.github/workflows/release.yml`)
1. Populate `[Unreleased]` in `CHANGELOG.md` (existing habit)
2. Run `npx release-it` locally — prompts for bump type, then:
   - Runs `lint` + `build` (pre-flight guard)
   - Moves `[Unreleased]` → `[x.y.z]` in `CHANGELOG.md`
   - Bumps `package.json` version
   - Commits `chore: release vX.Y.Z` and pushes tag
3. `release.yml` fires on the tag → extracts the changelog section via `awk` → creates GitHub Release

`github.release: false` in `.release-it.json` — GitHub Release is always created by CI, never from a local machine.
To enable npm publish: set `"publish": true` in `.release-it.json` and add `NPM_TOKEN` to GitHub Secrets.

### Node version pinning
- `.nvmrc`: `25.9.0` — nvm/mise/asdf local dev
- `package.json` `volta.node`: `25.9.0` — Volta local dev
- `env.NODE_VERSION` in each workflow file — single source per file

## Milestone Status (project-spec.md)

| Milestone | Status | Notes |
|---|---|---|
| MVP | Partial | Scaffolding + IMAP pool + audit + verify. Missing: `list_folders` tool, idle pool drain timer |
| M1 | Partial | `list_mailbox`, `fetch_summaries`, `fetch_message`, `fetch_attachment` done |
| M2 | Not started | Move done; revert tool not started |
| M3 | Partial | `mark_read`, `mark_unread` done; star/archive/trash pending |
| M4–M5 | Not started | |

**Next required for MVP:** `list_folders` tool (IMAP LIST command) + idle pool drain timer (5 min configurable).

## Key Patterns

### Pool Version Pattern (`src/bridge/pool.ts`)
Do NOT use a `#draining` flag. Use `#poolVersion`:
- Each connection stamped `{ conn, version: this.#poolVersion }` at creation
- `drain()` increments `#poolVersion`, closes available connections immediately
- `release(conn)`: if `conn.version < #poolVersion` → close it + replenish; else return to pool
- Safe for multiple consecutive drains. Pool stays live without restart.

### `@Audited` Decorator (`src/bridge/decorators.ts`)
Every public `ImapClient` method must be decorated with `@Audited('operation_name')`.
Wraps the method in `this.audit.wrap()` — no manual audit calls needed in method bodies.
The class must expose `audit: AuditLogger` as a public property (not private).

### Batch Operations + Index Stability
All `ImapClient` methods taking `EmailId[]` preserve input order in results.
`BatchItemResult<T>[]` ops: result[i] ↔ input[i], with success or `{ code, message }` error.
Internals: group IDs by mailbox → one `getMailboxLock` per group → reorder before return.

### IMAP Mailbox Lock
```typescript
const conn = await this.pool.acquire();
const lock = await conn.getMailboxLock(mailbox);
try {
  // IMAP operations
} finally {
  lock.release();       // always release lock first
  this.pool.release(conn);  // then return connection to pool
}
```

### Logging Separation
- **App logger** (`src/logger.ts`): pino → stderr (default) or `PROTONMAIL_LOG_PATH`
- **Audit logger** (`src/bridge/audit.ts`): JSONL → `PROTONMAIL_AUDIT_LOG_PATH` (file only, **never stderr**)
- stderr is reserved for operational/MCP/Fastify output

### Config Precedence
CLI args (`commander`) → env vars → defaults. All env vars prefixed `PROTONMAIL_`.
`loadConfig(process.argv)` throws with the flag/var name if a required value is missing.

### Per-Session McpServer
`McpServer` connects to one transport at a time. Each HTTP session gets its own instance
(created in `createHttpApp`, not in `src/index.ts`). `ImapClient` and `ImapConnectionPool` are shared singletons.

## NodeNext ESM Import Rule
All local imports MUST use `.js` extension:
```typescript
import { ImapClient } from './bridge/imap.js';  // ✓
import { ImapClient } from './bridge/imap';      // ✗ fails at runtime
```

## Key Learnings (from build + implementation)

| Issue | Root Cause | Fix |
|---|---|---|
| `conn.mailbox?.exists` | `imapflow`: `conn.mailbox` is `false \| MailboxObject`, not just `MailboxObject` | Guard: `conn.mailbox !== false ? conn.mailbox.exists : 0` |
| `parsed.html ?? undefined` | `mailparser`: `html` is `string \| false`, not `string \| undefined` | Use `\|\|` not `??`: `parsed.html \|\| undefined` |
| `moved['uidMap'][uid]` | `imapflow`: `CopyResponseObject.uidMap` is `Map<number,number>` not a plain object | `moved !== false ? moved.uidMap?.get(uid) : undefined` |
| `logPath: undefined` in config | `exactOptionalPropertyTypes`: can't assign `undefined` to `prop?: T` | Conditional spread: `...(val ? { logPath: val } : {})` |
| `server.connect(transport)` | MCP SDK: `StreamableHTTPServerTransport.onclose` is optional but `Transport` requires non-optional — `exactOptionalPropertyTypes` mismatch | Cast: `transport as Parameters<typeof server.connect>[0]` |
| Fastify logger generic | `loggerInstance: pinoLogger` infers `AppLogger` generic; incompatible with `FastifyBaseLogger` return type | Cast: `logger as unknown as FastifyBaseLogger` |
| TC39 decorator syntax at runtime | TypeScript 6 with `target: ESNext` emits `@Decorator(...)` verbatim; Node.js 25.9.0 cannot parse it (no V8 flag enables it reliably) | Use `experimentalDecorators: true` in tsconfig — TypeScript compiles to `__decorate` helpers; rewrite decorator to legacy `(target, key, descriptor)` API |

## MCP Tools (current)

| Tool | Purpose |
|---|---|
| `list_mailbox` | Browse emails in a mailbox, newest first (paginated) |
| `fetch_summaries` | Envelope data for known UIDs (batch) |
| `fetch_message` | Text/HTML body + attachment metadata (batch, no content) |
| `fetch_attachment` | Download one attachment (base64) |
| `search_mailbox` | IMAP TEXT search with pagination |
| `move_emails` | Move batch of emails to another mailbox |
| `mark_read` | Add `\Seen` flag (batch) |
| `mark_unread` | Remove `\Seen` flag (batch) |
| `verify_connectivity` | Test IMAP connection to Proton Bridge |
| `drain_connections` | Flush all pool connections immediately |

## Verify Setup

```bash
node dist/index.js --verify                     # connectivity check
curl -X POST http://127.0.0.1:3000/mcp          # → 401 (no token)
npx @modelcontextprotocol/inspector http://127.0.0.1:3000/mcp  # set Authorization header
tail -f audit.jsonl | jq .                      # watch audit entries
```
