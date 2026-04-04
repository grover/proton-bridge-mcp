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

/** Result of a single label application to one email */
export interface AddLabelsItemData {
  labelPath: string;
  /** New UID in the label folder. May be undefined if the server doesn't report COPYUID. */
  newId?:    EmailId;
}

/** Per-email result for add_labels */
export interface AddLabelsItem {
  id:     EmailId;
  data?:  AddLabelsItemData[];
  error?: { code: string; message: string };
}

/** Batch result for add_labels */
export interface AddLabelsBatchResult {
  items: AddLabelsItem[];
}

/** Result of a folder creation */
export interface CreateFolderResult {
  path:    string;
  created: boolean;
}

export type MoveBatchResult = BatchItemResult<MoveResult>[];
export type FlagBatchResult = BatchItemResult<FlagResult>[];
