import type { ImapConnectionPool } from '../bridge/pool.js';

export const drainConnectionsSchema = {};

export async function handleDrainConnections(
  pool: ImapConnectionPool,
): Promise<{ message: string }> {
  await pool.drain();
  return { message: 'Connection pool drained. New connections will be created on next request.' };
}
