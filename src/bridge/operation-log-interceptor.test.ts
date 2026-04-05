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
    createLabel: jest.fn(),
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
    it('delegates to imap.createFolder and returns operationId', async () => {
      mock(imap.createFolder).mockResolvedValue({ path: 'NewFolder', created: true });

      const result = await interceptor.createFolder('NewFolder');

      expect(imap.createFolder).toHaveBeenCalledWith('NewFolder');
      expect(result).toHaveProperty('operationId');
      expect(log.size).toBe(1);
    });

    it('records create_folder reversal when folder was newly created', async () => {
      mock(imap.createFolder).mockResolvedValue({ path: 'Folders/New', created: true });

      await interceptor.createFolder('Folders/New');

      const records = log.getFrom(1);
      expect(records[0]!.reversal).toEqual({ type: 'create_folder', path: 'Folders/New' });
    });

    it('records noop reversal when folder already existed', async () => {
      mock(imap.createFolder).mockResolvedValue({ path: 'Folders/Existing', created: false });

      await interceptor.createFolder('Folders/Existing');

      const records = log.getFrom(1);
      expect(records[0]!.reversal).toEqual({ type: 'noop' });
    });
  });

  describe('createLabel', () => {
    it('delegates to imap.createLabel and returns operationId', async () => {
      mock(imap.createLabel).mockResolvedValue({ path: 'Labels/Important', created: true });

      const result = await interceptor.createLabel('Important');

      expect(imap.createLabel).toHaveBeenCalledWith('Important');
      expect(result).toHaveProperty('operationId');
      expect(log.size).toBe(1);
    });

    it('records noop reversal (deleteLabel not yet implemented)', async () => {
      mock(imap.createLabel).mockResolvedValue({ path: 'Labels/Important', created: true });

      await interceptor.createLabel('Important');

      const records = log.getFrom(1);
      expect(records[0]!.reversal).toEqual({ type: 'noop' });
    });
  });

  // ── Irreversible method tests ─────────────────────────────────────────────

  describe('deleteFolder', () => {
    it('delegates to imap.deleteFolder and returns SingleToolResult without operationId', async () => {
      mock(imap.deleteFolder).mockResolvedValue({ path: 'Folders/Work', deleted: true });

      const result = await interceptor.deleteFolder('Folders/Work');

      expect(imap.deleteFolder).toHaveBeenCalledWith('Folders/Work');
      expect(result).toEqual({ status: 'succeeded', data: { path: 'Folders/Work', deleted: true } });
      expect(result).not.toHaveProperty('operationId');
    });

    it('clears the operation log when deleted is true', async () => {
      // Pre-populate the log with a tracked operation
      mock(imap.createFolder).mockResolvedValue({ path: 'Folders/A', created: true });
      await interceptor.createFolder('Folders/A');
      expect(log.size).toBe(1);

      mock(imap.deleteFolder).mockResolvedValue({ path: 'Folders/A', deleted: true });
      await interceptor.deleteFolder('Folders/A');

      expect(log.size).toBe(0);
    });

    it('does not clear the log when deleted is false (folder did not exist)', async () => {
      // Pre-populate the log
      mock(imap.createFolder).mockResolvedValue({ path: 'Folders/A', created: true });
      await interceptor.createFolder('Folders/A');
      expect(log.size).toBe(1);

      mock(imap.deleteFolder).mockResolvedValue({ path: 'Folders/Missing', deleted: false });
      const result = await interceptor.deleteFolder('Folders/Missing');

      expect(result).toEqual({ status: 'succeeded', data: { path: 'Folders/Missing', deleted: false } });
      expect(log.size).toBe(1);
    });

    it('does not clear the log when imap.deleteFolder throws', async () => {
      // Pre-populate the log
      mock(imap.createFolder).mockResolvedValue({ path: 'Folders/A', created: true });
      await interceptor.createFolder('Folders/A');
      expect(log.size).toBe(1);

      mock(imap.deleteFolder).mockRejectedValue(new Error('FORBIDDEN'));

      await expect(interceptor.deleteFolder('Folders/Special')).rejects.toThrow('FORBIDDEN');
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

    it('reverses create_folder — calls imap.deleteFolder with the created path', async () => {
      mock(imap.createFolder).mockResolvedValue({ path: 'Folders/New', created: true });

      const result = await interceptor.createFolder('Folders/New');
      const operationId = (result as unknown as Record<string, unknown>).operationId as number;

      mock(imap.deleteFolder).mockReset().mockResolvedValue({ path: 'Folders/New' });

      const revertResult = await interceptor.revertOperations(operationId);

      expect(imap.deleteFolder).toHaveBeenCalledWith('Folders/New');
      expect(revertResult.stepsSucceeded).toBe(1);
    });

    it('skips reversal for create_folder that returned created: false (noop)', async () => {
      mock(imap.createFolder).mockResolvedValue({ path: 'Folders/Existing', created: false });

      const result = await interceptor.createFolder('Folders/Existing');
      const operationId = (result as unknown as Record<string, unknown>).operationId as number;

      const revertResult = await interceptor.revertOperations(operationId);

      expect(imap.deleteFolder).not.toHaveBeenCalled();
      expect(revertResult.stepsSucceeded).toBe(1);
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

  // ── UID rewriting during chain revert ─────────────────────────────────���────

  describe('UID rewriting during chain revert', () => {
    it('mark_read → move → revert rewrites flag reversal UIDs', async () => {
      // Op1: mark_read on INBOX:42
      const flagItems: BatchItemResult<FlagResult>[] = [
        { id: eid(42), status: 'succeeded', data: { flagsBefore: [], flagsAfter: ['\\Seen'] } },
      ];
      mock(imap.setFlag).mockResolvedValueOnce(flagItems);
      const r1 = await interceptor.markRead([eid(42)]);
      const opId1 = (r1 as unknown as Record<string, unknown>).operationId as number;

      // Op2: move INBOX:42 → Archive (gets Archive:101)
      const moveItems: BatchItemResult<MoveResult>[] = [
        { id: eid(42), status: 'succeeded', data: { fromMailbox: 'INBOX', toMailbox: 'Archive', targetId: eid(101, 'Archive') } },
      ];
      mock(imap.moveEmails).mockResolvedValueOnce(moveItems);
      await interceptor.moveEmails([eid(42)], 'Archive');

      // Reset mocks for revert phase
      // Move reversal: Archive:101 → INBOX gets new UID INBOX:55
      const moveRevertItems: BatchItemResult<MoveResult>[] = [
        { id: eid(101, 'Archive'), status: 'succeeded', data: { fromMailbox: 'Archive', toMailbox: 'INBOX', targetId: eid(55) } },
      ];
      mock(imap.moveEmails).mockReset().mockResolvedValueOnce(moveRevertItems);
      mock(imap.setFlag).mockReset().mockResolvedValueOnce([]);

      const revertResult = await interceptor.revertOperations(opId1);

      expect(revertResult.stepsSucceeded).toBe(2);
      // Flag reversal must use INBOX:55 (rewritten), not INBOX:42 (stale)
      expect(imap.setFlag).toHaveBeenCalledWith([eid(55)], '\\Seen', false);
    });

    it('mark_unread → move → revert rewrites UIDs', async () => {
      // Op1: mark_unread on INBOX:42
      const flagItems: BatchItemResult<FlagResult>[] = [
        { id: eid(42), status: 'succeeded', data: { flagsBefore: ['\\Seen'], flagsAfter: [] } },
      ];
      mock(imap.setFlag).mockResolvedValueOnce(flagItems);
      const r1 = await interceptor.markUnread([eid(42)]);
      const opId1 = (r1 as unknown as Record<string, unknown>).operationId as number;

      // Op2: move INBOX:42 → Archive (gets Archive:101)
      const moveItems: BatchItemResult<MoveResult>[] = [
        { id: eid(42), status: 'succeeded', data: { fromMailbox: 'INBOX', toMailbox: 'Archive', targetId: eid(101, 'Archive') } },
      ];
      mock(imap.moveEmails).mockResolvedValueOnce(moveItems);
      await interceptor.moveEmails([eid(42)], 'Archive');

      // Move reversal: Archive:101 → INBOX gets INBOX:55
      const moveRevertItems: BatchItemResult<MoveResult>[] = [
        { id: eid(101, 'Archive'), status: 'succeeded', data: { fromMailbox: 'Archive', toMailbox: 'INBOX', targetId: eid(55) } },
      ];
      mock(imap.moveEmails).mockReset().mockResolvedValueOnce(moveRevertItems);
      mock(imap.setFlag).mockReset().mockResolvedValueOnce([]);

      const revertResult = await interceptor.revertOperations(opId1);

      expect(revertResult.stepsSucceeded).toBe(2);
      // Flag reversal must use INBOX:55 and add \Seen (reverse of mark_unread)
      expect(imap.setFlag).toHaveBeenCalledWith([eid(55)], '\\Seen', true);
    });

    it('multiple emails: both marked read, both moved, revert rewrites both', async () => {
      // Op1: mark_read on INBOX:42 and INBOX:43
      const flagItems: BatchItemResult<FlagResult>[] = [
        { id: eid(42), status: 'succeeded', data: { flagsBefore: [], flagsAfter: ['\\Seen'] } },
        { id: eid(43), status: 'succeeded', data: { flagsBefore: [], flagsAfter: ['\\Seen'] } },
      ];
      mock(imap.setFlag).mockResolvedValueOnce(flagItems);
      const r1 = await interceptor.markRead([eid(42), eid(43)]);
      const opId1 = (r1 as unknown as Record<string, unknown>).operationId as number;

      // Op2: move both to Archive
      const moveItems: BatchItemResult<MoveResult>[] = [
        { id: eid(42), status: 'succeeded', data: { fromMailbox: 'INBOX', toMailbox: 'Archive', targetId: eid(101, 'Archive') } },
        { id: eid(43), status: 'succeeded', data: { fromMailbox: 'INBOX', toMailbox: 'Archive', targetId: eid(102, 'Archive') } },
      ];
      mock(imap.moveEmails).mockResolvedValueOnce(moveItems);
      await interceptor.moveEmails([eid(42), eid(43)], 'Archive');

      // Move reversal returns new UIDs
      const moveRevertItems: BatchItemResult<MoveResult>[] = [
        { id: eid(101, 'Archive'), status: 'succeeded', data: { fromMailbox: 'Archive', toMailbox: 'INBOX', targetId: eid(55) } },
        { id: eid(102, 'Archive'), status: 'succeeded', data: { fromMailbox: 'Archive', toMailbox: 'INBOX', targetId: eid(56) } },
      ];
      mock(imap.moveEmails).mockReset().mockResolvedValueOnce(moveRevertItems);
      mock(imap.setFlag).mockReset().mockResolvedValueOnce([]);

      const revertResult = await interceptor.revertOperations(opId1);

      expect(revertResult.stepsSucceeded).toBe(2);
      expect(imap.setFlag).toHaveBeenCalledWith([eid(55), eid(56)], '\\Seen', false);
    });

    it('partial COPYUID: one gets new UID, other has targetId undefined', async () => {
      // Op1: mark_read on INBOX:42 and INBOX:43
      const flagItems: BatchItemResult<FlagResult>[] = [
        { id: eid(42), status: 'succeeded', data: { flagsBefore: [], flagsAfter: ['\\Seen'] } },
        { id: eid(43), status: 'succeeded', data: { flagsBefore: [], flagsAfter: ['\\Seen'] } },
      ];
      mock(imap.setFlag).mockResolvedValueOnce(flagItems);
      const r1 = await interceptor.markRead([eid(42), eid(43)]);
      const opId1 = (r1 as unknown as Record<string, unknown>).operationId as number;

      // Op2: move both — only INBOX:42 gets a targetId
      const moveItems: BatchItemResult<MoveResult>[] = [
        { id: eid(42), status: 'succeeded', data: { fromMailbox: 'INBOX', toMailbox: 'Archive', targetId: eid(101, 'Archive') } },
        { id: eid(43), status: 'succeeded', data: { fromMailbox: 'INBOX', toMailbox: 'Archive', targetId: eid(102, 'Archive') } },
      ];
      mock(imap.moveEmails).mockResolvedValueOnce(moveItems);
      await interceptor.moveEmails([eid(42), eid(43)], 'Archive');

      // Move reversal: first gets new UID, second has no COPYUID
      const moveRevertItems: BatchItemResult<MoveResult>[] = [
        { id: eid(101, 'Archive'), status: 'succeeded', data: { fromMailbox: 'Archive', toMailbox: 'INBOX', targetId: eid(55) } },
        { id: eid(102, 'Archive'), status: 'succeeded', data: { fromMailbox: 'Archive', toMailbox: 'INBOX', targetId: undefined } },
      ];
      mock(imap.moveEmails).mockReset().mockResolvedValueOnce(moveRevertItems);
      mock(imap.setFlag).mockReset().mockResolvedValueOnce([]);

      const revertResult = await interceptor.revertOperations(opId1);

      expect(revertResult.stepsSucceeded).toBe(2);
      // First rewritten to INBOX:55, second keeps original INBOX:43
      expect(imap.setFlag).toHaveBeenCalledWith([eid(55), eid(43)], '\\Seen', false);
    });

    it('move reversal fails → no rewrite of remaining specs', async () => {
      // Op1: mark_read on INBOX:42
      const flagItems: BatchItemResult<FlagResult>[] = [
        { id: eid(42), status: 'succeeded', data: { flagsBefore: [], flagsAfter: ['\\Seen'] } },
      ];
      mock(imap.setFlag).mockResolvedValueOnce(flagItems);
      const r1 = await interceptor.markRead([eid(42)]);
      const opId1 = (r1 as unknown as Record<string, unknown>).operationId as number;

      // Op2: move INBOX:42 → Archive
      const moveItems: BatchItemResult<MoveResult>[] = [
        { id: eid(42), status: 'succeeded', data: { fromMailbox: 'INBOX', toMailbox: 'Archive', targetId: eid(101, 'Archive') } },
      ];
      mock(imap.moveEmails).mockResolvedValueOnce(moveItems);
      await interceptor.moveEmails([eid(42)], 'Archive');

      // Move reversal throws
      mock(imap.moveEmails).mockReset().mockRejectedValueOnce(new Error('IMAP_ERROR'));
      mock(imap.setFlag).mockReset().mockResolvedValueOnce([]);

      const revertResult = await interceptor.revertOperations(opId1);

      expect(revertResult.stepsFailed).toBe(1);   // move reversal failed
      expect(revertResult.stepsSucceeded).toBe(1); // flag reversal still attempted
      // Flag reversal uses original (stale) UID — best-effort, no rewriting happened
      expect(imap.setFlag).toHaveBeenCalledWith([eid(42)], '\\Seen', false);
    });

    it('noop spec unaffected by UID rewriting', async () => {
      // Op1: mark_read on already-read email (noop reversal)
      const noopItems: BatchItemResult<FlagResult>[] = [
        { id: eid(42), status: 'succeeded', data: { flagsBefore: ['\\Seen'], flagsAfter: ['\\Seen'] } },
      ];
      mock(imap.setFlag).mockResolvedValueOnce(noopItems);
      const r1 = await interceptor.markRead([eid(42)]);
      const opId1 = (r1 as unknown as Record<string, unknown>).operationId as number;

      // Op2: move INBOX:42 → Archive
      const moveItems: BatchItemResult<MoveResult>[] = [
        { id: eid(42), status: 'succeeded', data: { fromMailbox: 'INBOX', toMailbox: 'Archive', targetId: eid(101, 'Archive') } },
      ];
      mock(imap.moveEmails).mockResolvedValueOnce(moveItems);
      await interceptor.moveEmails([eid(42)], 'Archive');

      // Move reversal returns new UID
      const moveRevertItems: BatchItemResult<MoveResult>[] = [
        { id: eid(101, 'Archive'), status: 'succeeded', data: { fromMailbox: 'Archive', toMailbox: 'INBOX', targetId: eid(55) } },
      ];
      mock(imap.moveEmails).mockReset().mockResolvedValueOnce(moveRevertItems);

      const revertResult = await interceptor.revertOperations(opId1);

      // Both succeed — noop is harmless, no crash from rewriting
      expect(revertResult.stepsSucceeded).toBe(2);
      expect(revertResult.stepsFailed).toBe(0);
    });

    it('cascading moves: move A→B then B→C → revert rewrites progressively', async () => {
      // Op1: mark_read on INBOX:42
      const flagItems: BatchItemResult<FlagResult>[] = [
        { id: eid(42), status: 'succeeded', data: { flagsBefore: [], flagsAfter: ['\\Seen'] } },
      ];
      mock(imap.setFlag).mockResolvedValueOnce(flagItems);
      const r1 = await interceptor.markRead([eid(42)]);
      const opId1 = (r1 as unknown as Record<string, unknown>).operationId as number;

      // Op2: move INBOX:42 → Folder-A (gets Folder-A:101)
      const moveItems1: BatchItemResult<MoveResult>[] = [
        { id: eid(42), status: 'succeeded', data: { fromMailbox: 'INBOX', toMailbox: 'Folder-A', targetId: eid(101, 'Folder-A') } },
      ];
      mock(imap.moveEmails).mockResolvedValueOnce(moveItems1);
      await interceptor.moveEmails([eid(42)], 'Folder-A');

      // Op3: move Folder-A:101 → Folder-B (gets Folder-B:201)
      const moveItems2: BatchItemResult<MoveResult>[] = [
        { id: eid(101, 'Folder-A'), status: 'succeeded', data: { fromMailbox: 'Folder-A', toMailbox: 'Folder-B', targetId: eid(201, 'Folder-B') } },
      ];
      mock(imap.moveEmails).mockResolvedValueOnce(moveItems2);
      await interceptor.moveEmails([eid(101, 'Folder-A')], 'Folder-B');

      // Reset mocks for revert phase (reverse order: op3, op2, op1)
      mock(imap.moveEmails).mockReset();
      mock(imap.setFlag).mockReset();

      // Revert op3: Folder-B:201 → Folder-A gets Folder-A:301
      const revertMove3: BatchItemResult<MoveResult>[] = [
        { id: eid(201, 'Folder-B'), status: 'succeeded', data: { fromMailbox: 'Folder-B', toMailbox: 'Folder-A', targetId: eid(301, 'Folder-A') } },
      ];
      // Revert op2: should use Folder-A:301 (rewritten from Folder-A:101) → INBOX gets INBOX:55
      const revertMove2: BatchItemResult<MoveResult>[] = [
        { id: eid(301, 'Folder-A'), status: 'succeeded', data: { fromMailbox: 'Folder-A', toMailbox: 'INBOX', targetId: eid(55) } },
      ];
      mock(imap.moveEmails)
        .mockResolvedValueOnce(revertMove3)
        .mockResolvedValueOnce(revertMove2);
      mock(imap.setFlag).mockResolvedValueOnce([]);

      const revertResult = await interceptor.revertOperations(opId1);

      expect(revertResult.stepsSucceeded).toBe(3);

      // Verify op2 reversal used rewritten UID (Folder-A:301, not Folder-A:101)
      expect(imap.moveEmails).toHaveBeenNthCalledWith(2, [eid(301, 'Folder-A')], 'INBOX');

      // Verify flag reversal used final rewritten UID (INBOX:55, not INBOX:42)
      expect(imap.setFlag).toHaveBeenCalledWith([eid(55)], '\\Seen', false);
    });
  });

});

