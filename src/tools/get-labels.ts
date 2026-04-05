import type { LabelInfo, ReadOnlyMailOps } from '../types/index.js';

export const getLabelsSchema = {};

export async function handleGetLabels(
  ops: ReadOnlyMailOps,
): Promise<LabelInfo[]> {
  return ops.getLabels();
}
