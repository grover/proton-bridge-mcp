import type { ImapClient } from '../bridge/imap.js';
import type { EmailId, ListToolResult, EmailSummary } from '../types/index.js';
import { emailIdStringSchema } from '../types/index.js';
import { z } from 'zod';

export const fetchSummariesSchema = {
  ids: z.array(emailIdStringSchema).min(1).max(50).describe('List of email IDs to fetch'),
};

export async function handleFetchSummaries(
  args: { ids: EmailId[] },
  imap: ImapClient,
): Promise<ListToolResult<EmailSummary>> {
  const items = await imap.fetchSummaries(args.ids);
  return { status: 'succeeded' as const, items };
}
