# MCP Tool Interfaces

This document describes the MCP tool interface design: result types, annotation classification, operations interfaces, handler patterns, and tool registration. For per-tool schemas and annotation values, see `docs/tools/README.md`. For the EmailId identity model and serialization, see `docs/impl/email-identity.md`.

## Overview

Every MCP tool follows a layered architecture:

```
Zod schema validates input
  → Handler function processes via interface
    → Typed result returned
      → toText() serializes for MCP client
```

Tool handlers depend on **interfaces** (`ReadOnlyMailOps`, `MutatingMailOps`), not concrete classes. This enables dependency injection for testing and separates the tool layer from IMAP implementation details.

## Result Type System

Three wrapper types express the semantics of different tool operations. Defined in `src/types/operations.ts`.

### Choosing the Right Type

| Type | Use When | Example Tools |
|------|----------|---------------|
| `ListToolResult<T>` | Read operations returning collections — the operation either fully succeeds or throws | get_folders, list_mailbox, fetch_summaries, fetch_message, search_mailbox |
| `SingleToolResult<T>` | Operations on a single entity or returning a single result | fetch_attachment, create_folder, verify_connectivity, drain_connections |
| `BatchToolResult<T>` | Operations on `EmailId[]` where individual items can fail independently | move_emails, mark_read, mark_unread, add_labels |

### Type Definitions

```typescript
type ToolStatus = 'succeeded' | 'partial' | 'failed';
type ItemStatus = 'succeeded' | 'failed';

interface ListToolResult<T> {
  status: ToolStatus;
  items:  T[];
}

interface SingleToolResult<T> {
  status: ToolStatus;
  data:   T;
}

interface BatchToolResult<T> {
  status: ToolStatus;           // computed via batchStatus()
  items:  BatchItemResult<T>[];
}
```

### Per-Item Batch Types

`BatchToolResult` contains an array of `BatchItemResult<T>`, one per input item. The array preserves input order — `result.items[i]` always corresponds to `input.ids[i]`.

```typescript
interface BatchItemResult<T> {
  id:     EmailId;
  status: ItemStatus;
  data?:  T;                    // present on success
  error?: BatchItemError;       // present on failure
}

interface BatchItemError {
  code:    string;              // semantic: 'MOVE_FAILED', 'FLAG_FAILED', 'COPY_FAILED'
  message: string;              // human-readable error detail
}
```

### ToolStatus vs ItemStatus

`ToolStatus` has three values because the top-level result can represent **partial success** — some items succeeded while others failed. `ItemStatus` has only two values because an individual item either succeeded or failed; there is no partial state for a single item.

## The batchStatus() Utility

```typescript
function batchStatus<T>(items: BatchItemResult<T>[]): ToolStatus {
  if (items.length === 0) return 'succeeded';
  const failed = items.filter(i => i.status === 'failed').length;
  if (failed === 0) return 'succeeded';
  if (failed === items.length) return 'failed';
  return 'partial';
}
```

This utility **must** be used to compute the top-level status for all `BatchToolResult` responses. Never hardcode the status — it must always be derived from the per-item results.

The `partial` status is critical for LLM consumption: it tells the agent that some work succeeded and some failed, enabling it to report partial results, retry failed items, or escalate — rather than treating the entire operation as a binary success or failure.

## Tool Annotation Classification

Every tool declares `annotations` with two boolean hints. Three presets are defined in `src/server.ts`:

```typescript
const READ_ONLY   = { readOnlyHint: true,  destructiveHint: false };
const MUTATING    = { readOnlyHint: false, destructiveHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true  };
```

### Classification Rationale

**READ_ONLY** — The tool does not modify any state. Safe to call at any time without side effects. The LLM can call these tools freely for information gathering.

**MUTATING** — The tool modifies state but the change is **reversible**. It can be undone via `revert_operations` or repeated application is harmless. Examples: flag changes (mark_read, mark_unread), label additions (add_labels), folder creation (create_folder). The LLM should confirm intent with the user before calling, but mistakes are recoverable.

**DESTRUCTIVE** — The tool modifies state in a way that may be **irreversible** or has significant side effects. Examples: moving emails (source UID is invalidated, new UID may be unknown), draining connections (drops active pool state), reverting operations (applies cascading reverse changes). The LLM should exercise extra caution and clearly confirm with the user.

