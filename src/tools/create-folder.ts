import { z } from 'zod';
import type { ImapClient } from '../bridge/imap.js';
import type { SingleToolResult, CreateFolderResult } from '../types/index.js';

export const createFolderSchema = {
  path: z.string().min(1)
    .describe('Full folder path (must start with "Folders/"). Nested segments (e.g. "Folders/Work/Projects") are created recursively.'),
};

export async function handleCreateFolder(
  args: { path: string },
  imap: ImapClient,
): Promise<SingleToolResult<CreateFolderResult>> {
  // Strip trailing slashes and validate a real folder name exists after "Folders/"
  const cleaned = args.path.replace(/\/+$/, '');
  if (!cleaned || cleaned === 'Folders' || !cleaned.startsWith('Folders/') || cleaned === 'Folders/') {
    throw new Error('INVALID_PATH: path must contain a folder name after "Folders/" (e.g. "Folders/MyFolder")');
  }
  const data = await imap.createFolder(cleaned);
  return { status: 'succeeded' as const, data };
}
