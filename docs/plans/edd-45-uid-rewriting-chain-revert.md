# EDD: UID Rewriting During Chain Revert Across Move Operations

**Issue:** [#45 — feat: UID rewriting during chain revert across move operations](https://github.com/grover/proton-bridge-mcp/issues/45)
**Parent EDD:** [EDD-21 — Operation Log and `revert_operations` Tool](edd-21-operation-log-revert.md)

## Goal

When `revert_operations` reverses a chain that includes a `move_emails`, rewrite stale UIDs in remaining reversal specs so that subsequent flag reversals target the correct emails.

## Approach

After each `move_batch` reversal in `#executeReversal`, capture the COPYUID mapping (original EmailId → new EmailId) and mutate remaining reversal specs in-place before they execute. No new types needed — uses `formatEmailId` as map key and `Map<string, EmailId>` for the mapping.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Store original `Message-ID` header alongside UID for stable identity | Expensive extra FETCH per tracked operation; IMAP UIDs are sufficient when rewritten during revert |
| Build UID map upfront before executing any reversals | Impossible — new UIDs are only known after the IMAP MOVE executes |
| Immutable spec copy + new array | Unnecessary allocation — specs are local to `revertOperations` call, no external observer |

## Changes

### `src/bridge/operation-log-interceptor.ts`

#### 1. `#executeReversal` — return UID mapping

Change return type from `Promise<void>` to `Promise<Map<string, EmailId> | undefined>`.

For the `move_batch` case:
- Build a lookup: `formatEmailId(move.from)` → `move` (to correlate batch results back to moves)
- Capture `moveEmails` return value (currently discarded)
- For each succeeded result where `targetId` is defined, map `formatEmailId(move.to)` → `targetId`
- `move.to` is the original EmailId that earlier reversal specs reference
- `targetId` is the new EmailId after the reverse move
- Return the map (empty map if no COPYUID responses)

All other spec types return `undefined`.

```typescript
async #executeReversal(spec: ReversalSpec): Promise<Map<string, EmailId> | undefined> {
  switch (spec.type) {
    case 'move_batch': {
      const uidMap = new Map<string, EmailId>();
      const byMailbox = new Map<string, EmailId[]>();
      // fromLookup: correlate batch result item.id (= move.from) back to move.to
      const fromLookup = new Map<string, EmailId>();

      for (const move of spec.moves) {
        const target = move.to.mailbox;
        const ids = byMailbox.get(target) ?? [];
        ids.push(move.from);
        byMailbox.set(target, ids);
        fromLookup.set(formatEmailId(move.from), move.to);
      }

      for (const [mailbox, ids] of byMailbox) {
        const results = await this.#imap.moveEmails(ids, mailbox);
        for (const item of results) {
          if (item.status === 'succeeded' && item.data?.targetId) {
            const originalId = fromLookup.get(formatEmailId(item.id));
            if (originalId) {
              uidMap.set(formatEmailId(originalId), item.data.targetId);
            }
          }
        }
      }

      return uidMap;
    }

    // ... other cases return undefined
  }
}
```

#### 2. `#rewriteSpecs` — new private method

Mutates remaining reversal specs in-place, replacing EmailIds that match the UID map:

```typescript
#rewriteSpecs(specs: ReversalSpec[], uidMap: Map<string, EmailId>): void {
  for (const spec of specs) {
    switch (spec.type) {
      case 'mark_read':
      case 'mark_unread':
        spec.ids = spec.ids.map(id => uidMap.get(formatEmailId(id)) ?? id);
        break;
      case 'move_batch':
        for (const move of spec.moves) {
          const newFrom = uidMap.get(formatEmailId(move.from));
          if (newFrom) move.from = newFrom;
          const newTo = uidMap.get(formatEmailId(move.to));
          if (newTo) move.to = newTo;
        }
        break;
      // noop, create_folder, add_labels: no EmailIds to rewrite (or not yet executable)
    }
  }
}
```

#### 3. `revertOperations` — thread UID map through loop

After a successful `#executeReversal` that returns a non-empty map, call `#rewriteSpecs` on remaining records' reversal specs:

```typescript
for (let i = 0; i < records.length; i++) {
  const record = records[i]!;
  try {
    const uidMap = await this.#executeReversal(record.reversal);
    this.log.remove(record.id);
    steps.push({ operationId: record.id, tool: record.tool, status: 'succeeded' });

    if (uidMap && uidMap.size > 0) {
      const remaining = records.slice(i + 1).map(r => r.reversal);
      this.#rewriteSpecs(remaining, uidMap);
    }
  } catch (err) {
    steps.push({
      operationId: record.id,
      tool:        record.tool,
      status:      'failed',
      error:       err instanceof Error ? err.message : String(err),
    });
  }
}
```

In-place mutation works because `records[j].reversal` is the same object reference — subsequent loop iterations see updated specs.

## Files Changed

| File | Change |
|------|--------|
| `src/bridge/operation-log-interceptor.ts` | `#executeReversal` returns UID map; new `#rewriteSpecs`; `revertOperations` threads map |
| `src/bridge/operation-log-interceptor.test.ts` | New test group for UID rewriting (see unit test plan below) |

## What Does NOT Change

- `ReversalSpec` type definitions — no new variants
- `EmailId` type or `formatEmailId` — reused as-is
- `OperationLog` ring buffer
- `@Tracked` / `@Irreversible` decorators
- `ImapClient` — already returns `targetId`
- Tool handlers
- `revert_operations` tool schema

## Edge Cases

| Scenario | Behavior |
|---|---|
| COPYUID missing (`targetId: undefined`) | Move succeeds but UID not added to map; downstream specs keep stale UID (best-effort) |
| Move reversal fails | Catch block skips rewriting; downstream specs keep original UIDs |
| Multiple moves in chain (A→B then B→C) | Each move reversal produces its own map; applied progressively |
| Email not referenced by any downstream spec | Map entry created but never consumed; harmless |
| Noop reversal spec in remaining chain | `#rewriteSpecs` skips it; no crash |
| Empty `move_batch.moves` array | Returns empty map; no rewriting |

## Idempotency Analysis

UID rewriting is a pure in-memory transformation on already-fetched reversal specs. It does not interact with IMAP and has no side effects beyond mutating local objects. Calling `revert_operations` twice in succession is already handled by record removal — once a record is reverted and removed, the second call throws `UNKNOWN_OPERATION_ID`.

## Unit Test Plan

New `describe('UID rewriting during chain revert')` block:

| # | Test | Setup | Assertion |
|---|------|-------|-----------|
| 1 | mark_read → move → revert rewrites flag reversal UIDs | `markRead([INBOX:42])` → `moveEmails([INBOX:42], 'Archive')` → mock move reversal returns `INBOX:55` | `setFlag` called with `[INBOX:55]`, not `[INBOX:42]` |
| 2 | mark_unread → move → revert rewrites UIDs | Same pattern with `markUnread` | `setFlag` called with new UID and `\\Seen` true |
| 3 | Multiple emails: both marked read, both moved | Two emails `INBOX:42`, `INBOX:43` → move → revert returns `INBOX:55`, `INBOX:56` | `setFlag` called with `[INBOX:55, INBOX:56]` |
| 4 | Partial COPYUID: one gets new UID, other `targetId: undefined` | Two emails moved; one result has `targetId`, other doesn't | `setFlag` called with `[INBOX:55, INBOX:43]` (first rewritten, second kept) |
| 5 | Move reversal fails → no rewrite | Mock `moveEmails` throws during revert | `setFlag` called with original `[INBOX:42]` (stale — best-effort) |
| 6 | Noop spec unaffected | `markRead` noop (already read) → `moveEmails` → revert | Noop step succeeds; no crash |
| 7 | Cascading moves: move A→B then move B→C → revert rewrites progressively | `markRead(INBOX:42)` → `moveEmails(INBOX:42, 'Folder-A')` → `moveEmails(Folder-A:101, 'Folder-B')` → revert all | After reversing Folder-B→Folder-A (gets `Folder-A:201`), next reversal uses `Folder-A:201`; after reversing Folder-A→INBOX (gets `INBOX:55`), flag reversal uses `INBOX:55` |

## Smoke Test Scenarios

From [EDD-21](edd-21-operation-log-revert.md):

| # | Scenario | Expected |
|---|----------|----------|
| 9 | Chain: `mark_read` → `move_emails` → revert from mark_read ID | All steps succeed; email back in original mailbox AND marked unread |
| 14 | Cascading moves: `mark_read` → `move_emails` A→B → `move_emails` B→C → revert from mark_read ID | All steps succeed (`stepsSucceeded: 3`); email back in original mailbox AND marked unread |
