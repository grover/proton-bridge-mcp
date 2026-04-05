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

## Label Operations

### Adding labels (`add_labels`)

Uses `conn.messageCopy()` to copy the source email into `Labels/<name>`. The copy gets a new UID in the label folder. The original remains in its source mailbox.

### Removing labels (`remove_labels`)

Uses `conn.messageDelete()` (STORE \Deleted + EXPUNGE) on the copy inside `Labels/<name>`. Proton Bridge translates EXPUNGE from a label-type mailbox into `UnlabelMessages()` — the label is removed from the message, but no permanent deletion occurs. The permanent deletion path only activates for Trash/Drafts.

**Two-phase algorithm:**
1. Fetch each source email's Message-ID header from its source mailbox
2. For each label folder: search by Message-ID to locate the copy's UID, then `messageDelete()` it

**Why Message-ID search?** The copy in the label folder has a different UID than the source. We need to find it by content identity (Message-ID header), not by UID.

**Safety:** EXPUNGE from `Labels/*` folders is safe — Proton Bridge's `RemoveMessagesFromMailbox()` ([connector.go:408-414](https://github.com/ProtonMail/proton-bridge/blob/main/internal/services/imapservice/connector.go#L408)) only calls `UnlabelMessages()` for label-type mailboxes. Never use this mechanism on Trash or Drafts folders.

## Type Gotchas

See [docs/impl/imap-error-handling.md](../impl/imap-error-handling.md) § "imapflow/mailparser Type Quirks" for `conn.mailbox`, `messageMove()`, and `ParsedMail.html` gotchas.
