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

All `ImapClient` batch methods preserve input order in results.
See [docs/impl/mailbox-locking.md](../impl/mailbox-locking.md) for the `groupByMailbox` pattern and result ordering strategies.

## Batch Contract

1. **Input-order preserved** — result[i] ↔ input[i]
2. **Per-item errors** — `{ id, error: { code, message } }` for failed items
3. **Mailbox grouping** — IDs grouped internally; one lock per mailbox; results reordered before return
4. **Top-level failure** — connection/auth failure → tool error (not per-item)

## IMAP Mailbox Lock

See [docs/impl/mailbox-locking.md](../impl/mailbox-locking.md) for the full locking pattern, lock/release ordering invariant, and edge cases.

## groupByMailbox Pattern

See [docs/impl/mailbox-locking.md](../impl/mailbox-locking.md) for the complete `groupByMailbox` specification.

## Type Gotchas

See [docs/impl/imap-error-handling.md](../impl/imap-error-handling.md) § "imapflow/mailparser Type Quirks" for `conn.mailbox`, `messageMove()`, and `ParsedMail.html` gotchas.
