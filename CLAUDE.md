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
node dist/index.js \                 # STDIO mode (default) — minimum required args
  --bridge-username your@protonmail.com \
  --bridge-password bridge-generated-password

node dist/index.js --http \          # HTTP mode — requires auth token
  --bridge-username your@protonmail.com \
  --bridge-password bridge-generated-password \
  --mcp-auth-token your-secret-token

npm run package                      # build + create proton-bridge-mcp.mcpb for Claude Desktop
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
3. `release.yml` fires on the tag → builds → creates GitHub Release with:
   - `proton-bridge-mcp.mcpb` — Claude Desktop package
   - `proton-bridge-mcp-X.Y.Z-source.tar.gz` — source archive (excludes `node_modules`, `.git`, `dist`)
   - Changelog section extracted via `awk`
4. Same workflow publishes to npm (`npm publish --access public`)

`github.release: false` in `.release-it.json` — GitHub Release is always created by CI, never from a local machine.
npm publish is enabled (`"publish": true`); requires `NPM` secret in GitHub repo settings.
`package.json` `files` field limits the npm tarball to `dist/`, `manifest.json`, `CHANGELOG.md`, and `LICENSE`.

### Node version pinning
- `.nvmrc`: `25.9.0` — nvm/mise/asdf local dev
- `package.json` `volta.node`: `25.9.0` — Volta local dev
- `env.NODE_VERSION` in each workflow file — single source per file

## Milestone Status (project-spec.md)

| Milestone | Status | Notes |
|---|---|---|
| MVP | **Complete** | Scaffolding + IMAP pool + audit + verify + `get_folders` + idle drain timer |
| M1 | **Complete** | `list_mailbox`, `fetch_summaries`, `fetch_message`, `fetch_attachment`, `search_mailbox` |
| M2 | **Complete** | STDIO default transport + MCPB packaging; OAuth (issue #7) not started |
| M3 | In progress | `get_folders`, `create_folder`, `add_labels`, `mark_read`, `mark_unread` done; `get_labels`, operation log, tool result standardization in flight |
| M4–M5 | Not started | |

**Next:** Complete M3 — get_labels, operation log + revert, remaining folder/label tools.

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

### Standardized Tool Result Structure
Every tool response includes a top-level `status: ToolStatus` (`'succeeded' | 'partial' | 'failed'`).
Three wrapper types:
- `BatchToolResult<T>` — batch-mutating tools: `{ status, items: BatchItemResult<T>[] }`
- `ListToolResult<T>` — read-only array tools: `{ status, items: T[] }`
- `SingleToolResult<T>` — single-item tools: `{ status, data: T }`

Each `BatchItemResult<T>` also carries `status: ItemStatus` (`'succeeded' | 'failed'`).
Use `batchStatus(items)` utility to compute the top-level status from per-item statuses.
Read-only tools always return `status: 'succeeded'` (they throw on failure).

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

### Standardized Tool Result Structure
All tool responses include a top-level `status: ToolStatus` (`'succeeded' | 'partial' | 'failed'`).
- **Batch tools:** `BatchToolResult<T>` — `{ status, items: BatchItemResult<T>[] }` with per-item `status: ItemStatus`
- **List tools:** `ListToolResult<T>` — `{ status: 'succeeded', items: T[] }` (throw on failure)
- **Single tools:** `SingleToolResult<T>` — `{ status, data: T }`
- Use `batchStatus(items)` utility to compute top-level status from per-item results.

### groupByMailbox Pattern (`src/bridge/imap.ts`)
Returns `MailboxGroup[]` with pre-computed indices for O(n) result placement:
```typescript
interface MailboxGroup { mailbox: string; entries: Array<{ index: number; id: EmailId }> }
```
Callers use `entry.index` for result placement — never `indexOf`.

### Transport Modes
- **STDIO (default):** no flags needed; `src/stdio.ts` connects one `McpServer` to `StdioServerTransport`
- **HTTP:** `--http`; each session gets its own `McpServer` instance (created in `createHttpApp`)
- **HTTPS:** `--https`; same as HTTP but with TLS; auto-generates self-signed cert if no cert/key provided
- Transport mode is CLI-flag only — no env var (`PROTONMAIL_HTTPS` removed)
- `ImapClient` and `ImapConnectionPool` are shared singletons across all modes

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
| `server.tool()` with annotations | MCP SDK v1: the 5-arg `tool(name, desc, schema, annotations, cb)` overload is deprecated | Use `server.registerTool(name, { description, inputSchema, annotations }, cb)` instead |
| Fastify logger generic | `loggerInstance: pinoLogger` infers `AppLogger` generic; incompatible with `FastifyBaseLogger` return type | Cast: `logger as unknown as FastifyBaseLogger` |
| TC39 decorator syntax at runtime | TypeScript 6 with `target: ESNext` emits `@Decorator(...)` verbatim; Node.js 25.9.0 cannot parse it (no V8 flag enables it reliably) | Use `experimentalDecorators: true` in tsconfig — TypeScript compiles to `__decorate` helpers; rewrite decorator to legacy `(target, key, descriptor)` API |

## MCP Tools (current)

| Tool | Purpose |
|---|---|
| `get_folders` | List all mail folders with message counts, unread counts, and IMAP metadata (excludes Proton labels) |
| `create_folder` | Create a new mail folder under `Folders/` (recursive) |
| `get_labels` | List all Proton Mail labels with message counts, unread counts, and IMAP metadata |
| `list_mailbox` | Browse emails in a mailbox, newest first (paginated) |
| `fetch_summaries` | Envelope data for known UIDs (batch) |
| `fetch_message` | Text/HTML body + attachment metadata (batch, no content) |
| `fetch_attachment` | Download one attachment (base64) |
| `search_mailbox` | IMAP TEXT search with pagination |
| `move_emails` | Move batch of emails to another mailbox |
| `mark_read` | Add `\Seen` flag (batch) |
| `mark_unread` | Remove `\Seen` flag (batch) |
| `verify_connectivity` | Test IMAP connection to Proton Bridge |
| `add_labels` | Add Proton Mail labels to a batch of emails (IMAP COPY) |
| `drain_connections` | Flush all pool connections immediately |

## Verify Setup

```bash
node dist/index.js --verify \
  --bridge-username x --bridge-password y         # connectivity check (STDIO mode)

# HTTP mode testing
node dist/index.js --http \
  --bridge-username x --bridge-password y \
  --mcp-auth-token t &
curl -X POST http://127.0.0.1:3000/mcp            # → 401 (no token)
npx @modelcontextprotocol/inspector http://127.0.0.1:3000/mcp  # set Authorization header

tail -f ~/.proton-bridge-mcp/audit.jsonl | jq .   # watch audit entries (default path)
npm run package                                    # build proton-bridge-mcp.mcpb
```
