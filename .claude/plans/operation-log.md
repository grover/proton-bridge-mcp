# Plan: Operation Log and `revert_operations` Tool (#21)

## Architecture

```
MCP Tool handler
  → OperationLogInterceptor (@Tracked, records reversal)
    → ImapClient (@Audited, does IMAP work)
```

ImapClient has **zero awareness** of the log. Read-only tools call ImapClient directly.

## Types — `src/types/operations.ts` (existing file, add to it)

```typescript
export type ReversalSpec =
  | { type: 'move_batch';    moves:   Array<{ from: EmailId; to: EmailId }> }
  | { type: 'mark_read';     ids:     EmailId[] }    // reversal: call markUnread
  | { type: 'mark_unread';   ids:     EmailId[] }    // reversal: call markRead
  | { type: 'create_folder'; path:    string }
  | { type: 'create_label';  path:    string }
  | { type: 'delete_label';  path:    string; emails: EmailId[] }
  | { type: 'add_labels';    entries: Array<{ original: EmailId; labelPath: string; copy: EmailId }> }
  | { type: 'remove_labels'; entries: Array<{ original: EmailId; labelPath: string }> };

export interface OperationRecord {
  id:        number;
  tool:      string;
  reversal:  ReversalSpec;
  timestamp: string;   // ISO 8601
}

export interface RevertStepResult {
  operationId: number;
  tool:        string;
  status:      'success' | 'partial' | 'error';
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
export class OperationLog {
  #seq = 0;
  #ring: OperationRecord[] = [];  // max 100, FIFO eviction

  push(record: Omit<OperationRecord, 'id'>): number   // ++#seq, returns id
  getFrom(operationId: number): OperationRecord[]      // id >= operationId, most-recent-first
  has(operationId: number): boolean
  remove(operationId: number): void                    // single record (after successful revert)
  clear(): void                                        // wipe all (@Irreversible only)
}
```

- Monotonic `#seq`, never wraps
- FIFO eviction when > 100 entries
- `remove()` splices single record — for successful reverts
- `clear()` empties entire ring — only for `@Irreversible`

## Decorators — `src/bridge/decorators.ts` (add to existing)

Both use legacy `experimentalDecorators` API (same as `@Audited`).

### `@Tracked(toolName, buildReversal)`

- After method succeeds, calls `buildReversal(args, result)` → `ReversalSpec`
- Calls `this.log.push({ tool, reversal, timestamp })`
- Extends result: object → `{ ...result, operationId }`, array → `{ operationId, items: result }`
- Class must have `log: OperationLog` as public property

### `@Irreversible`

- After method succeeds, calls `this.log.clear()`
- Used for future `delete_folder`

## Interceptor — `src/bridge/operation-log-interceptor.ts` (new)

```typescript
export class OperationLogInterceptor {
  readonly log: OperationLog;    // public for decorator access
  readonly #imap: ImapClient;

  constructor(imap: ImapClient, log: OperationLog)

  @Tracked('move_emails', buildMoveReversal)
  async moveEmails(ids, targetMailbox): Promise<MoveBatchResult>
  // Delegates to #imap.moveEmails(), builds reversal:
  // { type: 'move_batch', moves: successItems.map(i => ({ from: i.data.targetId, to: i.id })) }

  @Tracked('mark_read', buildMarkReadReversal)
  async markRead(ids): Promise<FlagBatchResult>
  // { type: 'mark_read', ids: successIds }  — reversal calls markUnread

  @Tracked('mark_unread', buildMarkUnreadReversal)
  async markUnread(ids): Promise<FlagBatchResult>
  // { type: 'mark_unread', ids: successIds }  — reversal calls markRead

  async revertOperations(operationId: number): Promise<RevertResult>
  // 1. log.has(operationId) → false? UNKNOWN_OPERATION_ID
  // 2. log.getFrom(operationId) → most-recent-first
  // 3. For each: #executeReversal, on success: log.remove(id)
  // 4. Return { stepsTotal, stepsSucceeded, stepsFailed, steps }

  #executeReversal(spec: ReversalSpec): Promise<void>
  // 'move_batch' → #imap.moveEmails (per move)
  // 'mark_read'  → #imap.setFlag(ids, '\\Seen', false)  (i.e. markUnread)
  // 'mark_unread' → #imap.setFlag(ids, '\\Seen', true)  (i.e. markRead)
  // other types → throw 'not yet implemented'
  // NOTE: All reversals execute against ImapClient directly, never the interceptor
}
```

Reversals call `#imap` directly — NOT tracked.

## Tool — `src/tools/revert-operations.ts` (new)

```typescript
export const revertOperationsSchema = {
  operationId: z.number().int().positive(),
};

export async function handleRevertOperations(
  args: { operationId: number },
  interceptor: OperationLogInterceptor,
): Promise<RevertResult>
```

## Wiring — `src/server.ts`

- Signature: `createMcpServer(imap, pool, interceptor)` 
- Mutating tools call interceptor (not imap directly)
- Register `revert_operations` with `DESTRUCTIVE` annotation
- Read-only tools unchanged

## Entry Points — `src/index.ts`, `src/stdio.ts`, `src/http.ts`

- Instantiate `OperationLog` and `OperationLogInterceptor`
- Thread interceptor to `createMcpServer`

## Files Summary

| File | Action |
|---|---|
| `src/types/operations.ts` | Add ReversalSpec, OperationRecord, RevertStepResult, RevertResult |
| `src/bridge/operation-log.ts` | **New** — OperationLog class |
| `src/bridge/decorators.ts` | Add @Tracked, @Irreversible |
| `src/bridge/operation-log-interceptor.ts` | **New** — GoF Decorator |
| `src/tools/revert-operations.ts` | **New** — tool handler |
| `src/tools/index.ts` | Add export |
| `src/server.ts` | Accept interceptor, rewire mutating tools, register revert_operations |
| `src/index.ts` | Instantiate log + interceptor |
| `src/stdio.ts` | Thread interceptor |
| `src/http.ts` | Thread interceptor |
| CLAUDE.md, ARCHITECTURE.md, CHANGELOG.md | Documentation |

## Key Constraints

- ImapClient has ZERO awareness of the log
- Reversals are NOT tracked (no infinite recursion)
- Ring buffer max 100, FIFO eviction, monotonic IDs
- Revert removes only successfully reverted records
- `clear()` only for `@Irreversible`
- `ReversalSpec` includes all 7 future variants; `#executeReversal` handles `move_batch`, `mark_read`, and `mark_unread` now
- All reversals execute against `ImapClient` directly, never the interceptor

## Smoke Test Scenarios

1. **Move + revert:** `move_emails` 2 emails from INBOX to Folders/Test → verify moved → `revert_operations(operationId)` → verify emails back in INBOX
2. **Mark read + revert:** `mark_read` on 2 unread emails → verify \Seen flag set → `revert_operations(operationId)` → verify \Seen removed
3. **Mark unread + revert:** `mark_unread` on 2 read emails → verify \Seen removed → `revert_operations(operationId)` → verify \Seen restored
4. **Chain revert:** `move_emails` → `mark_read` → `revert_operations(moveOperationId)` → both operations reversed in reverse chronological order
5. **Unknown operation ID:** `revert_operations(99999)` → returns `UNKNOWN_OPERATION_ID` error, no changes made
6. **operationId in responses:** Every `move_emails`, `mark_read`, `mark_unread` response includes `operationId` field
7. **Ring buffer eviction:** Perform 101 operations → verify first operation ID returns `UNKNOWN_OPERATION_ID`
