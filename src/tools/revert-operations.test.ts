import { jest } from '@jest/globals';
import { handleRevertOperations } from './revert-operations.js';
import { OperationLogInterceptor } from '../bridge/operation-log-interceptor.js';
import { OperationLog } from '../bridge/operation-log.js';
import type { ImapClient } from '../bridge/imap.js';
import type { BatchItemResult, FlagResult } from '../types/operations.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<(...args: any[]) => any>;

function createMockImap() {
  return {
    moveEmails: jest.fn(),
    setFlag: jest.fn(),
    createFolder: jest.fn(),
    addLabels: jest.fn(),
  } as unknown as ImapClient;
}

function mock(fn: unknown): AnyMock {
  return fn as AnyMock;
}

describe('handleRevertOperations', () => {
  it('delegates to interceptor.revertOperations and returns result', async () => {
    const imap = createMockImap();
    const log = new OperationLog();
    const interceptor = new OperationLogInterceptor(imap, log);

    // Create a tracked operation first
    const items: BatchItemResult<FlagResult>[] = [
      { id: { uid: 1, mailbox: 'INBOX' }, status: 'succeeded', data: { flagsBefore: [], flagsAfter: ['\\Seen'] } },
    ];
    mock(imap.setFlag).mockResolvedValue(items);
    const markResult = await interceptor.markRead([{ uid: 1, mailbox: 'INBOX' }]);
    const operationId = (markResult as unknown as Record<string, unknown>).operationId as number;

    // Reset mock for reversal
    mock(imap.setFlag).mockReset().mockResolvedValue([]);

    const result = await handleRevertOperations({ operationId }, interceptor);

    expect(result.stepsTotal).toBe(1);
    expect(result.stepsSucceeded).toBe(1);
    expect(result.stepsFailed).toBe(0);
  });

  it('propagates UNKNOWN_OPERATION_ID error', async () => {
    const imap = createMockImap();
    const log = new OperationLog();
    const interceptor = new OperationLogInterceptor(imap, log);

    await expect(handleRevertOperations({ operationId: 999 }, interceptor))
      .rejects.toThrow('UNKNOWN_OPERATION_ID');
  });
});
