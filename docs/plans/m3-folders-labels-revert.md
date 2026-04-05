# M3 PRD: Folders, Labels, and Reversible Operations

## Overview

Milestone 3 adds folder management, Proton label management, and a reversible operation
log to the MCP server. All new mutating tools participate in the in-memory operation log
and are revertable via a dedicated `revert_operations` tool — with the single exception
of `delete_folder`, which clears the log.

---

## Key Design Decisions

| Topic | Decision |
|---|---|
| Folder path shape | Single `path` parameter (must start with `Folders/`). Multi-segment paths allowed (e.g. `Folders/Work/Projects`). IMAP CREATE handles recursive creation. |
| IMAP CREATE API | Confirmed: `conn.mailboxCreate(path)` → `{ path, created: boolean }` |
| IMAP DELETE API | Confirmed: `conn.mailboxDelete(path)` → `{ path }` |
| `delete_folder` | Clears the operation log conditionally via `@IrreversibleWhen` — only when `deleted: true`. Idempotent. |
| `delete_label` | Irreversible — clears the operation log conditionally via `@IrreversibleWhen`. IMAP can't discover source mailbox UIDs for label copies, so reversal is not possible. |
| Log-clearing decorators | `@Irreversible`: unconditional log clear. `@IrreversibleWhen(predicate)`: conditional — only clears when predicate returns true. |
| remove_labels IMAP mechanism | Uses IMAP `messageDelete()` (STORE `\Deleted` + EXPUNGE) from label folders. Proton Bridge translates this to `UnlabelMessages()` — no permanent deletion. Finds copies by Message-ID search. |
| OperationLog coupling | ImapClient has zero awareness of OperationLog. Use `OperationLogInterceptor` class (GoF Decorator) wrapping ImapClient. Tool handlers in `server.ts` call the interceptor for mutating ops. |
| operationId in responses | **Extend** — not wrap. Object results: spread `operationId` at top level. Array results: return `{ operationId, items: [...] }`. |
| `revert_operations` | IS marked DESTRUCTIVE. |

---

## Issues (9 total)

| # | Issue title | Revertable | Log effect |
|---|---|---|---|
| 1 | `M3: get_folders — enhanced folder listing` | n/a (read) | none |
| 2 | `M3: create_folder — create a custom mail folder` | yes | appends |
| 3 | `M3: delete_folder — delete a custom mail folder` | no | **clears** |
| 4 | `M3: list_labels — list all Proton labels` | n/a (read) | none |
| 5 | `M3: create_label — create a Proton label` | yes | appends |
| 6 | `M3: delete_label — delete a Proton label` | no | **clears** |
| 7 | `M3: add_labels — bulk add labels to emails` | yes | appends |
| 8 | `M3: remove_labels — bulk remove labels from emails` | yes | appends |
| 9 | `M3: Operation log and revert_operations tool` | n/a (recovery) | consumes |

---

## Issue 1 — `M3: get_folders — enhanced folder listing`

**Goal:** Replace `list_folders` with `get_folders` — richer per-folder metadata and filtering.

### Tool specification

**Name:** `get_folders`

**Description:**
> List all mail folders with detailed metadata — message counts, unread counts, next UID,
> subscription status, and IMAP flags. Includes INBOX, special-use folders (Sent, Drafts,
> Trash, Archive, Junk, Spam), and user-created folders under Folders/. Proton labels,
> the virtual Starred mailbox, and the Labels root are excluded.

**Parameters:** _(none)_

**Return:**
```typescript
Array<{
  path:        string;   // Full IMAP path, e.g. "Folders/Work/Projects"
  name:        string;   // Last path component, e.g. "Projects"
  delimiter:   string;   // Path separator, usually "/"
  listed:      boolean;  // Appeared in the LIST response
  subscribed:  boolean;  // Folder is subscribed
  flags:       string[]; // IMAP flags, e.g. ["\\HasNoChildren"]
  specialUse?: string;   // e.g. "\\Sent", "\\Trash"
  messageCount: number;  // Total messages (STATUS MESSAGES)
  unreadCount:  number;  // Unseen messages (STATUS UNSEEN)
  uidNext:      number;  // Next UID to be assigned (STATUS UIDNEXT)
}>
```

**Error conditions:**
- IMAP connectivity failure → top-level thrown error

