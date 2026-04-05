import { z } from 'zod';
import type { SingleToolResult, DeleteFolderResult, MutatingMailOps } from '../types/index.js';

export const deleteFolderSchema = {
  path: z.string().min(1)
    .describe('Full IMAP path of the folder to delete (must start with "Folders/"). Example: "Folders/Work"'),
};

export async function handleDeleteFolder(
  _args: { path: string },
  _ops: MutatingMailOps,
): Promise<SingleToolResult<DeleteFolderResult>> {
  throw new Error('Not implemented');
}
