import { jest } from '@jest/globals';
import { handleDeleteLabel } from './delete-label.js';
import type { MutatingMailOps } from '../types/index.js';

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
    revertOperations: jest.fn(),
  } as unknown as MutatingMailOps;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<(...args: any[]) => any>;

function mock(fn: unknown): AnyMock {
  return fn as AnyMock;
}

describe('handleDeleteLabel', () => {
  let ops: MutatingMailOps;

  beforeEach(() => {
    ops = createMockOps();
  });

  it('delegates to ops.deleteLabel with name', async () => {
    const expected = { status: 'succeeded' as const, data: { name: 'Work', deleted: true } };
    mock(ops.deleteLabel).mockResolvedValue(expected);

    const result = await handleDeleteLabel({ name: 'Work' }, ops);

    expect(ops.deleteLabel).toHaveBeenCalledWith('Work');
    expect(result).toEqual(expected);
  });

  it('throws INVALID_NAME when name contains slash', async () => {
    await expect(handleDeleteLabel({ name: 'Has/Slash' }, ops)).rejects.toThrow('INVALID_NAME');
    expect(ops.deleteLabel).not.toHaveBeenCalled();
  });
});
