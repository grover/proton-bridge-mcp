import { z } from 'zod';
import type { ImapClient } from '../bridge/imap.js';
import type { ListToolResult, EmailSummary } from '../types/index.js';

export const searchMailboxSchema = {
  mailbox: z.string().min(1).default('INBOX').describe('Mailbox to search in'),
  query:   z.string().min(1).describe('Text to search for (IMAP TEXT search across all fields)'),
  limit:   z.number().int().min(1).max(100).default(20).describe('Max results to return'),
  offset:  z.number().int().min(0).default(0).describe('Number of results to skip'),
};

export async function handleSearchMailbox(
  args: { mailbox: string; query: string; limit: number; offset: number },
  imap: ImapClient,
): Promise<ListToolResult<EmailSummary>> {
  const items = await imap.searchMailbox(args.mailbox, args.query, args.limit, args.offset);
  return { status: 'succeeded' as const, items };
}
