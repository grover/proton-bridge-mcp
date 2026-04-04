import type { ImapClient } from '../bridge/imap.js';
import type { FolderInfo } from '../types/index.js';

export const listFoldersSchema = {};

export async function handleListFolders(
  imap: ImapClient,
): Promise<FolderInfo[]> {
  return imap.listFolders();
}
