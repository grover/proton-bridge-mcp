# Architecture

## Overview

```
HTTP Client (Claude Desktop / MCP Inspector)
      │  POST/GET/DELETE /mcp
      │  Authorization: Bearer <PROTONMAIL_MCP_AUTH_TOKEN>
      ▼
┌─────────────────────────────────────────────┐
│  Fastify HTTP Server  (src/http.ts)         │
│  ─ onRequest hook: Bearer token check       │
│  ─ session map: sessionId → transport       │
│  ─ POST: create/reuse StreamableHTTP session│
│  ─ GET: SSE stream                          │
│  ─ DELETE: close session                    │
└──────────────────┬──────────────────────────┘
                   │  one McpServer per session
┌──────────────────▼──────────────────────────┐
│  McpServer  (src/server.ts)                 │
│  createMcpServer(imap, pool)                │
│  ─ 13 registered tools                      │
│  ─ created fresh per HTTP session           │
│  ─ imap + pool are shared singletons        │
└──────────────────┬──────────────────────────┘
                   ��
┌──────────────────▼──────────────────────────┐
│  ImapClient  (src/bridge/imap.ts)           │
│  ─ all methods @Audited                     │
│  ─ batches grouped by mailbox               │
│  ─ results reordered to match input order   │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  ImapConnectionPool  (src/bridge/pool.ts)   │
│  ─ min/max connections (configurable)       │
│  ─ pool version drain (no draining flag)    │
│  ─ idle drain timer (drain-to-min + empty)  │
│  ─ per-event structured logging             │
│  ─ auto-replenish to min on error/drain     │
└──────────────────┬──────────────────────────┘
                   │  TLS (rejectUnauthorized: false)
      Proton Bridge daemon
      IMAP: 127.0.0.1:1143
```

## Startup Flow

```
process.argv + env vars
      │
  loadConfig()          ─ CLI args override env vars; throws on missing required values
      │
  createLogger()        ─ pino → stderr or file
  AuditLogger()         ─ JSONL → file only
  ImapConnectionPool()  ─ start() spins up min connections
      │
  [--verify mode]       ─ verifyConnectivity() → exit 0/1
      │
  ImapClient()          ─ shared singleton
  createHttpApp()       ─ Fastify + MCP HTTP transport wiring
  app.listen()
```

## Component Responsibilities

### `src/config.ts`
Parses CLI args via `commander`, falls back to env vars (all `PROTONMAIL_*`), validates required values. Returns `AppConfig`.
Note: uses conditional spread for optional `logPath` due to `exactOptionalPropertyTypes`.

### `src/logger.ts`
Creates a `pino` logger to stderr (fd 2) or a file. Passed to Fastify via `loggerInstance` (cast to `FastifyBaseLogger` for type compatibility).

### `src/bridge/audit.ts` — `AuditLogger`
Writes `AuditEntry` JSONL to a **file only** (never stderr). Wraps operations via `audit.wrap()`.
On batch results, counts items where `result.error !== undefined` → sets `outcome: 'partial'`.

### `src/bridge/decorators.ts` — `@Audited`
TC39 Stage 3 method decorator. Constraints the class to have `audit: AuditLogger` (public field).
Wraps the decorated method body in `this.audit.wrap(operation, firstArg, fn)`.

### `src/bridge/pool.ts` — `ImapConnectionPool`
**Pool version drain pattern:**
- `#poolVersion: number` starts at 0
- Each `PoolEntry = { conn: ImapFlow, version: number }` stamped at creation
- `drain()` increments `#poolVersion`, closes available entries, waits for in-use to be released
- `release(conn)`: stale version → close + replenish; current version → return to pool or hand to waiter
- `verifyConnectivity()`: opens a throwaway connection, sends NOOP, closes it

**Idle timers (setInterval, 10 s check interval):**
- `idleDrainSecs` (default 30): closes available connections above `min` — `#drainToMin()`
- `idleTimeoutSecs` (default 300): closes all available connections + bumps pool version — `#drainToZero()`
- Timer is unref'd (won't prevent process exit); stopped in `stop()`
- `#lastActivityAt` updated on every `acquire()`

### `src/bridge/imap.ts` — `ImapClient`
All methods `@Audited`. Internal helper `#fetchByIds` groups `EmailId[]` by mailbox,
fetches each group under one `getMailboxLock`, then reassembles in input order via a `Map<"mailbox:uid", T>`.

**imapflow type gotchas:**
- `conn.mailbox` is `false | MailboxObject` — guard with `conn.mailbox !== false`
- `messageMove()` returns `CopyResponseObject | false` — `uidMap` is `Map<number,number>`, use `.get()`

**mailparser type gotcha:**
- `ParsedMail.html` is `string | false` — use `|| undefined`, not `?? undefined`

### `src/http.ts`
Creates one `McpServer` per client session (not one global instance).
Sessions keyed by `mcp-session-id` header. `reply.hijack()` before passing to transport.
`server.connect(transport)` requires a cast due to MCP SDK `exactOptionalPropertyTypes` mismatch on `onclose`.

