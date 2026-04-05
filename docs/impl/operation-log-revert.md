# Operation Log and `revert_operations`

`src/bridge/operation-log.ts`, `src/bridge/operation-log-interceptor.ts`, `src/bridge/decorators.ts` (`@Tracked`, `@Irreversible`)

## Why This Exists

AI agents operating on a mailbox are powerful but fallible. A single misinterpreted instruction can move dozens of emails to the wrong folder or mark an entire thread as read. Without a revert mechanism, the user must manually undo every change — or worse, may not notice the damage until it's too late.

The operation log exists so that a single `revert_operations` call can undo a chain of mutations cheaply. This is especially important for LLM token efficiency: rather than replaying the original operations in reverse (which requires the LLM to remember every detail of what it did), the agent just passes back the `operationId` it received from any mutating tool call. The server handles the rest. A revert that might cost hundreds of tokens to plan and execute manually becomes a single small tool call.

## Goals

1. **One-call undo.** Any tracked mutation returns an `operationId`. Passing that ID to `revert_operations` undoes everything from that point forward in reverse chronological order.
2. **Zero coupling to ImapClient.** The IMAP layer has no awareness of the log. All tracking logic lives in the interceptor and decorators, keeping the IMAP code focused on protocol concerns.
3. **Transparent to existing tools.** Read-only tools are completely unaffected. Mutating tools gain an `operationId` field in their responses but are otherwise unchanged.
4. **Best-effort resilience.** If one step in a multi-step revert fails (e.g., a moved email was subsequently deleted by the user), the revert continues with remaining steps and reports per-step status.

## Design Choices and Tradeoffs

### In-memory only, no persistence

The log resets on process restart. This is deliberate:

- **Simplicity.** No file I/O, no serialization format, no migration path.
- **Privacy.** The log contains `EmailId` references (mailbox + UID). Persisting these to disk would create a durable record of which emails were touched. In-memory means the data is gone when the process stops.
- **Correctness after restart.** IMAP UIDs can change after server-side operations (expunge, compaction). A persisted log with stale UIDs would produce incorrect reversals. Starting fresh is safer than risking silent data corruption.

The tradeoff: if the server crashes mid-session, all revert history is lost. This is acceptable because the audit log (`@Audited`) provides a durable record for forensic purposes — the operation log is an ergonomic convenience, not a durability guarantee.

### Ring buffer with FIFO eviction

The log holds at most 100 entries (`MAX_LOG_SIZE`). When full, the oldest entry is evicted. This bounds memory usage without configuration complexity. The constant is exported from `src/bridge/operation-log.ts` for testability.

100 was chosen because interactive AI sessions rarely accumulate more than a few dozen mutations before the user reviews results. Operations that fall off the ring buffer are no longer revertible; the agent receives `UNKNOWN_OPERATION_ID` if it tries.

### GoF Decorator pattern (interceptor), not subclass or middleware

The `OperationLogInterceptor` wraps `ImapClient` without modifying it. Alternative approaches considered:

- **Subclass ImapClient:** Would work but couples tracking to the IMAP implementation. Adding a new ImapClient method that shouldn't be tracked would require remembering to not-override it.
- **Middleware/hook system:** More flexible but over-engineered for the current scope. The interceptor is a single class with a clear interface.
- **Decorator pattern:** Clean separation. ImapClient can be tested, extended, and refactored without touching tracking logic. The interceptor can be tested with a mock ImapClient.

### Interface segregation at the tool handler boundary

Tool handlers depend on `ReadOnlyMailOps` and `MutatingMailOps` interfaces (`src/types/mail-ops.ts`), not on concrete `ImapClient` or `OperationLogInterceptor` classes. This means:

- Tool handlers are testable with simple mock objects.
- The wiring decision (which concrete class satisfies which interface) lives in `src/index.ts` only.
- A future refactoring of the interceptor or ImapClient doesn't ripple through tool handler imports.

### Reversal specs capture only succeeded items

When a batch operation partially fails (e.g., 3 emails moved, 1 failed), the `ReversalSpec` records only the 3 that succeeded. Reverting that operation moves only those 3 back. The failed item was never mutated, so there's nothing to revert.

### Reversals bypass the interceptor

When `revertOperations` executes reversals, it calls `ImapClient` directly — not the interceptor. This prevents:

- **Infinite recursion:** A revert creating new log entries that would themselves need reverting.
- **Log pollution:** Revert operations are transient housekeeping, not user-initiated mutations.

The audit logger (`@Audited` on ImapClient) still captures the underlying IMAP operations, so there is a durable record of what the revert did.

## Architecture

```
MCP Client
  │
  ▼
McpServer (src/server.ts)
  │
  ├── read-only tools ──► ReadOnlyMailOps ──► ImapClient (@Audited)
  │                                               │
  ├── mutating tools ───► MutatingMailOps ──► OperationLogInterceptor
  │                                               │          │
  │                                   @Tracked ───┘    OperationLog
  │                                               │    (ring buffer)
  │                                               ▼
  │                                          ImapClient (@Audited)
  │
  └── revert_operations ► MutatingMailOps ──► interceptor.revertOperations()
                                                  │
                                                  └── ImapClient (directly)
```

### Components

**`OperationLog`** (`src/bridge/operation-log.ts`)

A ring buffer holding up to `MAX_LOG_SIZE` (100) `OperationRecord` entries. Each record has a monotonically increasing `id` (never wraps — safe to 2^53), the `tool` name, a `ReversalSpec` describing how to undo the operation, and an ISO 8601 `timestamp`.

