# Plan: EmailId String Format Refactor

## Goal

On MCP tool interfaces, represent email IDs as strings in `Mailbox:UID` format (e.g. `INBOX:42`) instead of `{ uid, mailbox }` objects. Internally, `EmailId` stays as-is.

## Approach: Generic JSON Replacer

Instead of per-type serializers, modify `toText()` in `server.ts` to use a `JSON.stringify` replacer that automatically converts any `EmailId` to its string form. Input parsing uses `parseEmailId()` in each handler.

## Changes

### `src/types/email.ts` — Add three utility functions

- `formatEmailId(id: EmailId): string` — returns `${mailbox}:${uid}`
- `parseEmailId(str: string): EmailId` — splits on LAST colon (handles mailbox names with colons), validates UID is positive integer, throws clear error on malformed input
- `isEmailId(value: unknown): value is EmailId` — duck-type check: typeof object, has `uid` (number) + `mailbox` (string), exactly 2 keys

### `src/server.ts` — Modify `toText()` replacer

```typescript
function toText(data: unknown): string {
  return JSON.stringify(data, (_key, value) => {
    if (isEmailId(value) && Object.keys(value).length === 2) {
      return formatEmailId(value);
    }
    return value;
  }, 2);
}
```

One change, handles ALL output serialization automatically.

### Tool handlers accepting EmailId input (7 files)

Change Zod schemas from `emailIdSchema` objects to `z.string().min(1)`. Each handler calls `parseEmailId()`:

| Tool | Change |
|---|---|
| `fetch_summaries` | `ids: z.array(z.string().min(1))`, parse in handler |
| `fetch_message` | Same |
| `fetch_attachment` | `id: z.string().min(1)`, parse in handler |
| `move_emails` | `ids: z.array(z.string().min(1))`, parse in handler |
| `mark_read` | Same |
| `mark_unread` | Same |
| `add_labels` | Same |

### What does NOT change

- `src/bridge/imap.ts` — ImapClient keeps accepting/returning `EmailId` objects
- `src/types/operations.ts` — internal types unchanged
- No per-type serializers needed

## Files Changed (12 total)

| File | Change |
|---|---|
| `src/types/email.ts` | Add `formatEmailId`, `parseEmailId`, `isEmailId` |
| `src/server.ts` | Modify `toText()` with replacer |
| `src/tools/fetch-summaries.ts` | Input: string array + parse |
| `src/tools/fetch-message.ts` | Input: string array + parse |
| `src/tools/fetch-attachment.ts` | Input: string + parse |
| `src/tools/move-emails.ts` | Input: string array + parse |
| `src/tools/mark-read.ts` | Input: string array + parse |
| `src/tools/mark-unread.ts` | Input: string array + parse |
| `src/tools/add-labels.ts` | Input: string array + parse |
| `CLAUDE.md` | Document string ID format |
| `ARCHITECTURE.md` | Update type docs |
| `docs/tools/README.md` | Update input/output examples |

## Edge Cases

- **Mailbox with colons:** `"Folders/My:Project:123"` → mailbox `"Folders/My:Project"`, UID `123`
- **Malformed input:** `"nocolon"` → error. `"INBOX:"` → error. `"INBOX:0"` → error
- **Duck-typing safety:** `isEmailId` checks type + exactly 2 keys to avoid false matches

## Smoke Test Scenarios

1. `list_mailbox` → IDs as `"INBOX:42"` strings, not objects
2. `fetch_summaries` with `["INBOX:42"]` → works, returns string IDs
3. `fetch_attachment` with `"INBOX:42"` → works
4. `move_emails` with string IDs → `id` and `targetId` both strings
5. `mark_read` with `["INBOX:42"]` → works
6. `add_labels` with string IDs → `id` and `newId` both strings
7. `"nocolon"` → clear parse error
8. `"Folders/My:Project:123"` → correctly parsed
