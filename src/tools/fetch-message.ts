import { z } from 'zod';
import type { ImapClient } from '../bridge/imap.js';
import type { ListToolResult, EmailMessage } from '../types/index.js';

const emailIdSchema = z.object({
  uid:     z.number().int().positive().describe('IMAP UID'),
  mailbox: z.string().min(1).describe('Mailbox name'),
});

export const fetchMessageSchema = {
  ids: z.array(emailIdSchema).min(1).max(20)
    .describe('List of email IDs to fetch. Returns text/HTML body and attachment metadata (not content).'),
};

export async function handleFetchMessage(
  args: { ids: Array<{ uid: number; mailbox: string }> },
  imap: ImapClient,
): Promise<ListToolResult<EmailMessage>> {
  const items = await imap.fetchMessage(args.ids);
  return { status: 'succeeded' as const, items };
}
