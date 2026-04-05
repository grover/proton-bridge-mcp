import type { EmailId, ListToolResult, EmailMessage, ReadOnlyMailOps } from '../types/index.js';
import { emailIdStringSchema } from '../types/index.js';
import { z } from 'zod';

export const fetchMessageSchema = {
  ids: z.array(emailIdStringSchema).min(1).max(20)
    .describe('List of email IDs to fetch. Returns text/HTML body and attachment metadata (not content).'),
};

export async function handleFetchMessage(
  args: { ids: EmailId[] },
  ops: ReadOnlyMailOps,
): Promise<ListToolResult<EmailMessage>> {
  const items = await ops.fetchMessage(args.ids);
  return { status: 'succeeded' as const, items };
}
