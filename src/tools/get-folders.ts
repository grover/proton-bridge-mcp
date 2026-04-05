import type { ListToolResult, FolderInfo, ReadOnlyMailOps } from '../types/index.js';

export const getFoldersSchema = {};

export async function handleGetFolders(
  ops: ReadOnlyMailOps,
): Promise<ListToolResult<FolderInfo>> {
  const items = await ops.getFolders();
  return { status: 'succeeded' as const, items };
}
