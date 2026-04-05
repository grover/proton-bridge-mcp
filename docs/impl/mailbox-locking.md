# Mailbox Locking

This document describes the mailbox locking pattern used throughout `ImapClient`: why it's needed, how locks interact with connections, and how `groupByMailbox` minimizes lock overhead. For connection pool mechanics, see `docs/impl/connection-pool.md`. For error handling around IMAP operations, see `docs/impl/imap-error-handling.md`.

## Why Mailbox Locking Matters

IMAP is a stateful protocol. A connection has a **single selected mailbox** at any time. Commands like `FETCH`, `SEARCH`, `STORE`, and `COPY` operate on the currently selected mailbox. If two concurrent tasks select different mailboxes on the same connection, they interfere with each other — task A selects INBOX, task B selects Trash, and task A's subsequent FETCH reads from Trash instead of INBOX.

imapflow exposes `getMailboxLock(mailbox)` to prevent this. The lock serializes access: only one task can hold a lock on a given connection at a time. While the lock is held, imapflow ensures the connection remains in the correct mailbox state for the holder.

IMAP commands that don't require a selected mailbox — `LIST`, `CREATE`, `NOOP` — don't need locks.

## The Lock/Release Ordering Invariant

Every locked operation in `ImapClient` follows the same pattern:

```typescript
const conn = await this.#pool.acquire();
const lock = await conn.getMailboxLock(mailbox);
try {
  // IMAP operations on the selected mailbox
} finally {
  lock.release();              // release lock FIRST
  this.#pool.release(conn);    // return connection SECOND
}
```

**Acquire order:** pool first, lock second. The connection must exist before a lock can be acquired on it.

**Release order:** lock first, pool second. Always in a `finally` block. Releasing the lock before returning the connection prevents another task from acquiring the same connection while the lock is still held.

This invariant is universal — no `ImapClient` method deviates from it.

## Lock-Free vs. Locked Operations

| Method | Lock Required | Why |
|--------|:---:|-----|
| `getFolders()` / `getLabels()` | No | Uses `conn.list()` — a server-level command, no mailbox selection |
| `createFolder(path)` | No | Uses `conn.mailboxCreate()` — a server-level command |
| `listMailbox(mailbox, ...)` | Yes | Selects the mailbox to fetch message summaries |
| `fetchAttachment(id, partId)` | Yes | Selects the mailbox to fetch a specific message part |
| `searchMailbox(mailbox, ...)` | Yes | Selects the mailbox to run a search query |
| `fetchSummaries(ids)` | Yes | Via `#fetchByIds` — selects each mailbox to fetch headers |
| `fetchMessage(ids)` | Yes | Via `#fetchByIds` — selects each mailbox to fetch full messages |
| `moveEmails(ids, target)` | Yes | Selects each source mailbox to move messages |
| `setFlag(ids, flag, add)` | Yes | Selects each mailbox to modify flags |
| `addLabels(ids, labels)` | Yes | Selects each source mailbox to copy messages |

## Connection-Lock Pairing Strategies

When an operation spans multiple mailboxes, callers choose how to pair connections with locks. Two patterns exist. Pool mechanics (acquire, release, draining) are documented separately in `docs/impl/connection-pool.md`.

### One Connection per Mailbox Group

Used by `moveEmails`, `setFlag`, and `#fetchByIds` (which backs `fetchSummaries` and `fetchMessage`):

```typescript
for (const { mailbox, entries } of groups) {
  const conn = await this.#pool.acquire();       // fresh connection per group
  const lock = await conn.getMailboxLock(mailbox);
  try {
    for (const { index, id } of entries) {
      // operate on id
    }
  } finally {
    lock.release();
    this.#pool.release(conn);                    // connection freed after each group
  }
}
```

Each mailbox group gets an independent connection. This allows pool-level parallelism (if the pool has multiple connections available) and frees the connection for other operations after each group completes.

**When to use:** Default choice for new operations. Preferred when each group's work is self-contained and the connection has no state that needs to carry across groups.

### One Connection for All Groups

Used by `addLabels`:

```typescript
const conn = await this.#pool.acquire();         // single connection
try {
  for (const { mailbox, entries } of groups) {
    const lock = await conn.getMailboxLock(mailbox);
    try {
      for (const { index, id } of entries) {
        // operate on id
      }
    } finally {
      lock.release();                            // lock released, connection kept
    }
  }
} finally {
  this.#pool.release(conn);                      // connection freed once at end
}
```

A single connection is reused across all mailbox groups. Locks are acquired sequentially — each lock is released before the next is acquired — so there is no deadlock risk.

