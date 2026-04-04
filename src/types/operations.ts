import type { EmailId } from './email.js';

/**
 * Per-item result for batch mutating operations.
 * Index-stable: result[i] always corresponds to input[i].
 */
export interface BatchItemResult<T> {
  id:     EmailId;
  data?:  T;
  error?: { code: string; message: string };
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
  /** Full set of IMAP flags after the operation */
  flagsAfter: string[];
}

export type MoveBatchResult = BatchItemResult<MoveResult>[];
export type FlagBatchResult = BatchItemResult<FlagResult>[];
