import { z } from 'zod';
import type { ImapClient } from '../bridge/imap.js';
import type { BatchToolResult, FlagResult } from '../types/index.js';
import { batchStatus } from '../types/index.js';

const emailIdSchema = z.object({
  uid:     z.number().int().positive().describe('IMAP UID'),
  mailbox: z.string().min(1).describe('Mailbox name'),
});

export const markUnreadSchema = {
  ids: z.array(emailIdSchema).min(1).max(50)
    .describe('Emails to mark as unread (removes \\Seen flag)'),
};

export async function handleMarkUnread(
  args: { ids: Array<{ uid: number; mailbox: string }> },
  imap: ImapClient,
): Promise<BatchToolResult<FlagResult>> {
  const items = await imap.setFlag(args.ids, '\\Seen', false);
  return { status: batchStatus(items), items };
}
