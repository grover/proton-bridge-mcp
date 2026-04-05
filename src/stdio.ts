import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ImapConnectionPool } from './bridge/pool.js';
import type { ReadOnlyMailOps, MutatingMailOps } from './types/mail-ops.js';
import { createMcpServer } from './server.js';

export async function runStdioServer(
  readOps: ReadOnlyMailOps,
  pool:    ImapConnectionPool,
  mutOps:  MutatingMailOps,
): Promise<() => Promise<void>> {
  const transport = new StdioServerTransport();
  const server    = createMcpServer(readOps, pool, mutOps);
  await server.connect(transport as Parameters<typeof server.connect>[0]);
  return () => transport.close();
}
