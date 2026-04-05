import { z } from 'zod';
import type { ImapClient } from '../bridge/imap.js';
import type { BatchToolResult, FlagResult } from '../types/index.js';
import { batchStatus } from '../types/index.js';

const emailIdSchema = z.object({
  uid:     z.number().int().positive().describe('IMAP UID'),
  mailbox: z.string().min(1).describe('Mailbox name'),
});

export const markReadSchema = {
  ids: z.array(emailIdSchema).min(1).max(50)
    .describe('Emails to mark as read (adds \\Seen flag)'),
};

export async function handleMarkRead(
  args: { ids: Array<{ uid: number; mailbox: string }> },
  imap: ImapClient,
): Promise<BatchToolResult<FlagResult>> {
  const items = await imap.setFlag(args.ids, '\\Seen', true);
  return { status: batchStatus(items), items };
}
