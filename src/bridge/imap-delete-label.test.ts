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

describe('ImapClient.deleteLabel', () => {
  let conn: ReturnType<typeof createMockConn>;
  let pool: ImapConnectionPool;
  let client: ImapClient;

  beforeEach(() => {
    conn = createMockConn();
    pool = createMockPool(conn);
    client = new ImapClient(pool, createMockAudit(), createMockLogger());
  });

  it('deletes label and returns name with deleted: true on success', async () => {
    mock(conn.list).mockResolvedValue([
      { path: 'Labels/Work' },
    ]);
    mock(conn.mailboxDelete).mockResolvedValue({ path: 'Labels/Work' });

    const result = await client.deleteLabel('Work');

    expect(result).toEqual({ name: 'Work', deleted: true });
    expect(conn.mailboxDelete).toHaveBeenCalledWith('Labels/Work');
  });

  it('returns deleted: false when label does not exist', async () => {
    mock(conn.list).mockResolvedValue([
      { path: 'INBOX' },
    ]);

    const result = await client.deleteLabel('NonExistent');

    expect(result).toEqual({ name: 'NonExistent', deleted: false });
    expect(conn.mailboxDelete).not.toHaveBeenCalled();
  });

  it('throws FORBIDDEN for special-use label', async () => {
    mock(conn.list).mockResolvedValue([
      { path: 'Labels/System', specialUse: '\\Important' },
    ]);

    await expect(client.deleteLabel('System')).rejects.toThrow('FORBIDDEN');
    expect(conn.mailboxDelete).not.toHaveBeenCalled();
  });

  it('propagates IMAP error from mailboxDelete', async () => {
    mock(conn.list).mockResolvedValue([
      { path: 'Labels/Work' },
    ]);
    const imapError = new Error('IMAP connection lost');
    mock(conn.mailboxDelete).mockRejectedValue(imapError);

    await expect(client.deleteLabel('Work')).rejects.toThrow(imapError);
  });

  it('always releases the connection back to the pool', async () => {
    mock(conn.list).mockResolvedValue([{ path: 'Labels/Work' }]);
    mock(conn.mailboxDelete).mockRejectedValue(new Error('fail'));

    await expect(client.deleteLabel('Work')).rejects.toThrow();
    expect(pool.release).toHaveBeenCalledWith(conn);
  });
});
