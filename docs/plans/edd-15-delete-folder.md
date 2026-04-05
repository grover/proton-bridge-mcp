# EDD: `delete_folder` Tool

**Issue:** [#15 — M3: delete_folder — delete a custom mail folder](https://github.com/grover/proton-bridge-mcp/issues/15)
**PRD:** [M3 Folders, Labels & Revert](m3-folders-labels-revert.md)

## Goal

Add a `delete_folder` MCP tool that deletes user-defined folders under `Folders/`. The operation is irreversible — it clears the entire operation log on success, so no prior operations can be reverted afterward.

## Approach

Follow the existing `createFolder` pattern across all layers (types, IMAP client, interceptor, tool handler, server registration). Use `@IrreversibleWhen(predicate)` instead of `@Tracked` — it conditionally clears the log on success (only when `deleted: true`) and does not attach an `operationId` to the result.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| `@Tracked` with noop reversal (like `createFolder`) | `delete_folder` must clear the log, not append to it. `@Tracked` would add an `operationId` that is immediately invalidated. |
| MUTATING annotation (as PRD says) | The tool permanently deletes a folder and clears the operation log. This matches the DESTRUCTIVE classification used by `move_emails` and `revert_operations`. |
| Validate all guards in tool handler | FORBIDDEN is a domain concern (special-use detection requires IMAP LIST). Tool handler validates path format only; IMAP client validates domain rules. |
| Attempt delete first, catch errors | Proton Bridge error codes are unreliable (see `createFolder` experience). Pre-checking via `conn.list()` gives clear NOT_FOUND/FORBIDDEN semantics and enables `specialUse` check. |

## Architecture

```
MCP Client
  │
  ▼
McpServer (src/server.ts)
  │
  └── delete_folder (DESTRUCTIVE) ──► OperationLogInterceptor (@IrreversibleWhen)
                                           │
                                           │ log.clear() on success
                                           │
                                           └── delegates to ──► ImapClient (@Audited)
                                                                    │
                                                                    ├── guards: FORBIDDEN / NOT_FOUND
                                                                    └── conn.mailboxDelete(path)
```

## Changes

### 1. `src/types/operations.ts` — Add `DeleteFolderResult`

After `CreateFolderResult` (line 91):

```typescript
/** Result of a folder deletion */
export interface DeleteFolderResult {
  path: string;
}
```

No changes to `ReversalSpec` — `@IrreversibleWhen` does not record reversals.

### 2. `src/types/mail-ops.ts` — Extend `MutatingMailOps`

Add to `MutatingMailOps` interface after `createFolder`:

```typescript
deleteFolder(path: string): Promise<SingleToolResult<DeleteFolderResult>>;
```

### 3. `src/bridge/imap.ts` — Add `deleteFolder` method

After `createFolder` (line 92):

```typescript
@Audited('delete_folder')
async deleteFolder(path: string): Promise<DeleteFolderResult> {
  const cleaned = path.replace(/\/+$/, '');

  if (!cleaned.startsWith('Folders/') || cleaned === 'Folders/') {
    throw new Error('FORBIDDEN: can only delete folders under Folders/');
  }

  const conn = await this.#pool.acquire();
  try {
    const mailboxes = await conn.list();
    const target = mailboxes.find(mb => mb.path === cleaned);

    if (!target) {
      throw new Error('NOT_FOUND: folder does not exist');
    }
    if (target.specialUse) {
      throw new Error('FORBIDDEN: cannot delete special-use folder');
    }

    await conn.mailboxDelete(cleaned);
    return { path: cleaned };
  } finally {
    this.#pool.release(conn);
  }
}
```

**Design notes:**
- Guard checks path prefix before acquiring a connection (fail fast).
- `conn.list()` provides both existence check and `specialUse` detection in a single call.
- Top-level protected names (INBOX, Sent, Drafts, etc.) are already excluded by the `Folders/` prefix check — they never start with `Folders/`.
- Returns `cleaned` path (not `result.path` from mailboxDelete) since we already validated it.

### 4. `src/bridge/operation-log-interceptor.ts` — Add `deleteFolder`

Add `IrreversibleWhen` to import from `./decorators.js`. Add `DeleteFolderResult` to type imports.

After `createFolder` (line 91):

```typescript
@IrreversibleWhen((result) => (result as SingleToolResult<DeleteFolderResult>).data.deleted)
async deleteFolder(path: string): Promise<SingleToolResult<DeleteFolderResult>> {
  const data = await this.#imap.deleteFolder(path);
  return { status: 'succeeded' as const, data };
}
```

### 5. `src/tools/delete-folder.ts` — New tool handler

```typescript
import { z } from 'zod';
import type { SingleToolResult, DeleteFolderResult, MutatingMailOps } from '../types/index.js';

export const deleteFolderSchema = {
  path: z.string().min(1)
    .describe('Full IMAP path of the folder to delete (must start with "Folders/"). Example: "Folders/Work"'),
};

export async function handleDeleteFolder(
  args: { path: string },
  ops: MutatingMailOps,
): Promise<SingleToolResult<DeleteFolderResult>> {
  const cleaned = args.path.replace(/\/+$/, '');
  if (!cleaned || cleaned === 'Folders' || !cleaned.startsWith('Folders/') || cleaned === 'Folders/') {
    throw new Error('INVALID_PATH: path must contain a folder name after "Folders/" (e.g. "Folders/MyFolder")');
  }
  return ops.deleteFolder(cleaned);
}
```

### 6. `src/tools/index.ts` — Export

```typescript
export * from './delete-folder.js';
```

### 7. `src/server.ts` — Register tool

After `create_folder` registration:

```typescript
server.registerTool(
  'delete_folder',
  {
    description: "Delete a mail folder. The path must be under Folders/ — Folders/ itself, special-use folders (INBOX, Sent, Drafts, Trash, etc.), and paths outside Folders/ are rejected. Emails are retained in Proton's backend. Warning: this operation clears the operation history — no prior operations can be reverted after calling delete_folder.",
    inputSchema: deleteFolderSchema,
    annotations: DESTRUCTIVE,
  },
  async (args) => ({
    content: [{ type: 'text', text: toText(await handleDeleteFolder(args, mutOps)) }],
  }),
);
```

## Files Changed

| File | Change |
|---|---|
| `src/types/operations.ts` | Add `DeleteFolderResult` interface |
| `src/types/mail-ops.ts` | Add `deleteFolder` to `MutatingMailOps` |
| `src/bridge/imap.ts` | Add `deleteFolder` method with `@Audited` |
| `src/bridge/operation-log-interceptor.ts` | Add `deleteFolder` with `@IrreversibleWhen` |
| `src/tools/delete-folder.ts` | New: schema + handler |
| `src/tools/index.ts` | Add export |
| `src/server.ts` | Register tool (DESTRUCTIVE) |

## What Does NOT Change

- `ReversalSpec` union — `@IrreversibleWhen` doesn't record reversals
- `@IrreversibleWhen` decorator — conditional log clearing based on result
- Operation log ring buffer internals

## Deviation: `createFolder` reversal now enabled

With `deleteFolder` available, `createFolder` tracking was upgraded from noop to a real reversal:
- `buildCreateFolderReversal` returns `{ type: 'create_folder', path }` when `created: true`, `null` (noop) when `created: false` (don't delete a pre-existing folder on revert)
- `#executeReversal` for `create_folder` calls `this.#imap.deleteFolder(path)`
- This was not in the original EDD scope but is a natural consequence of `deleteFolder` existing

- `ReadOnlyMailOps` interface

## Idempotency Analysis

Originally designed as non-idempotent (throwing NOT_FOUND for non-existent folders). Changed during smoke testing to match `createFolder`'s idempotent pattern.

| Scenario | Behavior | Response shape |
|---|---|---|
| Folder exists | Deleted, log cleared | `{ status: 'succeeded', data: { path, deleted: true } }` |
| Folder doesn't exist | Success (no-op), log NOT cleared | `{ status: 'succeeded', data: { path, deleted: false } }` |
| Folder already deleted (repeat call) | Same as "doesn't exist" | `{ status: 'succeeded', data: { path, deleted: false } }` |
| `@IrreversibleWhen` on error | Log NOT cleared (error thrown before predicate check) | Error |

`delete_folder` **is idempotent** — calling it on an already-deleted folder returns `{ deleted: false }`. The operation log is only cleared when `deleted: true` (actual deletion happened), using `@IrreversibleWhen(predicate)` instead of unconditional `@Irreversible`.

**Reverting a delete_folder:** Not applicable. When `deleted: true`, `@IrreversibleWhen` clears the log — no operation record to revert. When `deleted: false`, the log is preserved but no record was added (no `@Tracked`).

## Edge Cases

| Scenario | Expected behavior |
|---|---|
| `path: "Folders/Work"` (exists, no specialUse) | Deleted, log cleared, returns `{ path: "Folders/Work", deleted: true }` |
| `path: "INBOX"` | INVALID_PATH (tool handler — doesn't start with Folders/) |
| `path: "Folders/"` or `"Folders"` | INVALID_PATH (tool handler) |
| `path: "Sent"` | INVALID_PATH (tool handler — doesn't start with Folders/) |
| `path: "Labels/Important"` | INVALID_PATH (tool handler — doesn't start with Folders/) |
| `path: "Folders/WithSpecialUse"` with specialUse set | FORBIDDEN (IMAP client) |
| Non-existent folder | Success with `deleted: false`, log preserved |
| Folder with child folders | IMAP error propagates (server-dependent behavior) |
| `path: "Folders/Work/"` (trailing slash) | Cleaned to `"Folders/Work"`, then processed normally |

## Smoke Test Scenarios

1. **Happy path:** `create_folder { path: "Folders/TestDelete" }` → `get_folders` shows it → `delete_folder { path: "Folders/TestDelete" }` → `get_folders` no longer shows it.
2. **FORBIDDEN — INBOX:** `delete_folder { path: "INBOX" }` → error contains `INVALID_PATH`.
3. **FORBIDDEN — Folders/ root:** `delete_folder { path: "Folders/" }` → error contains `INVALID_PATH`.
4. **NOT_FOUND:** `delete_folder { path: "Folders/NonExistent" }` → error contains `NOT_FOUND`.
5. **Operation log cleared:** `create_folder { path: "Folders/A" }` → `move_emails` (some emails to Folders/A) → note the `operationId` → `delete_folder { path: "Folders/A" }` → `revert_operations { operationId }` → error `UNKNOWN_OPERATION_ID`.
6. **No-op idempotency (negative):** `delete_folder { path: "Folders/TestDelete" }` after already deleted → `NOT_FOUND`.

## Unit Test Plan

### `src/bridge/imap-delete-folder.test.ts` (new file)

| # | Test case | Setup | Expected |
|---|---|---|---|
| 1 | Successful deletion | `conn.list()` returns folder, `conn.mailboxDelete()` succeeds | Returns `{ path }` |
| 2 | FORBIDDEN: path not under Folders/ | Path = `"INBOX"` | Throws `FORBIDDEN` |
| 3 | FORBIDDEN: bare Folders/ | Path = `"Folders/"` | Throws `FORBIDDEN` |
| 4 | FORBIDDEN: special-use folder | `conn.list()` returns folder with `specialUse: '\\Trash'` | Throws `FORBIDDEN` |
| 5 | NOT_FOUND: folder missing | `conn.list()` returns no match | Throws `NOT_FOUND` |
| 6 | IMAP error propagation | `conn.mailboxDelete()` throws | Error propagates |
| 7 | Connection always released | Any path (success or error) | `pool.release()` called |
| 8 | Trailing slash cleaned | Path = `"Folders/Work/"` | Cleaned to `"Folders/Work"`, processed normally |

### `src/bridge/operation-log-interceptor.test.ts` (additions)

| # | Test case | Setup | Expected |
|---|---|---|---|
| 1 | Delegates to imap.deleteFolder | Mock imap.deleteFolder resolves | Result is `SingleToolResult` (no operationId) |
| 2 | Clears log on success | Pre-populate log with records | `log.size === 0` after call |
| 3 | Does not clear log on error | Mock imap.deleteFolder throws | Log unchanged |

### `src/tools/delete-folder.test.ts` (new file)

| # | Test case | Input | Expected |
|---|---|---|---|
| 1 | Valid path delegates to ops | `"Folders/Work"` | `ops.deleteFolder("Folders/Work")` called |
| 2 | Trailing slash cleaned | `"Folders/Work/"` | `ops.deleteFolder("Folders/Work")` called |
| 3 | INVALID_PATH: empty after clean | `"///"` | Throws INVALID_PATH |
| 4 | INVALID_PATH: bare Folders | `"Folders"` | Throws INVALID_PATH |
| 5 | INVALID_PATH: bare Folders/ | `"Folders/"` | Throws INVALID_PATH |
| 6 | INVALID_PATH: not under Folders/ | `"INBOX"` | Throws INVALID_PATH |
