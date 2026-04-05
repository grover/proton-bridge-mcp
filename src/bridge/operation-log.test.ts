import { OperationLog, MAX_LOG_SIZE } from './operation-log.js';
import type { OperationRecord } from '../types/operations.js';

function makeRecord(tool = 'test_tool'): Omit<OperationRecord, 'id'> {
  return { tool, reversal: { type: 'mark_read', ids: [] }, timestamp: new Date().toISOString() };
}

describe('OperationLog', () => {
  let log: OperationLog;

  beforeEach(() => {
    log = new OperationLog();
  });

  it('push returns monotonically increasing IDs', () => {
    const id1 = log.push(makeRecord());
    const id2 = log.push(makeRecord());
    const id3 = log.push(makeRecord());

    expect(id2).toBeGreaterThan(id1);
    expect(id3).toBeGreaterThan(id2);
  });

  it('has returns true for existing IDs', () => {
    const id = log.push(makeRecord());

    expect(log.has(id)).toBe(true);
  });

  it('has returns false for non-existing IDs', () => {
    expect(log.has(999)).toBe(false);
  });

  it('has returns false for evicted IDs after 101 pushes', () => {
    const firstId = log.push(makeRecord());

    for (let i = 1; i <= MAX_LOG_SIZE; i++) {
      log.push(makeRecord());
    }

    expect(log.has(firstId)).toBe(false);
  });

  it('getFrom returns records most-recent-first', () => {
    const id1 = log.push(makeRecord('tool_a'));
    const id2 = log.push(makeRecord('tool_b'));
    const id3 = log.push(makeRecord('tool_c'));

    const records = log.getFrom(id1);

    expect(records).toHaveLength(3);
    expect(records[0]!.id).toBe(id3);
    expect(records[1]!.id).toBe(id2);
    expect(records[2]!.id).toBe(id1);
  });

  it('getFrom returns empty for unknown ID', () => {
    log.push(makeRecord());

    const records = log.getFrom(999);

    expect(records).toEqual([]);
  });

  it('remove splices single record', () => {
    const id1 = log.push(makeRecord());
    const id2 = log.push(makeRecord());
    const id3 = log.push(makeRecord());

    log.remove(id2);

    expect(log.has(id1)).toBe(true);
    expect(log.has(id2)).toBe(false);
    expect(log.has(id3)).toBe(true);
    expect(log.size).toBe(2);
  });

  it('remove is no-op for unknown ID', () => {
    log.push(makeRecord());
    log.push(makeRecord());

    const sizeBefore = log.size;
    log.remove(999);

    expect(log.size).toBe(sizeBefore);
  });

  it('clear empties the log', () => {
    log.push(makeRecord());
    log.push(makeRecord());
    log.push(makeRecord());

    log.clear();

    expect(log.size).toBe(0);
  });

  it('FIFO eviction at 101 entries — size stays at 100, first ID gone', () => {
    const firstId = log.push(makeRecord());

    for (let i = 1; i <= MAX_LOG_SIZE; i++) {
      log.push(makeRecord());
    }

    expect(log.size).toBe(MAX_LOG_SIZE);
    expect(log.has(firstId)).toBe(false);
  });

  it('IDs continue incrementing after eviction (101st push returns 101, not 1)', () => {
    for (let i = 0; i < MAX_LOG_SIZE; i++) {
      log.push(makeRecord());
    }

    const id101 = log.push(makeRecord());

    expect(id101).toBe(MAX_LOG_SIZE + 1);
  });

  it('getFrom after remove skips removed records', () => {
    const id1 = log.push(makeRecord('tool_a'));
    const id2 = log.push(makeRecord('tool_b'));
    const id3 = log.push(makeRecord('tool_c'));

    log.remove(id2);

    const records = log.getFrom(id1);

    expect(records).toHaveLength(2);
    expect(records[0]!.id).toBe(id3);
    expect(records[1]!.id).toBe(id1);
    expect(records.find((r) => r.id === id2)).toBeUndefined();
  });
});
