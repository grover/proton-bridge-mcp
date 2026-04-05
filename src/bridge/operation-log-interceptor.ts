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
  RevertStepResult,
} from '../types/operations.js';
import { batchStatus } from '../types/operations.js';

// ── Build-reversal functions ─────────────────────────────────────────────────

function buildMoveReversal(
  _args: unknown[],
  result: unknown,
): ReversalSpec {
  const r = result as BatchToolResult<MoveResult>;
  const moves = r.items
    .filter(item => item.status === 'succeeded' && item.data?.targetId)
    .map(item => ({ from: item.data!.targetId!, to: item.id }));
  return { type: 'move_batch', moves };
}

function buildMarkReadReversal(
  _args: unknown[],
  result: unknown,
): ReversalSpec {
  const r = result as BatchToolResult<FlagResult>;
  const ids = r.items
    .filter(item => item.status === 'succeeded')
    .map(item => item.id);
  return { type: 'mark_read', ids };
}

function buildMarkUnreadReversal(
  _args: unknown[],
  result: unknown,
): ReversalSpec {
  const r = result as BatchToolResult<FlagResult>;
  const ids = r.items
    .filter(item => item.status === 'succeeded')
    .map(item => item.id);
  return { type: 'mark_unread', ids };
}

function buildCreateFolderReversal(
  _args: unknown[],
  result: unknown,
): ReversalSpec | null {
  const r = result as SingleToolResult<CreateFolderResult>;
  if (!r.data.created) return null;
  return { type: 'create_folder', path: r.data.path };
}

function buildAddLabelsReversal(
  _args: unknown[],
  result: unknown,
): ReversalSpec {
  const r = result as AddLabelsBatchResult;
  const entries = r.items
    .filter(item => item.status === 'succeeded' && item.data)
    .flatMap(item =>
      item.data!
        .filter(d => d.newId !== undefined)
        .map(d => ({ original: item.id, labelPath: d.labelPath, copy: d.newId! })),
    );
  return { type: 'add_labels', entries };
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
  async moveEmails(ids: EmailId[], targetMailbox: string): Promise<BatchToolResult<MoveResult>> {
    const items = await this.#imap.moveEmails(ids, targetMailbox);
    return { status: batchStatus(items), items };
  }

  @Tracked('mark_read', buildMarkReadReversal)
  async markRead(ids: EmailId[]): Promise<BatchToolResult<FlagResult>> {
    const items = await this.#imap.setFlag(ids, '\\Seen', true);
    return { status: batchStatus(items), items };
  }

  @Tracked('mark_unread', buildMarkUnreadReversal)
  async markUnread(ids: EmailId[]): Promise<BatchToolResult<FlagResult>> {
    const items = await this.#imap.setFlag(ids, '\\Seen', false);
    return { status: batchStatus(items), items };
  }

  @Tracked('create_folder', buildCreateFolderReversal)
  async createFolder(path: string): Promise<SingleToolResult<CreateFolderResult>> {
    const data = await this.#imap.createFolder(path);
    return { status: 'succeeded' as const, data };
  }

  @Tracked('add_labels', buildAddLabelsReversal)
  async addLabels(ids: EmailId[], labelNames: string[]): Promise<AddLabelsBatchResult> {
    return this.#imap.addLabels(ids, labelNames);
  }

  // ── Revert ────────────────────────────────────────────────────────────────

  async revertOperations(_operationId: number): Promise<RevertResult> {
    throw new Error('Not implemented');
  }
}