| Method | Purpose |
|---|---|
| `push(record)` → `number` | Append a record, evict oldest if over capacity, return the assigned ID |
| `getFrom(id)` → `OperationRecord[]` | All records from `id` to most recent, in reverse chronological order |
| `has(id)` → `boolean` | True if the ID is still in the buffer |
| `remove(id)` | Splice out a single record (after successful revert of that step) |
| `clear()` | Wipe the entire buffer (called by `@Irreversible`) |

**`OperationLogInterceptor`** (`src/bridge/operation-log-interceptor.ts`)

Wraps `ImapClient` for mutating operations. Each tracked method delegates to `ImapClient`, wraps the raw result into the tool result shape (`BatchToolResult` or `SingleToolResult`), then the `@Tracked` decorator builds a `ReversalSpec` and pushes it to the log.

Currently tracked: `move_emails`, `mark_read`, `mark_unread`.
Not yet tracked: `create_folder`, `add_labels` (require `deleteFolder`/`deleteEmails` — see TODO.md).

The interceptor also owns `revertOperations()`, which retrieves records from the log, executes each reversal against `ImapClient` directly, and removes successfully reverted records.

**Decorators** (`src/bridge/decorators.ts`)

| Decorator | Applied to | Requires | Behavior |
|---|---|---|---|
| `@Tracked(tool, buildReversal)` | Interceptor methods | `log: OperationLog` | After success: build `ReversalSpec`, push to log, extend result with `operationId`. If `buildReversal` returns `null`, skip tracking. |
| `@Irreversible` | Future `deleteFolder` | `log: OperationLog` | After success: `log.clear()`. All prior operation IDs become unknown. |

Both use TypeScript's `experimentalDecorators` API, same as the existing `@Audited` decorator on `ImapClient`.

**`ReversalSpec`** (`src/types/operations.ts`)

A discriminated union describing how to undo each operation type:

| Variant | Captures | Reversal action |
|---|---|---|
| `move_batch` | `{ from: EmailId, to: EmailId }[]` | Move each email from current location back to original mailbox (batched by target) |
| `mark_read` | `EmailId[]` | Remove `\Seen` flag |
| `mark_unread` | `EmailId[]` | Add `\Seen` flag |
| `create_folder` | `path: string` | Delete the folder (not yet implemented) |
| `add_labels` | `{ original, labelPath, copy }[]` | Delete the copy UIDs from label folders (not yet implemented) |

## Requirements for Future Tool Implementations

When adding a new mutating tool that should be revertible:

1. **Define a `ReversalSpec` variant.** Add a new case to the `ReversalSpec` union in `src/types/operations.ts`. Capture enough state to undo the operation — typically the IDs of affected items and their original state.

2. **Write a `buildReversal` function.** This receives the method arguments and the tool result, and returns the `ReversalSpec` (or `null` to skip tracking). Only include succeeded items. Place it in `src/bridge/operation-log-interceptor.ts`.

3. **Add the method to `OperationLogInterceptor`.** Delegate to `ImapClient`, wrap the result, and apply `@Tracked(toolName, buildReversal)`.

4. **Implement the reversal in `#executeReversal`.** Add a `case` to the switch statement. Call `ImapClient` methods directly (not the interceptor).

5. **Update `MutatingMailOps` interface.** Add the method signature to `src/types/mail-ops.ts`.

6. **Wire it up.** The tool handler imports `MutatingMailOps`, `server.ts` passes the interceptor.

For **irreversible** operations (e.g., `delete_folder` which destroys data that cannot be recovered):

1. Apply `@Irreversible` instead of `@Tracked`. This clears the log after success — all prior operation IDs become `UNKNOWN_OPERATION_ID`.
2. Document clearly that this operation is irreversible and will invalidate all pending operation IDs.

### Missing COPYUID and reversal correctness

IMAP `MOVE` and `COPY` commands may return a `COPYUID` response mapping source UIDs to target UIDs. If the server omits this (Proton Bridge typically provides it, but it's not guaranteed by the protocol), the `targetId` field will be `undefined`. A `move_batch` reversal with a missing `targetId` is silently excluded from the reversal — the email cannot be moved back because we don't know its new UID. This is a known limitation documented in the `MoveResult` type.

## Configuration

The operation log has no external configuration. `MAX_LOG_SIZE` is a compile-time constant (100). This is intentional:

- The feature targets interactive AI sessions, not bulk automation.
- 100 operations is generous for any reasonable session.
- Making it configurable would add CLI flags and validation for a parameter that almost no one would change.

If a future use case requires a larger buffer, change the constant in `src/bridge/operation-log.ts` and update the corresponding test.

## Safety and Privacy

### Privacy

- **In-memory only.** The log contains `EmailId` references (mailbox path + UID) and operation metadata. This data exists only in process memory and is gone when the server stops.
- **No email content.** The log stores structural identifiers only — it never captures subjects, bodies, senders, or any PII from the email itself.
- **Audit log separation.** The JSONL audit log (`@Audited`) is a separate system with its own privacy controls. The operation log does not write to disk.

### Safety guardrails

- **Ring buffer bounds memory.** A runaway agent issuing thousands of mutations can't cause unbounded memory growth. The buffer is fixed at 100 entries.
- **Reversals are best-effort, not transactional.** If step 3 of a 5-step revert fails, steps 4 and 5 (which were reverted before step 3 in reverse order) remain reverted. The response clearly reports per-step status so the agent can assess the outcome.
- **No recursive tracking.** Reversal operations bypass the interceptor entirely, preventing feedback loops where a revert generates new operations that need reverting.
- **`@Irreversible` as a circuit breaker.** Destructive operations that can't be undone (like deleting a folder) clear the log. This prevents agents from believing they can revert past a destructive boundary.
- **`UNKNOWN_OPERATION_ID` is fail-safe.** If an ID is evicted from the ring buffer, or the log was cleared by `@Irreversible`, or the server restarted, the revert fails cleanly with no side effects.
