import type { ImapClient } from '../bridge/imap.js';
import type { EmailId, ListToolResult, EmailMessage } from '../types/index.js';
import { emailIdStringSchema } from '../types/index.js';
import { z } from 'zod';

export const fetchMessageSchema = {
  ids: z.array(emailIdStringSchema).min(1).max(20)
    .describe('List of email IDs to fetch. Returns text/HTML body and attachment metadata (not content).'),
};

export async function handleFetchMessage(
  args: { ids: EmailId[] },
  imap: ImapClient,
): Promise<ListToolResult<EmailMessage>> {
  const items = await imap.fetchMessage(args.ids);
  return { status: 'succeeded' as const, items };
}
