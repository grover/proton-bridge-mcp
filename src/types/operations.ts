import type { EmailId } from './email.js';

// ── Status types ───────────────────────────────────────────────────────────────

/** Top-level status for every tool response. */
export type ToolStatus = 'succeeded' | 'partial' | 'failed';

/** Per-item status inside batch results. */
export type ItemStatus = 'succeeded' | 'failed';

// ── Wrapper result types ───────────────────────────────────────────────────────

/** Wrapper for batch-mutating tool results. */
export interface BatchToolResult<T> {
  status: ToolStatus;
  items:  BatchItemResult<T>[];
}

/** Wrapper for read-only tools that return arrays. */
export interface ListToolResult<T> {
  status: ToolStatus;
  items:  T[];
}

/** Wrapper for single-item tool results. */
export interface SingleToolResult<T> {
  status: ToolStatus;
  data:   T;
}

// ── Batch item types ───────────────────────────────────────────────────────────

/** Shared error shape for per-item batch failures. */
export interface BatchItemError {
  code:    string;
  message: string;
}

/**
 * Per-item result for batch mutating operations.
 * Index-stable: result[i] always corresponds to input[i].
 */
export interface BatchItemResult<T> {
  id:     EmailId;
  status: ItemStatus;
  data?:  T;
  error?: BatchItemError;
}

// ── Utilities ──────────────────────────────────────────────────────────────────

/** Compute top-level status from per-item statuses. */
export function batchStatus<T>(items: BatchItemResult<T>[]): ToolStatus {
  if (items.length === 0) return 'succeeded';
  const failed = items.filter(i => i.status === 'failed').length;
  if (failed === 0) return 'succeeded';
  if (failed === items.length) return 'failed';
  return 'partial';
}

/** Result of a single email move */
export interface MoveResult {
  fromMailbox: string;
  toMailbox:   string;
  /** New UID in target mailbox. May be undefined if the server doesn't report COPYUID. */
  targetId:    EmailId | undefined;
}

/** Result of a flag operation */
export interface FlagResult {
  /** Full set of IMAP flags before the operation */
  flagsBefore: string[];
  /** Full set of IMAP flags after the operation */
  flagsAfter:  string[];
}

/** Result of a single label application to one email */
export interface AddLabelsItemData {
  labelPath: string;
  /** New UID in the label folder. May be undefined if the server doesn't report COPYUID. */
  newId?:    EmailId;
}

/** Batch result for add_labels — unified with BatchItemResult */
export type AddLabelsBatchResult = BatchToolResult<AddLabelsItemData[]>;

/** Result of creating an IMAP mailbox (folder or label) */
export interface CreateMailboxResult {
  path:    string;
  created: boolean;
}

/** Result of a folder creation */
export type CreateFolderResult = CreateMailboxResult;

/** Result of a folder deletion */
export interface DeleteFolderResult {
  path:    string;
  deleted: boolean;
}

export type MoveBatchResult = BatchItemResult<MoveResult>[];
export type FlagBatchResult = BatchItemResult<FlagResult>[];

// ── Reversal specifications ───────────────────────────────────────────────────

export type ReversalSpec =
  | { type: 'noop' }
  | { type: 'move_batch';    moves:   Array<{ from: EmailId; to: EmailId }> }
  | { type: 'mark_read';     ids:     EmailId[] }
  | { type: 'mark_unread';   ids:     EmailId[] }
  | { type: 'create_folder'; path:    string }
  | { type: 'add_labels';    entries: Array<{ original: EmailId; labelPath: string; copy: EmailId }> };

// ── Operation record ──────────────────────────────────────────────────────────

export interface OperationRecord {
  id:        number;
  tool:      string;
  reversal:  ReversalSpec;
  timestamp: string;   // ISO 8601
}

// ── Revert result types ───────────────────────────────────────────────────────

export interface RevertStepResult {
  operationId: number;
  tool:        string;
  status:      ToolStatus;
  error?:      string;
}

export interface RevertResult {
  stepsTotal:     number;
  stepsSucceeded: number;
  stepsFailed:    number;
  steps:          RevertStepResult[];
}
