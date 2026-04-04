import { z } from 'zod';
import type { ImapClient } from '../bridge/imap.js';
import type { AddLabelsBatchResult } from '../types/index.js';

const emailIdSchema = z.object({
  uid:     z.number().int().positive().describe('IMAP UID'),
  mailbox: z.string().min(1).describe('Source mailbox name'),
});

export const addLabelsSchema = {
  ids: z.array(emailIdSchema).min(1).max(50)
    .describe('Emails to label'),
  labelNames: z.array(z.string().min(1)).min(1)
    .describe('Label names to apply (plain names without "Labels/" prefix)'),
};

export async function handleAddLabels(
  args: { ids: Array<{ uid: number; mailbox: string }>; labelNames: string[] },
  imap: ImapClient,
): Promise<AddLabelsBatchResult> {
  return imap.addLabels(args.ids, args.labelNames);
}
