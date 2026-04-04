import type { ImapConnectionPool } from '../bridge/pool.js';

export const verifyConnectivitySchema = {};

export async function handleVerifyConnectivity(
  pool: ImapConnectionPool,
): Promise<{ success: boolean; latencyMs?: number; error?: string }> {
  return pool.verifyConnectivity();
}
