import { z } from 'zod';
import type { ImapClient } from '../bridge/imap.js';
import type { SingleToolResult, AttachmentContent } from '../types/index.js';

export const fetchAttachmentSchema = {
  id: z.object({
    uid:     z.number().int().positive().describe('IMAP UID'),
    mailbox: z.string().min(1).describe('Mailbox name'),
  }).describe('Email identifier'),
  partId: z.string().min(1)
    .describe('Attachment part ID from fetch_message result (e.g. "1", "2")'),
};

export async function handleFetchAttachment(
  args: { id: { uid: number; mailbox: string }; partId: string },
  imap: ImapClient,
): Promise<SingleToolResult<AttachmentContent>> {
  const data = await imap.fetchAttachment(args.id, args.partId);
  return { status: 'succeeded' as const, data };
}
