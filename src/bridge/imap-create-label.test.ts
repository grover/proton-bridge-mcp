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

describe('ImapClient.createLabel', () => {
  let conn: ReturnType<typeof createMockConn>;
  let pool: ImapConnectionPool;
  let client: ImapClient;

  beforeEach(() => {
    conn = createMockConn();
    pool = createMockPool(conn);
    client = new ImapClient(pool, createMockAudit(), createMockLogger());
  });

  it('calls mailboxCreate with Labels/ prefix and returns result', async () => {
    mock(conn.mailboxCreate).mockResolvedValue({ path: 'Labels/Important', created: true });

    const result = await client.createLabel('Important');

    expect(result).toEqual({ path: 'Labels/Important', created: true });
    expect(conn.mailboxCreate).toHaveBeenCalledWith('Labels/Important');
    expect(conn.list).not.toHaveBeenCalled();
  });

  it('returns created: false via fast path when ALREADYEXISTS response code is set', async () => {
    const err = Object.assign(new Error('Command failed'), {
      serverResponseCode: 'ALREADYEXISTS',
    });
    mock(conn.mailboxCreate).mockRejectedValue(err);

    const result = await client.createLabel('Existing');

    expect(result).toEqual({ path: 'Labels/Existing', created: false });
    expect(conn.list).not.toHaveBeenCalled();
  });

  it('returns created: false when bare NO and LIST confirms label exists', async () => {
    mock(conn.mailboxCreate).mockRejectedValue(new Error('Command failed'));
    mock(conn.list).mockResolvedValue([
      { path: 'INBOX' },
      { path: 'Labels/Existing' },
    ]);

    const result = await client.createLabel('Existing');

    expect(result).toEqual({ path: 'Labels/Existing', created: false });
    expect(conn.list).toHaveBeenCalled();
  });

  it('rethrows original error when bare NO and LIST shows label does not exist', async () => {
    const originalError = new Error('Command failed');
    mock(conn.mailboxCreate).mockRejectedValue(originalError);
    mock(conn.list).mockResolvedValue([{ path: 'INBOX' }]);

    await expect(client.createLabel('Missing')).rejects.toThrow(originalError);
    expect(conn.list).toHaveBeenCalled();
  });

  it('always releases the connection back to the pool', async () => {
    mock(conn.mailboxCreate).mockRejectedValue(new Error('Command failed'));
    mock(conn.list).mockResolvedValue([]);

    await expect(client.createLabel('Test')).rejects.toThrow();
    expect(pool.release).toHaveBeenCalledWith(conn);
  });
});
