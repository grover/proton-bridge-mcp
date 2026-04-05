import { jest } from '@jest/globals';
import { handleRemoveLabels } from './remove-labels.js';
import type { MutatingMailOps } from '../types/mail-ops.js';
import type { RemoveLabelsBatchResult } from '../types/operations.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<(...args: any[]) => any>;

function mock(fn: unknown): AnyMock {
  return fn as AnyMock;
}

function createMockOps() {
  return {
    moveEmails: jest.fn(),
    markRead: jest.fn(),
    markUnread: jest.fn(),
    createFolder: jest.fn(),
    createLabel: jest.fn(),
    deleteFolder: jest.fn(),
    deleteLabel: jest.fn(),
    addLabels: jest.fn(),
    removeLabels: jest.fn(),
    revertOperations: jest.fn(),
  } as unknown as MutatingMailOps;
}

describe('handleRemoveLabels', () => {
  let ops: MutatingMailOps;

  beforeEach(() => {
    ops = createMockOps();
  });

  it('delegates to ops.removeLabels with ids and labelNames', async () => {
    const ids = [{ uid: 1, mailbox: 'INBOX' }];
    const labels = ['Work'];
    const expected: RemoveLabelsBatchResult = {
      status: 'succeeded',
      items: [
        {
          id: { uid: 1, mailbox: 'INBOX' },
          status: 'succeeded',
          data: [{ labelName: 'Work', removed: true }],
        },
      ],
    };
    mock(ops.removeLabels).mockResolvedValue(expected);

    const result = await handleRemoveLabels({ ids, labelNames: labels }, ops);

    expect(ops.removeLabels).toHaveBeenCalledWith(ids, labels);
    expect(result).toEqual(expected);
  });
});
