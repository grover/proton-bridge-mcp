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
    getMailboxLock: jest.fn(),
    fetch: jest.fn(),
    search: jest.fn(),
    messageDelete: jest.fn(),
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

// Helper to create an async iterable from an array (for conn.fetch mock)
function asyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < items.length) return { value: items[i++]!, done: false };
          return { value: undefined, done: true as const };
        },
      };
    },
  };
}

describe('ImapClient.removeLabels', () => {
  let conn: ReturnType<typeof createMockConn>;
  let pool: ImapConnectionPool;
  let client: ImapClient;

  beforeEach(() => {
    conn = createMockConn();
    pool = createMockPool(conn);
    client = new ImapClient(pool, createMockAudit(), createMockLogger());
    mock(conn.getMailboxLock).mockResolvedValue({ release: jest.fn() });
  });

  it('removes single email from single label — returns removed: true', async () => {
    // Phase 1: fetch Message-ID from source mailbox
    mock(conn.fetch).mockReturnValue(asyncIterable([
      { uid: 1, envelope: { messageId: '<msg1@example.com>' } },
    ]));
    // Phase 2: search label folder, find copy
    mock(conn.search).mockResolvedValue([42]);
    mock(conn.messageDelete).mockResolvedValue(true);

    const result = await client.removeLabels(
      [{ uid: 1, mailbox: 'INBOX' }],
      ['Work'],
    );

    expect(result.status).toBe('succeeded');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe('succeeded');
    expect(result.items[0]!.data).toEqual([
      { labelName: 'Work', removed: true },
    ]);
    expect(conn.messageDelete).toHaveBeenCalledWith('42', { uid: true });
  });

  it('returns removed: false when email not found in label folder', async () => {
    mock(conn.fetch).mockReturnValue(asyncIterable([
      { uid: 1, envelope: { messageId: '<msg1@example.com>' } },
    ]));
    // Search returns empty — email not in label
    mock(conn.search).mockResolvedValue([]);

    const result = await client.removeLabels(
      [{ uid: 1, mailbox: 'INBOX' }],
      ['Work'],
    );

    expect(result.status).toBe('succeeded');
    expect(result.items[0]!.status).toBe('succeeded');
    expect(result.items[0]!.data).toEqual([
      { labelName: 'Work', removed: false },
    ]);
    expect(conn.messageDelete).not.toHaveBeenCalled();
  });

  it('handles multiple emails and multiple labels', async () => {
    // Phase 1: two source emails with Message-IDs
    mock(conn.fetch)
      .mockReturnValueOnce(asyncIterable([
        { uid: 1, envelope: { messageId: '<msg1@example.com>' } },
      ]))
      .mockReturnValueOnce(asyncIterable([
        { uid: 2, envelope: { messageId: '<msg2@example.com>' } },
      ]));
    // Phase 2: LabelA — both found; LabelB — first found, second not
    mock(conn.search)
      .mockResolvedValueOnce([42])   // msg1 in LabelA
      .mockResolvedValueOnce([43])   // msg2 in LabelA
      .mockResolvedValueOnce([44])   // msg1 in LabelB
      .mockResolvedValueOnce([]);    // msg2 NOT in LabelB
    mock(conn.messageDelete).mockResolvedValue(true);

    const result = await client.removeLabels(
      [{ uid: 1, mailbox: 'INBOX' }, { uid: 2, mailbox: 'INBOX' }],
      ['LabelA', 'LabelB'],
    );

    expect(result.status).toBe('succeeded');
    expect(result.items[0]!.data).toEqual([
      { labelName: 'LabelA', removed: true },
      { labelName: 'LabelB', removed: true },
    ]);
    expect(result.items[1]!.data).toEqual([
      { labelName: 'LabelA', removed: true },
      { labelName: 'LabelB', removed: false },
    ]);
  });

  it('sets per-item error REMOVE_FAILED when messageDelete throws', async () => {
    mock(conn.fetch).mockReturnValue(asyncIterable([
      { uid: 1, envelope: { messageId: '<msg1@example.com>' } },
    ]));
    mock(conn.search).mockResolvedValue([42]);
    mock(conn.messageDelete).mockRejectedValue(new Error('IMAP connection lost'));

    const result = await client.removeLabels(
      [{ uid: 1, mailbox: 'INBOX' }],
      ['Work'],
    );

    expect(result.items[0]!.status).toBe('failed');
    expect(result.items[0]!.error).toEqual({
      code: 'REMOVE_FAILED',
      message: 'IMAP connection lost',
    });
  });

  it('returns removed: false when email has no Message-ID header', async () => {
    // Envelope without messageId
    mock(conn.fetch).mockReturnValue(asyncIterable([
      { uid: 1, envelope: {} },
    ]));

    const result = await client.removeLabels(
      [{ uid: 1, mailbox: 'INBOX' }],
      ['Work'],
    );

    expect(result.items[0]!.status).toBe('succeeded');
    expect(result.items[0]!.data).toEqual([
      { labelName: 'Work', removed: false },
    ]);
    expect(conn.search).not.toHaveBeenCalled();
  });

  it('sets LABEL_NOT_FOUND error when label folder does not exist', async () => {
    mock(conn.fetch).mockReturnValue(asyncIterable([
      { uid: 1, envelope: { messageId: '<msg1@example.com>' } },
    ]));
    // getMailboxLock succeeds for source, fails for label folder
    mock(conn.getMailboxLock).mockReset()
      .mockResolvedValueOnce({ release: jest.fn() })   // source mailbox lock
      .mockRejectedValueOnce(new Error('Mailbox not found'));  // label folder lock

    const result = await client.removeLabels(
      [{ uid: 1, mailbox: 'INBOX' }],
      ['NonExistent'],
    );

    expect(result.items[0]!.status).toBe('failed');
    expect(result.items[0]!.error).toEqual({
      code: 'LABEL_NOT_FOUND',
      message: 'Label NonExistent does not exist',
    });
  });

  it('always releases the connection back to the pool', async () => {
    mock(conn.fetch).mockReturnValue(asyncIterable([
      { uid: 1, envelope: { messageId: '<msg1@example.com>' } },
    ]));
    mock(conn.search).mockResolvedValue([42]);
    mock(conn.messageDelete).mockResolvedValue(true);

    await client.removeLabels(
      [{ uid: 1, mailbox: 'INBOX' }],
      ['Work'],
    );

    expect(pool.release).toHaveBeenCalledWith(conn);
  });

  it('releases the connection even when an error occurs', async () => {
    // getMailboxLock fails for source mailbox
    mock(conn.getMailboxLock).mockRejectedValue(new Error('Connection refused'));

    await expect(
      client.removeLabels([{ uid: 1, mailbox: 'INBOX' }], ['Work']),
    ).rejects.toThrow('Connection refused');

    expect(pool.release).toHaveBeenCalledWith(conn);
  });
});
