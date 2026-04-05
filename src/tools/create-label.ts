import { z } from 'zod';
import type { SingleToolResult, CreateLabelResult, MutatingMailOps } from '../types/index.js';

export const createLabelSchema = {
  name: z.string().min(1)
    .describe('Label name (plain text, no "/" allowed). Example: "Important"'),
};

export async function handleCreateLabel(
  _args: { name: string },
  _ops: MutatingMailOps,
): Promise<SingleToolResult<CreateLabelResult>> {
  throw new Error('Not implemented');
}
