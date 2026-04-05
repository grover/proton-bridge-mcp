import type { EmailId, BatchToolResult, FlagResult, MutatingMailOps } from '../types/index.js';
import { emailIdStringSchema } from '../types/index.js';
import { z } from 'zod';

export const markReadSchema = {
  ids: z.array(emailIdStringSchema).min(1).max(50)
    .describe('Emails to mark as read (adds \\Seen flag)'),
};

export async function handleMarkRead(
  args: { ids: EmailId[] },
  ops: MutatingMailOps,
): Promise<BatchToolResult<FlagResult>> {
  return ops.markRead(args.ids);
}
