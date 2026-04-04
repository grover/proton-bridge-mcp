import { z } from 'zod';
import type { ImapClient } from '../bridge/imap.js';
import type { FlagBatchResult } from '../types/index.js';

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
): Promise<FlagBatchResult> {
  return imap.setFlag(args.ids, '\\Seen', false);
}
