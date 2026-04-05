import { jest } from '@jest/globals';
import { handleDeleteFolder } from './delete-folder.js';
import type { MutatingMailOps } from '../types/index.js';

function createMockOps() {
  return {
    moveEmails: jest.fn(),
    markRead: jest.fn(),
    markUnread: jest.fn(),
    createFolder: jest.fn(),
    deleteFolder: jest.fn(),
    addLabels: jest.fn(),
    revertOperations: jest.fn(),
  } as unknown as MutatingMailOps;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<(...args: any[]) => any>;

function mock(fn: unknown): AnyMock {
  return fn as AnyMock;
}

describe('handleDeleteFolder', () => {
  let ops: MutatingMailOps;

  beforeEach(() => {
    ops = createMockOps();
  });

  it('delegates to ops.deleteFolder with cleaned path', async () => {
    const expected = { status: 'succeeded' as const, data: { path: 'Folders/Work', deleted: true } };
    mock(ops.deleteFolder).mockResolvedValue(expected);

    const result = await handleDeleteFolder({ path: 'Folders/Work' }, ops);

    expect(ops.deleteFolder).toHaveBeenCalledWith('Folders/Work');
    expect(result).toEqual(expected);
  });

  it('strips trailing slashes before delegating', async () => {
    const expected = { status: 'succeeded' as const, data: { path: 'Folders/Work', deleted: true } };
    mock(ops.deleteFolder).mockResolvedValue(expected);

    await handleDeleteFolder({ path: 'Folders/Work/' }, ops);

    expect(ops.deleteFolder).toHaveBeenCalledWith('Folders/Work');
  });

  it('throws INVALID_PATH for empty path after cleaning', async () => {
    await expect(handleDeleteFolder({ path: '///' }, ops)).rejects.toThrow('INVALID_PATH');
    expect(ops.deleteFolder).not.toHaveBeenCalled();
  });

  it('throws INVALID_PATH for bare "Folders"', async () => {
    await expect(handleDeleteFolder({ path: 'Folders' }, ops)).rejects.toThrow('INVALID_PATH');
    expect(ops.deleteFolder).not.toHaveBeenCalled();
  });

  it('throws INVALID_PATH for bare "Folders/"', async () => {
    await expect(handleDeleteFolder({ path: 'Folders/' }, ops)).rejects.toThrow('INVALID_PATH');
    expect(ops.deleteFolder).not.toHaveBeenCalled();
  });

  it('throws INVALID_PATH for path not under Folders/', async () => {
    await expect(handleDeleteFolder({ path: 'INBOX' }, ops)).rejects.toThrow('INVALID_PATH');
    expect(ops.deleteFolder).not.toHaveBeenCalled();
  });
});
