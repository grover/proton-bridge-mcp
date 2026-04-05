import { jest } from '@jest/globals';
import { OperationLogInterceptor } from './operation-log-interceptor.js';
import { OperationLog } from './operation-log.js';
import type { ImapClient } from './imap.js';
import type { EmailId } from '../types/email.js';
import type {
  BatchItemResult,
  MoveResult,
  FlagResult,
  AddLabelsBatchResult,
} from '../types/operations.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<(...args: any[]) => any>;

function createMockImap() {
  return {
    moveEmails: jest.fn(),
    setFlag: jest.fn(),
    createFolder: jest.fn(),
    addLabels: jest.fn(),
    deleteFolder: jest.fn(),
    deleteEmails: jest.fn(),
  } as unknown as ImapClient;
}

function mock(fn: unknown): AnyMock {
  return fn as AnyMock;
}

function eid(uid: number, mailbox = 'INBOX'): EmailId {
  return { uid, mailbox };
}

describe('OperationLogInterceptor', () => {
  let imap: ReturnType<typeof createMockImap>;
  let log: OperationLog;
  let interceptor: OperationLogInterceptor;

  beforeEach(() => {
    imap = createMockImap();
    log = new OperationLog();
    interceptor = new OperationLogInterceptor(imap, log);
  });

  // ── Tracked method tests ────────────────────────────────────────────────────

  describe('moveEmails', () => {
    it('delegates to imap.moveEmails and result includes operationId', async () => {
      const ids = [eid(1), eid(2)];
      const items: BatchItemResult<MoveResult>[] = [
        { id: eid(1), status: 'succeeded', data: { fromMailbox: 'INBOX', toMailbox: 'Archive', targetId: eid(101, 'Archive') } },
        { id: eid(2), status: 'succeeded', data: { fromMailbox: 'INBOX', toMailbox: 'Archive', targetId: eid(102, 'Archive') } },
      ];
      mock(imap.moveEmails).mockResolvedValue(items);

      const result = await interceptor.moveEmails(ids, 'Archive');

      expect(imap.moveEmails).toHaveBeenCalledWith(ids, 'Archive');
      expect(result).toHaveProperty('operationId');
      expect(typeof (result as unknown as Record<string, unknown>).operationId).toBe('number');
    });

    it('builds correct move_batch reversal with reversed from/to', async () => {
      const ids = [eid(1), eid(2)];
      const items: BatchItemResult<MoveResult>[] = [
        { id: eid(1), status: 'succeeded', data: { fromMailbox: 'INBOX', toMailbox: 'Archive', targetId: eid(101, 'Archive') } },
        { id: eid(2), status: 'succeeded', data: { fromMailbox: 'INBOX', toMailbox: 'Archive', targetId: eid(102, 'Archive') } },
      ];
      mock(imap.moveEmails).mockResolvedValue(items);

      const result = await interceptor.moveEmails(ids, 'Archive');
      const operationId = (result as unknown as Record<string, unknown>).operationId as number;
      const records = log.getFrom(operationId);

      expect(records).toHaveLength(1);
      expect(records[0]!.tool).toBe('move_emails');
      expect(records[0]!.reversal).toEqual({
        type: 'move_batch',
        moves: [
          { from: eid(101, 'Archive'), to: eid(1) },
          { from: eid(102, 'Archive'), to: eid(2) },
        ],
      });
    });

    it('reversal only includes succeeded items on partial failure', async () => {
      const ids = [eid(1), eid(2), eid(3)];
      const items: BatchItemResult<MoveResult>[] = [
        { id: eid(1), status: 'succeeded', data: { fromMailbox: 'INBOX', toMailbox: 'Archive', targetId: eid(101, 'Archive') } },
        { id: eid(2), status: 'failed', error: { code: 'IMAP_ERROR', message: 'fail' } },
        { id: eid(3), status: 'succeeded', data: { fromMailbox: 'INBOX', toMailbox: 'Archive', targetId: eid(103, 'Archive') } },
      ];
      mock(imap.moveEmails).mockResolvedValue(items);

      const result = await interceptor.moveEmails(ids, 'Archive');
      const operationId = (result as unknown as Record<string, unknown>).operationId as number;
      const records = log.getFrom(operationId);

      expect(records[0]!.reversal).toEqual({
        type: 'move_batch',
        moves: [
          { from: eid(101, 'Archive'), to: eid(1) },
          { from: eid(103, 'Archive'), to: eid(3) },
        ],
      });
    });
  });

  describe('markRead', () => {
    it('delegates to imap.setFlag and returns operationId', async () => {
      const ids = [eid(1), eid(2)];
      const items: BatchItemResult<FlagResult>[] = [
        { id: eid(1), status: 'succeeded', data: { flagsBefore: [], flagsAfter: ['\\Seen'] } },
        { id: eid(2), status: 'succeeded', data: { flagsBefore: [], flagsAfter: ['\\Seen'] } },
      ];
      mock(imap.setFlag).mockResolvedValue(items);

      const result = await interceptor.markRead(ids);

      expect(imap.setFlag).toHaveBeenCalledWith(ids, '\\Seen', true);
      expect(result).toHaveProperty('operationId');
    });

    it('builds correct mark_read reversal with succeeded IDs', async () => {
      const ids = [eid(1), eid(2), eid(3)];
      const items: BatchItemResult<FlagResult>[] = [
        { id: eid(1), status: 'succeeded', data: { flagsBefore: [], flagsAfter: ['\\Seen'] } },
        { id: eid(2), status: 'failed', error: { code: 'IMAP_ERROR', message: 'fail' } },
        { id: eid(3), status: 'succeeded', data: { flagsBefore: [], flagsAfter: ['\\Seen'] } },
      ];
      mock(imap.setFlag).mockResolvedValue(items);

      const result = await interceptor.markRead(ids);
      const operationId = (result as unknown as Record<string, unknown>).operationId as number;
      const records = log.getFrom(operationId);

      expect(records).toHaveLength(1);
      expect(records[0]!.tool).toBe('mark_read');
      expect(records[0]!.reversal).toEqual({
        type: 'mark_read',
        ids: [eid(1), eid(3)],
      });
    });

    it('records noop when all emails already have \\Seen — operationId present, revert is harmless', async () => {
      const ids = [eid(1)];
      const items: BatchItemResult<FlagResult>[] = [
        { id: eid(1), status: 'succeeded', data: { flagsBefore: ['\\Seen'], flagsAfter: ['\\Seen'] } },
      ];
      mock(imap.setFlag).mockResolvedValue(items);

      const result = await interceptor.markRead(ids);
      const operationId = (result as unknown as Record<string, unknown>).operationId as number;

      expect(result).toHaveProperty('operationId');
      expect(log.size).toBe(1);

      // Revert the noop — should succeed harmlessly
      const revertResult = await interceptor.revertOperations(operationId);
      expect(revertResult.stepsTotal).toBe(1);
      expect(revertResult.stepsSucceeded).toBe(1);
    });

    it('mixed batch: only tracks emails whose flags actually changed (excludes no-ops)', async () => {
      const ids = [eid(1), eid(2)];
      const items: BatchItemResult<FlagResult>[] = [
        { id: eid(1), status: 'succeeded', data: { flagsBefore: [], flagsAfter: ['\\Seen'] } },       // changed
        { id: eid(2), status: 'succeeded', data: { flagsBefore: ['\\Seen'], flagsAfter: ['\\Seen'] } }, // no-op
      ];
      mock(imap.setFlag).mockResolvedValue(items);

      const result = await interceptor.markRead(ids);
      const operationId = (result as unknown as Record<string, unknown>).operationId as number;
      const records = log.getFrom(operationId);

      expect(records).toHaveLength(1);
      expect(records[0]!.reversal).toEqual({ type: 'mark_read', ids: [eid(1)] });
    });

    it('three-way mixed batch: changed + no-op + failed — reversal includes only the changed one', async () => {
      const ids = [eid(1), eid(2), eid(3)];
      const items: BatchItemResult<FlagResult>[] = [
        { id: eid(1), status: 'succeeded', data: { flagsBefore: [], flagsAfter: ['\\Seen'] } },       // changed
        { id: eid(2), status: 'succeeded', data: { flagsBefore: ['\\Seen'], flagsAfter: ['\\Seen'] } }, // no-op
        { id: eid(3), status: 'failed', error: { code: 'IMAP_ERROR', message: 'fail' } },              // failed
      ];
      mock(imap.setFlag).mockResolvedValue(items);

      const result = await interceptor.markRead(ids);
      const operationId = (result as unknown as Record<string, unknown>).operationId as number;
      const records = log.getFrom(operationId);

      expect(records).toHaveLength(1);
      expect(records[0]!.reversal).toEqual({ type: 'mark_read', ids: [eid(1)] });
    });
  });

  describe('markUnread', () => {
    it('delegates to imap.setFlag and returns operationId', async () => {
      const ids = [eid(1)];
      const items: BatchItemResult<FlagResult>[] = [
        { id: eid(1), status: 'succeeded', data: { flagsBefore: ['\\Seen'], flagsAfter: [] } },
      ];
      mock(imap.setFlag).mockResolvedValue(items);

      const result = await interceptor.markUnread(ids);

      expect(imap.setFlag).toHaveBeenCalledWith(ids, '\\Seen', false);
      expect(result).toHaveProperty('operationId');
    });

    it('builds correct mark_unread reversal', async () => {
      const ids = [eid(1), eid(2)];
      const items: BatchItemResult<FlagResult>[] = [
        { id: eid(1), status: 'succeeded', data: { flagsBefore: ['\\Seen'], flagsAfter: [] } },
        { id: eid(2), status: 'succeeded', data: { flagsBefore: ['\\Seen'], flagsAfter: [] } },
      ];
      mock(imap.setFlag).mockResolvedValue(items);

      const result = await interceptor.markUnread(ids);
      const operationId = (result as unknown as Record<string, unknown>).operationId as number;
      const records = log.getFrom(operationId);

      expect(records).toHaveLength(1);
      expect(records[0]!.tool).toBe('mark_unread');
      expect(records[0]!.reversal).toEqual({
        type: 'mark_unread',
        ids: [eid(1), eid(2)],
      });
    });

    it('records noop when all emails already lack \\Seen — operationId present, revert is harmless', async () => {
      const ids = [eid(1)];
      const items: BatchItemResult<FlagResult>[] = [
        { id: eid(1), status: 'succeeded', data: { flagsBefore: [], flagsAfter: [] } },
      ];
      mock(imap.setFlag).mockResolvedValue(items);

      const result = await interceptor.markUnread(ids);

      expect(result).toHaveProperty('operationId');
      expect(log.size).toBe(1);
    });
  });

  describe('createFolder', () => {
    it('delegates to imap.createFolder and returns operationId (noop — reversal not yet implemented)', async () => {
      mock(imap.createFolder).mockResolvedValue({ path: 'NewFolder', created: true });

      const result = await interceptor.createFolder('NewFolder');

      expect(imap.createFolder).toHaveBeenCalledWith('NewFolder');
      expect(result).toHaveProperty('operationId');
      expect(log.size).toBe(1);
    });
  });

  describe('addLabels', () => {
    it('delegates to imap.addLabels and returns operationId (noop — reversal not yet implemented)', async () => {
      const ids = [eid(1)];
      const labels = ['Important'];
      const batchResult: AddLabelsBatchResult = {
        status: 'succeeded',
        items: [
          {
            id: eid(1),
            status: 'succeeded',
            data: [{ labelPath: 'Labels/Important', newId: eid(50, 'Labels/Important') }],
          },
        ],
      };
      mock(imap.addLabels).mockResolvedValue(batchResult);

      const result = await interceptor.addLabels(ids, labels);

      expect(imap.addLabels).toHaveBeenCalledWith(ids, labels);
      expect(result).toHaveProperty('operationId');
      expect(log.size).toBe(1);
    });
  });

  // ── Revert tests ────────────────────────────────────────────────────────────

  describe('revertOperations', () => {
    it('throws UNKNOWN_OPERATION_ID for unknown ID', async () => {
      await expect(interceptor.revertOperations(999)).rejects.toThrow('UNKNOWN_OPERATION_ID');
    });

    it('reverses move_batch — calls imap.moveEmails with reversed from/to', async () => {
      const items: BatchItemResult<MoveResult>[] = [
        { id: eid(1), status: 'succeeded', data: { fromMailbox: 'INBOX', toMailbox: 'Trash', targetId: eid(101, 'Trash') } },
      ];
      mock(imap.moveEmails).mockResolvedValue(items);

      const result = await interceptor.moveEmails([eid(1)], 'Trash');
      const operationId = (result as unknown as Record<string, unknown>).operationId as number;

      // Reset mock to track reversal calls
      mock(imap.moveEmails).mockReset().mockResolvedValue([]);

      const revertResult = await interceptor.revertOperations(operationId);

      expect(imap.moveEmails).toHaveBeenCalledWith([eid(101, 'Trash')], 'INBOX');
      expect(revertResult.stepsSucceeded).toBe(1);
    });

    it('reverses mark_read — calls imap.setFlag with \\Seen false', async () => {
      const items: BatchItemResult<FlagResult>[] = [
        { id: eid(1), status: 'succeeded', data: { flagsBefore: [], flagsAfter: ['\\Seen'] } },
        { id: eid(2), status: 'succeeded', data: { flagsBefore: [], flagsAfter: ['\\Seen'] } },
      ];
      mock(imap.setFlag).mockResolvedValue(items);

      const result = await interceptor.markRead([eid(1), eid(2)]);
      const operationId = (result as unknown as Record<string, unknown>).operationId as number;

      mock(imap.setFlag).mockReset().mockResolvedValue([]);

      const revertResult = await interceptor.revertOperations(operationId);

      expect(imap.setFlag).toHaveBeenCalledWith([eid(1), eid(2)], '\\Seen', false);
      expect(revertResult.stepsSucceeded).toBe(1);
    });

    it('reverses mark_unread — calls imap.setFlag with \\Seen true', async () => {
      const items: BatchItemResult<FlagResult>[] = [
        { id: eid(1), status: 'succeeded', data: { flagsBefore: ['\\Seen'], flagsAfter: [] } },
      ];
      mock(imap.setFlag).mockResolvedValue(items);

      const result = await interceptor.markUnread([eid(1)]);
      const operationId = (result as unknown as Record<string, unknown>).operationId as number;

      mock(imap.setFlag).mockReset().mockResolvedValue([]);

      const revertResult = await interceptor.revertOperations(operationId);

      expect(imap.setFlag).toHaveBeenCalledWith([eid(1)], '\\Seen', true);
      expect(revertResult.stepsSucceeded).toBe(1);
    });

    it('processes in reverse chronological order', async () => {
      // Push 3 operations
      const flagItems1: BatchItemResult<FlagResult>[] = [
        { id: eid(1), status: 'succeeded', data: { flagsBefore: [], flagsAfter: ['\\Seen'] } },
      ];
      const flagItems2: BatchItemResult<FlagResult>[] = [
        { id: eid(2), status: 'succeeded', data: { flagsBefore: [], flagsAfter: ['\\Seen'] } },
      ];
      const flagItems3: BatchItemResult<FlagResult>[] = [
        { id: eid(3), status: 'succeeded', data: { flagsBefore: ['\\Seen'], flagsAfter: [] } },
      ];

      mock(imap.setFlag).mockResolvedValueOnce(flagItems1);
      const r1 = await interceptor.markRead([eid(1)]);
      const opId1 = (r1 as unknown as Record<string, unknown>).operationId as number;

      mock(imap.setFlag).mockResolvedValueOnce(flagItems2);
      await interceptor.markRead([eid(2)]);

      mock(imap.setFlag).mockResolvedValueOnce(flagItems3);
      await interceptor.markUnread([eid(3)]);

      // Reset and track call order
      mock(imap.setFlag).mockReset().mockResolvedValue([]);
      const callOrder: string[] = [];
      mock(imap.setFlag).mockImplementation(async (ids: EmailId[]) => {
        callOrder.push(`uid:${ids[0]!.uid}`);
        return [];
      });

      await interceptor.revertOperations(opId1);

      // Reverse order: op3 (uid:3), op2 (uid:2), op1 (uid:1)
      expect(callOrder).toEqual(['uid:3', 'uid:2', 'uid:1']);
    });

    it('removes only successfully reverted records from log', async () => {
      // Push two mark_read ops; make the second one's reversal fail
      const items1: BatchItemResult<FlagResult>[] = [
        { id: eid(1), status: 'succeeded', data: { flagsBefore: [], flagsAfter: ['\\Seen'] } },
      ];
      mock(imap.setFlag).mockResolvedValueOnce(items1);
      const r1 = await interceptor.markRead([eid(1)]);
      const opId1 = (r1 as unknown as Record<string, unknown>).operationId as number;

      const items2: BatchItemResult<FlagResult>[] = [
        { id: eid(2), status: 'succeeded', data: { flagsBefore: [], flagsAfter: ['\\Seen'] } },
      ];
      mock(imap.setFlag).mockResolvedValueOnce(items2);
      const r2 = await interceptor.markRead([eid(2)]);
      const opId2 = (r2 as unknown as Record<string, unknown>).operationId as number;

      // Reversal: op2 succeeds, op1 fails
      mock(imap.setFlag).mockReset()
        .mockResolvedValueOnce([]) // op2 reversal succeeds
        .mockRejectedValueOnce(new Error('IMAP_ERROR')); // op1 reversal fails

      const revertResult = await interceptor.revertOperations(opId1);

      expect(revertResult.stepsSucceeded).toBe(1);
      expect(revertResult.stepsFailed).toBe(1);
      expect(log.has(opId2)).toBe(false); // reverted successfully, removed
      expect(log.has(opId1)).toBe(true);  // failed, still in log
    });

    it('continues on error (best-effort) — first fails, second succeeds', async () => {
      // Two mark_read ops
      const items1: BatchItemResult<FlagResult>[] = [
        { id: eid(1), status: 'succeeded', data: { flagsBefore: [], flagsAfter: ['\\Seen'] } },
      ];
      mock(imap.setFlag).mockResolvedValueOnce(items1);
      const r1 = await interceptor.markRead([eid(1)]);
      const opId1 = (r1 as unknown as Record<string, unknown>).operationId as number;

      const items2: BatchItemResult<FlagResult>[] = [
        { id: eid(2), status: 'succeeded', data: { flagsBefore: [], flagsAfter: ['\\Seen'] } },
      ];
      mock(imap.setFlag).mockResolvedValueOnce(items2);
      await interceptor.markRead([eid(2)]);

      // Reverse order: op2 fails, op1 succeeds
      mock(imap.setFlag).mockReset()
        .mockRejectedValueOnce(new Error('IMAP_ERROR')) // op2 reversal fails
        .mockResolvedValueOnce([]); // op1 reversal succeeds

      const revertResult = await interceptor.revertOperations(opId1);

      expect(revertResult.steps).toHaveLength(2);
      const successStep = revertResult.steps.find(s => s.status === 'succeeded');
      expect(successStep).toBeDefined();
      expect(successStep!.tool).toBe('mark_read');
      const errorStep = revertResult.steps.find(s => s.status === 'failed');
      expect(errorStep).toBeDefined();
      expect(errorStep!.tool).toBe('mark_read');
      expect(errorStep!.error).toContain('IMAP_ERROR');
    });

    it('returns correct summary counts', async () => {
      // Two operations: op2 reversal fails, op1 succeeds
      const items1: BatchItemResult<FlagResult>[] = [
        { id: eid(1), status: 'succeeded', data: { flagsBefore: ['\\Seen'], flagsAfter: [] } },
      ];
      mock(imap.setFlag).mockResolvedValueOnce(items1);
      const r1 = await interceptor.markUnread([eid(1)]);
      const opId1 = (r1 as unknown as Record<string, unknown>).operationId as number;

      const items2: BatchItemResult<FlagResult>[] = [
        { id: eid(2), status: 'succeeded', data: { flagsBefore: [], flagsAfter: ['\\Seen'] } },
      ];
      mock(imap.setFlag).mockResolvedValueOnce(items2);
      await interceptor.markRead([eid(2)]);

      mock(imap.setFlag).mockReset()
        .mockRejectedValueOnce(new Error('fail')) // op2 reversal fails
        .mockResolvedValueOnce([]); // op1 reversal succeeds

      const revertResult = await interceptor.revertOperations(opId1);

      expect(revertResult.stepsTotal).toBe(2);
      expect(revertResult.stepsSucceeded).toBe(1);
      expect(revertResult.stepsFailed).toBe(1);
    });

    it('revert calls imap directly — no new log entries created during revert', async () => {
      const items: BatchItemResult<FlagResult>[] = [
        { id: eid(1), status: 'succeeded', data: { flagsBefore: [], flagsAfter: ['\\Seen'] } },
      ];
      mock(imap.setFlag).mockResolvedValue(items);

      const result = await interceptor.markRead([eid(1)]);
      const operationId = (result as unknown as Record<string, unknown>).operationId as number;

      expect(log.size).toBe(1);

      mock(imap.setFlag).mockReset().mockResolvedValue([]);

      await interceptor.revertOperations(operationId);

      // The reverted record is removed; no new records added
      expect(log.size).toBe(0);
    });
  });

});

