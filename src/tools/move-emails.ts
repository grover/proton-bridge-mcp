import { z } from 'zod';
import type { ImapClient } from '../bridge/imap.js';
import type { BatchToolResult, MoveResult } from '../types/index.js';
import { batchStatus } from '../types/index.js';

const emailIdSchema = z.object({
  uid:     z.number().int().positive().describe('IMAP UID'),
  mailbox: z.string().min(1).describe('Source mailbox name'),
});

export const moveEmailsSchema = {
  ids: z.array(emailIdSchema).min(1).max(50)
    .describe('Emails to move'),
  targetMailbox: z.string().min(1)
    .describe('Destination mailbox name (e.g. Archive, Trash)'),
};

export async function handleMoveEmails(
  args: { ids: Array<{ uid: number; mailbox: string }>; targetMailbox: string },
  imap: ImapClient,
): Promise<BatchToolResult<MoveResult>> {
  const items = await imap.moveEmails(args.ids, args.targetMailbox);
  return { status: batchStatus(items), items };
}
