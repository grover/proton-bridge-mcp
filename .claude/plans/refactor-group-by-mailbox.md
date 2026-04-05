# Refactoring Plan: `groupByMailbox` with Index Tracking

## Problem

Four callers of `groupByMailbox` use `ids.indexOf(id)` to map results back to the original input array. This is O(n) per lookup (O(n²) total for a batch) and relies on reference equality — fragile and non-obvious.

## New Signature

```typescript
interface MailboxGroupEntry {
  index: number;    // position in the original ids array
  id:    EmailId;   // the EmailId at that position
}

interface MailboxGroup {
  mailbox: string;
  entries: MailboxGroupEntry[];
}

function groupByMailbox(ids: EmailId[]): MailboxGroup[]
```

- Returns an **array** — every caller iterates, none do keyed lookups
- Entries carry both `index` and `id` — callers use `entry.id` directly (readable) and `entry.index` for result placement (no `indexOf`)
- Both types are module-private (not exported)

## Optimized Implementation

```typescript
function groupByMailbox(ids: EmailId[]): MailboxGroup[] {
  const groups: MailboxGroup[] = [];
  const seen = new Map<string, number>();  // mailbox → position in groups[]
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const gi = seen.get(id.mailbox);
    if (gi !== undefined) {
      groups[gi].entries.push({ index: i, id });
    } else {
      seen.set(id.mailbox, groups.length);
      groups.push({ mailbox: id.mailbox, entries: [{ index: i, id }] });
    }
  }
  return groups;
}
```

**Why not a Set?** A `Set` provides O(1) membership testing, but we never test membership — we iterate entries and need ordered pairs `{ index, id }`. The `Map<string, number>` is the right O(1) structure for construction-time group lookup. A `Set<string>` of mailbox names would be redundant since `Map.has()` already serves that purpose.

**Complexity:** O(n) time, O(n) space. Single pass. No intermediate conversions. The `Map` is used only during construction and discarded. The `groups` array is the final result — no spread, no copy.

## Caller-by-Caller Changes

### 1. `moveEmails` (line ~220)

**Before:**
```typescript
const groups = groupByMailbox(ids);
for (const [mailbox, mailboxIds] of groups) {
  const lock = await conn.getMailboxLock(mailbox);
  for (const id of mailboxIds) {
    const idx = ids.indexOf(id);
    results[idx] = { id, data: ... };
  }
}
```

**After:**
```typescript
const groups = groupByMailbox(ids);
for (const { mailbox, entries } of groups) {
  const lock = await conn.getMailboxLock(mailbox);
  for (const { index, id } of entries) {
    results[index] = { id, data: ... };
  }
}
```

### 2. `setFlag` (line ~260)

Same transformation — destructure `{ index, id }` from entries.

### 3. `addLabels` (line ~299)

Same transformation — `items[index] = { id, ... }`.

### 4. `#fetchByIds` (line ~347)

**Before:** Destructures `[mailbox, mailboxIds]`, passes `mailboxIds` to fetcher.

**After:**
```typescript
for (const { mailbox, entries } of groups) {
  const mailboxIds = entries.map(e => e.id);
  const items = await fetcher(conn, mailbox, mailboxIds);
  ...
}
```

This caller doesn't use `index` (reorders via a `byUid` Map), so it extracts `id` from entries for the fetcher. Minimal overhead.

## Files Changed

**Only one file:** `src/bridge/imap.ts`

No exports change. Both types are private. No downstream consumers affected.

## Edge Cases

- **Empty input:** Returns `[]`. All callers' loops simply don't execute.
- **Duplicate UIDs in same mailbox:** Each gets its own entry with distinct `index` — correct, unlike `indexOf` which silently returns first occurrence.
- **`#fetchByIds` fetcher contract:** Receives `entries.map(e => e.id)` — same `EmailId[]` shape, no fetcher changes.

## Risk

**Low.** Single-file change, private function, mechanical transformation. O(n²) → O(n).
