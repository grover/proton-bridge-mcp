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

function buildFlagReversal(type: 'mark_read' | 'mark_unread') {
  return (_args: unknown[], result: unknown): ReversalSpec => {
    const r = result as BatchToolResult<FlagResult>;
    const ids = r.items
      .filter(item => item.status === 'succeeded')
      .map(item => item.id);
    return { type, ids };
  };
}

const buildMarkReadReversal = buildFlagReversal('mark_read');
const buildMarkUnreadReversal = buildFlagReversal('mark_unread');

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

  // Not tracked: reversal requires deleteFolder which is on a separate branch.
  // TODO: re-add @Tracked('create_folder', buildCreateFolderReversal) when deleteFolder lands.
  async createFolder(path: string): Promise<SingleToolResult<CreateFolderResult>> {
    const data = await this.#imap.createFolder(path);
    return { status: 'succeeded' as const, data };
  }

  // Not tracked: reversal requires deleteEmails which is on a separate branch.
  // TODO: re-add @Tracked('add_labels', buildAddLabelsReversal) when deleteEmails lands.
  async addLabels(ids: EmailId[], labelNames: string[]): Promise<AddLabelsBatchResult> {
    return this.#imap.addLabels(ids, labelNames);
  }

  // ── Revert ────────────────────────────────────────────────────────────────

  async revertOperations(operationId: number): Promise<RevertResult> {
    if (!this.log.has(operationId)) {
      throw new Error('UNKNOWN_OPERATION_ID');
    }

    const records = this.log.getFrom(operationId);
    const steps: RevertStepResult[] = [];

    for (const record of records) {
      try {
        await this.#executeReversal(record.reversal);
        this.log.remove(record.id);
        steps.push({ operationId: record.id, tool: record.tool, status: 'succeeded' });
      } catch (err) {
        steps.push({
          operationId: record.id,
          tool:        record.tool,
          status:      'failed',
          error:       err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      stepsTotal:     steps.length,
      stepsSucceeded: steps.filter(s => s.status === 'succeeded').length,
      stepsFailed:    steps.filter(s => s.status === 'failed').length,
      steps,
    };
  }

  async #executeReversal(spec: ReversalSpec): Promise<void> {
    switch (spec.type) {
      case 'move_batch': {
        // Group by target mailbox to minimize IMAP lock acquisitions
        const byMailbox = new Map<string, EmailId[]>();
        for (const move of spec.moves) {
          const target = move.to.mailbox;
          const ids = byMailbox.get(target) ?? [];
          ids.push(move.from);
          byMailbox.set(target, ids);
        }
        for (const [mailbox, ids] of byMailbox) {
          await this.#imap.moveEmails(ids, mailbox);
        }
        break;
      }

      case 'mark_read':
        await this.#imap.setFlag(spec.ids, '\\Seen', false);
        break;

      case 'mark_unread':
        await this.#imap.setFlag(spec.ids, '\\Seen', true);
        break;

      case 'create_folder':
      case 'add_labels':
        // These reversal types are stored in ReversalSpec but not yet executable.
        // They will be implemented when deleteFolder/deleteEmails land.
        throw new Error(`Reversal of ${spec.type} not yet implemented`);

      default: {
        const _exhaustive: never = spec;
        throw new Error(`Unknown reversal type: ${(_exhaustive as ReversalSpec).type}`);
      }
    }
  }
}
