import type { EmailId, BatchToolResult, MoveResult, MutatingMailOps } from '../types/index.js';
import { emailIdStringSchema } from '../types/index.js';
import { z } from 'zod';

export const moveEmailsSchema = {
  ids: z.array(emailIdStringSchema).min(1).max(50)
    .describe('Emails to move'),
  targetMailbox: z.string().min(1)
    .describe('Destination mailbox name (e.g. Archive, Trash)'),
};

export async function handleMoveEmails(
  args: { ids: EmailId[]; targetMailbox: string },
  ops: MutatingMailOps,
): Promise<BatchToolResult<MoveResult>> {
  return ops.moveEmails(args.ids, args.targetMailbox);
}