### Background

`list_folders` returns 5 fields via `conn.list()`. `get_folders` adds 4 fields using parallel
`conn.status(path, { messages, unseen, uidNext })` calls, and applies filtering.

### Implementation steps

1. Extend `FolderInfo` in `src/types/email.ts` with the 4 new fields.
2. Rename `ImapClient.listFolders()` → `getFolders()`. Update `@Audited('get_folders')`.
   - Filter: exclude `path === 'Starred'`, `path === 'Labels'`, `path.startsWith('Labels/')`.
   - `Promise.all` STATUS calls for all retained folders.
   - Map `listed` and `subscribed` from imapflow's ListResponse.
3. Rename `src/tools/list-folders.ts` → `src/tools/get-folders.ts`. Update handler + exports.
4. In `src/server.ts`: replace `list_folders` with `get_folders`. Use description above.
5. Update `src/types/index.ts`, `CLAUDE.md` (MCP Tools table), `ARCHITECTURE.md`, `CHANGELOG.md`, `README.md`.

### Acceptance criteria

- `list_folders` no longer appears. `get_folders` present with the description above.
- No result has a path starting with `Labels/`, nor `Starred`, nor `Labels`.
- All 10 fields populated per entry.
- `messageCount` / `unreadCount` match what the Proton Mail client reports.

### Testing

- Live Bridge via MCP Inspector: call `get_folders`, verify shape and filtering.
- Pick a folder with known email count; compare `messageCount`.

---

## Issue 2 — `M3: create_folder — create a custom mail folder`

**Goal:** Create user-defined mail folders, supporting nested paths.

### Tool specification

**Name:** `create_folder`

**Description:**
> Create a new mail folder. The path must start with 'Folders/' and include at least one
> folder name segment (e.g. 'Folders/Work' or 'Folders/Work/Projects'). Nested paths are
> created recursively by IMAP CREATE. Returns the full path and whether it was newly created
> or already existed.

**Parameters:**
```typescript
{
  path: string;  // Required. Full folder path, must start with "Folders/".
                 // Nested segments (e.g. "Folders/Work/Projects") created recursively.
}
```

**Return:**
```typescript
{
  path:    string;  // Full path, e.g. "Folders/Work/Projects"
  created: boolean; // true = newly created; false = already existed (no error)
}
```
_(Note: `operationId` will be added when the operation log interceptor is implemented in Issue 9.)_

**Error conditions:**
- `INVALID_PATH` — path does not start with `"Folders/"`, is bare `"Folders/"`, or has no folder name after the prefix
- IMAP failure → top-level thrown error

### imapflow API

`conn.mailboxCreate(path)` → `{ path, created: boolean }`

### Implementation steps

1. Add `src/tools/create-folder.ts` with Zod schema for `path`. Validate path starts with
   `Folders/` and contains a folder name after the prefix.
2. Add `ImapClient.createFolder(path: string): Promise<CreateFolderResult>` with `@Audited('create_folder')`.
3. On `OperationLogInterceptor`: wrap `createFolder` with `@Tracked`, reversal
   `{ type: 'create_folder', path }`. Revert = `deleteFolder(path)`.
