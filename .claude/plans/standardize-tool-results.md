# Plan: Standardize Tool Result Status Fields

## Goal

Every tool response gets a top-level `status` field. Batch items get per-item `status`.

## New Types (`src/types/operations.ts`)

```typescript
type ToolStatus = 'succeeded' | 'partial' | 'failed';
type ItemStatus = 'succeeded' | 'failed';
```

### Batch Results

```typescript
interface BatchItemResult<T> {
  id:     EmailId;
  status: ItemStatus;        // NEW
  data?:  T;
  error?: BatchItemError;
}

interface BatchToolResult<T> {  // NEW generic wrapper
  status: ToolStatus;
  items:  BatchItemResult<T>[];
}
```

### Read-Only & Single-Item Results

```typescript
interface ListToolResult<T> {   // for array-returning tools
  status: ToolStatus;
  items:  T[];
}

interface SingleToolResult<T> { // for single-item tools
  status: ToolStatus;
  data:   T;
}
```

## Utility

```typescript
function batchStatus<T>(items: BatchItemResult<T>[]): ToolStatus {
  const failed = items.filter(i => i.status === 'failed').length;
  if (failed === 0) return 'succeeded';
  if (failed === items.length) return 'failed';
  return 'partial';
}
```

## Per-Tool Changes

### Batch Mutating Tools

| Tool | New Return Type | Status Logic |
|---|---|---|
| `move_emails` | `BatchToolResult<MoveResult>` | `batchStatus(items)` |
| `mark_read` | `BatchToolResult<FlagResult>` | `batchStatus(items)` |
| `mark_unread` | `BatchToolResult<FlagResult>` | `batchStatus(items)` |
| `add_labels` | `BatchToolResult<AddLabelsItemData[]>` | `batchStatus(items)` |

Example output:
```json
{
  "status": "partial",
  "items": [
    { "id": {...}, "status": "succeeded", "data": {...} },
    { "id": {...}, "status": "failed", "error": { "code": "MOVE_FAILED", "message": "..." } }
  ]
}
```

### Read-Only Array Tools

| Tool | New Return Type | Status |
|---|---|---|
| `get_folders` | `ListToolResult<FolderInfo>` | Always `'succeeded'` |
| `get_labels` | `ListToolResult<FolderInfo>` | Always `'succeeded'` |
| `list_mailbox` | `ListToolResult<EmailSummary>` | Always `'succeeded'` |
| `fetch_summaries` | `ListToolResult<EmailSummary>` | Always `'succeeded'` |
| `fetch_message` | `ListToolResult<EmailMessage>` | Always `'succeeded'` |
| `search_mailbox` | `ListToolResult<EmailSummary>` | Always `'succeeded'` |

### Single-Item Tools

| Tool | New Return Type | Status |
|---|---|---|
| `fetch_attachment` | `SingleToolResult<AttachmentContent>` | Always `'succeeded'` |
| `verify_connectivity` | `SingleToolResult<{latencyMs}>` | Computed from success |
| `drain_connections` | `SingleToolResult<{message}>` | Always `'succeeded'` |

`verify_connectivity`: remove `success: boolean` field, replace with top-level `status`.

## Unify `AddLabelsItem` into `BatchItemResult`

Remove the separate `AddLabelsItem` type. Use `BatchItemResult<AddLabelsItemData[]>` instead — identical structure.

## Where Status Is Set

- **`ItemStatus`** — set in `ImapClient` methods (`imap.ts`) where `BatchItemResult` is constructed
- **`ToolStatus`** — set in tool handlers (`src/tools/*.ts`) via `batchStatus()` utility
- Read-only tools always return `'succeeded'` (they throw on failure)

## Files Changed (16 total)

| File | Change |
|---|---|
| `src/types/operations.ts` | Add types, `batchStatus()`, add `status` to `BatchItemResult`, unify `AddLabelsItem` |
| `src/bridge/imap.ts` | Set `status: 'succeeded'`/`'failed'` on every `BatchItemResult` |
| `src/tools/move-emails.ts` | Wrap with `batchStatus()` |
| `src/tools/mark-read.ts` | Wrap with `batchStatus()` |
| `src/tools/mark-unread.ts` | Wrap with `batchStatus()` |
| `src/tools/add-labels.ts` | Wrap with `batchStatus()`, use unified type |
| `src/tools/get-folders.ts` | Return `ListToolResult<FolderInfo>` |
| `src/tools/get-labels.ts` | Return `ListToolResult<FolderInfo>` |
| `src/tools/list-mailbox.ts` | Return `ListToolResult<EmailSummary>` |
| `src/tools/fetch-summaries.ts` | Return `ListToolResult<EmailSummary>` |
| `src/tools/fetch-message.ts` | Return `ListToolResult<EmailMessage>` |
| `src/tools/fetch-attachment.ts` | Return `SingleToolResult<AttachmentContent>` |
| `src/tools/search-mailbox.ts` | Return `ListToolResult<EmailSummary>` |
| `src/tools/verify-connectivity.ts` | Return `SingleToolResult`, remove `success` boolean |
| `src/tools/drain-connections.ts` | Return `SingleToolResult` |
| Docs: ARCHITECTURE.md, CLAUDE.md | Update type hierarchy and tool inventory |

## Risks

1. **`verify_connectivity` breaking change** — removes `success` field. Acceptable (pre-1.0).
2. **`fetch_summaries`/`fetch_message` silent drops** — still report `'succeeded'` even if some IDs not found. Acceptable for now.
3. **`exactOptionalPropertyTypes`** — `status` is required, no issue.
