import type { ImapClient } from '../bridge/imap.js';
import type { EmailId, BatchToolResult, MoveResult } from '../types/index.js';
import { emailIdStringSchema, batchStatus } from '../types/index.js';
import { z } from 'zod';

export const moveEmailsSchema = {
  ids: z.array(emailIdStringSchema).min(1).max(50)
    .describe('Emails to move'),
  targetMailbox: z.string().min(1)
    .describe('Destination mailbox name (e.g. Archive, Trash)'),
};

export async function handleMoveEmails(
  args: { ids: EmailId[]; targetMailbox: string },
  imap: ImapClient,
): Promise<BatchToolResult<MoveResult>> {
  const items = await imap.moveEmails(args.ids, args.targetMailbox);
  return { status: batchStatus(items), items };
}
