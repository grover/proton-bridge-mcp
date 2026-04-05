import type { ImapClient } from '../bridge/imap.js';
import type { EmailId, BatchToolResult, FlagResult } from '../types/index.js';
import { emailIdStringSchema, batchStatus } from '../types/index.js';
import { z } from 'zod';

export const markUnreadSchema = {
  ids: z.array(emailIdStringSchema).min(1).max(50)
    .describe('Emails to mark as unread (removes \\Seen flag)'),
};

export async function handleMarkUnread(
  args: { ids: EmailId[] },
  imap: ImapClient,
): Promise<BatchToolResult<FlagResult>> {
  const items = await imap.setFlag(args.ids, '\\Seen', false);
  return { status: batchStatus(items), items };
}
