# EDD: `delete_label` Tool

**Issue:** [#18 — M3: delete_label — delete a Proton label](https://github.com/grover/proton-bridge-mcp/issues/18)
**PRD:** [M3 Folders, Labels & Revert](m3-folders-labels-revert.md)

## Goal

Add a `delete_label` MCP tool that deletes Proton Mail labels under `Labels/`. Irreversible — clears the operation log on success. Emails are preserved (verified in Proton Bridge source).

## Approach

Mirror the `delete_folder` pattern. Extract shared `#deleteMailbox(path, prefix)` from existing `deleteFolder` in `ImapClient` (same refactor pattern as `#createMailbox`). Use `@IrreversibleWhen` for conditional log clearing. Also enable `create_label` reversal now that `deleteLabel` exists.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Reversible with email capture (PRD design) | IMAP doesn't track copy provenance. Emails in `Labels/<name>` have label-folder UIDs, not source mailbox UIDs. No reliable way to discover originals for `addLabels` reversal. |
| Message-ID cross-referencing | Expensive (fetch + search across all mailboxes), fragile (originals may be moved/deleted), not guaranteed unique. |
| `MUTATING` annotation | Tool clears the operation log — destructive by definition. Matches `delete_folder` classification. |

## Changes

### 1. `src/types/operations.ts` — Add `DeleteMailboxResult` and `DeleteLabelResult`

Refactor `DeleteFolderResult` into a shared base (mirrors existing `CreateMailboxResult` pattern):

```typescript
/** Result of deleting an IMAP mailbox (folder or label) */
export interface DeleteMailboxResult {
  path:    string;
  deleted: boolean;
}

/** Result of a folder deletion */
export type DeleteFolderResult = DeleteMailboxResult;

/** Result of a label deletion */
export type DeleteLabelResult = DeleteMailboxResult;
```

Add `create_label` to `ReversalSpec` union:

```typescript
| { type: 'create_label'; name: string }
```

Add `DeleteLabelResult` — uses `name` (not path) to match `CreateLabelResult`:

```typescript
export interface DeleteLabelResult {
  name:    string;
  deleted: boolean;
}
```

### 2. `src/types/mail-ops.ts` — Add `deleteLabel` to `MutatingMailOps`

```typescript
deleteLabel(name: string): Promise<SingleToolResult<DeleteLabelResult>>;
```

### 3. `src/bridge/imap.ts` — Extract `#deleteMailbox`, add `deleteLabel`

Extract shared delete logic from `deleteFolder` into private helper:

```typescript
async #deleteMailbox(path: string, prefix: string): Promise<DeleteMailboxResult> {
  const cleaned = path.replace(/\/+$/, '');
  if (!cleaned.startsWith(prefix) || cleaned === prefix) {
    throw new Error(`FORBIDDEN: can only delete mailboxes under ${prefix}`);
  }
  const conn = await this.#pool.acquire();
  try {
    const mailboxes = await conn.list();
    const target = mailboxes.find((mb: { path: string }) => mb.path === cleaned);
    if (!target) {
      return { path: cleaned, deleted: false };
    }
    if ((target as { specialUse?: string }).specialUse) {
      throw new Error('FORBIDDEN: cannot delete special-use mailbox');
    }
    await conn.mailboxDelete(cleaned);
    return { path: cleaned, deleted: true };
  } finally {
    this.#pool.release(conn);
  }
}

@Audited('delete_folder')
async deleteFolder(path: string): Promise<DeleteFolderResult> {
  return this.#deleteMailbox(path, 'Folders/');
}

@Audited('delete_label')
async deleteLabel(name: string): Promise<DeleteLabelResult> {
  const result = await this.#deleteMailbox(`Labels/${name}`, 'Labels/');
  return { name, deleted: result.deleted };
}
```

### 4. `src/bridge/operation-log-interceptor.ts`

**Add `deleteLabel`** with `@IrreversibleWhen`:

```typescript
@IrreversibleWhen((result) => (result as SingleToolResult<DeleteLabelResult>).data.deleted)
async deleteLabel(name: string): Promise<SingleToolResult<DeleteLabelResult>> {
  const data = await this.#imap.deleteLabel(name);
  return { status: 'succeeded' as const, data };
}
```

**Enable `create_label` reversal.** Note: `CreateLabelResult` uses `name` (not `path`). The reversal spec stores the `name` so `#executeReversal` can call `deleteLabel(name)`:

```typescript
function buildCreateLabelReversal(
  _args: unknown[],
  result: unknown,
): ReversalSpec | null {
  const r = result as SingleToolResult<CreateLabelResult>;
  if (!r.data.created) return null;
  return { type: 'create_label', name: r.data.name };
}
```

Update `@Tracked` on `createLabel`:

```typescript
@Tracked('create_label', buildCreateLabelReversal)
```

**Add `create_label` case to `#executeReversal`:**

```typescript
case 'create_label':
  await this.#imap.deleteLabel(spec.name);
  return undefined;
```

**Update `buildCreateMailboxReversal` type:** Widen the type parameter from `'create_folder'` to accept the literal union type, or just keep separate builders since `CreateLabelResult` has a different shape (`name` vs `path`).

### 5. `src/tools/delete-label.ts` — New tool handler

Takes `name` (not path), matching `create_label`. The handler constructs the IMAP path internally:

```typescript
import { z } from 'zod';
import type { SingleToolResult, DeleteLabelResult, MutatingMailOps } from '../types/index.js';

export const deleteLabelSchema = {
  name: z.string().min(1)
    .describe('Label name to delete (plain text, no "/" allowed). Example: "Project X"'),
};

export async function handleDeleteLabel(
  args: { name: string },
  ops: MutatingMailOps,
): Promise<SingleToolResult<DeleteLabelResult>> {
  if (args.name.includes('/')) {
    throw new Error('INVALID_NAME: label name must not contain "/"');
  }
  return ops.deleteLabel(args.name);
}
```

### 6. `src/tools/index.ts` — Add export

### 7. `src/server.ts` — Register with DESTRUCTIVE annotation

Description from updated issue: warns about operation history clearing.

## Files Changed

| File | Change |
|---|---|
| `src/types/operations.ts` | `DeleteMailboxResult` base, `DeleteLabelResult` alias, `create_label` in `ReversalSpec` |
| `src/types/mail-ops.ts` | Add `deleteLabel` to `MutatingMailOps` |
| `src/bridge/imap.ts` | Extract `#deleteMailbox`, refactor `deleteFolder`, add `deleteLabel` |
| `src/bridge/operation-log-interceptor.ts` | Add `deleteLabel` with `@IrreversibleWhen`, enable `create_label` reversal |
| `src/tools/delete-label.ts` | New: schema + handler |
| `src/tools/index.ts` | Add export |
| `src/server.ts` | Register tool (DESTRUCTIVE) |

## What Does NOT Change

- `@IrreversibleWhen` decorator — reused as-is from delete_folder
- `@Irreversible` decorator — stays available for future use
- `add_labels` tracking — still noop (needs `deleteEmails`)
- `delete_folder` behavior — `#deleteMailbox` extraction preserves identical logic

## Idempotency Analysis

| Scenario | Behavior | Response shape |
|---|---|---|
| Label exists | Deleted, log cleared | `{ status: 'succeeded', data: { name, deleted: true } }` |
| Label doesn't exist | Success (no-op), log preserved | `{ status: 'succeeded', data: { name, deleted: false } }` |
| Repeat delete | Same as "doesn't exist" | `{ status: 'succeeded', data: { name, deleted: false } }` |
| `@IrreversibleWhen` on FORBIDDEN | Log NOT cleared (error thrown before predicate check) | Error |

## Edge Cases

| Scenario | Expected behavior |
|---|---|
| `name: "Work"` (exists) | Deleted, log cleared, returns `{ name: "Work", deleted: true }` |
| `name: "Has/Slash"` | INVALID_NAME (tool handler) |
| `name: "WithSpecialUse"` (specialUse set) | FORBIDDEN (IMAP client) |
| Non-existent label | Success with `{ name, deleted: false }`, log preserved |

## Smoke Test Scenarios

1. **Happy path:** `create_label { name: "TestDelete" }` → `get_labels` shows it → `delete_label { name: "TestDelete" }` → `get_labels` no longer shows it → `{ deleted: true }`
2. **INVALID_NAME:** `delete_label { name: "Has/Slash" }` → error `INVALID_NAME`
3. **Idempotent:** `delete_label { name: "NonExistent" }` → `{ deleted: false }`
4. **Operation log cleared:** `create_label` → some tracked op → `delete_label` → `revert_operations` → `UNKNOWN_OPERATION_ID`
5. **Revert create_label:** `create_label { name: "RevertMe" }` → `revert_operations` → `get_labels` no longer shows it

## Unit Test Plan

### `src/bridge/imap-delete-label.test.ts` (new)

| # | Test case | Expected |
|---|---|---|
| 1 | Successful deletion | Returns `{ name, deleted: true }` |
| 2 | FORBIDDEN: special-use label | Throws `FORBIDDEN` |
| 3 | Returns deleted: false when label missing | Returns `{ name, deleted: false }` |
| 4 | IMAP error propagation | Error propagates |
| 5 | Connection always released | `pool.release()` called |

Note: Guard validation (prefix check) is tested via `#deleteMailbox` in `imap-delete-folder.test.ts`. The `deleteLabel` tests focus on the `name → path` mapping and delegation.

### `src/bridge/operation-log-interceptor.test.ts` (additions)

| # | Test case | Expected |
|---|---|---|
| 1 | Delegates to imap.deleteLabel, no operationId | `SingleToolResult` without operationId |
| 2 | Clears log when deleted: true | `log.size === 0` |
| 3 | Does not clear log when deleted: false | Log preserved |
| 4 | Does not clear log on error | Log preserved |
| 5 | create_label records create_label reversal when created: true | `{ type: 'create_label', path }` |
| 6 | create_label records noop when created: false | `{ type: 'noop' }` |
| 7 | Revert create_label calls imap.deleteLabel | `imap.deleteLabel` called with path |
| 8 | Revert create_label noop (created: false) skips deleteLabel | `imap.deleteLabel` not called |

### `src/tools/delete-label.test.ts` (new)

| # | Test case | Expected |
|---|---|---|
| 1 | Valid name delegates to ops | `ops.deleteLabel("Work")` called |
| 2 | INVALID_NAME: contains slash | Throws INVALID_NAME |
