import type { EmailId, RemoveLabelsBatchResult, MutatingMailOps } from '../types/index.js';
import { emailIdStringSchema } from '../types/index.js';
import { z } from 'zod';

export const removeLabelsSchema = {
  ids: z.array(emailIdStringSchema).min(1).max(50)
    .describe('Emails to remove labels from (source mailbox IDs)'),
  labelNames: z.array(z.string().min(1)).min(1)
    .describe('Label names to remove (plain names without "Labels/" prefix)'),
};

export async function handleRemoveLabels(
  args: { ids: EmailId[]; labelNames: string[] },
  ops: MutatingMailOps,
): Promise<RemoveLabelsBatchResult> {
  return ops.removeLabels(args.ids, args.labelNames);
}
