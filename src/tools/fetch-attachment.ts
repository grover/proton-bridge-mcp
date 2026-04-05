import type { EmailId, SingleToolResult, AttachmentContent, ReadOnlyMailOps } from '../types/index.js';
import { emailIdStringSchema } from '../types/index.js';
import { z } from 'zod';

export const fetchAttachmentSchema = {
  id: emailIdStringSchema.describe('Email identifier'),
  partId: z.string().min(1)
    .describe('Attachment part ID from fetch_message result (e.g. "1", "2")'),
};

export async function handleFetchAttachment(
  args: { id: EmailId; partId: string },
  ops: ReadOnlyMailOps,
): Promise<SingleToolResult<AttachmentContent>> {
  const data = await ops.fetchAttachment(args.id, args.partId);
  return { status: 'succeeded' as const, data };
}
