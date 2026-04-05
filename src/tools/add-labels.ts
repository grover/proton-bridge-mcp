import type { EmailId, AddLabelsBatchResult, MutatingMailOps } from '../types/index.js';
import { emailIdStringSchema } from '../types/index.js';
import { z } from 'zod';

export const addLabelsSchema = {
  ids: z.array(emailIdStringSchema).min(1).max(50)
    .describe('Emails to label'),
  labelNames: z.array(z.string().min(1)).min(1)
    .describe('Label names to apply (plain names without "Labels/" prefix)'),
};

export async function handleAddLabels(
  args: { ids: EmailId[]; labelNames: string[] },
  ops: MutatingMailOps,
): Promise<AddLabelsBatchResult> {
  return ops.addLabels(args.ids, args.labelNames);
}
