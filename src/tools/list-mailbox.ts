import { z } from 'zod';
import type { ImapClient } from '../bridge/imap.js';
import type { ListToolResult, EmailSummary } from '../types/index.js';

export const listMailboxSchema = {
  mailbox: z.string().min(1).default('INBOX').describe('Mailbox name (e.g. INBOX, Sent, Trash)'),
  limit:   z.number().int().min(1).max(100).default(20).describe('Max number of emails to return'),
  offset:  z.number().int().min(0).default(0).describe('Number of emails to skip from newest'),
};

export async function handleListMailbox(
  args:  { mailbox: string; limit: number; offset: number },
  imap:  ImapClient,
): Promise<ListToolResult<EmailSummary>> {
  const items = await imap.listMailbox(args.mailbox, args.limit, args.offset);
  return { status: 'succeeded' as const, items };
}
