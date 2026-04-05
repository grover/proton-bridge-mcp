# EDD: Fix `add_labels` response shape and enable reversal

**Issue:** [#54 — bug: add_labels exposes internal newId and labelPath in tool response](https://github.com/grover/proton-bridge-mcp/issues/54)
**PRD:** [M3 Folders, Labels & Revert](m3-folders-labels-revert.md)

## Goal

1. Fix `add_labels` response to hide IMAP internals (`labelPath`, `newId`). Return `{ labelName, applied }` matching `remove_labels`'s `{ labelName, removed }`.
2. Enable `add_labels` reversal — `removeLabels` now exists and handles copy removal via Message-ID search. No `deleteEmails` method needed.

## Approach

Reshape `AddLabelsItemData` from `{ labelPath, newId? }` to `{ labelName, applied }`. Enable reversal by adding `buildAddLabelsReversal` (symmetric with `buildRemoveLabelsReversal`) and implementing the `add_labels` case in `#executeReversal` to call `this.#imap.removeLabels()`.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Keep `newId` for direct UID-based reversal | `removeLabels` already handles copy lookup via Message-ID search — storing copy UIDs is unnecessary complexity and exposes internals |
| Separate fix and reversal into two PRs | Tightly coupled — reshaping the response changes what the reversal builder captures |

## Changes

### 1. `src/types/operations.ts`

**Reshape `AddLabelsItemData`:**
```typescript
export interface AddLabelsItemData {
  labelName: string;   // plain name, no "Labels/" prefix
  applied:   boolean;  // true = newly labeled
}
```

**Simplify `ReversalSpec` for `add_labels`:**
```typescript
| { type: 'add_labels'; entries: Array<{ original: EmailId; labelName: string }> }
```

### 2. `src/bridge/imap.ts` — `addLabels` method

Change result construction from:
```typescript
labelResults.push({
  labelPath,
  ...(targetUid ? { newId: { uid: targetUid, mailbox: labelPath } } : {}),
});
```
To:
```typescript
labelResults.push({ labelName: labelPath.slice('Labels/'.length), applied: true });
```

### 3. `src/bridge/operation-log-interceptor.ts`

**Add `buildAddLabelsReversal`** (mirrors `buildRemoveLabelsReversal`):
```typescript
function buildAddLabelsReversal(
  _args: unknown[],
  result: unknown,
): ReversalSpec | null {
  const r = result as AddLabelsBatchResult;
  const entries = r.items
    .filter(item => item.status === 'succeeded' && item.data)
    .flatMap(item =>
      (item.data ?? [])
        .filter(label => label.applied)
        .map(label => ({ original: item.id, labelName: label.labelName })),
    );
  if (entries.length === 0) return null;
  return { type: 'add_labels', entries };
}
```

**Update `@Tracked`:** `@Tracked('add_labels', buildAddLabelsReversal)`

**Implement `#executeReversal` case:**
```typescript
case 'add_labels': {
  const byLabel = new Map<string, EmailId[]>();
  for (const entry of spec.entries) {
    const ids = byLabel.get(entry.labelName) ?? [];
    ids.push(entry.original);
    byLabel.set(entry.labelName, ids);
  }
  for (const [labelName, ids] of byLabel) {
    await this.#imap.removeLabels(ids, [labelName]);
  }
  return undefined;
}
```

**Add to `#rewriteSpecs`:**
```typescript
case 'add_labels':
  for (const entry of spec.entries) {
    const newOriginal = uidMap.get(formatEmailId(entry.original));
    if (newOriginal) entry.original = newOriginal;
  }
  break;
```

## Files Changed

| File | Change |
|---|---|
| `src/types/operations.ts` | Reshape `AddLabelsItemData`, simplify `add_labels` `ReversalSpec` |
| `src/bridge/imap.ts` | Return `{ labelName, applied }` instead of `{ labelPath, newId }` |
| `src/bridge/operation-log-interceptor.ts` | `buildAddLabelsReversal`, update `@Tracked`, `#executeReversal`, `#rewriteSpecs` |
| `docs/tools/README.md` | Update response example |

## What Does NOT Change

- `removeLabels` implementation — already handles reverse via Message-ID search
- `remove_labels` reversal — symmetric, unchanged
- `AddLabelsBatchResult` type alias — still `BatchToolResult<AddLabelsItemData[]>`

## Idempotency Analysis

`applied` is always `true` currently — IMAP COPY succeeds or throws. Calling `add_labels` on an already-labeled email creates a duplicate copy. The reversal only removes one copy per label (via Message-ID search finding the first match), which is correct.

## Edge Cases

| Scenario | Behavior |
|---|---|
| All labels applied successfully | `buildAddLabelsReversal` captures all entries |
| Some labels fail (COPY_FAILED) | Only `applied: true` entries captured for reversal |
| All items fail | `buildAddLabelsReversal` returns `null` → noop |
| Revert after move (UID changed) | `#rewriteSpecs` updates `original` EmailId |

## Smoke Test Scenarios

1. **Response shape:** `add_labels { ids: [...], labelNames: ["Work"] }` → response shows `{ labelName: "Work", applied: true }`, no `labelPath` or `newId`
2. **Reversal:** `add_labels` → note `operationId` → `revert_operations` → `get_labels` shows label still exists but email no longer in it
3. **Chain revert:** `add_labels` → `move_emails` → `revert_operations` from add_labels op → both reversed correctly

## Unit Test Plan

### Existing tests to update

- `src/bridge/operation-log-interceptor.test.ts` — `addLabels` describe block: update mock return values from `{ labelPath, newId }` to `{ labelName, applied }`
- Any IMAP client test that checks `addLabels` result shape

### New tests

**`src/bridge/operation-log-interceptor.test.ts`** — add to `addLabels` describe:

| # | Test case | Expected |
|---|---|---|
| 1 | Records add_labels reversal with entries when applied: true | `{ type: 'add_labels', entries: [{ original, labelName }] }` |
| 2 | Records noop when no labels were applied | `{ type: 'noop' }` |

**`src/bridge/operation-log-interceptor.test.ts`** — add to `revertOperations` describe:

| # | Test case | Expected |
|---|---|---|
| 3 | Reverses add_labels — calls imap.removeLabels | `removeLabels` called with correct ids and labelNames |
| 4 | Skips reversal for add_labels noop | `removeLabels` not called |
