# MCP Tools Reference

This document describes every tool exposed by the proton-bridge-mcp server. Each tool listing includes its MCP annotations, input schema, and return type.

**Annotations** tell the MCP client how the tool behaves:

| Annotation | Meaning |
|---|---|
| `readOnlyHint: true` | The tool does not modify any data |
| `destructiveHint: true` | The tool may irreversibly change data |

All batch operations preserve input order — `result[i]` always corresponds to `input[i]`. Individual item failures are reported per-item (with `error.code` and `error.message`), while top-level failures return a tool error.

---

## Table of Contents

- [Read Operations](#read-operations)
  - [get_folders](#get_folders)
  - [get_labels](#get_labels)
  - [list_mailbox](#list_mailbox)
  - [fetch_summaries](#fetch_summaries)
  - [fetch_message](#fetch_message)
  - [fetch_attachment](#fetch_attachment)
  - [search_mailbox](#search_mailbox)
- [Write Operations](#write-operations)
  - [create_folder](#create_folder)
  - [move_emails](#move_emails)
  - [mark_read](#mark_read)
  - [mark_unread](#mark_unread)
  - [add_labels](#add_labels)
- [Maintenance](#maintenance)
  - [verify_connectivity](#verify_connectivity)
  - [drain_connections](#drain_connections)
- [Shared Types](#shared-types)

---

## Read Operations

### `get_folders`

List all mail folders with detailed metadata — message counts, unread counts, next UID, subscription status, and IMAP flags. Includes INBOX, special-use folders (Sent, Drafts, Trash, Archive, Junk, Spam), and user-created folders under `Folders/`. Proton labels, the virtual Starred mailbox, and the Labels root are excluded.

| | |
|---|---|
| **Annotations** | `readOnlyHint: true` &nbsp; `destructiveHint: false` |
| **Input** | _(none)_ |

**Returns:** `FolderInfo[]`

```jsonc
[
  {
    "path": "INBOX",              // Full hierarchy path
    "name": "INBOX",              // Leaf name
    "delimiter": "/",             // Hierarchy delimiter
    "listed": true,               // Appeared in LIST response
    "subscribed": true,           // Folder is subscribed
    "flags": ["\\HasNoChildren"], // IMAP folder attributes
    "specialUse": "\\Inbox",      // RFC 6154 special-use (optional)
    "messageCount": 142,          // Total messages (STATUS MESSAGES)
    "unreadCount": 3,             // Unseen messages (STATUS UNSEEN)
    "uidNext": 1089               // Next UID to be assigned
  },
  {
    "path": "Folders/Work",
    "name": "Work",
    "delimiter": "/",
    "listed": true,
    "subscribed": true,
    "flags": ["\\HasNoChildren"],
    "messageCount": 57,
    "unreadCount": 0,
    "uidNext": 412
  }
]
```

---

### `get_labels`

List all Proton Mail labels with detailed metadata — message counts, unread counts, next UID, subscription status, and IMAP flags. Returns only label folders (under `Labels/`), excluding regular mail folders, the virtual Starred mailbox, and the Labels root.

| | |
|---|---|
| **Annotations** | `readOnlyHint: true` &nbsp; `destructiveHint: false` |
| **Input** | _(none)_ |

**Returns:** `LabelInfo[]`

```jsonc
[
  {
    "name": "Important",              // Label name (last path component)
    "listed": true,                   // Appeared in LIST response
    "subscribed": true,               // Label is subscribed
    "flags": ["\\HasNoChildren"],     // IMAP folder attributes
    "messageCount": 23,               // Total messages (STATUS MESSAGES)
    "unreadCount": 1,                 // Unseen messages (STATUS UNSEEN)
    "uidNext": 87                     // Next UID to be assigned
  },
  {
    "name": "Work",
    "listed": true,
    "subscribed": true,
    "flags": ["\\HasNoChildren"],
    "messageCount": 14,
    "unreadCount": 0,
    "uidNext": 52
  }
]
```

---

### `list_mailbox`

List emails in a ProtonMail mailbox, newest first. Returns envelope summaries (no body content).

| | |
|---|---|
| **Annotations** | `readOnlyHint: true` &nbsp; `destructiveHint: false` |

**Input:**

| Field | Type | Default | Description |
|---|---|---|---|
| `mailbox` | `string` | `"INBOX"` | Mailbox name (e.g. `INBOX`, `Sent`, `Trash`, `Folders/Work`) |
| `limit` | `integer` | `20` | Max emails to return (1–100) |
| `offset` | `integer` | `0` | Number of emails to skip from newest |

**Returns:** [`EmailSummary[]`](#emailsummary)

---

### `fetch_summaries`

Fetch envelope summaries for a list of known email IDs. Use this when you already have specific UIDs (e.g. from a previous `list_mailbox` or `search_mailbox` call) and want to refresh their metadata.

| | |
|---|---|
| **Annotations** | `readOnlyHint: true` &nbsp; `destructiveHint: false` |

**Input:**

| Field | Type | Description |
|---|---|---|
| `ids` | `string[]` | Email IDs in `"Mailbox:UID"` format (1–50), e.g. `["INBOX:42", "Sent:7"]` |

**Returns:** [`EmailSummary[]`](#emailsummary)

---

### `fetch_message`

Fetch full message content (text/HTML body + attachment metadata) for a list of email IDs. Attachment binary content is **not** included — use `fetch_attachment` to download individual attachments.

| | |
|---|---|
| **Annotations** | `readOnlyHint: true` &nbsp; `destructiveHint: false` |

**Input:**

| Field | Type | Description |
|---|---|---|
| `ids` | `string[]` | Email IDs in `"Mailbox:UID"` format (1–20) |

**Returns:** `EmailMessage[]`

```jsonc
[
  {
    // ...all EmailSummary fields, plus:
    "textBody": "Hello, this is the plain text body...",   // optional
    "htmlBody": "<html><body>Hello...</body></html>",      // optional
    "attachments": [
      {
        "partId": "2",                // IMAP body part ID — pass to fetch_attachment
        "filename": "report.pdf",     // optional
        "contentType": "application/pdf",
        "size": 245760                // bytes
      }
    ]
  }
]
```

---

### `fetch_attachment`

Download a single email attachment by its IMAP part ID (obtained from `fetch_message` results). Returns the binary content as a base64-encoded string.

| | |
|---|---|
| **Annotations** | `readOnlyHint: true` &nbsp; `destructiveHint: false` |

**Input:**

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Email ID in `"Mailbox:UID"` format, e.g. `"INBOX:42"` |
| `partId` | `string` | Attachment part ID from `fetch_message` (e.g. `"2"`, `"1.2"`) |

**Returns:** `AttachmentContent`

```jsonc
{
  "emailId": "INBOX:42",
  "partId": "2",
  "filename": "report.pdf",        // optional
  "contentType": "application/pdf",
  "data": "JVBERi0xLjQK...",       // base64-encoded binary content
  "size": 245760                    // bytes
}
```

---

### `search_mailbox`

Search for emails in a mailbox by text query. Uses IMAP `TEXT` search, which matches against all message fields (headers, body, etc.). Returns summaries of matching emails.

| | |
|---|---|
| **Annotations** | `readOnlyHint: true` &nbsp; `destructiveHint: false` |

**Input:**

| Field | Type | Default | Description |
|---|---|---|---|
| `mailbox` | `string` | `"INBOX"` | Mailbox to search in |
| `query` | `string` | _(required)_ | Text to search for |
| `limit` | `integer` | `20` | Max results to return (1–100) |
| `offset` | `integer` | `0` | Number of results to skip |

**Returns:** [`EmailSummary[]`](#emailsummary)

---

## Write Operations

### `create_folder`

Create a new mail folder under `Folders/`. Supports nested paths — intermediate folders are created recursively by IMAP CREATE. If the folder already exists, returns `created: false` without error.

| | |
|---|---|
| **Annotations** | `readOnlyHint: false` &nbsp; `destructiveHint: false` |

**Input:**

| Field | Type | Description |
|---|---|---|
| `path` | `string` | Full folder path (must start with `"Folders/"`). Nested segments (e.g. `"Folders/Work/Projects"`) are created recursively. |

**Returns:** `CreateFolderResult`

```jsonc
{
  "path": "Folders/Work/Projects",   // Full IMAP path of the folder
  "created": true                    // true = newly created; false = already existed
}
```

**Error conditions:**
- `INVALID_PATH` — path does not start with `"Folders/"`, is bare `"Folders/"`, or is empty after stripping trailing slashes
- IMAP failure -> top-level thrown error

---

### `move_emails`

Move a batch of emails to a target mailbox. Returns per-email results with source/target info and new UIDs.

| | |
|---|---|
| **Annotations** | `readOnlyHint: false` &nbsp; `destructiveHint: true` |

> **Destructive:** Moving an email changes its UID and mailbox. The original UID becomes invalid.

**Input:**

| Field | Type | Description |
|---|---|---|
| `ids` | `string[]` | Email IDs in `"Mailbox:UID"` format (1–50) |
| `targetMailbox` | `string` | Destination mailbox (e.g. `Archive`, `Trash`, `Folders/Work`) |

**Returns:** `BatchItemResult<MoveResult>[]`

```jsonc
[
  {
    "id": "INBOX:42",
    "data": {
      "fromMailbox": "INBOX",
      "toMailbox": "Archive",
      "targetId": "Archive:108"    // new ID, or null if unknown
    }
  },
  {
    "id": "INBOX:99",
    "error": { "code": "NOT_FOUND", "message": "UID 99 not found in INBOX" }
  }
]
```

---

### `mark_read`

Mark a batch of emails as read by adding the `\Seen` IMAP flag.

| | |
|---|---|
| **Annotations** | `readOnlyHint: false` &nbsp; `destructiveHint: false` |

**Input:**

| Field | Type | Description |
|---|---|---|
| `ids` | `string[]` | Email IDs in `"Mailbox:UID"` format (1–50) |

**Returns:** `BatchItemResult<FlagResult>[]`

```jsonc
[
  {
    "id": "INBOX:42",
    "data": {
      "flagsAfter": ["\\Seen", "\\Flagged"]   // full flag set after the operation
    }
  }
]
```

---

### `mark_unread`

Mark a batch of emails as unread by removing the `\Seen` IMAP flag.

| | |
|---|---|
| **Annotations** | `readOnlyHint: false` &nbsp; `destructiveHint: false` |

**Input:**

| Field | Type | Description |
|---|---|---|
| `ids` | `string[]` | Email IDs in `"Mailbox:UID"` format (1–50) |

**Returns:** `BatchItemResult<FlagResult>[]`

_(Same structure as `mark_read` — see above.)_

---

### `add_labels`

Add one or more Proton Mail labels to a batch of emails. Each email is copied into the corresponding label folder via IMAP COPY, so it simultaneously remains in its original folder. Returns per-email results including the new UID in each label folder.

| | |
|---|---|
| **Annotations** | `readOnlyHint: false` &nbsp; `destructiveHint: false` |

**Input:**

| Field | Type | Description |
|---|---|---|
| `ids` | `string[]` | Email IDs in `"Mailbox:UID"` format (1–50) |
| `labelNames` | `string[]` | Label names to apply (plain names without `Labels/` prefix, 1+) |

**Returns:** `AddLabelsBatchResult`

```jsonc
{
  "items": [
    {
      "id": "INBOX:42",
      "data": [
        {
          "labelPath": "Labels/Important",
          "newId": "Labels/Important:7"
        },
        {
          "labelPath": "Labels/Work",
          "newId": "Labels/Work:12"
        }
      ]
    },
    {
      "id": "INBOX:99",
      "error": { "code": "COPY_FAILED", "message": "UID 99 not found in INBOX" }
    }
  ]
}
```

> **Note:** If a requested label does not exist as an IMAP folder (e.g. `Labels/Foo`), the corresponding entry in `data` will have `labelPath` but no `newId`. If **all** requested labels are missing, the item reports a `LABEL_NOT_FOUND` error instead.

---

## Maintenance

### `verify_connectivity`

Test the connection to the Proton Bridge IMAP server. Acquires a connection from the pool, measures latency, and releases it. Use this to check if Bridge is running and reachable.

| | |
|---|---|
| **Annotations** | `readOnlyHint: true` &nbsp; `destructiveHint: false` |
| **Input** | _(none)_ |

**Returns:**

```jsonc
{
  "status": "succeeded",
  "data": {
    "latencyMs": 12        // round-trip time in milliseconds
  }
}
// or on failure:
{
  "status": "failed",
  "data": {
    "error": "Connection refused"
  }
}
```

---

### `drain_connections`

Close all connections in the IMAP connection pool immediately. Useful for forcing reconnection after a Proton Bridge restart, or to recover from stale connection errors.

| | |
|---|---|
| **Annotations** | `readOnlyHint: true` &nbsp; `destructiveHint: false` |
| **Input** | _(none)_ |

**Returns:**

```jsonc
{
  "status": "succeeded",
  "data": {
    "message": "Connection pool drained. New connections will be created on next request."
  }
}
```

---

## Shared Types

### `EmailId`

Stable identifier for an email. On tool interfaces, represented as a `"Mailbox:UID"` string (e.g. `"INBOX:42"`). Internally stored as `{ uid: number, mailbox: string }` — conversion happens at the tool boundary via `parseEmailId()` (input) and `formatEmailId()` (output).

Mailbox names may contain colons (e.g. `"Folders/My:Project"`); the parser splits on the **last** colon.

```
"INBOX:42"                        → { uid: 42, mailbox: "INBOX" }
"Folders/My:Project:123"          → { uid: 123, mailbox: "Folders/My:Project" }
```

### `EmailAddress`

RFC 5321 email address with optional display name.

```typescript
{
  address: string;  // e.g. "alice@example.com"
  name?: string;    // e.g. "Alice Smith"
}
```

### `EmailSummary`

Envelope metadata for an email (no body content).

```typescript
{
  id: string;                   // "Mailbox:UID" format, e.g. "INBOX:42"
  messageId?: string;         // RFC 2822 Message-ID
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  replyTo: EmailAddress[];
  subject: string;
  date?: Date;                // ISO 8601 string in JSON
  size?: number;              // bytes
  flags: string[];            // e.g. ["\\Seen", "\\Flagged"]
  hasAttachments: boolean;
}
```

### `BatchItemResult<T>`

Per-item result for batch operations. Either `data` or `error` is present, never both.

```typescript
{
  id: string;                   // "Mailbox:UID" format
  data?: T;                   // present on success
  error?: {
    code: string;             // e.g. "NOT_FOUND", "LOCK_FAILED"
    message: string;
  };
}
```
