# Plan: EmailId String Format Refactor

## Goal

On MCP tool interfaces, represent email IDs as strings in `Mailbox:UID` format (e.g. `INBOX:42`) instead of `{ uid, mailbox }` objects. Internally, `EmailId` stays as-is.

## Approach: Generic JSON Replacer

Instead of per-type serializers, modify `toText()` in `server.ts` to use a `JSON.stringify` replacer that automatically converts any `EmailId` to its string form. Input parsing uses `parseEmailId()` in each handler.

## Changes

### `src/types/email.ts` — Add utility functions and shared schema

- `formatEmailId(id: EmailId): string` — returns `${mailbox}:${uid}`
- `parseEmailId(str: string): EmailId` — splits on LAST colon (handles mailbox names with colons), validates UID is positive integer, throws clear error on malformed input
- `isEmailId(value: unknown): value is EmailId` — strict duck-type check: typeof object, not null, exactly 2 keys named `uid` (number) and `mailbox` (string):
  ```typescript
  export function isEmailId(value: unknown): value is EmailId {
    if (typeof value !== 'object' || value === null) return false;
    const keys = Object.keys(value);
    return keys.length === 2
      && 'uid' in value && typeof (value as Record<string, unknown>).uid === 'number'
      && 'mailbox' in value && typeof (value as Record<string, unknown>).mailbox === 'string';
  }
  ```
- `emailIdStringSchema` — shared Zod schema with `.transform()` for tool input:
  ```typescript
  export const emailIdStringSchema = z.string()
    .min(3)
    .describe('Email ID in "Mailbox:UID" format (e.g. "INBOX:42")')
    .transform((str) => parseEmailId(str));
  ```
  Zod handles the error path; handlers receive already-parsed `EmailId` objects.

### `src/server.ts` — Modify `toText()` replacer

```typescript
function toText(data: unknown): string {
  return JSON.stringify(data, (_key, value) => {
    if (isEmailId(value)) return formatEmailId(value);
    return value;
  }, 2);
}
```

`isEmailId` already verifies exactly 2 keys — no redundant check needed.

One change, handles ALL output serialization automatically.

### Tool handlers accepting EmailId input (7 files)

Replace per-file `emailIdSchema` objects with the shared `emailIdStringSchema` (which includes `.transform(parseEmailId)`). Handlers receive already-parsed `EmailId` objects — no manual parsing needed:

| Tool | Schema change | Handler change |
|---|---|---|
| `fetch_summaries` | `ids: z.array(emailIdStringSchema)` | `args.ids` is `EmailId[]` — pass directly to `imap` |
| `fetch_message` | Same | Same |
| `fetch_attachment` | `id: emailIdStringSchema` | `args.id` is `EmailId` — pass directly |
| `move_emails` | `ids: z.array(emailIdStringSchema)` | Same |
| `mark_read` | Same | Same |
| `mark_unread` | Same | Same |
| `add_labels` | Same | Same |

**Caveat:** Verify MCP SDK's Zod integration supports `.transform()`. If not, fall back to `z.string().min(3).describe(...)` + manual `parseEmailId()` in each handler.

### What does NOT change

- `src/bridge/imap.ts` — ImapClient keeps accepting/returning `EmailId` objects
- `src/types/operations.ts` — internal types unchanged
- No per-type serializers needed

## Files Changed (12 total)

| File | Change |
|---|---|
| `src/types/email.ts` | Add `formatEmailId`, `parseEmailId`, `isEmailId`, `emailIdStringSchema` |
| `src/server.ts` | Modify `toText()` with replacer; import `isEmailId`, `formatEmailId` |
| `src/tools/fetch-summaries.ts` | Use `emailIdStringSchema`; remove local `emailIdSchema` |
| `src/tools/fetch-message.ts` | Same |
| `src/tools/fetch-attachment.ts` | Use `emailIdStringSchema` for single ID |
| `src/tools/move-emails.ts` | Use `emailIdStringSchema`; remove local `emailIdSchema` |
| `src/tools/mark-read.ts` | Same |
| `src/tools/mark-unread.ts` | Same |
| `src/tools/add-labels.ts` | Same |
| `CLAUDE.md` | Document string ID format |
| `ARCHITECTURE.md` | Update type docs |
| `docs/tools/README.md` | Update input/output examples |

## Edge Cases

- **Mailbox with colons:** `"Folders/My:Project:123"` → mailbox `"Folders/My:Project"`, UID `123`
- **Malformed input:** `"nocolon"` → error. `"INBOX:"` → error. `"INBOX:0"` → error
- **Duck-typing safety:** `isEmailId` checks type + exactly 2 keys named `uid` (number) and `mailbox` (string) to avoid false matches against other 2-key objects

## Smoke Test Scenarios

1. `list_mailbox` → IDs as `"INBOX:42"` strings, not objects
2. `fetch_summaries` with `["INBOX:42"]` → works, returns string IDs
3. `fetch_attachment` with `"INBOX:42"` → works
4. `move_emails` with string IDs → `id` and `targetId` both strings
5. `mark_read` with `["INBOX:42"]` → works
6. `add_labels` with string IDs → `id` and `newId` both strings
7. `"nocolon"` → clear parse error
8. `"Folders/My:Project:123"` → correctly parsed
9. `search_mailbox` → IDs in results as `"INBOX:42"` strings
10. `fetch_message` with `["INBOX:42"]` → works, IDs in response as strings
