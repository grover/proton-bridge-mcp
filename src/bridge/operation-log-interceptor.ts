import type { ImapClient } from './imap.js';
import { OperationLog } from './operation-log.js';
import { Tracked } from './decorators.js';
import type { EmailId } from '../types/email.js';
import type {
  BatchToolResult,
  MoveResult,
  FlagResult,
  SingleToolResult,
  CreateFolderResult,
  AddLabelsBatchResult,
  ReversalSpec,
  RevertResult,
} from '../types/operations.js';

// ── Build-reversal stubs ─────────────────────────────────────────────────────

function buildMoveReversal(): ReversalSpec {
  throw new Error('Not implemented');
}

function buildMarkReadReversal(): ReversalSpec {
  throw new Error('Not implemented');
}

function buildMarkUnreadReversal(): ReversalSpec {
  throw new Error('Not implemented');
}

function buildCreateFolderReversal(): ReversalSpec | null {
  throw new Error('Not implemented');
}

function buildAddLabelsReversal(): ReversalSpec {
  throw new Error('Not implemented');
}

// ── Interceptor ──────────────────────────────────────────────────────────────

export class OperationLogInterceptor {
  readonly log: OperationLog;
  readonly #imap: ImapClient;

  constructor(imap: ImapClient, log: OperationLog) {
    this.#imap = imap;
    this.log   = log;
  }

  // ── Tracked mutating methods ──────────────────────────────────────────────

  @Tracked('move_emails', buildMoveReversal)
  async moveEmails(_ids: EmailId[], _targetMailbox: string): Promise<BatchToolResult<MoveResult>> {
    throw new Error('Not implemented');
  }

  @Tracked('mark_read', buildMarkReadReversal)
  async markRead(_ids: EmailId[]): Promise<BatchToolResult<FlagResult>> {
    throw new Error('Not implemented');
  }

  @Tracked('mark_unread', buildMarkUnreadReversal)
  async markUnread(_ids: EmailId[]): Promise<BatchToolResult<FlagResult>> {
    throw new Error('Not implemented');
  }

  @Tracked('create_folder', buildCreateFolderReversal)
  async createFolder(_path: string): Promise<SingleToolResult<CreateFolderResult>> {
    throw new Error('Not implemented');
  }

  @Tracked('add_labels', buildAddLabelsReversal)
  async addLabels(_ids: EmailId[], _labelNames: string[]): Promise<AddLabelsBatchResult> {
    throw new Error('Not implemented');
  }

  // ── Revert ────────────────────────────────────────────────────────────────

  async revertOperations(_operationId: number): Promise<RevertResult> {
    throw new Error('Not implemented');
  }
}