4. Add `CreateFolderResult` to `src/types/operations.ts`.
5. Register in `src/server.ts` (MUTATING). Description above.
6. Update `CLAUDE.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `README.md`.

### Acceptance criteria

- `{ path: "Folders/Work" }` → `Folders/Work` appears in `get_folders`.
- `{ path: "Folders/Work/Projects" }` → `Folders/Work/Projects` appears (recursive creation).
- `{ path: "Folders/" }` → `INVALID_PATH`.
- `{ path: "INBOX" }` → `INVALID_PATH`.
- Pre-existing path → `{ created: false }`, no error.

---

## Issue 3 — `M3: delete_folder — delete a custom mail folder`

**Goal:** Delete user-defined folders under `Folders/`. Clears the operation log.

### Tool specification

**Name:** `delete_folder`

**Description:**
> Delete a mail folder. The path must be under Folders/ — Folders/ itself, special-use
> folders (INBOX, Sent, Drafts, Trash, etc.), and paths outside Folders/ are rejected.
> Emails are retained in Proton's backend. Warning: this operation clears the operation
> history — no prior operations can be reverted after calling delete_folder.

**Parameters:**
```typescript
{
  path: string;  // Required. Full IMAP path, e.g. "Folders/Work".
}
```

**Return:**
```typescript
{
  path: string;  // Path of the deleted folder
}
```
_(No `operationId` — this operation clears the log, not appends to it.)_

**Error conditions:**
- `FORBIDDEN` — path is `"Folders/"`, a special-use folder, or not under `Folders/`
- `NOT_FOUND` — folder does not exist
- IMAP failure → top-level thrown error

### imapflow API

`conn.mailboxDelete(path)` → `{ path }`

### Implementation steps

1. Add `src/tools/delete-folder.ts` with Zod schema as above.
2. Add `ImapClient.deleteFolder(path: string): Promise<DeleteFolderResult>` with `@Audited('delete_folder')`.
   - Guard: reject `path === 'Folders/'`, non-`Folders/` paths, special-use folders.
   - Call `conn.mailboxDelete(path)`. Return `{ path }`.
3. On `OperationLogInterceptor`: wrap `deleteFolder` with new `@Irreversible` decorator
   (clears log on success/partial). NOT `@Tracked`.
4. Add `DeleteFolderResult { path: string }` to `src/types/operations.ts`.
5. Register in `src/server.ts` (MUTATING). Description above.
6. Update `CLAUDE.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `README.md`.

### Acceptance criteria

- `{ path: "Folders/Work" }` → gone from `get_folders`.
- `"INBOX"`, `"Folders/"`, non-`Folders/` path → `FORBIDDEN`.
- Non-existent folder → `NOT_FOUND`.
- After deletion, `revert_operations` with any prior ID → `UNKNOWN_OPERATION_ID`.

### Testing

- Create folder → move emails in → delete folder → assert `revert_operations` fails.

---

## Issue 4 — `M3: list_labels — list all Proton labels`

**Goal:** List all Proton labels (`Labels/` folders) with per-folder metadata. Read-only.

### Tool specification

**Name:** `list_labels`

**Description:**
> List all Proton Mail labels with message counts, unread counts, and folder metadata.
> Labels allow a single email to appear in multiple categories simultaneously without being
> moved from its original folder. Returns the same schema as get_folders.

**Parameters:** _(none)_

**Return:** `Array<FolderInfo>` — same type as `get_folders` (all 10 fields). Empty array if no labels exist.

**Error conditions:**
- IMAP connectivity failure → top-level thrown error

### Implementation steps

1. Add `src/tools/list-labels.ts` with empty Zod schema `{}`.
2. Add `ImapClient.listLabels(): Promise<FolderInfo[]>` with `@Audited('list_labels')`.
   - `conn.list()`, filter to `path.startsWith('Labels/')`, exclude `path === 'Labels'`.
   - Parallel STATUS calls (same pattern as `get_folders`).
3. Register in `src/server.ts` (READ_ONLY). Description above.
4. Update `CLAUDE.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `README.md`.

### Acceptance criteria

- Only `Labels/`-prefixed paths returned.
- All 10 fields present per entry.
- Empty array when no labels exist.

---

## Issue 5 — `M3: create_label — create a Proton label`

**Goal:** Create a new Proton label (`Labels/<name>`). Flat (no nesting). Revertable.

### Tool specification

**Name:** `create_label`

**Description:**
> Create a new Proton Mail label. Labels are flat — names must not contain path separators.
> Returns the full label path and whether the label was newly created or already existed.

**Parameters:**
```typescript
{
  name: string;  // Required. Plain label name. Must not contain "/".
}
```

**Return:**
```typescript
{
  operationId: number;  // For use with revert_operations
  path:        string;  // e.g. "Labels/Project X"
  created:     boolean; // true = newly created; false = already existed
}
```

**Error conditions:**
- Zod validation error — `name` contains `"/"`
- IMAP failure → top-level thrown error

### Implementation steps

1. Add `src/tools/create-label.ts` with Zod schema. Validate no `/`. Path = `` `Labels/${name}` ``.
2. Add `ImapClient.createLabel(name: string): Promise<CreateFolderResult>` with `@Audited('create_label')`.
3. On `OperationLogInterceptor`: `@Tracked` with reversal `{ type: 'create_label', path }`.
   Revert = `deleteLabel(path)`.
4. Register in `src/server.ts` (MUTATING). Description above.
5. Update `CLAUDE.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `README.md`.

