import { z } from 'zod';
import type { SingleToolResult, DeleteLabelResult, MutatingMailOps } from '../types/index.js';

export const deleteLabelSchema = {
  name: z.string().min(1)
    .describe('Label name to delete (plain text, no "/" allowed). Example: "Project X"'),
};

export async function handleDeleteLabel(
  args: { name: string },
  ops: MutatingMailOps,
): Promise<SingleToolResult<DeleteLabelResult>> {
  if (args.name.includes('/')) {
    throw new Error('INVALID_NAME: label name must not contain "/"');
  }
  return ops.deleteLabel(args.name);
}
