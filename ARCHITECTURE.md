# Architecture

## Overview

proton-bridge-mcp is an MCP server that bridges ProtonMail to AI agents via the local Proton Bridge IMAP daemon. It exposes 15 tools for reading, searching, and organizing email through the Model Context Protocol. Three transport modes are supported: STDIO (default), HTTP, and HTTPS.

## Startup Flow

`src/index.ts` orchestrates initialization:

1. `loadConfig(process.argv)` — parse CLI args, fall back to env vars, validate
2. `createLogger(config.log)` — pino logger to stderr or file
3. `new AuditLogger(auditLogPath)` — JSONL audit log to file
4. `new ImapConnectionPool(config.bridge, config.pool, logger)` — connection pool
5. If `--verify`: `pool.start()` → `pool.verifyConnectivity()` → `pool.stop()` → exit
6. `pool.start()` — open min connections
7. `new ImapClient(pool, audit, logger)` — IMAP operations facade
8. `new OperationLog()` — in-memory ring buffer (max 100)
9. `new OperationLogInterceptor(imap, log)` — GoF Decorator wrapping ImapClient
10. Branch on transport mode:
   - **STDIO:** `runStdioServer(imap, pool, interceptor)` → register shutdown handlers
   - **HTTP/HTTPS:** `createHttpApp(imap, pool, interceptor, config.http, logger)` → `app.listen()` → register shutdown handlers

Shutdown: SIGINT/SIGTERM → close transport → `pool.stop()` → `process.exit(0)`

## STDIO Transport

```
MCP Client
  ↕ stdin/stdout
StdioServerTransport
  ↕
McpServer (single instance)
  ↕
ImapClient ──→ ImapConnectionPool ──→ Proton Bridge (IMAP)
```

One `McpServer` instance for the lifetime of the process. `ImapClient` and `ImapConnectionPool` are shared singletons.

## HTTP(S) Transport

```
MCP Client ──→ HTTP(S) + Bearer Auth
  ↕
Fastify (onRequest auth hook)
  ↕
StreamableHTTPServerTransport (per session, keyed by mcp-session-id)
  ↕
McpServer (per session, created on first POST)
  ↕
ImapClient (shared) ──→ ImapConnectionPool (shared) ──→ Proton Bridge (IMAP)
```

Each client session gets its own `McpServer` + `StreamableHTTPServerTransport`. `ImapClient` and `ImapConnectionPool` are shared across all sessions.

## Folder Structure

```
src/
├── config.ts              # CLI/env config parsing (commander)
├── logger.ts              # pino logger factory
├── index.ts               # Entry point, startup orchestration
├── server.ts              # McpServer factory, tool registration
├── stdio.ts               # STDIO transport setup
├── http.ts                # HTTP/HTTPS transport (Fastify)
├── bridge/
│   ├── imap.ts            # ImapClient — all IMAP operations
│   ├── pool.ts            # ImapConnectionPool — connection management
│   ├── audit.ts           # AuditLogger — JSONL audit trail
│   ├── decorators.ts      # @Audited, @Tracked, @Irreversible decorators
│   ├── errors.ts          # IMAP error types
│   ├── operation-log.ts   # OperationLog — in-memory ring buffer
│   ├── operation-log-interceptor.ts  # OperationLogInterceptor — GoF Decorator
│   └── index.ts           # Barrel export
├── tools/
│   ├── get-folders.ts     # One file per tool handler
│   ├── ...                # (15 tool files total)
│   └── index.ts           # Barrel export
└── types/
    ├── email.ts           # EmailId, EmailSummary, EmailMessage, etc.
    ├── config.ts          # AppConfig, McpHttpConfig, PoolConfig, etc.
    ├── audit.ts           # AuditEntry
    ├── operations.ts      # BatchToolResult, ListToolResult, SingleToolResult, ReversalSpec
    ├── mail-ops.ts        # ReadOnlyMailOps, MutatingMailOps interfaces
    └── index.ts           # Barrel export
```

## Component Responsibilities

### `src/config.ts`
Parses CLI args via `commander`, falls back to env vars (all `PROTONMAIL_*`), validates required values. Returns `AppConfig`.
Note: uses conditional spread for optional `logPath` due to `exactOptionalPropertyTypes`.

### `src/logger.ts`
Creates a `pino` logger to stderr (fd 2) or a file. Passed to Fastify via `loggerInstance` (cast to `FastifyBaseLogger` for type compatibility).

### `src/bridge/audit.ts` — `AuditLogger`
JSONL audit trail to file (never stderr). See [docs/impl/auditing.md](docs/impl/auditing.md).