### `src/server.ts` — `createMcpServer(imap, pool)`
Registers 13 tools. Called once per HTTP session. Tool handler pattern:
```typescript
server.tool(name, description, zodRawShape, async (args) => ({
  content: [{ type: 'text', text: JSON.stringify(await handler(args, imap)) }],
}));
```

## Type Hierarchy

```
EmailId          { uid: number, mailbox: string }
EmailAddress     { address: string, name?: string }

EmailSummary     id + messageId + from/to/cc/replyTo + subject + date + size + flags + hasAttachments
  └─ EmailMessage  + textBody + htmlBody + attachments: AttachmentMetadata[]

AttachmentMetadata  { partId, filename?, contentType, size }
AttachmentContent   { emailId, partId, filename?, contentType, data (base64), size }

MailboxBase          { name, listed, subscribed, flags: string[], specialUse?, messageCount, unreadCount, uidNext }
FolderInfo extends MailboxBase  { path, delimiter }
LabelInfo = MailboxBase
CreateFolderResult  { path, created }

── Status & Wrapper Types ──

ToolStatus          'succeeded' | 'partial' | 'failed'
ItemStatus          'succeeded' | 'failed'

BatchToolResult<T>  { status: ToolStatus, items: BatchItemResult<T>[] }
ListToolResult<T>   { status: ToolStatus, items: T[] }
SingleToolResult<T> { status: ToolStatus, data: T }

batchStatus<T>(items)  utility → ToolStatus from per-item statuses

── Batch Item Types ──

BatchItemResult<T>  { id: EmailId, status: ItemStatus, data?: T, error?: { code, message } }
  MoveResult        { fromMailbox, toMailbox, targetId? }
  FlagResult        { flagsAfter: string[] }

AddLabelsBatchResult  = BatchToolResult<AddLabelsItemData[]>
  AddLabelsItemData   { labelPath, newId?: EmailId }
```

## Tool Inventory

| Tool | Input | Output | IMAP Op |
|---|---|---|---|
| `get_folders` | — | `ListToolResult<FolderInfo>` | LIST * + STATUS (messages, unseen, uidNext) |
| `get_labels` | — | `ListToolResult<LabelInfo>` | LIST * + STATUS (messages, unseen, uidNext) |
| `create_folder` | `path` | `SingleToolResult<CreateFolderResult>` | CREATE mailbox |
| `list_mailbox` | `mailbox`, `limit`, `offset` | `ListToolResult<EmailSummary>` | SELECT + FETCH seq range, reversed |
| `fetch_summaries` | `ids: EmailId[]` | `ListToolResult<EmailSummary>` | UID FETCH envelope+flags |
| `fetch_message` | `ids: EmailId[]` | `ListToolResult<EmailMessage>` | UID FETCH source → mailparser |
| `fetch_attachment` | `id`, `partId` | `SingleToolResult<AttachmentContent>` | UID FETCH source → mailparser attachment[partId-1] |
| `search_mailbox` | `mailbox`, `query`, `limit`, `offset` | `ListToolResult<EmailSummary>` | SEARCH TEXT + UID FETCH |
| `move_emails` | `ids`, `targetMailbox` | `BatchToolResult<MoveResult>` | UID MOVE per item |
| `mark_read` | `ids` | `BatchToolResult<FlagResult>` | UID STORE +FLAGS (\\Seen) |
| `mark_unread` | `ids` | `BatchToolResult<FlagResult>` | UID STORE -FLAGS (\\Seen) |
| `verify_connectivity` | — | `SingleToolResult<{ latencyMs?, error? }>` | connect + NOOP |
| `add_labels` | `ids`, `labelNames` | `AddLabelsBatchResult` | UID COPY per item/label |
| `drain_connections` | — | `SingleToolResult<{ message }>` | pool.drain() |

## Batch Contract

1. **Input-order preserved** — result[i] ↔ input[i]
2. **Per-item errors** — `{ id, error: { code, message } }` for failed items
3. **Mailbox grouping** — IDs grouped internally; one lock per mailbox; results reordered before return
4. **Top-level failure** — connection/auth failure → tool error (not per-item)

## Authentication

`Authorization: Bearer <PROTONMAIL_MCP_AUTH_TOKEN>` on all `basePath` routes.
Checked in Fastify `onRequest` hook. Returns HTTP 401 on mismatch.

## Logging

| Stream | Destination | Format | When |
|---|---|---|---|
| App logger | stderr or `PROTONMAIL_LOG_PATH` | pino JSON | Startup, shutdown, pool events, errors |
| Audit log | `PROTONMAIL_AUDIT_LOG_PATH` | JSONL | Every IMAP operation: timestamp, op, duration, sanitized input, outcome |
| Fastify/MCP | stderr (built-in) | pino JSON | HTTP requests, framework internals |

## Session Lifecycle

```
POST /mcp (no mcp-session-id) → new sessionId = randomUUID()
                               → new StreamableHTTPServerTransport
                               → new McpServer (createMcpServer)
                               → server.connect(transport)
                               → sessions.set(sessionId, { transport })

POST /mcp (with mcp-session-id) → reuse existing transport

GET  /mcp (with mcp-session-id) → SSE stream via existing transport

DELETE /mcp                      → transport.close(), sessions.delete()
```
