import type { ImapConnectionPool } from '../bridge/pool.js';
import type { SingleToolResult, ToolStatus } from '../types/index.js';

export const verifyConnectivitySchema = {};

export async function handleVerifyConnectivity(
  pool: ImapConnectionPool,
): Promise<SingleToolResult<{ latencyMs?: number; error?: string }>> {
  const result = await pool.verifyConnectivity();
  const status: ToolStatus = result.success ? 'succeeded' : 'failed';
  if (result.success) {
    return { status, data: { latencyMs: result.latencyMs } };
  }
  return { status, data: { error: result.error } };
}
