import type { EmailId, ListToolResult, EmailSummary, ReadOnlyMailOps } from '../types/index.js';
import { emailIdStringSchema } from '../types/index.js';
import { z } from 'zod';

export const fetchSummariesSchema = {
  ids: z.array(emailIdStringSchema).min(1).max(50).describe('List of email IDs to fetch'),
};

export async function handleFetchSummaries(
  args: { ids: EmailId[] },
  ops: ReadOnlyMailOps,
): Promise<ListToolResult<EmailSummary>> {
  const items = await ops.fetchSummaries(args.ids);
  return { status: 'succeeded' as const, items };
}
