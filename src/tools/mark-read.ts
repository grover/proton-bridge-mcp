import type { ImapClient } from '../bridge/imap.js';
import type { EmailId, BatchToolResult, FlagResult } from '../types/index.js';
import { emailIdStringSchema, batchStatus } from '../types/index.js';
import { z } from 'zod';

export const markReadSchema = {
  ids: z.array(emailIdStringSchema).min(1).max(50)
    .describe('Emails to mark as read (adds \\Seen flag)'),
};

export async function handleMarkRead(
  args: { ids: EmailId[] },
  imap: ImapClient,
): Promise<BatchToolResult<FlagResult>> {
  const items = await imap.setFlag(args.ids, '\\Seen', true);
  return { status: batchStatus(items), items };
}