**When to use:** When the IMAP commands are read-from-source operations (like `messageCopy`) where reusing the connection avoids unnecessary overhead. Only appropriate when groups are processed sequentially.

## groupByMailbox: Reducing Lock Acquisitions

Without grouping, processing N emails across M mailboxes requires up to N lock acquire/release cycles — one per email, potentially re-locking the same mailbox repeatedly. With grouping, it requires exactly M cycles — one per distinct mailbox.

### The MailboxGroup Type

```typescript
interface MailboxGroupEntry {
  index: number;    // original position in the input array
  id:    EmailId;
}

interface MailboxGroup {
  mailbox: string;
  entries: MailboxGroupEntry[];
}
```

`groupByMailbox(ids)` performs a single-pass O(n) grouping. The key feature is the **pre-computed `index`**: each entry remembers its position in the original input array, enabling O(1) result placement without searching.

### Result Ordering Patterns

Callers use two patterns to maintain input-order results after grouped processing:

**Direct-write** (batch mutations — `moveEmails`, `setFlag`, `addLabels`):

```typescript
const results = ids.map(id => ({ id, status: 'failed' as const }));

for (const { mailbox, entries } of groups) {
  // ... acquire conn and lock
  for (const { index, id } of entries) {
    results[index] = { id, status: 'succeeded', data: { ... } };
  }
}

return results;  // already in input order
```

Results are pre-allocated with a `failed` default. Each entry's `index` writes directly to the correct position. No reordering step needed.

**Map-reassemble** (reads — `#fetchByIds` backing `fetchSummaries`/`fetchMessage`):

```typescript
const byUid = new Map<string, T>();

for (const { mailbox, entries } of groups) {
  // ... acquire conn and lock, fetch items
  for (const item of items) {
    byUid.set(`${item.id.mailbox}:${item.id.uid}`, item);
  }
}

return ids
  .map(id => byUid.get(`${id.mailbox}:${id.uid}`))
  .filter((item): item is T => item !== undefined);
```

Results are collected into a Map, then reordered in a final pass over the original `ids` array. Items not found are silently dropped.

## Edge Cases and Safety

### Lock Acquisition Failure

`getMailboxLock()` either succeeds (returns a lock object) or throws (mailbox doesn't exist, connection broken). On throw:

- The `lock` variable is never assigned
- `lock.release()` in the `finally` block is never reached (the code enters `finally` but `lock` was declared in the `try` scope or before the lock line)
- The connection is still released via `pool.release(conn)` in the outer `finally`

### Mid-Operation Connection Error

If the connection errors during an IMAP command while a lock is held:

1. The pool's `#onError()` handler removes the connection from tracking
2. The `finally` block runs — `lock.release()` is called on the lock object (safe even if the underlying connection is broken; the lock is a local object)
3. `pool.release(conn)` handles cleanup (discards the stale connection)
4. The exception propagates to the caller

### Deadlock Prevention

No method acquires two locks simultaneously. Multi-mailbox methods process groups **sequentially**: acquire lock → do work → release lock → move to next group. There are no nested locks anywhere in the codebase.

Even `addLabels`, which reuses a single connection across groups, acquires locks one at a time. The risk is limited to a single lock acquisition hanging (unlikely with a local IMAP daemon), which would block only that operation, not the entire pool.

## The Pool's Role (Separation of Concerns)

The connection pool (`src/bridge/pool.ts`) has **zero knowledge of locks**:

- It manages connection creation, acquisition, release, and draining
- It does not know about `getMailboxLock()`, which mailboxes are selected, or how many locks a caller holds
- Locking is entirely an imapflow concern — `getMailboxLock()` is an `ImapFlow` API
- Callers (`ImapClient` methods) are responsible for lock discipline

The pool's error handler removes broken connections but does not release locks — that's the caller's `finally` block's job. This separation keeps the pool simple and generic.

## Checklist for New Operations

When adding a new operation to `ImapClient`:

- [ ] **Does the operation select a mailbox?** If it uses `FETCH`, `SEARCH`, `STORE`, `COPY`, `MOVE`, or any command that operates on mailbox contents → acquire a lock
- [ ] **Does it operate on multiple mailboxes?** Use `groupByMailbox()` to minimize lock acquisitions (M locks instead of N)
- [ ] **Choose connection-lock pairing:** one-per-group (default) or single-connection (only for read-from-source operations like `messageCopy`)
- [ ] **Release order:** lock first, connection second, always in `finally`
- [ ] **Never acquire two locks simultaneously** on the same connection — process groups sequentially
- [ ] **Result ordering:** use `entry.index` for direct placement (mutations) or Map-reassemble (reads)