---

## Issue 6 — `M3: delete_label — delete a Proton label`

**Goal:** Delete a Proton label. Irreversible — clears the operation log on success. Emails are preserved.

> **Implementation deviation:** The original PRD design described `delete_label` as revertable, capturing email associations before deletion. Investigation during implementation (see [EDD-18](edd-18-delete-label.md)) revealed this is **not practically possible** at the IMAP level: emails in label folders have copy UIDs, not source mailbox UIDs. IMAP doesn't track copy provenance. Verified safe in Proton Bridge source (`connector.go:272-283`) — `DeleteMailbox()` only removes the label classification, not the emails.

### Tool specification

**Name:** `delete_label`

**Description:**
> Delete a Proton Mail label. The underlying emails remain in their original folders — only
> the label view is removed. Warning: this operation clears the operation history — no prior
> operations can be reverted after calling delete_label.

**Parameters:**
```typescript
{
  name: string;  // Required. Plain label name, e.g. "Project X".
}
```

**Return:**
```typescript
{
  name:    string;   // Label name
  deleted: boolean;  // true = deleted; false = label didn't exist (idempotent)
}
```

Note: no `operationId` — this operation clears the log rather than appending to it.

**Error conditions:**
- `INVALID_NAME` — name contains `"/"`
- `FORBIDDEN` — label has `specialUse` attribute
- IMAP failure → top-level thrown error

### imapflow API

`conn.mailboxDelete(path)` → `{ path }`

### Implementation steps

1. Add `src/tools/delete-label.ts` with Zod schema `{ name: z.string().min(1) }`.
2. Add `ImapClient.deleteLabel(name: string): Promise<DeleteLabelResult>` with `@Audited('delete_label')`.
   - Constructs `Labels/<name>` internally, delegates to shared `#deleteMailbox(path, prefix)`.
   - Returns `{ name, deleted: true/false }`.
3. On `OperationLogInterceptor`: `@IrreversibleWhen` — clears log only when `deleted: true`.
4. Add `DeleteLabelResult { name: string; deleted: boolean }` to `src/types/operations.ts`.
5. Register in `src/server.ts` (DESTRUCTIVE).
6. Update `CLAUDE.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `README.md`.

### Acceptance criteria

- Deletion removes label from `get_labels`.
- Underlying emails remain in source folders.
- `{ deleted: false }` for non-existent labels (idempotent).
- After deletion (with `deleted: true`), `revert_operations` → `UNKNOWN_OPERATION_ID`.
- `create_label` reversal (via `revert_operations`) calls `deleteLabel` to remove newly created labels.

---

## Issue 7 — `M3: add_labels — bulk add labels to emails`

**Goal:** Bulk-copy emails into one or more label folders (add Proton labels).

### Tool specification

**Name:** `add_labels`

**Description:**
> Add one or more Proton Mail labels to a batch of emails. Each email is copied into the
> corresponding label folder and simultaneously remains in its original folder. Supports up to
> 50 emails per call. Returns per-email results including the new UID in each label folder,
> which is used internally to enable label removal and revert.

**Parameters:**
```typescript
{
  ids:        Array<{ uid: number; mailbox: string }>;  // Min 1, max 50. Source mailbox IDs.
  labelNames: string[];  // Min 1. Plain label names (without "Labels/" prefix).
}
```

**Return:**
```typescript
{
  operationId: number;
  items: Array<{                       // items[i] ↔ ids[i]
    id:     EmailId;
    data?:  Array<{
      labelPath: string;               // e.g. "Labels/Work"
      newId?:    { uid: number; mailbox: string };  // Copy's UID in the label folder
    }>;
    error?: { code: string; message: string };
  }>;
}
```

**Error conditions (per-item):**
- `LABEL_NOT_FOUND` — label does not exist
- `COPY_FAILED` — IMAP COPY failed for this email

**Top-level errors:**
- IMAP connectivity failure → thrown

### IMAP mechanism (to be validated during implementation)

Hypothesis: IMAP COPY (`conn.messageCopy(uid, 'Labels/<name>', { uid: true })`) to the label
folder. `messageCopy` returns a `uidMap` mapping source UIDs to new destination UIDs. The
`newId` in the result is taken from this map and stored in the operation log for use by
`remove_labels`. **Implementer must verify this against a live Proton Bridge and document
findings in ARCHITECTURE.md.**

### Implementation steps

1. Add `src/tools/add-labels.ts` with Zod schema as above.
2. Add `ImapClient.addLabels(ids: EmailId[], labelNames: string[]): Promise<AddLabelsBatchResult>`.
   - Validate all label paths exist; per-item `LABEL_NOT_FOUND` if not.
   - For each label: group ids by source mailbox (smart locking). Per group: lock, COPY, capture newId.
   - Return `BatchItemResult<AddLabelResult[]>[]`.
3. Add types to `src/types/operations.ts`.
4. On `OperationLogInterceptor`: `@Tracked` with reversal
   `{ type: 'add_labels', entries: [{ original, labelPath, copy }] }`.
   Revert = `removeLabels` using stored copy UIDs.
5. Register in `src/server.ts` (MUTATING). Description above.
6. Update `CLAUDE.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `README.md`.

