import { jest } from '@jest/globals';
import { OperationLogInterceptor } from './operation-log-interceptor.js';
import { OperationLog } from './operation-log.js';
import type { ImapClient } from './imap.js';
import type { EmailId } from '../types/email.js';
import type {
  BatchItemResult,
  MoveResult,
  FlagResult,
  AddLabelsItemData,
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
        { id: eid(1), status: 'succeeded', data: { flagsAfter: ['\\Seen'] } },
        { id: eid(2), status: 'succeeded', data: { flagsAfter: ['\\Seen'] } },
      ];
      mock(imap.setFlag).mockResolvedValue(items);

      const result = await interceptor.markRead(ids);

      expect(imap.setFlag).toHaveBeenCalledWith(ids, '\\Seen', true);
      expect(result).toHaveProperty('operationId');
    });

    it('builds correct mark_read reversal with succeeded IDs', async () => {
      const ids = [eid(1), eid(2), eid(3)];
      const items: BatchItemResult<FlagResult>[] = [
        { id: eid(1), status: 'succeeded', data: { flagsAfter: ['\\Seen'] } },
        { id: eid(2), status: 'failed', error: { code: 'IMAP_ERROR', message: 'fail' } },
        { id: eid(3), status: 'succeeded', data: { flagsAfter: ['\\Seen'] } },
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
  });

  describe('markUnread', () => {
    it('delegates to imap.setFlag and returns operationId', async () => {
      const ids = [eid(1)];
      const items: BatchItemResult<FlagResult>[] = [
        { id: eid(1), status: 'succeeded', data: { flagsAfter: [] } },
      ];
      mock(imap.setFlag).mockResolvedValue(items);

      const result = await interceptor.markUnread(ids);

      expect(imap.setFlag).toHaveBeenCalledWith(ids, '\\Seen', false);
      expect(result).toHaveProperty('operationId');
    });

    it('builds correct mark_unread reversal', async () => {
      const ids = [eid(1), eid(2)];
      const items: BatchItemResult<FlagResult>[] = [
        { id: eid(1), status: 'succeeded', data: { flagsAfter: [] } },
        { id: eid(2), status: 'succeeded', data: { flagsAfter: [] } },
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
  });

  describe('createFolder', () => {
    it('tracks when created === true', async () => {
      mock(imap.createFolder).mockResolvedValue({ path: 'NewFolder', created: true });

      const result = await interceptor.createFolder('NewFolder');

      expect(result).toHaveProperty('operationId');
      expect(log.size).toBe(1);
    });

    it('does NOT track when created === false', async () => {
      mock(imap.createFolder).mockResolvedValue({ path: 'ExistingFolder', created: false });

      const result = await interceptor.createFolder('ExistingFolder');

      expect(result).not.toHaveProperty('operationId');
      expect(log.size).toBe(0);
    });
  });

  describe('addLabels', () => {
    it('delegates to imap.addLabels and returns operationId', async () => {
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
    });

    it('builds correct add_labels reversal with copy UIDs', async () => {
      const ids = [eid(1), eid(2)];
      const labels = ['Important', 'Work'];
      const batchResult: AddLabelsBatchResult = {
        status: 'succeeded',
        items: [
          {
            id: eid(1),
            status: 'succeeded',
            data: [
              { labelPath: 'Labels/Important', newId: eid(50, 'Labels/Important') },
              { labelPath: 'Labels/Work', newId: eid(51, 'Labels/Work') },
            ],
          },
          {
            id: eid(2),
            status: 'succeeded',
            data: [
              { labelPath: 'Labels/Important', newId: eid(52, 'Labels/Important') },
              { labelPath: 'Labels/Work', newId: eid(53, 'Labels/Work') },
            ],
          },
        ],
      };
      mock(imap.addLabels).mockResolvedValue(batchResult);

      const result = await interceptor.addLabels(ids, labels);
      const operationId = (result as unknown as Record<string, unknown>).operationId as number;
      const records = log.getFrom(operationId);

      expect(records).toHaveLength(1);
      expect(records[0]!.tool).toBe('add_labels');
      expect(records[0]!.reversal).toEqual({
        type: 'add_labels',
        entries: [
          { original: eid(1), labelPath: 'Labels/Important', copy: eid(50, 'Labels/Important') },
          { original: eid(1), labelPath: 'Labels/Work', copy: eid(51, 'Labels/Work') },
          { original: eid(2), labelPath: 'Labels/Important', copy: eid(52, 'Labels/Important') },
          { original: eid(2), labelPath: 'Labels/Work', copy: eid(53, 'Labels/Work') },
        ],
      });
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
        { id: eid(1), status: 'succeeded', data: { flagsAfter: ['\\Seen'] } },
        { id: eid(2), status: 'succeeded', data: { flagsAfter: ['\\Seen'] } },
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
        { id: eid(1), status: 'succeeded', data: { flagsAfter: [] } },
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
        { id: eid(1), status: 'succeeded', data: { flagsAfter: ['\\Seen'] } },
      ];
      const flagItems2: BatchItemResult<FlagResult>[] = [
        { id: eid(2), status: 'succeeded', data: { flagsAfter: ['\\Seen'] } },
      ];
      const flagItems3: BatchItemResult<FlagResult>[] = [
        { id: eid(3), status: 'succeeded', data: { flagsAfter: [] } },
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
      // Push a create_folder (will fail on revert) and a mark_read (will succeed)
      mock(imap.createFolder).mockResolvedValue({ path: 'TestFolder', created: true });
      const r1 = await interceptor.createFolder('TestFolder');
      const opId1 = (r1 as unknown as Record<string, unknown>).operationId as number;

      const flagItems: BatchItemResult<FlagResult>[] = [
        { id: eid(1), status: 'succeeded', data: { flagsAfter: ['\\Seen'] } },
      ];
      mock(imap.setFlag).mockResolvedValue(flagItems);
      await interceptor.markRead([eid(1)]);

      mock(imap.setFlag).mockReset().mockResolvedValue([]);

      const revertResult = await interceptor.revertOperations(opId1);

      // mark_read reverted successfully (removed), create_folder failed (still in log)
      expect(revertResult.stepsSucceeded).toBe(1);
      expect(revertResult.stepsFailed).toBe(1);
      expect(log.has(opId1)).toBe(true); // create_folder still present
    });

    it('continues on error (best-effort) — first fails, second succeeds', async () => {
      // First: create_folder (revert throws "not yet implemented")
      mock(imap.createFolder).mockResolvedValue({ path: 'Folder1', created: true });
      const r1 = await interceptor.createFolder('Folder1');
      const opId1 = (r1 as unknown as Record<string, unknown>).operationId as number;

      // Second: markRead (revert will succeed)
      const flagItems: BatchItemResult<FlagResult>[] = [
        { id: eid(5), status: 'succeeded', data: { flagsAfter: ['\\Seen'] } },
      ];
      mock(imap.setFlag).mockResolvedValue(flagItems);
      await interceptor.markRead([eid(5)]);

      mock(imap.setFlag).mockReset().mockResolvedValue([]);

      const revertResult = await interceptor.revertOperations(opId1);

      // Both steps attempted; reverse order means markRead is first, create_folder second
      expect(revertResult.steps).toHaveLength(2);
      // markRead revert succeeds
      const successStep = revertResult.steps.find(s => s.status === 'success');
      expect(successStep).toBeDefined();
      expect(successStep!.tool).toBe('mark_read');
      // create_folder revert errors
      const errorStep = revertResult.steps.find(s => s.status === 'error');
      expect(errorStep).toBeDefined();
      expect(errorStep!.tool).toBe('create_folder');
      expect(errorStep!.error).toContain('not yet implemented');
    });

    it('returns correct summary counts', async () => {
      // Two operations: one that will revert OK, one that will fail
      mock(imap.createFolder).mockResolvedValue({ path: 'X', created: true });
      const r1 = await interceptor.createFolder('X');
      const opId1 = (r1 as unknown as Record<string, unknown>).operationId as number;

      const flagItems: BatchItemResult<FlagResult>[] = [
        { id: eid(1), status: 'succeeded', data: { flagsAfter: [] } },
      ];
      mock(imap.setFlag).mockResolvedValue(flagItems);
      await interceptor.markUnread([eid(1)]);

      mock(imap.setFlag).mockReset().mockResolvedValue([]);

      const revertResult = await interceptor.revertOperations(opId1);

      expect(revertResult.stepsTotal).toBe(2);
      expect(revertResult.stepsSucceeded).toBe(1);
      expect(revertResult.stepsFailed).toBe(1);
    });

    it('revert calls imap directly — no new log entries created during revert', async () => {
      const items: BatchItemResult<FlagResult>[] = [
        { id: eid(1), status: 'succeeded', data: { flagsAfter: ['\\Seen'] } },
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

  // ── Revert for not-yet-implemented reversals ────────────────────────────────

  describe('revert of create_folder', () => {
    it('results in error status since reversal throws not yet implemented', async () => {
      mock(imap.createFolder).mockResolvedValue({ path: 'MyFolder', created: true });
      const result = await interceptor.createFolder('MyFolder');
      const operationId = (result as unknown as Record<string, unknown>).operationId as number;

      const revertResult = await interceptor.revertOperations(operationId);

      expect(revertResult.steps).toHaveLength(1);
      expect(revertResult.steps[0]!.status).toBe('error');
      expect(revertResult.steps[0]!.error).toContain('not yet implemented');
    });
  });

  describe('revert of add_labels', () => {
    it('results in error status since reversal throws not yet implemented', async () => {
      const batchResult = {
        status: 'succeeded' as const,
        items: [
          {
            id: eid(1),
            status: 'succeeded' as const,
            data: [{ labelPath: 'Labels/Test', newId: eid(50, 'Labels/Test') }],
          },
        ],
      };
      mock(imap.addLabels).mockResolvedValue(batchResult);

      const result = await interceptor.addLabels([eid(1)], ['Test']);
      const operationId = (result as unknown as Record<string, unknown>).operationId as number;

      const revertResult = await interceptor.revertOperations(operationId);

      expect(revertResult.steps).toHaveLength(1);
      expect(revertResult.steps[0]!.status).toBe('error');
      expect(revertResult.steps[0]!.error).toContain('not yet implemented');
    });
  });
});
