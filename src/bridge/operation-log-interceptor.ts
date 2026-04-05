import type { ImapClient } from './imap.js';
import { OperationLog } from './operation-log.js';
import { Tracked, IrreversibleWhen } from './decorators.js';
import { formatEmailId, type EmailId } from '../types/email.js';
import type {
  BatchToolResult,
  MoveResult,
  FlagResult,
  SingleToolResult,
  CreateMailboxResult,
  CreateFolderResult,
  CreateLabelResult,
  DeleteFolderResult,
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

function buildFlagReversal(type: 'mark_read' | 'mark_unread', flag: string) {
  return (_args: unknown[], result: unknown): ReversalSpec | null => {
    const r = result as BatchToolResult<FlagResult>;
    const ids = r.items
      .filter(item => {
        if (item.status !== 'succeeded' || !item.data) return false;
        const hadFlag = item.data.flagsBefore.includes(flag);
        const hasFlag = item.data.flagsAfter.includes(flag);
        return hadFlag !== hasFlag; // only include if the flag actually changed
      })
      .map(item => item.id);
    if (ids.length === 0) return null;
    return { type, ids };
  };
}

const buildMarkReadReversal = buildFlagReversal('mark_read', '\\Seen');
const buildMarkUnreadReversal = buildFlagReversal('mark_unread', '\\Seen');


function buildCreateMailboxReversal(type: 'create_folder') {
  return (_args: unknown[], result: unknown): ReversalSpec | null => {
    const r = result as SingleToolResult<CreateMailboxResult>;
    if (!r.data.created) return null; // mailbox already existed — don't delete on revert
    return { type, path: r.data.path };
  };
}

const buildCreateFolderReversal = buildCreateMailboxReversal('create_folder');

// buildAddLabelsReversal not yet tracked — requires deleteEmails (see TODO.md).

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

  // Tracked as noop — reversal requires deleteLabel (existing GitHub issue).
  // buildReversal returns null → @Tracked records { type: 'noop' }.
  @Tracked('create_label', () => null)
  async createLabel(name: string): Promise<SingleToolResult<CreateLabelResult>> {
    const data = await this.#imap.createLabel(name);
    return { status: 'succeeded' as const, data };
  }

  @IrreversibleWhen((result) => (result as SingleToolResult<DeleteFolderResult>).data.deleted)
  async deleteFolder(path: string): Promise<SingleToolResult<DeleteFolderResult>> {
    const data = await this.#imap.deleteFolder(path);
    return { status: 'succeeded' as const, data };
  }

  // Tracked as noop — reversal requires deleteEmails (separate branch).
  // buildReversal returns null → @Tracked records { type: 'noop' }.
  @Tracked('add_labels', () => null)
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

    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      try {
        const uidMap = await this.#executeReversal(record.reversal);
        this.log.remove(record.id);
        steps.push({ operationId: record.id, tool: record.tool, status: 'succeeded' });

        if (uidMap && uidMap.size > 0) {
          const remaining = records.slice(i + 1).map(r => r.reversal);
          this.#rewriteSpecs(remaining, uidMap);
        }
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

  async #executeReversal(spec: ReversalSpec): Promise<Map<string, EmailId> | undefined> {
    switch (spec.type) {
      case 'noop':
        return undefined;

      case 'move_batch': {
        const uidMap = new Map<string, EmailId>();
        const byMailbox = new Map<string, EmailId[]>();
        const fromLookup = new Map<string, EmailId>();

        for (const move of spec.moves) {
          const target = move.to.mailbox;
          const ids = byMailbox.get(target) ?? [];
          ids.push(move.from);
          byMailbox.set(target, ids);
          fromLookup.set(formatEmailId(move.from), move.to);
        }

        for (const [mailbox, ids] of byMailbox) {
          const results = await this.#imap.moveEmails(ids, mailbox);
          for (const item of results) {
            if (item.status === 'succeeded' && item.data?.targetId) {
              const originalId = fromLookup.get(formatEmailId(item.id));
              if (originalId) {
                uidMap.set(formatEmailId(originalId), item.data.targetId);
              }
            }
          }
        }

        return uidMap;
      }

      case 'mark_read':
        await this.#imap.setFlag(spec.ids, '\\Seen', false);
        return undefined;

      case 'mark_unread':
        await this.#imap.setFlag(spec.ids, '\\Seen', true);
        return undefined;

      case 'create_folder':
        await this.#imap.deleteFolder(spec.path);
        return undefined;

      case 'add_labels':
        // Reversal requires deleteEmails — not yet implemented.
        throw new Error(`Reversal of ${spec.type} not yet implemented`);

      default: {
        const _exhaustive: never = spec;
        throw new Error(`Unknown reversal type: ${(_exhaustive as ReversalSpec).type}`);
      }
    }
  }

  #rewriteSpecs(specs: ReversalSpec[], uidMap: Map<string, EmailId>): void {
    for (const spec of specs) {
      switch (spec.type) {
        case 'mark_read':
        case 'mark_unread':
          spec.ids = spec.ids.map(id => uidMap.get(formatEmailId(id)) ?? id);
          break;
        case 'move_batch':
          for (const move of spec.moves) {
            const newFrom = uidMap.get(formatEmailId(move.from));
            if (newFrom) move.from = newFrom;
            const newTo = uidMap.get(formatEmailId(move.to));
            if (newTo) move.to = newTo;
          }
          break;
      }
    }
  }
}
