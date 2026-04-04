import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ImapClient }         from './bridge/imap.js';
import type { ImapConnectionPool } from './bridge/pool.js';
import { createMcpServer }         from './server.js';

export async function runStdioServer(
  imap: ImapClient,
  pool: ImapConnectionPool,
): Promise<() => Promise<void>> {
  const transport = new StdioServerTransport();
  const server    = createMcpServer(imap, pool);
  await server.connect(transport as Parameters<typeof server.connect>[0]);
  return () => transport.close();
}
