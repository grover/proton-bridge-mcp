import type { ImapClient } from '../bridge/imap.js';
import type { ListToolResult, FolderInfo } from '../types/index.js';

export const getFoldersSchema = {};

export async function handleGetFolders(
  imap: ImapClient,
): Promise<ListToolResult<FolderInfo>> {
  const items = await imap.getFolders();
  return { status: 'succeeded' as const, items };
}
