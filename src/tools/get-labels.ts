import type { ImapClient } from '../bridge/imap.js';
import type { LabelInfo } from '../types/index.js';

export const getLabelsSchema = {};

export async function handleGetLabels(
  imap: ImapClient,
): Promise<LabelInfo[]> {
  return imap.getLabels();
}