### `src/bridge/decorators.ts` — `@Audited`, `@Tracked`, `@Irreversible`
Method decorators for audit logging, operation tracking, and irreversible-operation log clearing. See [docs/impl/auditing.md](docs/impl/auditing.md) and [docs/impl/operation-log-revert.md](docs/impl/operation-log-revert.md).

### `src/bridge/operation-log.ts` + `src/bridge/operation-log-interceptor.ts`
In-memory operation log (ring buffer, configurable max size) and GoF Decorator interceptor for tracking mutating operations and executing reversals. See [docs/impl/operation-log-revert.md](docs/impl/operation-log-revert.md).

### `src/bridge/pool.ts` — `ImapConnectionPool`
Manages pooled IMAP connections with version-based drain, idle timers, and automatic replenishment. See [docs/impl/connection-pool.md](docs/impl/connection-pool.md).

### `src/bridge/imap.ts` — `ImapClient`
All methods `@Audited`. Uses `groupByMailbox` to minimize lock acquisitions across batch operations.
See [docs/impl/mailbox-locking.md](docs/impl/mailbox-locking.md) for locking patterns and [docs/IMAP.md](docs/IMAP.md) for type gotchas.

### `src/http.ts`
Creates one `McpServer` per client session (not one global instance).
Sessions keyed by `mcp-session-id` header. `reply.hijack()` before passing to transport.
`server.connect(transport)` requires a cast due to MCP SDK `exactOptionalPropertyTypes` mismatch on `onclose`.

### `src/server.ts` — `createMcpServer(readOps, pool, mutOps)`
Registers 16 tools. Called once per HTTP session. Parameters are interfaces (`ReadOnlyMailOps`, `MutatingMailOps`), not concrete classes. Tool handler pattern:
```typescript
server.tool(name, description, zodRawShape, async (args) => ({
  content: [{ type: 'text', text: JSON.stringify(await handler(args, ops)) }],
}));
```

## Type Hierarchy

```
EmailId          { uid: number, mailbox: string }
  formatEmailId(id) → "Mailbox:UID"       (tool output — JSON.stringify replacer in toText())
  parseEmailId(str) → EmailId             (tool input — splits on last colon)
  isEmailId(value)  → type guard          (duck-type: exactly 2 keys, uid + mailbox)

EmailAddress     { address: string, name?: string }

EmailSummary     id + messageId + from/to/cc/replyTo + subject + date + size + flags + hasAttachments
  └─ EmailMessage  + textBody + htmlBody + attachments: AttachmentMetadata[]

AttachmentMetadata  { partId, filename?, contentType, size }
AttachmentContent   { emailId, partId, filename?, contentType, data (base64), size }

MailboxBase          { name, listed, subscribed, flags: string[], specialUse?, messageCount, unreadCount, uidNext }
FolderInfo extends MailboxBase  { path, delimiter }
LabelInfo = MailboxBase
CreateMailboxResult  { path, created }
CreateFolderResult = CreateMailboxResult
CreateLabelResult   { name, created }
DeleteFolderResult  { path }

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

── Operation Log Types ──

ReversalSpec         discriminated union: move_batch | mark_read | mark_unread | create_folder | add_labels
OperationRecord      { id, tool, reversal: ReversalSpec, timestamp }
RevertStepResult     { operationId, tool, status: ToolStatus, error? }
RevertResult         { stepsTotal, stepsSucceeded, stepsFailed, steps: RevertStepResult[] }

── Interface Types ──

ReadOnlyMailOps      interface for read-only tool handlers (getFolders, getLabels, listMailbox, etc.)
MutatingMailOps      interface for mutating tool handlers (moveEmails, markRead, revertOperations, etc.)
```

## Tool Inventory

See [docs/tools/README.md](docs/tools/README.md) for the complete tool reference (schemas, annotations, examples). The server registers 15 tools in `src/server.ts`.

## Batch Contract

See [docs/IMAP.md](docs/IMAP.md) for the full batch operations contract and IMAP implementation patterns.

## Authentication

`Authorization: Bearer <PROTONMAIL_MCP_AUTH_TOKEN>` on all `basePath` routes.
Checked in Fastify `onRequest` hook. Returns HTTP 401 on mismatch.

## Logging

| Stream | Destination | Format | When |
|---|---|---|---|
| App logger | stderr or `PROTONMAIL_LOG_PATH` | pino JSON | Startup, shutdown, pool events, errors |
| Audit log | `PROTONMAIL_AUDIT_LOG_PATH` | JSONL | Every IMAP operation — see [docs/impl/auditing.md](docs/impl/auditing.md) |
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