### Guidelines for Classifying New Tools

1. If it only reads data → `READ_ONLY`
2. If it changes state but can be cleanly undone → `MUTATING`
3. If it changes state and may be hard or impossible to undo, or has cascading effects → `DESTRUCTIVE`
4. **When in doubt, prefer DESTRUCTIVE** — it's safer for the LLM to treat an operation as destructive than to underestimate risk

## Operations Interfaces

Tool handlers depend on two interfaces defined in `src/types/mail-ops.ts`. This decouples the tool layer from concrete IMAP and operation-log implementations.

### ReadOnlyMailOps

Implemented by `ImapClient`. Used by all read-only tool handlers.

```typescript
interface ReadOnlyMailOps {
  getFolders(): Promise<FolderInfo[]>;
  getLabels(): Promise<LabelInfo[]>;
  listMailbox(mailbox: string, limit: number, offset: number): Promise<EmailSummary[]>;
  fetchSummaries(ids: EmailId[]): Promise<EmailSummary[]>;
  fetchMessage(ids: EmailId[]): Promise<EmailMessage[]>;
  fetchAttachment(id: EmailId, partId: string): Promise<AttachmentContent>;
  searchMailbox(mailbox: string, query: string, limit: number, offset: number): Promise<EmailSummary[]>;
}
```

Read ops return **raw arrays** or single objects. The handler wraps them in `ListToolResult` or `SingleToolResult` with `status: 'succeeded'`. If the operation fails, it throws — there is no per-item error model for reads.

### MutatingMailOps

Implemented by `OperationLogInterceptor`. Used by all mutating tool handlers.

```typescript
interface MutatingMailOps {
  moveEmails(ids: EmailId[], targetMailbox: string): Promise<BatchToolResult<MoveResult>>;
  markRead(ids: EmailId[]): Promise<BatchToolResult<FlagResult>>;
  markUnread(ids: EmailId[]): Promise<BatchToolResult<FlagResult>>;
  createFolder(path: string): Promise<SingleToolResult<CreateFolderResult>>;
  addLabels(ids: EmailId[], labelNames: string[]): Promise<AddLabelsBatchResult>;
  revertOperations(operationId: number): Promise<RevertResult>;
}
```

Mutating ops return **fully typed result wrappers**. The handler passes them through directly — the ops layer is responsible for constructing the result, computing `batchStatus()`, and attaching `operationId` for revert support.

### Why Interfaces?

- **Testability**: Unit tests inject mock implementations without touching IMAP or the operation log
- **Separation of concerns**: The tool layer doesn't know about `@Audited`, `@Tracked`, connection pools, or mailbox locks
- **Composition**: `OperationLogInterceptor` wraps `ImapClient` (GoF Decorator pattern), adding operation tracking without modifying the client

## Tool Handler Patterns

Seven canonical patterns cover all existing tools. New tools should follow the closest matching pattern.

### Pattern 1: No-Input Read

```typescript
// get_folders, get_labels
export async function handleGetFolders(
  ops: ReadOnlyMailOps,
): Promise<ListToolResult<FolderInfo>> {
  const items = await ops.getFolders();
  return { status: 'succeeded' as const, items };
}
```

The handler calls the ops method and wraps the result. No input validation needed.

### Pattern 2: Parameterized Read

```typescript
// list_mailbox, search_mailbox
export async function handleListMailbox(
  args: { mailbox: string; limit: number; offset: number },
  ops: ReadOnlyMailOps,
): Promise<ListToolResult<EmailSummary>> {
  const items = await ops.listMailbox(args.mailbox, args.limit, args.offset);
  return { status: 'succeeded' as const, items };
}
```

Zod schema provides defaults and validation. Handler receives validated args.

### Pattern 3: Batch Read

```typescript
// fetch_summaries, fetch_message
export async function handleFetchSummaries(
  args: { ids: EmailId[] },
  ops: ReadOnlyMailOps,
): Promise<ListToolResult<EmailSummary>> {
  const items = await ops.fetchSummaries(args.ids);
  return { status: 'succeeded' as const, items };
}
```

The `ids` array arrives as typed `EmailId` objects (Zod `.transform()` handles string→object conversion at the schema layer).

