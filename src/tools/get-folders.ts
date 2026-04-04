import type { ImapClient } from '../bridge/imap.js';
import type { FolderInfo } from '../types/index.js';

export const getFoldersSchema = {};

export async function handleGetFolders(
  imap: ImapClient,
): Promise<FolderInfo[]> {
  return imap.getFolders();
}
