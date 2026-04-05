import { Tracked, Irreversible } from './decorators.js';
import type { BuildReversalFn } from './decorators.js';
import { OperationLog } from './operation-log.js';
import type { ReversalSpec } from '../types/operations.js';

// ── Shared reversal fixture ───────────────────────────────────────────────────

const STUB_REVERSAL: ReversalSpec = {
  type: 'mark_read',
  ids:  [{ mailbox: 'INBOX', uid: 1 }],
};

// ── @Tracked ──────────────────────────────────────────────────────────────────

describe('@Tracked', () => {
  it('adds operationId to successful result', async () => {
    const log = new OperationLog();
    const buildReversal: BuildReversalFn = () => STUB_REVERSAL;

    class Subject {
      log = log;

      @Tracked('test_tool', buildReversal)
      async doWork() {
        return { value: 42 };
      }
    }

    const subject = new Subject();
    const result = await subject.doWork();

    expect(result).toHaveProperty('value', 42);
    expect(result).toHaveProperty('operationId');
    expect(typeof (result as unknown as { operationId: number }).operationId).toBe('number');
  });

  it('pushes record to log', async () => {
    const log = new OperationLog();
    const buildReversal: BuildReversalFn = () => STUB_REVERSAL;

    class Subject {
      log = log;

      @Tracked('test_tool', buildReversal)
      async doWork() {
        return { value: 1 };
      }
    }

    const subject = new Subject();
    expect(log.size).toBe(0);

    const result = await subject.doWork();
    const operationId = (result as unknown as { operationId: number }).operationId;

    expect(log.size).toBe(1);
    expect(log.has(operationId)).toBe(true);

    const records = log.getFrom(operationId);
    expect(records).toHaveLength(1);
    expect(records[0]!.tool).toBe('test_tool');
    expect(records[0]!.reversal).toEqual(STUB_REVERSAL);
    expect(typeof records[0]!.timestamp).toBe('string');
  });

  it('skips when buildReversal returns null', async () => {
    const log = new OperationLog();
    const buildReversal: BuildReversalFn = () => null;

    class Subject {
      log = log;

      @Tracked('test_tool', buildReversal)
      async doWork() {
        return { value: 99 };
      }
    }

    const subject = new Subject();
    const result = await subject.doWork();

    expect(result).toEqual({ value: 99 });
    expect(result).not.toHaveProperty('operationId');
    expect(log.size).toBe(0);
  });

  it('does not catch exceptions', async () => {
    const log = new OperationLog();
    const buildReversal: BuildReversalFn = () => STUB_REVERSAL;

    class Subject {
      log = log;

      @Tracked('test_tool', buildReversal)
      async doWork() {
        throw new Error('boom');
      }
    }

    const subject = new Subject();

    await expect(subject.doWork()).rejects.toThrow('boom');
    expect(log.size).toBe(0);
  });

  it('passes correct args and result to buildReversal', async () => {
    const log = new OperationLog();
    const calls: Array<{ args: unknown[]; result: unknown }> = [];
    const buildReversal: BuildReversalFn = (args, result) => {
      calls.push({ args, result });
      return STUB_REVERSAL;
    };

    class Subject {
      log = log;

      @Tracked('test_tool', buildReversal)
      async doWork(a: string, b: number) {
        return { sum: a + b };
      }
    }

    const subject = new Subject();
    await subject.doWork('hello', 5);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(['hello', 5]);
    expect(calls[0]!.result).toEqual({ sum: 'hello5' });
  });

  it('preserves original result properties', async () => {
    const log = new OperationLog();
    const buildReversal: BuildReversalFn = () => STUB_REVERSAL;

    class Subject {
      log = log;

      @Tracked('test_tool', buildReversal)
      async doWork() {
        return { a: 1, b: 2 };
      }
    }

    const subject = new Subject();
    const result = await subject.doWork();

    expect(result).toHaveProperty('a', 1);
    expect(result).toHaveProperty('b', 2);
    expect(result).toHaveProperty('operationId');
  });
});

// ── @Irreversible ─────────────────────────────────────────────────────────────

describe('@Irreversible', () => {
  it('clears log on success', async () => {
    const log = new OperationLog();

    class Subject {
      log = log;

      @Irreversible
      async destroy() {
        return { done: true };
      }
    }

    // Push records to verify clear
    log.push({ tool: 'a', reversal: STUB_REVERSAL, timestamp: '2026-01-01T00:00:00Z' });
    log.push({ tool: 'b', reversal: STUB_REVERSAL, timestamp: '2026-01-01T00:00:01Z' });
    expect(log.size).toBe(2);

    const subject = new Subject();
    const result = await subject.destroy();

    expect(result).toEqual({ done: true });
    expect(log.size).toBe(0);
  });

  it('does not clear log on throw', async () => {
    const log = new OperationLog();

    class Subject {
      log = log;

      @Irreversible
      async destroy() {
        throw new Error('kaboom');
      }
    }

    // Push records
    log.push({ tool: 'a', reversal: STUB_REVERSAL, timestamp: '2026-01-01T00:00:00Z' });
    log.push({ tool: 'b', reversal: STUB_REVERSAL, timestamp: '2026-01-01T00:00:01Z' });
    expect(log.size).toBe(2);

    const subject = new Subject();

    await expect(subject.destroy()).rejects.toThrow('kaboom');
    expect(log.size).toBe(2);
  });
});
