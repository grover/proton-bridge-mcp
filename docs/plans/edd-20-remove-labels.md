# EDD: `remove_labels` Tool

**Issue:** [#20 — M3: remove_labels — bulk-remove Proton Mail labels from emails](https://github.com/grover/proton-bridge-mcp/issues/20)
**PRD:** [M3 Folders, Labels & Revert](m3-folders-labels-revert.md)

## Goal

Add a `remove_labels` MCP tool that bulk-removes Proton Mail labels from emails. Copies in label folders are deleted; originals remain in their source mailboxes. The operation is tracked and revertable via `revert_operations`.

## Approach

Mirror the `addLabels` pattern. Use IMAP `messageDelete()` (STORE \Deleted + EXPUNGE) on the copy inside each label folder. Proton Bridge translates this into `UnlabelMessages()` when the source is a label-type mailbox — no permanent deletion occurs.

**Key challenge:** We need the copy's UID inside the label folder, not the source UID. Strategy: fetch the source email's Message-ID header, then search each label folder by Message-ID to locate the copy.

## Deviations from Issue Spec

| Deviation | Rationale |
|---|---|
| Issue forbids `\Deleted + EXPUNGE`; EDD uses it | Research of Proton Bridge source ([connector.go:408-414](https://github.com/ProtonMail/proton-bridge/blob/main/internal/services/imapservice/connector.go#L408)) proves that EXPUNGE from a label-type mailbox calls `UnlabelMessages()` only — no permanent deletion. The permanent deletion path only activates for Trash/Drafts. imapflow's `messageDelete()` wraps both steps atomically. |
| Issue says MUTATING annotation; EDD uses DESTRUCTIVE | `remove_labels` deletes copies from label folders — semantically destructive (same as `move_emails`). MUTATING is for operations that modify metadata without removing emails from folders (e.g., `mark_read`, `add_labels`). |

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| IMAP MOVE from label to source folder | Requires knowing the message's "home" folder. Picking wrong adds an unintended label. Also adds a destination label as side-effect. |
| IMAP COPY + STORE \Deleted + EXPUNGE | Same destination problem as MOVE, plus non-atomic. No advantage. |
| Gmail X-GM-LABELS extension | Proton Bridge does not implement it. Not available. |
| IMAP STORE with custom keywords | Proton labels are not IMAP keywords — they are folder membership. Removing a keyword does not remove a label. |
| Lookup copy UID from operation log | `OperationLog` is not queryable at tool execution time (it's a revert-only ring buffer). Would require architectural changes. Message-ID search is simple and handles labels added outside MCP. |

## IMAP Mechanism

When `messageDelete()` is called on a message inside a `Labels/*` folder, Proton Bridge's `RemoveMessagesFromMailbox()` ([connector.go:408-414](https://github.com/ProtonMail/proton-bridge/blob/main/internal/services/imapservice/connector.go#L408)) executes:

```go
if s.isMailboxOfTypeLabel(string(mboxID)) {
    if err := s.client.UnlabelMessages(ctx, msgIDs, string(mboxID)); err != nil {
        return err
    }
}
```

This calls the Proton API's `UnlabelMessages()` — the label is removed from the message, and the message continues to exist in its source folder and any other labels. No permanent deletion check runs (that path only activates for Trash/Drafts).

## Changes

### 1. `src/types/operations.ts` — Add result type + reversal variant

After `AddLabelsBatchResult` (line 85):

```typescript
/** Result of removing a single label from one email */
export interface RemoveLabelResult {
  labelPath: string;
  removed:   boolean;  // false if email was not in this label
}

/** Batch result for remove_labels */
export type RemoveLabelsBatchResult = BatchToolResult<RemoveLabelResult[]>;
```

Add to `ReversalSpec` union (line 129):

```typescript
| { type: 'remove_labels'; entries: Array<{ original: EmailId; labelPath: string }> }
```

### 2. `src/types/mail-ops.ts` — Extend `MutatingMailOps`

Add after `addLabels`:

```typescript
removeLabels(ids: EmailId[], labelNames: string[]): Promise<RemoveLabelsBatchResult>;
```

Add `RemoveLabelsBatchResult` to imports.

### 3. `src/bridge/imap.ts` — Core IMAP method

Add `removeLabels` method after `addLabels`:

```typescript
@Audited('remove_labels')
async removeLabels(ids: EmailId[], labelNames: string[]): Promise<RemoveLabelsBatchResult> {
  const labelPaths = labelNames.map(name => `Labels/${name}`);
  const items: Array<BatchItemResult<RemoveLabelResult[]>> =
    ids.map(id => ({ id, status: 'failed' as const }));
  const groups = groupByMailbox(ids);

  const conn = await this.#pool.acquire();
  try {
    // Phase 1: Fetch Message-IDs from source mailboxes
    const messageIds = new Map<number, string>(); // index → Message-ID
    for (const { mailbox, entries } of groups) {
      const lock = await conn.getMailboxLock(mailbox);
      try {
        for (const { index, id } of entries) {
          for await (const msg of conn.fetch(String(id.uid), {
            uid: true, envelope: true,
          }, { uid: true })) {
            if (msg.envelope?.messageId) {
              messageIds.set(index, msg.envelope.messageId);
            }
          }
        }
      } finally {
        lock.release();
      }
    }

    // Phase 2: Remove from each label folder
    for (const labelPath of labelPaths) {
      let lock;
      try {
        lock = await conn.getMailboxLock(labelPath);
      } catch {
        // Label folder does not exist — mark all items for this label
        for (let i = 0; i < ids.length; i++) {
          items[i] = {
            id: ids[i]!,
            status: 'failed',
            error: { code: 'LABEL_NOT_FOUND', message: `Label folder ${labelPath} does not exist` },
          };
        }
        continue;
      }
      try {
        for (let i = 0; i < ids.length; i++) {
          const msgId = messageIds.get(i);
          if (!msgId) {
            // Could not fetch Message-ID — mark label as not removed
            const existing = items[i]!.data ?? [];
            existing.push({ labelPath, removed: false });
            items[i] = { id: ids[i]!, status: 'succeeded' as const, data: existing };
            continue;
          }

          try {
            const uids = await conn.search(
              { header: { 'message-id': msgId } },
              { uid: true },
            );

            if (!uids || uids.length === 0) {
              const existing = items[i]!.data ?? [];
              existing.push({ labelPath, removed: false });
              items[i] = { id: ids[i]!, status: 'succeeded' as const, data: existing };
              continue;
            }

            await conn.messageDelete(String(uids[0]), { uid: true });
            const existing = items[i]!.data ?? [];
            existing.push({ labelPath, removed: true });
            items[i] = { id: ids[i]!, status: 'succeeded' as const, data: existing };
          } catch (err) {
            items[i] = {
              id: ids[i]!,
              status: 'failed',
              error: { code: 'REMOVE_FAILED', message: err instanceof Error ? err.message : String(err) },
            };
          }
        }
      } finally {
        lock.release();
      }
    }
  } finally {
    this.#pool.release(conn);
  }

  return { status: batchStatus(items), items };
}
```

**Idempotency analysis:** Calling `remove_labels` on an email not in the label returns `removed: false` (succeeded, not an error). Calling it again after a successful removal also returns `removed: false`. Reverting a no-op removal is harmless — `addLabels` re-copies the email into the label folder.

### 4. `src/tools/remove-labels.ts` — New tool handler

```typescript
import type { EmailId, RemoveLabelsBatchResult, MutatingMailOps } from '../types/index.js';
import { emailIdStringSchema } from '../types/index.js';
import { z } from 'zod';

export const removeLabelsSchema = {
  ids: z.array(emailIdStringSchema).min(1).max(50)
    .describe('Emails to remove labels from (source mailbox IDs)'),
  labelNames: z.array(z.string().min(1)).min(1)
    .describe('Label names to remove (plain names without "Labels/" prefix)'),
};

export async function handleRemoveLabels(
  args: { ids: EmailId[]; labelNames: string[] },
  ops: MutatingMailOps,
): Promise<RemoveLabelsBatchResult> {
  return ops.removeLabels(args.ids, args.labelNames);
}
```

### 5. `src/tools/index.ts` — Add export

```typescript
export * from './remove-labels.js';
```

### 6. `src/bridge/operation-log-interceptor.ts` — Tracking + reversal

**Add `buildRemoveLabelsReversal` function** (after `buildCreateLabelReversal`):

```typescript
function buildRemoveLabelsReversal(
  _args: unknown[],
  result: unknown,
): ReversalSpec | null {
  const r = result as RemoveLabelsBatchResult;
  const entries = r.items
    .filter(item => item.status === 'succeeded' && item.data)
    .flatMap(item =>
      (item.data ?? [])
        .filter(removal => removal.removed)
        .map(removal => ({ original: item.id, labelPath: removal.labelPath })),
    );
  if (entries.length === 0) return null;
  return { type: 'remove_labels', entries };
}
```

**Add interceptor method** (after `addLabels`):

```typescript
@Tracked('remove_labels', buildRemoveLabelsReversal)
async removeLabels(ids: EmailId[], labelNames: string[]): Promise<RemoveLabelsBatchResult> {
  return this.#imap.removeLabels(ids, labelNames);
}
```

**Add reversal execution** in `#executeReversal` (before `default` case):

```typescript
case 'remove_labels': {
  const byLabel = new Map<string, EmailId[]>();
  for (const entry of spec.entries) {
    const ids = byLabel.get(entry.labelPath) ?? [];
    ids.push(entry.original);
    byLabel.set(entry.labelPath, ids);
  }
  for (const [labelPath, ids] of byLabel) {
    const labelName = labelPath.slice('Labels/'.length);
    await this.#imap.addLabels(ids, [labelName]);
  }
  return undefined;
}
```

**Add UID rewriting** in `#rewriteSpecs`:

```typescript
case 'remove_labels':
  for (const entry of spec.entries) {
    const newOriginal = uidMap.get(formatEmailId(entry.original));
    if (newOriginal) entry.original = newOriginal;
  }
  break;
```

### 7. `src/server.ts` — Register tool

Add between `add_labels` and `revert_operations`:

```typescript
server.registerTool(
  'remove_labels',
  {
    description: 'Remove one or more Proton Mail labels from a batch of emails. Removes the email copies from label folders; originals remain in their source mailboxes. Supports up to 50 emails per call.',
    inputSchema: removeLabelsSchema,
    annotations: DESTRUCTIVE,
  },
  async (args) => ({
    content: [{ type: 'text', text: toText(await handleRemoveLabels(args, mutOps)) }],
  }),
);
```

Import `removeLabelsSchema`, `handleRemoveLabels` from `'./tools/index.js'`.

## Files Changed

| File | Change |
|---|---|
| `src/types/operations.ts` | Add `RemoveLabelResult`, `RemoveLabelsBatchResult`, `remove_labels` reversal variant |
| `src/types/mail-ops.ts` | Add `removeLabels` to `MutatingMailOps` |
| `src/bridge/imap.ts` | Add `removeLabels()` method |
| `src/tools/remove-labels.ts` | **New file** — schema + handler |
| `src/tools/index.ts` | Add export |
| `src/bridge/operation-log-interceptor.ts` | Add reversal builder, interceptor method, reversal execution, UID rewriting |
| `src/server.ts` | Register `remove_labels` tool |
| `CLAUDE.md` | Add `remove_labels` to tool categories table |
| `ARCHITECTURE.md` | Document IMAP label removal mechanism |
| `CHANGELOG.md` | Add entry under `[Unreleased]` |
| `docs/tools/README.md` | Add `remove_labels` tool documentation |

## What Does NOT Change

- `ImapClient` has no awareness of the operation log (interceptor pattern preserved)
- `OperationLog` class — no structural changes
- `@Tracked` / `@IrreversibleWhen` decorators — no changes
- Read-only tools — unaffected
- `add_labels` tracking — remains noop (separate issue, requires `deleteEmails`)
- STDIO / HTTP / HTTPS transport modes — unaffected

## Edge Cases

| Scenario | Behavior |
|---|---|
| Email not in label folder | `removed: false`, `status: 'succeeded'` — not treated as error |
| Label folder does not exist | `getMailboxLock` fails → all items for that label get `LABEL_NOT_FOUND` error |
| Email has no Message-ID header | `removed: false` for all labels — cannot locate copy without Message-ID |
| Multiple copies in same label folder (duplicate Message-ID) | First match is deleted; `removed: true` |
| Remove labels then revert | `addLabels` re-copies emails into label folders |
| Revert a no-op removal (all `removed: false`) | `buildRemoveLabelsReversal` returns `null` → `{ type: 'noop' }` recorded |
| Connection lost during phase 2 | Partial results: some labels removed, others failed. `status: 'partial'` |

## Smoke Test Scenarios

1. **Happy path — single label removal**
   - **Setup:** `add_labels` to apply "SmokeTest" label to 2 emails in INBOX
   - **Action:** `remove_labels` with those 2 email IDs and `labelNames: ["SmokeTest"]`
   - **Expected:** Both items `removed: true`. Emails no longer in `Labels/SmokeTest`. Originals in INBOX untouched.
   - **Validates:** Core IMAP mechanism (messageDelete from label folder)

2. **Not in label**
   - **Action:** `remove_labels` on an email that was never labeled "SmokeTest"
   - **Expected:** `removed: false`, `status: 'succeeded'`
   - **Validates:** Graceful handling of missing copies

3. **Multiple labels at once**
   - **Setup:** `add_labels` with `labelNames: ["LabelA", "LabelB"]` on 1 email
   - **Action:** `remove_labels` with `labelNames: ["LabelA", "LabelB"]`
   - **Expected:** Both labels removed. Email gone from both `Labels/LabelA` and `Labels/LabelB`.
   - **Validates:** Multi-label removal in single call

4. **Revert removes labels**
   - **Setup:** `add_labels` "RevertTest" on 1 email, then `remove_labels` "RevertTest"
   - **Action:** `revert_operations` with the `remove_labels` operationId
   - **Expected:** Email re-appears in `Labels/RevertTest`
   - **Validates:** Operation log tracking and reversal

5. **Idempotent removal**
   - **Setup:** `add_labels` "IdempotentTest" then `remove_labels` "IdempotentTest"
   - **Action:** `remove_labels` "IdempotentTest" again
   - **Expected:** `removed: false`, no error
   - **Validates:** Double-removal is safe

## Unit Test Plan

### `src/bridge/imap.test.ts` — `removeLabels` method

1. **Single email, single label — removed:** Mock `conn.fetch` → returns envelope with Message-ID. Mock `conn.search` → returns `[42]`. Mock `conn.messageDelete` → succeeds. Assert `removed: true`.
2. **Single email, not in label:** Mock `conn.search` → returns `[]`. Assert `removed: false`, `status: 'succeeded'`.
3. **Multiple emails, multiple labels:** Verify each combination independently processed. Assert correct per-item results.
4. **IMAP error during delete:** Mock `conn.messageDelete` → throws. Assert per-item error `REMOVE_FAILED`.
5. **No Message-ID header:** Mock `conn.fetch` → envelope without messageId. Assert `removed: false`.
6. **Connection pattern:** Verify single `acquire`/`release`. Verify lock/release per mailbox.

### `src/bridge/operation-log-interceptor.test.ts` — `removeLabels` tracking + reversal

7. **Tracking records reversal entries:** Call `removeLabels` with 2 emails, both `removed: true`. Verify operation log contains `{ type: 'remove_labels', entries }` with both entries.
8. **Tracking with no-ops:** All items `removed: false`. Verify reversal is `{ type: 'noop' }`.
9. **Mixed results:** 1 removed, 1 not. Verify only the removed entry appears in reversal.
10. **Reversal execution:** Execute reversal of `remove_labels` spec. Verify `addLabels` called with correct IDs and label names.
11. **UID rewriting:** Verify `#rewriteSpecs` updates `original` EmailIds in `remove_labels` specs.

### `src/tools/remove-labels.test.ts` — Tool handler

12. **Pass-through:** Verify `handleRemoveLabels` delegates to `ops.removeLabels`.
