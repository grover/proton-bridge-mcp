import { z } from 'zod';
import type { SingleToolResult, DeleteFolderResult, MutatingMailOps } from '../types/index.js';

export const deleteFolderSchema = {
  path: z.string().min(1)
    .describe('Full IMAP path of the folder to delete (must start with "Folders/"). Example: "Folders/Work"'),
};

export async function handleDeleteFolder(
  args: { path: string },
  ops: MutatingMailOps,
): Promise<SingleToolResult<DeleteFolderResult>> {
  const cleaned = args.path.replace(/\/+$/, '');
  if (!cleaned || cleaned === 'Folders' || !cleaned.startsWith('Folders/') || cleaned === 'Folders/') {
    throw new Error('INVALID_PATH: path must contain a folder name after "Folders/" (e.g. "Folders/MyFolder")');
  }
  return ops.deleteFolder(cleaned);
}
