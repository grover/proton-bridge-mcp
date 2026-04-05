# EDD: Operation Log and `revert_operations` Tool

**Issue:** [#21 — M3: Operation log and revert_operations tool](https://github.com/grover/proton-bridge-mcp/issues/21)
**PRD:** [M3 Folders, Labels & Revert](m3-folders-labels-revert.md)

## Context

Add an in-memory operation log that tracks the last 100 mutating operations with sequential IDs, and a `revert_operations` tool that unwinds a range of operations in reverse chronological order.

The operation log is orthogonal to the existing JSONL audit logger — it is in-memory only and resets on restart. The core constraint: **ImapClient has ZERO awareness of the log.** All coupling lives in a new `OperationLogInterceptor` (GoF Decorator pattern) that wraps ImapClient.

## Architecture

```
MCP Client
  │
  ▼
McpServer (src/server.ts)
  │
  ├── read-only tools ──────────────► ImapClient (@Audited)
  │
  ├── mutating tools ──► OperationLogInterceptor (@Tracked)
  │                           │
  │                           │ log: OperationLog (ring buffer, max 100)
  │                           │
  │                           └── delegates to ──► ImapClient (@Audited)
  │
  └── revert_operations ──► interceptor.revertOperations()
                                │
                                └── reversal calls ──► ImapClient (directly, NOT interceptor)
```

**Instantiation chain** (`src/index.ts`):
```
config → logger → audit → pool → ImapClient(pool, audit, logger)
                                      │
                                  OperationLog()
                                      │
                                  OperationLogInterceptor(imap, log)
                                      │
                                  createMcpServer(imap, pool, interceptor)
```

## Key Design Decisions

### Result wrapping absorbed by interceptor

Current tool handlers wrap raw ImapClient results (e.g., `moveEmails` returns an array, handler wraps to `{ status, items }`). The interceptor absorbs this wrapping — its methods return the final tool result shape (`BatchToolResult<T>` or `SingleToolResult<T>`). `@Tracked` then adds `operationId` to that object. Tool handlers become trivial pass-throughs.

`operationId` appears in JSON responses as a top-level field (e.g., `{ status, items, operationId }`) without TypeScript declaring it — a runtime addition serialized via `JSON.stringify`.

### Reversal calls bypass the interceptor

All reversals in `#executeReversal` call `ImapClient` directly, never the interceptor. This prevents infinite recursion and ensures revert operations don't create new log entries.

## Types — `src/types/operations.ts`

```typescript
export type ReversalSpec =
  | { type: 'move_batch';    moves:   Array<{ from: EmailId; to: EmailId }> }
  | { type: 'mark_read';     ids:     EmailId[] }
  | { type: 'mark_unread';   ids:     EmailId[] }
  | { type: 'create_folder'; path:    string }
  | { type: 'add_labels';    entries: Array<{ original: EmailId; labelPath: string; copy: EmailId }> };

export interface OperationRecord {
  id:        number;
  tool:      string;
  reversal:  ReversalSpec;
  timestamp: string;   // ISO 8601
}

export type RevertStepStatus = 'success' | 'partial' | 'error';

export interface RevertStepResult {
  operationId: number;
  tool:        string;
  status:      RevertStepStatus;
  error?:      string;
}

export interface RevertResult {
  stepsTotal:     number;
  stepsSucceeded: number;
  stepsFailed:    number;
  steps:          RevertStepResult[];
}
```

## OperationLog — `src/bridge/operation-log.ts` (new)

```typescript
class OperationLog {
  #seq  = 0;
  #ring: OperationRecord[] = [];  // max 100, FIFO eviction

  push(record: Omit<OperationRecord, 'id'>): number   // ++#seq, returns id
  getFrom(operationId: number): OperationRecord[]      // id >= operationId, most-recent-first
  has(operationId: number): boolean
  remove(operationId: number): void                    // splice single record
  clear(): void                                        // wipe all
  get size(): number                                   // for testing
}
```

- Monotonic `#seq`, never wraps (safe to 2^53)
- FIFO eviction when > 100 entries
- `getFrom` returns most-recent-first for reverse-chronological revert

## Decorators — `src/bridge/decorators.ts`

### `@Tracked(toolName, buildReversal)`

- Calls original method first (delegates to ImapClient via interceptor body)
- On success, calls `buildReversal(args, result)` → `ReversalSpec | null`
- If non-null: pushes to `this.log`, extends result with `{ ...result, operationId }`
- If null (e.g., `createFolder` when `created === false`): returns result unmodified
- On throw: exception propagates, no log entry
- Requires class to have `log: OperationLog` as public property

### `@Irreversible`

- Calls original method, then `this.log.clear()` on success
- Reserved for future `delete_folder` tool
- On throw: log NOT cleared

## OperationLogInterceptor — `src/bridge/operation-log-interceptor.ts` (new)

### Tracked methods

| Method | ImapClient call | Returns | Reversal type |
|--------|----------------|---------|---------------|
| `moveEmails(ids, target)` | `imap.moveEmails` | `BatchToolResult<MoveResult>` | `move_batch`: succeeded items' `targetId → original id` |
| `markRead(ids)` | `imap.setFlag(ids, '\\Seen', true)` | `BatchToolResult<FlagResult>` | `mark_read`: succeeded items' EmailIds |
| `markUnread(ids)` | `imap.setFlag(ids, '\\Seen', false)` | `BatchToolResult<FlagResult>` | `mark_unread`: succeeded items' EmailIds |
| `createFolder(path)` | `imap.createFolder` | `SingleToolResult<CreateFolderResult>` | `create_folder`: path (null if `created === false`) |
| `addLabels(ids, names)` | `imap.addLabels` | `AddLabelsBatchResult` | `add_labels`: `[{original, labelPath, copy}]` |

### Reversal execution (`#executeReversal`)

| Reversal type | Action |
|--------------|--------|
| `move_batch` | For each move: `imap.moveEmails([from], to.mailbox)` |
| `mark_read` | `imap.setFlag(ids, '\\Seen', false)` — remove Seen |
| `mark_unread` | `imap.setFlag(ids, '\\Seen', true)` — add Seen |
| `create_folder` | `imap.deleteFolder(path)` |
| `add_labels` | For each entry: `imap.deleteEmails([copy])` |

### `revertOperations(operationId)`

1. `log.has(operationId)` → false? throw `UNKNOWN_OPERATION_ID`
2. `log.getFrom(operationId)` → most-recent-first
3. For each: `#executeReversal`, on success: `log.remove(id)`
4. Continue on error (best-effort)
5. Return `{ stepsTotal, stepsSucceeded, stepsFailed, steps }`

## ImapClient additions — `src/bridge/imap.ts`

Two new methods for reversal support only (not exposed as MCP tools):

- `@Audited('delete_folder') deleteFolder(path)` → `{ path: string }` — calls `conn.mailboxDelete(path)`
- `@Audited('delete_emails') deleteEmails(ids)` → `void` — groups by mailbox, calls `conn.messageDelete()` per UID

## Tool handler changes

All 5 mutating handlers change from `(args, imap: ImapClient)` to `(args, interceptor: OperationLogInterceptor)` and become trivial pass-throughs.

## New tool — `src/tools/revert-operations.ts`

- Schema: `{ operationId: z.number().int().positive() }`
- Handler: delegates to `interceptor.revertOperations(args.operationId)`
- Annotation: `DESTRUCTIVE`
- Category: `destructive`

## Wiring changes

| File | Change |
|------|--------|
| `src/server.ts` | `createMcpServer(imap, pool, interceptor)` — rewire 5 mutating tools, register `revert_operations` |
| `src/index.ts` | Instantiate `OperationLog` + `OperationLogInterceptor`, thread to transports |
| `src/stdio.ts` | `runStdioServer(imap, pool, interceptor)` — thread to `createMcpServer` |
| `src/http.ts` | `createHttpApp(imap, pool, interceptor, config, logger)` — thread to `createMcpServer` |

## File Summary

| File | Action |
|------|--------|
| `src/types/operations.ts` | Add ReversalSpec, OperationRecord, RevertStepResult, RevertResult |
| `src/bridge/operation-log.ts` | **New** — OperationLog class |
| `src/bridge/decorators.ts` | Add @Tracked, @Irreversible |
| `src/bridge/operation-log-interceptor.ts` | **New** — Interceptor class |
| `src/bridge/imap.ts` | Add deleteFolder, deleteEmails |
| `src/tools/revert-operations.ts` | **New** — tool handler + schema |
| `src/tools/move-emails.ts` | Accept interceptor instead of imap |
| `src/tools/mark-read.ts` | Accept interceptor instead of imap |
| `src/tools/mark-unread.ts` | Accept interceptor instead of imap |
| `src/tools/create-folder.ts` | Accept interceptor instead of imap |
| `src/tools/add-labels.ts` | Accept interceptor instead of imap |
| `src/tools/index.ts` | Add revert-operations export |
| `src/server.ts` | Add interceptor param, rewire mutating tools, register revert_operations |
| `src/index.ts` | Instantiate log + interceptor |
| `src/stdio.ts` | Thread interceptor |
| `src/http.ts` | Thread interceptor |

## Unit Test Plan

### `src/bridge/operation-log.test.ts`

| # | Test |
|---|------|
| 1 | push returns monotonically increasing IDs |
| 2 | has returns true for existing, false for non-existing IDs |
| 3 | has returns false for evicted IDs |
| 4 | getFrom returns records most-recent-first |
| 5 | getFrom returns empty for unknown ID |
| 6 | remove splices single record |
| 7 | remove is no-op for unknown ID |
| 8 | clear empties the log |
| 9 | FIFO eviction at 101 entries |
| 10 | IDs continue incrementing after eviction |
| 11 | getFrom after remove skips removed records |

### `src/bridge/decorators.test.ts`

| # | Test |
|---|------|
| 1 | @Tracked adds operationId to successful result |
| 2 | @Tracked pushes record to log |
| 3 | @Tracked skips when buildReversal returns null |
| 4 | @Tracked does not catch exceptions (no log entry) |
| 5 | @Tracked passes correct args/result to buildReversal |
| 6 | @Tracked preserves original result properties |
| 7 | @Irreversible clears log on success |
| 8 | @Irreversible does not clear log on throw |

### `src/bridge/operation-log-interceptor.test.ts`

| # | Test |
|---|------|
| 1 | Each tracked method delegates to imap and returns operationId |
| 2 | Each tracked method builds correct reversal spec |
| 3 | Partial failures: reversal only includes succeeded items |
| 4 | createFolder not tracked when created === false |
| 5 | revertOperations throws UNKNOWN_OPERATION_ID |
| 6 | revertOperations reverses each type correctly |
| 7 | revertOperations processes in reverse chronological order |
| 8 | revertOperations removes only successfully reverted records |
| 9 | revertOperations continues on error (best-effort) |
| 10 | revertOperations returns correct summary counts |
| 11 | Revert calls imap directly (no new log entries created) |

### `src/tools/revert-operations.test.ts`

| # | Test |
|---|------|
| 1 | Delegates to interceptor.revertOperations |
| 2 | Propagates UNKNOWN_OPERATION_ID error |

## Key Design Decision: Idempotency and No-Op Handling

IMAP flag operations are idempotent — adding a flag that already exists or removing one that doesn't both succeed silently. `setFlag` fetches `flagsBefore` for all emails before modifying, skips emails already in the target state, and returns both `flagsBefore` and `flagsAfter` in `FlagResult`. `buildFlagReversal` compares before/after to only include emails whose flags actually changed.

When `buildReversal` returns `null` (all no-ops, or tools without real reversal support like `create_folder`), `@Tracked` records a `{ type: 'noop' }` entry. This ensures `operationId` is **always present** in every mutating tool response — a stable response shape for LLM clients. Reverting a noop is harmless (`stepsSucceeded: 1`).

## Smoke Tests

| # | Scenario | Expected |
|---|----------|----------|
| 1 | `mark_read` on unread emails | `operationId` present, `flagsBefore`/`flagsAfter` show change |
| 2 | Revert mark_read | `\Seen` removed, `stepsSucceeded: 1` |
| 3 | `mark_read` on already-read (no-op) | `operationId` present, revert is harmless |
| 4 | `mark_unread` on read emails | `operationId` present |
| 5 | Revert mark_unread | `\Seen` restored, `stepsSucceeded: 1` |
| 6 | `mark_unread` on already-unread (no-op) | `operationId` present, revert is harmless |
| 7 | `move_emails` to test folder | `operationId` present |
| 8 | Revert move | Email back in original mailbox |
| 9 | Chain: `mark_read` → `move_emails` → revert from mark_read ID | All steps succeed; email back in original mailbox AND marked unread (fixed in [#45](https://github.com/grover/proton-bridge-mcp/issues/45)) |
| 10 | Unknown operation ID | `UNKNOWN_OPERATION_ID` error |
| 11 | `create_folder` | `operationId` present (noop reversal) |
| 12 | `add_labels` | `operationId` present (noop reversal) |
| 13 | `create_folder` existing path | **Bug:** throws "Command failed" instead of `created: false` ([#44](https://github.com/grover/proton-bridge-mcp/issues/44)) |

## Implementation Order

1. **Skeleton**: types → OperationLog → decorators → interceptor → ImapClient methods → tool handler → wiring — `npm run build` passes
2. **Tests**: Write all unit tests — all RED
3. **Red-green-refactor** (bottom-up): OperationLog → decorators → interceptor tracked methods → ImapClient methods → revertOperations → tool handler → wiring
4. **Documentation**: CLAUDE.md, ARCHITECTURE.md, CHANGELOG.md
