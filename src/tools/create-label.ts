import { z } from 'zod';
import type { SingleToolResult, CreateLabelResult, MutatingMailOps } from '../types/index.js';

export const createLabelSchema = {
  name: z.string().min(1)
    .describe('Label name (plain text, no "/" allowed). Example: "Important"'),
};

export async function handleCreateLabel(
  args: { name: string },
  ops: MutatingMailOps,
): Promise<SingleToolResult<CreateLabelResult>> {
  if (args.name.includes('/')) {
    throw new Error('INVALID_NAME: label name must not contain "/"');
  }
  return ops.createLabel(args.name);
}
