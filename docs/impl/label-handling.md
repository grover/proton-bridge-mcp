# Label Handling Design

## The problem: labels are not folders

ProtonMail labels are a tagging system. A single email can carry multiple labels simultaneously without leaving its mailbox. Labels are metadata associations, not physical locations — an email labeled "Work" and "Urgent" still lives in INBOX.

Proton Bridge has no native IMAP representation for this. IMAP understands folders (SELECT, COPY, MOVE) and flags (\Seen, \Flagged), but has no concept of user-defined tags. Bridge virtualizes labels as IMAP folders under the `Labels/` namespace. Adding the "Work" label to `INBOX:42` becomes an IMAP COPY of that message into `Labels/Work`, giving the copy a new UID (e.g., `Labels/Work:7`). Removing the label EXPUNGEs the copy — Bridge translates this back into an `UnlabelMessages()` API call, preserving the original.

This virtualization creates two identities for the same email:
- **The original:** `INBOX:42` — the real message, reachable by other tools
- **The copy:** `Labels/Work:7` — a virtual artifact of the Bridge's IMAP emulation

## The MCP server devirtualizes labels

This MCP server strips away the IMAP folder abstraction and presents labels as what they actually are in ProtonMail: flat tags applied to emails. The design rule:

> **No virtualized folder path may ever appear in a tool response.** The `Labels/` prefix and copy UIDs are internal IMAP implementation details. Exposing them to an LLM creates false affordances — the LLM may try to `fetch_message` on `Labels/Work:7`, `move_emails` from `Labels/Work`, or pass `Labels/Work` where a plain label name is expected.

### How each tool enforces this

| Tool | Input | Output | Devirtualization |
|---|---|---|---|
| `get_labels` | — | `LabelInfo[]` | `LabelInfo = MailboxBase` — deliberately omits `path` and `delimiter` fields that `FolderInfo` has. Returns `name: "Work"`, never `path: "Labels/Work"`. |
| `create_label` | `name: "Work"` | `{ name, created }` | ImapClient constructs `Labels/Work` internally, calls `mailboxCreate`, maps result back to `{ name }`. |
| `delete_label` | `name: "Work"` | `{ name, deleted }` | ImapClient constructs `Labels/Work` internally, calls `mailboxDelete`, maps result back to `{ name }`. |
| `remove_labels` | `labelNames: ["Work"]` | `{ labelName, removed }` | Uses Message-ID search to find copies in label folders. Returns plain `labelName`, not IMAP path. |
| `add_labels` | `labelNames: ["Work"]` | `{ labelName, applied }` | Returns plain label name and success flag. Fixed in #54. |

## Finding the true message

An LLM working with labels should never need to know about `Labels/Work:7`. The contract:

1. **Emails are identified by their source mailbox ID** (e.g., `INBOX:42`). This is the identity returned by `list_mailbox`, `fetch_summaries`, `search_mailbox`, and `fetch_message`.
2. **Label operations accept source IDs.** Both `add_labels` and `remove_labels` take `ids` in `"Mailbox:UID"` format — the same IDs the LLM already has from read tools. The MCP server resolves the internal copy UIDs transparently.
3. **`remove_labels` uses Message-ID search internally.** Given `INBOX:42`, it fetches the Message-ID header from INBOX, then searches `Labels/Work` for a message with that header to find the copy's UID. This two-phase lookup is invisible to the LLM.

The flow is always: read tools give you source IDs → label tools accept those same source IDs → internal resolution is hidden.

## Is a `list_label` tool needed?

`list_mailbox` can technically be called on `Labels/Work` — it will return summaries of the copies in that label folder. But this is problematic:

1. **The UIDs are wrong.** Summaries would show `Labels/Work:7` instead of `INBOX:42`. These copy UIDs are useless for any other tool — you cannot `mark_read` on `Labels/Work:7` and expect the original to change (Proton Bridge may or may not sync flags across copies).
2. **The mailbox path leaks.** The LLM would need to know the `Labels/` prefix to call `list_mailbox("Labels/Work")`, which is exactly what we are trying to hide.
3. **Duplicates across labels.** The same email appears as different copies in each label folder. Listing multiple labels produces duplicates with different UIDs, which is confusing.

A dedicated `list_label` tool could solve this by:
- Accepting a plain label name (e.g., `"Work"`)
- Internally listing `Labels/Work`
- For each copy, resolving back to the source mailbox ID via Message-ID search (the reverse of `remove_labels`)
- Returning summaries with source IDs, not copy UIDs

However, this is expensive — every email requires a Message-ID lookup back to its source mailbox. For a label with 100 emails, that is 100 extra IMAP searches. A pragmatic alternative: use `search_mailbox` on the source mailbox (e.g., INBOX) with query terms, then use `get_labels` to see which labels exist. The current tool set supports the workflow "find emails, then label them" — the reverse workflow "list emails by label" is a future enhancement that requires the resolution infrastructure described above.

## Type hierarchy

```
MailboxBase           { name, listed, subscribed, flags, specialUse?, messageCount, unreadCount, uidNext }
├── FolderInfo        extends MailboxBase + { path, delimiter }    ← get_folders
└── LabelInfo         = MailboxBase                                ← get_labels (no path!)

CreateMailboxResult   { path, created }       ← internal IMAP result
├── CreateFolderResult = CreateMailboxResult   ← create_folder returns path (folders need it)
└── CreateLabelResult  { name, created }      ← create_label maps path → name

DeleteMailboxResult   { path, deleted }       ← internal IMAP result
├── DeleteFolderResult = DeleteMailboxResult   ← delete_folder returns path
└── DeleteLabelResult  { name, deleted }      ← delete_label maps path → name
```

The internal `*MailboxResult` types carry the IMAP path for shared helpers (`#createMailbox`, `#deleteMailbox`). The label-specific result types map `path` to `name` at the `ImapClient` boundary — before the data reaches the interceptor or tool handler.

## References

- [Operation log and revert](operation-log-revert.md) — how `@Tracked` captures copy UIDs for reversal
- [MCP tool interfaces](mcp-tool-interfaces.md) — `ReadOnlyMailOps` / `MutatingMailOps` segregation
- [Email Identity](email-identity.md) — UID handling across IMAP, Proton Bridge, and MCP Server
- [Issue #54](https://github.com/grover/proton-bridge-mcp/issues/54) — `add_labels` path leakage bug (fixed)
