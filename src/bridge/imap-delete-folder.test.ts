import { jest } from '@jest/globals';
import { ImapClient } from './imap.js';
import type { AuditLogger } from './audit.js';
import type { ImapConnectionPool } from './pool.js';
import type { AppLogger } from '../logger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<(...args: any[]) => any>;

function mock(fn: unknown): AnyMock {
  return fn as AnyMock;
}

function createMockConn() {
  return {
    mailboxDelete: jest.fn(),
    list: jest.fn(),
  };
}

function createMockPool(conn: unknown) {
  return {
    acquire: jest.fn<() => Promise<unknown>>().mockResolvedValue(conn),
    release: jest.fn(),
  } as unknown as ImapConnectionPool;
}

function createMockAudit() {
  return {
    wrap: jest.fn((_op: string, _input: unknown, fn: () => Promise<unknown>) => fn()),
  } as unknown as AuditLogger;
}

function createMockLogger() {
  return {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  } as unknown as AppLogger;
}

describe('ImapClient.deleteFolder', () => {
  let conn: ReturnType<typeof createMockConn>;
  let pool: ImapConnectionPool;
  let client: ImapClient;

  beforeEach(() => {
    conn = createMockConn();
    pool = createMockPool(conn);
    client = new ImapClient(pool, createMockAudit(), createMockLogger());
  });

  it('deletes folder and returns deleted: true on success', async () => {
    mock(conn.list).mockResolvedValue([
      { path: 'INBOX' },
      { path: 'Folders/Work' },
    ]);
    mock(conn.mailboxDelete).mockResolvedValue({ path: 'Folders/Work' });

    const result = await client.deleteFolder('Folders/Work');

    expect(result).toEqual({ path: 'Folders/Work', deleted: true });
    expect(conn.mailboxDelete).toHaveBeenCalledWith('Folders/Work');
  });

  it('throws FORBIDDEN for path not under Folders/', async () => {
    await expect(client.deleteFolder('INBOX')).rejects.toThrow('FORBIDDEN');
    expect(pool.acquire).not.toHaveBeenCalled();
  });

  it('throws FORBIDDEN for bare Folders/', async () => {
    await expect(client.deleteFolder('Folders/')).rejects.toThrow('FORBIDDEN');
    expect(pool.acquire).not.toHaveBeenCalled();
  });

  it('throws FORBIDDEN for special-use folder under Folders/', async () => {
    mock(conn.list).mockResolvedValue([
      { path: 'Folders/SystemFolder', specialUse: '\\Trash' },
    ]);

    await expect(client.deleteFolder('Folders/SystemFolder')).rejects.toThrow('FORBIDDEN');
    expect(conn.mailboxDelete).not.toHaveBeenCalled();
  });

  it('returns deleted: false when folder does not exist', async () => {
    mock(conn.list).mockResolvedValue([
      { path: 'INBOX' },
      { path: 'Trash' },
    ]);

    const result = await client.deleteFolder('Folders/NonExistent');

    expect(result).toEqual({ path: 'Folders/NonExistent', deleted: false });
    expect(conn.mailboxDelete).not.toHaveBeenCalled();
  });

  it('propagates IMAP error from mailboxDelete', async () => {
    mock(conn.list).mockResolvedValue([
      { path: 'Folders/Work' },
    ]);
    const imapError = new Error('IMAP connection lost');
    mock(conn.mailboxDelete).mockRejectedValue(imapError);

    await expect(client.deleteFolder('Folders/Work')).rejects.toThrow(imapError);
  });

  it('always releases the connection back to the pool', async () => {
    mock(conn.list).mockResolvedValue([{ path: 'Folders/Work' }]);
    mock(conn.mailboxDelete).mockRejectedValue(new Error('fail'));

    await expect(client.deleteFolder('Folders/Work')).rejects.toThrow();
    expect(pool.release).toHaveBeenCalledWith(conn);
  });

  it('cleans trailing slashes before processing', async () => {
    mock(conn.list).mockResolvedValue([
      { path: 'Folders/Work' },
    ]);
    mock(conn.mailboxDelete).mockResolvedValue({ path: 'Folders/Work' });

    const result = await client.deleteFolder('Folders/Work/');

    expect(result).toEqual({ path: 'Folders/Work', deleted: true });
    expect(conn.mailboxDelete).toHaveBeenCalledWith('Folders/Work');
  });
});
