import { z } from 'zod';
import type { MutatingMailOps, RevertResult } from '../types/index.js';

export const revertOperationsSchema = {
  operationId: z.number().int().positive()
    .describe('The earliest operation ID to revert (inclusive). All operations from this ID to the most recent will be reversed in reverse chronological order.'),
};

export async function handleRevertOperations(
  args: { operationId: number },
  ops: MutatingMailOps,
): Promise<RevertResult> {
  return ops.revertOperations(args.operationId);
}