### Acceptance criteria

- Email appears in `Labels/Work` after `add_labels`.
- `items[i]` corresponds to `ids[i]`.
- `newId` populated when available.
- Reverting via `revert_operations` removes the label copies.

---

## Issue 8 — `M3: remove_labels — bulk remove labels from emails`

**Goal:** Bulk-remove Proton labels from a set of emails without affecting originals.

### Tool specification

**Name:** `remove_labels`

**Description:**
> Remove one or more Proton Mail labels from a batch of emails. The email copies in the label
> folders are removed; the originals remain in their source mailboxes. Supports up to 50
> emails per call.

**Parameters:**
```typescript
{
  ids:        Array<{ uid: number; mailbox: string }>;  // Min 1, max 50. Source mailbox IDs.
  labelNames: string[];  // Min 1. Plain label names (without "Labels/" prefix).
}
```

**Return:**
```typescript
{
  operationId: number;
  items: Array<{                       // items[i] ↔ ids[i]
    id:     EmailId;
    data?:  Array<{
      labelPath: string;               // e.g. "Labels/Work"
      removed:   boolean;              // false if email was not found in this label
    }>;
    error?: { code: string; message: string };
  }>;
}
```

**Error conditions (per-item):**
- `LABEL_NOT_FOUND` — label does not exist
- `NOT_IN_LABEL` — email was not found in the label folder
- `REMOVE_FAILED` — IMAP operation failed

**Top-level errors:**
- IMAP connectivity failure → thrown

### IMAP mechanism (to be validated during implementation)

Hypothesis: IMAP MOVE (`conn.messageMove()`) from `Labels/<name>` back to the message's source
mailbox. The UID in the label folder (from a prior `add_labels` operation log entry) is used for
precise targeting. If no prior `add_labels` record exists, search `Labels/<name>` by Message-ID.
**Must NOT use `\Deleted + EXPUNGE`** — that permanently deletes the message across all folders.
**Implementer must verify against a live Proton Bridge and document in ARCHITECTURE.md.**

### Implementation steps

1. Add `src/tools/remove-labels.ts` with same schema shape as `add_labels`.
2. Add `ImapClient.removeLabels(ids: EmailId[], labelNames: string[]): Promise<RemoveLabelsBatchResult>`.
   - For each label folder: lock `Labels/<name>`.
   - For each id: use stored copy UID from operation log if available; else search by Message-ID.
   - Move copy back to source mailbox.
3. Add types to `src/types/operations.ts`.
4. On `OperationLogInterceptor`: `@Tracked` with reversal
   `{ type: 'remove_labels', entries: [{ original, labelPath }] }`.
   Revert = `addLabels`.
