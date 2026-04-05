# Email Identity

How email identity works across the three layers: IMAP protocol, Proton Bridge, and the MCP server.

## IMAP UIDs

Every email in an IMAP mailbox has a **UID** — a positive integer assigned by the server, unique within that mailbox. UIDs are monotonically increasing and stable across sessions (unlike sequence numbers which shift on every expunge). However:

- **UIDs are not globally unique.** `INBOX:42` and `Sent:42` are different emails.
- **UIDs change on move.** IMAP MOVE/COPY assigns a new UID in the target mailbox. The old UID is invalidated.
- **COPYUID may be absent.** The server should report the new UID via the `COPYUID` response code, but Proton Bridge doesn't always do so (see [IMAP error handling](imap-error-handling.md)).

## Proton Bridge: labels as folders

Proton Mail uses labels — non-exclusive tags where one email can carry multiple labels. IMAP has no concept of tags, so Proton Bridge virtualizes labels as folders under `Labels/`. Adding label "Work" to `INBOX:42` means IMAP COPY into `Labels/Work`, creating a copy with a new UID (e.g., `Labels/Work:7`).

This creates **two identities** for the same underlying message:
- `INBOX:42` — the original, addressable by all tools
- `Labels/Work:7` — a virtual copy, an IMAP artifact

The copy UID is meaningless outside the label folder context. It cannot be used with `fetch_message`, `move_emails`, or `mark_read` — those tools operate on source mailbox UIDs. See [label handling](label-handling.md) for the full devirtualization design.

## MCP Server: EmailId

The MCP server uses `EmailId` as the identity type:

```typescript
interface EmailId {
  uid:     number;   // IMAP UID
  mailbox: string;   // Mailbox path, e.g. "INBOX", "Folders/Work"
}
```

### Serialization at tool boundary

- **Tool inputs:** Accept `"Mailbox:UID"` strings (e.g., `"INBOX:42"`). Parsed by `parseEmailId()` which splits on the last colon (handles colons in mailbox names like `"Folders/My:Project:123"`).
- **Tool outputs:** `EmailId` objects are auto-serialized to `"Mailbox:UID"` strings via a `JSON.stringify` replacer in `toText()`.
- **Internal code:** Uses the `EmailId` object form (`{ uid, mailbox }`).

### Utilities

| Function | Purpose |
|---|---|
| `parseEmailId(str)` | `"INBOX:42"` → `{ uid: 42, mailbox: "INBOX" }` |
| `formatEmailId(id)` | `{ uid: 42, mailbox: "INBOX" }` → `"INBOX:42"` |
| `isEmailId(value)` | Duck-type guard: exactly 2 keys, `uid` is number, `mailbox` is string |
| `emailIdStringSchema` | Zod schema with `.transform(parseEmailId)` for tool input validation |

### UID instability during operations

IMAP MOVE changes UIDs. When `move_emails` moves `INBOX:42` to `Archive`, it gets a new UID like `Archive:101`. The original `INBOX:42` is invalid.

This affects operation log reversal: if a prior operation recorded `INBOX:42` and a subsequent move changed it to `Archive:101`, the reversal must use the new UID. The `#rewriteSpecs` method in `OperationLogInterceptor` handles this — during chain reverts, each successful move reversal produces a UID map that rewrites subsequent reversal specs. See [operation log](operation-log-revert.md) for details.

### Label copy UIDs: never exposed

Label operations (`add_labels`, `remove_labels`) internally create/destroy copies in `Labels/*` folders. These copy UIDs are:
- Used internally for IMAP COPY/EXPUNGE operations
- Captured in the operation log `ReversalSpec` for `add_labels` reversal
- **Never exposed in tool responses** — LLMs see only `{ labelName, applied/removed }`

See [label handling](label-handling.md) for the devirtualization rules.

## References

- [IMAP patterns](../IMAP.md) — batch operations, locking, type gotchas
- [Label handling](label-handling.md) — devirtualization of Proton Bridge label folders
- [Operation log](operation-log-revert.md) — UID rewriting during chain reverts
- [IMAP error handling](imap-error-handling.md) — missing COPYUID, Proton Bridge quirks
