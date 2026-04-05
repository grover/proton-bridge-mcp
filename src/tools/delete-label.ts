import { z } from 'zod';
import type { SingleToolResult, DeleteLabelResult, MutatingMailOps } from '../types/index.js';

export const deleteLabelSchema = {
  name: z.string().min(1)
    .describe('Label name to delete (plain text, no "/" allowed). Example: "Project X"'),
};

export async function handleDeleteLabel(
  _args: { name: string },
  _ops: MutatingMailOps,
): Promise<SingleToolResult<DeleteLabelResult>> {
  throw new Error('Not implemented');
}
