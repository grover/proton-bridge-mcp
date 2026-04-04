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
  - [list_folders](#list_folders)
  - [list_mailbox](#list_mailbox)
  - [fetch_summaries](#fetch_summaries)
  - [fetch_message](#fetch_message)
  - [fetch_attachment](#fetch_attachment)
  - [search_mailbox](#search_mailbox)
- [Write Operations](#write-operations)
  - [move_emails](#move_emails)
  - [mark_read](#mark_read)
  - [mark_unread](#mark_unread)
- [Maintenance](#maintenance)
  - [verify_connectivity](#verify_connectivity)
  - [drain_connections](#drain_connections)
- [Shared Types](#shared-types)

---

## Read Operations

### `list_folders`

List all IMAP mailboxes/folders available in the ProtonMail account. Returns folder paths, names, hierarchy delimiters, and special-use flags (Sent, Drafts, Trash, etc.).

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
    "flags": ["\\HasNoChildren"], // IMAP folder attributes
    "specialUse": "\\Inbox"       // RFC 6154 special-use (optional)
  },
  {
    "path": "Folders/Work",
    "name": "Work",
    "delimiter": "/",
    "flags": ["\\HasNoChildren"],
    "specialUse": null
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
| `ids` | [`EmailId[]`](#emailid) | Email IDs to fetch (1–50) |

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
| `ids` | [`EmailId[]`](#emailid) | Email IDs to fetch (1–20) |

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
| `id` | [`EmailId`](#emailid) | The email containing the attachment |
| `partId` | `string` | Attachment part ID from `fetch_message` (e.g. `"2"`, `"1.2"`) |

**Returns:** `AttachmentContent`

```jsonc
{
  "emailId": { "uid": 42, "mailbox": "INBOX" },
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

### `move_emails`

Move a batch of emails to a target mailbox. Returns per-email results with source/target info and new UIDs.

| | |
|---|---|
| **Annotations** | `readOnlyHint: false` &nbsp; `destructiveHint: true` |

> **Destructive:** Moving an email changes its UID and mailbox. The original UID becomes invalid.

**Input:**

| Field | Type | Description |
|---|---|---|
| `ids` | [`EmailId[]`](#emailid) | Emails to move (1–50) |
| `targetMailbox` | `string` | Destination mailbox (e.g. `Archive`, `Trash`, `Folders/Work`) |

**Returns:** `BatchItemResult<MoveResult>[]`

```jsonc
[
  {
    "id": { "uid": 42, "mailbox": "INBOX" },
    "data": {
      "fromMailbox": "INBOX",
      "toMailbox": "Archive",
      "targetId": { "uid": 108, "mailbox": "Archive" }  // new UID, or null if unknown
    }
  },
  {
    "id": { "uid": 99, "mailbox": "INBOX" },
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
| `ids` | [`EmailId[]`](#emailid) | Emails to mark as read (1–50) |

**Returns:** `BatchItemResult<FlagResult>[]`

```jsonc
[
  {
    "id": { "uid": 42, "mailbox": "INBOX" },
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
| `ids` | [`EmailId[]`](#emailid) | Emails to mark as unread (1–50) |

**Returns:** `BatchItemResult<FlagResult>[]`

_(Same structure as `mark_read` — see above.)_

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
  "success": true,
  "latencyMs": 12          // round-trip time in milliseconds
}
// or on failure:
{
  "success": false,
  "error": "Connection refused"
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
  "message": "Drained 3 connections"
}
```

---

## Shared Types

### `EmailId`

Stable identifier for an email. UIDs are unique within a mailbox but not globally.

```typescript
{
  uid: number;      // IMAP UID (positive integer)
  mailbox: string;  // Mailbox path, e.g. "INBOX"
}
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
  id: EmailId;
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
  id: EmailId;
  data?: T;                   // present on success
  error?: {
    code: string;             // e.g. "NOT_FOUND", "LOCK_FAILED"
    message: string;
  };
}
```
