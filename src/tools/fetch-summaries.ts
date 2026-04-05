import { z } from 'zod';
import type { ImapClient } from '../bridge/imap.js';
import type { ListToolResult, EmailSummary } from '../types/index.js';

const emailIdSchema = z.object({
  uid:     z.number().int().positive().describe('IMAP UID'),
  mailbox: z.string().min(1).describe('Mailbox name'),
});

export const fetchSummariesSchema = {
  ids: z.array(emailIdSchema).min(1).max(50).describe('List of email IDs to fetch'),
};

export async function handleFetchSummaries(
  args: { ids: Array<{ uid: number; mailbox: string }> },
  imap: ImapClient,
): Promise<ListToolResult<EmailSummary>> {
  const items = await imap.fetchSummaries(args.ids);
  return { status: 'succeeded' as const, items };
}
