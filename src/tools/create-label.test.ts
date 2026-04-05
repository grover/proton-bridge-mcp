import { jest } from '@jest/globals';
import { handleCreateLabel } from './create-label.js';
import type { MutatingMailOps } from '../types/index.js';

function createMockOps() {
  return {
    createLabel: jest.fn(),
  } as unknown as MutatingMailOps;
}

describe('handleCreateLabel', () => {
  let ops: MutatingMailOps;

  beforeEach(() => {
    ops = createMockOps();
  });

  it('delegates to ops.createLabel with the name', async () => {
    const expected = { status: 'succeeded' as const, data: { path: 'Labels/Important', created: true } };
    (ops.createLabel as jest.Mock).mockResolvedValue(expected);

    const result = await handleCreateLabel({ name: 'Important' }, ops);

    expect(ops.createLabel).toHaveBeenCalledWith('Important');
    expect(result).toBe(expected);
  });

  it('throws INVALID_NAME when name contains "/"', async () => {
    await expect(handleCreateLabel({ name: 'Nested/Bad' }, ops)).rejects.toThrow('INVALID_NAME');
    expect(ops.createLabel).not.toHaveBeenCalled();
  });
});