### Pattern 4: Single-Item Read

```typescript
// fetch_attachment
export async function handleFetchAttachment(
  args: { id: EmailId; partId: string },
  ops: ReadOnlyMailOps,
): Promise<SingleToolResult<AttachmentContent>> {
  const data = await ops.fetchAttachment(args.id, args.partId);
  return { status: 'succeeded' as const, data };
}
```

### Pattern 5: Batch Mutation

```typescript
// move_emails, mark_read, mark_unread, add_labels
export async function handleMoveEmails(
  args: { ids: EmailId[]; targetMailbox: string },
  ops: MutatingMailOps,
): Promise<BatchToolResult<MoveResult>> {
  return ops.moveEmails(args.ids, args.targetMailbox);
}
```

The handler **passes through** the result from the ops layer. `BatchToolResult` is constructed by `OperationLogInterceptor` which calls `batchStatus()` and attaches `operationId`.

### Pattern 6: Validated Mutation

```typescript
// create_folder
export async function handleCreateFolder(
  args: { path: string },
  ops: MutatingMailOps,
): Promise<SingleToolResult<CreateFolderResult>> {
  const cleaned = args.path.replace(/\/+$/, '');
  if (!cleaned || !cleaned.startsWith('Folders/') || cleaned === 'Folders') {
    throw new Error('INVALID_PATH: path must start with "Folders/" and contain a folder name');
  }
  return ops.createFolder(cleaned);
}
```

Input validation happens **before** the ops call. Invalid input throws immediately — the MCP SDK converts this to a tool error response.

### Pattern 7: Pool Operation

```typescript
// verify_connectivity
export async function handleVerifyConnectivity(
  pool: ImapConnectionPool,
): Promise<SingleToolResult<{ latencyMs?: number; error?: string }>> {
  const result = await pool.verifyConnectivity();
  const status: ToolStatus = result.success ? 'succeeded' : 'failed';
  if (result.success) {
    return { status, data: { latencyMs: result.latencyMs } };
  }
  return { status, data: { error: result.error } };
}
```

Pool operations bypass both ops interfaces. The handler maps the pool's internal result shape to a `SingleToolResult`.

## Tool Registration

Tools are registered in `createMcpServer()` (`src/server.ts`):

```typescript
export function createMcpServer(
  readOps: ReadOnlyMailOps,
  pool:    ImapConnectionPool,
  mutOps:  MutatingMailOps,
): McpServer
```

The factory accepts interfaces, not concrete classes. Each tool is registered with:

```typescript
server.registerTool(
  'tool_name',
  {
    description: 'LLM-facing description of what the tool does',
    inputSchema: zodSchemaObject,
    annotations: READ_ONLY | MUTATING | DESTRUCTIVE,
  },
  async (args) => ({
    content: [{ type: 'text', text: toText(await handleXxx(args, ops)) }],
  }),
);
```

**Key points:**
- The `description` string is what the LLM reads to decide when to use the tool — make it specific and actionable
- Zod schema fields should use `.describe()` — these descriptions appear in the tool's JSON Schema for the LLM
- No error handling at the registration level — exceptions propagate to the MCP SDK, which returns them as tool error responses
- `toText()` serializes the result to JSON with pretty-printing and EmailId formatting

## Checklist for New Tools

When adding a new MCP tool:

- [ ] **Choose the correct result type** (List/Single/Batch) based on operation semantics — see the table in "Result Type System"
- [ ] **Define a Zod schema** with `.describe()` on each field — these are the LLM's documentation
- [ ] **Choose the correct annotation** (READ_ONLY/MUTATING/DESTRUCTIVE) using the classification rationale above
- [ ] **Add the handler to the correct ops interface** — `ReadOnlyMailOps` for reads, `MutatingMailOps` for mutations
- [ ] **Implement the handler** following the appropriate pattern from "Tool Handler Patterns"
- [ ] **Register in `createMcpServer()`** with description, schema, annotation, and handler
- [ ] **For batch operations**: use `batchStatus()` to compute top-level status — never hardcode
- [ ] **For batch operations**: use semantic error codes (e.g., `DELETE_FAILED`, `RENAME_FAILED`) — the LLM reads these to categorize failures
- [ ] **Update `docs/tools/README.md`** with the new tool's schema, annotations, and description
