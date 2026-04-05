import type { ImapConnectionPool } from '../bridge/pool.js';
import type { SingleToolResult } from '../types/index.js';

export const drainConnectionsSchema = {};

export async function handleDrainConnections(
  pool: ImapConnectionPool,
): Promise<SingleToolResult<{ message: string }>> {
  await pool.drain();
  return { status: 'succeeded' as const, data: { message: 'Connection pool drained. New connections will be created on next request.' } };
}
