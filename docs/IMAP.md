# IMAP Implementation Patterns

This document is the canonical reference for IMAP-level implementation patterns used throughout the codebase. For architecture-level concerns (component responsibilities, type hierarchy, session lifecycle), see `ARCHITECTURE.md`.

## EmailId String Format (Tool Boundary)

- Tool inputs accept email IDs as `"Mailbox:UID"` strings (e.g. `"INBOX:42"`).
- Tool outputs auto-serialize `EmailId` objects to strings via a `JSON.stringify` replacer in `toText()`.
- Internal `EmailId` type (`{ uid, mailbox }`) is unchanged — conversion at tool boundary only.
  - `parseEmailId(str)` — splits on LAST colon (handles `"Folders/My:Project:123"`)
  - `formatEmailId(id)` — returns `"${mailbox}:${uid}"`
  - `isEmailId(value)` — duck-type check (exactly 2 keys: `uid` number, `mailbox` string)

## Batch Operations + Index Stability

- All `ImapClient` methods taking `EmailId[]` preserve input order in results.
- `BatchItemResult<T>[]` ops: result[i] ↔ input[i], with success or `{ code, message }` error.
- Internals: group IDs by mailbox → one `getMailboxLock` per group → reorder before return.

## Batch Contract

1. **Input-order preserved** — result[i] ↔ input[i]
2. **Per-item errors** — `{ id, error: { code, message } }` for failed items
3. **Mailbox grouping** — IDs grouped internally; one lock per mailbox; results reordered before return
4. **Top-level failure** — connection/auth failure → tool error (not per-item)

## IMAP Mailbox Lock

```typescript
const conn = await this.pool.acquire();
const lock = await conn.getMailboxLock(mailbox);
try {
  // IMAP operations
} finally {
  lock.release();       // always release lock first
  this.pool.release(conn);  // then return connection to pool
}
```

## groupByMailbox Pattern (`src/bridge/imap.ts`)

- **Important:** Used to reduce mailbox locks
- Returns `MailboxGroup[]` with pre-computed indices for O(n) result placement:
```typescript
interface MailboxGroup { mailbox: string; entries: Array<{ index: number; id: EmailId }> }
```
- Callers use `entry.index` for result placement — never `indexOf`.

## imapflow Type Gotchas

- `conn.mailbox` is `false | MailboxObject` — guard with `conn.mailbox !== false`
- `messageMove()` returns `CopyResponseObject | false` — `uidMap` is `Map<number,number>`, use `.get()`

## mailparser Type Gotcha

- `ParsedMail.html` is `string | false` — use `|| undefined`, not `?? undefined`
