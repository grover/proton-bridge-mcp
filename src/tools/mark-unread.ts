import type { EmailId, BatchToolResult, FlagResult, MutatingMailOps } from '../types/index.js';
import { emailIdStringSchema } from '../types/index.js';
import { z } from 'zod';

export const markUnreadSchema = {
  ids: z.array(emailIdStringSchema).min(1).max(50)
    .describe('Emails to mark as unread (removes \\Seen flag)'),
};

export async function handleMarkUnread(
  args: { ids: EmailId[] },
  ops: MutatingMailOps,
): Promise<BatchToolResult<FlagResult>> {
  return ops.markUnread(args.ids);
}
