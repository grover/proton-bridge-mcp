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
    mailboxCreate: jest.fn(),
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

describe('ImapClient.createFolder', () => {
  let conn: ReturnType<typeof createMockConn>;
  let pool: ImapConnectionPool;
  let client: ImapClient;

  beforeEach(() => {
    conn = createMockConn();
    pool = createMockPool(conn);
    client = new ImapClient(pool, createMockAudit(), createMockLogger());
  });

  it('returns created: true on successful creation', async () => {
    mock(conn.mailboxCreate).mockResolvedValue({ path: 'Folders/New', created: true });

    const result = await client.createFolder('Folders/New');

    expect(result).toEqual({ path: 'Folders/New', created: true });
    expect(conn.list).not.toHaveBeenCalled();
  });

  it('returns created: false via fast path when ALREADYEXISTS response code is set', async () => {
    const err = Object.assign(new Error('Command failed'), {
      serverResponseCode: 'ALREADYEXISTS',
    });
    mock(conn.mailboxCreate).mockRejectedValue(err);

    const result = await client.createFolder('Folders/Existing');

    expect(result).toEqual({ path: 'Folders/Existing', created: false });
    expect(conn.list).not.toHaveBeenCalled();
  });

  it('returns created: false via fast path when error text matches regex', async () => {
    const err = Object.assign(new Error('Command failed'), {
      response: 'NO mailbox already exists',
    });
    mock(conn.mailboxCreate).mockRejectedValue(err);

    const result = await client.createFolder('Folders/Existing');

    expect(result).toEqual({ path: 'Folders/Existing', created: false });
    expect(conn.list).not.toHaveBeenCalled();
  });

  it('returns created: false when bare NO and LIST confirms mailbox exists', async () => {
    mock(conn.mailboxCreate).mockRejectedValue(new Error('Command failed'));
    mock(conn.list).mockResolvedValue([
      { path: 'INBOX' },
      { path: 'Folders/Existing' },
      { path: 'Trash' },
    ]);

    const result = await client.createFolder('Folders/Existing');

    expect(result).toEqual({ path: 'Folders/Existing', created: false });
    expect(conn.list).toHaveBeenCalled();
  });

  it('rethrows original error when bare NO and LIST shows mailbox does not exist', async () => {
    const originalError = new Error('Command failed');
    mock(conn.mailboxCreate).mockRejectedValue(originalError);
    mock(conn.list).mockResolvedValue([
      { path: 'INBOX' },
      { path: 'Trash' },
    ]);

    await expect(client.createFolder('Folders/Missing')).rejects.toThrow(originalError);
    expect(conn.list).toHaveBeenCalled();
  });

  it('propagates LIST error when LIST itself fails', async () => {
    mock(conn.mailboxCreate).mockRejectedValue(new Error('Command failed'));
    const listError = new Error('Connection lost');
    mock(conn.list).mockRejectedValue(listError);

    await expect(client.createFolder('Folders/Test')).rejects.toThrow(listError);
  });

  it('always releases the connection back to the pool', async () => {
    mock(conn.mailboxCreate).mockRejectedValue(new Error('Command failed'));
    mock(conn.list).mockResolvedValue([]);

    await expect(client.createFolder('Folders/Test')).rejects.toThrow();
    expect(pool.release).toHaveBeenCalledWith(conn);
  });
});