5. Register in `src/server.ts` (MUTATING). Description above.
6. Update `CLAUDE.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `README.md`.

### Acceptance criteria

- After `remove_labels`, email no longer appears in `Labels/Work`.
- Original in source mailbox unaffected.
- `items[i]` corresponds to `ids[i]`.
- `removed: false` when email was not in the label (not an error).

---

## Issue 9 — `M3: Operation log and revert_operations tool`

**Goal:** In-memory operation log with sequential IDs; `revert_operations` unwinds ops in reverse.

### Tool specification

**Name:** `revert_operations`

**Description:**
> Reverse all operations from the most recent back to and including the specified operation ID,
> in reverse chronological order. This is a destructive operation: emails may be moved, folders
> deleted, and flags changed. Fails with UNKNOWN_OPERATION_ID if the given ID is not in the
> log (e.g. if a delete_folder call has since cleared the history).

**Parameters:**
```typescript
{
  operationId: number;  // The earliest operation to revert, inclusive.
}
```

**Return:**
```typescript
{
  stepsTotal:     number;
  stepsSucceeded: number;
  stepsFailed:    number;
  steps: Array<{
    operationId: number;
    tool:        string;
    status:      'success' | 'partial' | 'error';
    error?:      string;
  }>;
}
```

**Error conditions:**
- `UNKNOWN_OPERATION_ID` — ID not in log; no changes made
- Per-step errors → collected in `steps[].error`; revert continues best-effort

### Architecture

**`OperationLog`** — new file `src/bridge/operation-log.ts`:
```typescript
class OperationLog {
  #seq  = 0
  #ring: OperationRecord[] = []   // max 100, FIFO eviction

  push(record: Omit<OperationRecord, 'id'>): number   // returns operationId
  getFrom(operationId: number): OperationRecord[]      // most-recent-first, from id onward
  has(operationId: number): boolean
  clear(): void
}
```

**`OperationLogInterceptor`** — new file `src/bridge/operation-log-interceptor.ts`.
Wraps `ImapClient` (GoF Decorator). Tool handlers in `server.ts` call the interceptor for
mutating ops; `ImapClient` has zero awareness of the log. The interceptor's mutating methods
are decorated:
- `@Tracked(tool, buildReversal)` — pushes to log, extends result with `operationId`
- `@Irreversible` — clears log on success/partial; used only for `deleteFolder`

**`ReversalSpec`** — add to `src/types/operations.ts`:
```typescript
type ReversalSpec =
  | { type: 'move_batch';    moves:   Array<{ from: EmailId; to: EmailId }> }
  | { type: 'flag';          ids:     EmailId[]; flag: string; wasAdded: boolean }
  | { type: 'create_folder'; path:    string }
  | { type: 'create_label';  path:    string }
  | { type: 'delete_label';  path:    string; emails: EmailId[] }
  | { type: 'add_labels';    entries: Array<{ original: EmailId; labelPath: string; copy: EmailId }> }
  | { type: 'remove_labels'; entries: Array<{ original: EmailId; labelPath: string }> }
```

**New decorators** in `src/bridge/decorators.ts` (legacy `experimentalDecorators` API):
- `@Tracked(tool, buildReversal)` — wraps method; on success/partial, builds reversal, pushes
  to `this.#log`, extends result with `operationId`.
- `@Irreversible` — wraps method; on success/partial, calls `this.#log.clear()`.

**Result extension convention:**
- Object results: `{ ...result, operationId }` (pure extension)
- Array results: `{ operationId, items: result }` (named wrapper)

**`revert_operations` handler** in `src/tools/revert-operations.ts`:
1. `!log.has(operationId)` → `UNKNOWN_OPERATION_ID` error.
2. `records = log.getFrom(operationId)` (most-recent-first).
3. Execute each reversal best-effort; collect per-step results.
4. Return summary. Remove reverted records from log after completion.

Register in `src/server.ts` (DESTRUCTIVE). Description above.

Update `CLAUDE.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `README.md`.

### Acceptance criteria

- Every mutating tool response includes `operationId`.
- `revert_operations(N)` reverses ops N → most-recent in reverse chronological order.
- Unknown ID → `UNKNOWN_OPERATION_ID`, no changes.
- After `delete_folder`, all prior IDs unknown.
- After `delete_label`, prior IDs still valid; revert restores label and emails.
- Ring buffer evicts at 101 entries; evicted IDs return unknown.

### Testing

- Move 3 emails → revert → back in original mailbox.
- `mark_read` → revert → `\Seen` removed.
- Chain: `move_emails` → `mark_read` → `revert_operations(moveId)` → both reversed.
- 101 operations → first ID unknown.
- `delete_folder` → all prior IDs unknown; `delete_label` → prior IDs still valid.
