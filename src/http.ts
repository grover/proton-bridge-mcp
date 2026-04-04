import Fastify, {
  type FastifyInstance,
  type FastifyBaseLogger,
  type FastifyRequest,
  type FastifyReply,
} from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import type { ImapClient }         from './bridge/imap.js';
import type { ImapConnectionPool } from './bridge/pool.js';
import type { McpHttpConfig }      from './types/index.js';
import type { AppLogger }          from './logger.js';
import { createMcpServer }         from './server.js';

interface Session {
  transport: StreamableHTTPServerTransport;
}

export async function createHttpApp(
  imap:   ImapClient,
  pool:   ImapConnectionPool,
  config: McpHttpConfig,
  logger: AppLogger,
): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger });

  const sessions = new Map<string, Session>();

  // ── Auth hook ─────────────────────────────────────────────────────────────
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith(config.basePath)) return;
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${config.authToken}`) {
      await reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  // ── POST /mcp — client → server ───────────────────────────────────────────
  app.post(config.basePath, async (req: FastifyRequest, reply: FastifyReply) => {
    reply.hijack();

    let sessionId = req.headers['mcp-session-id'] as string | undefined;
    let session   = sessionId ? sessions.get(sessionId) : undefined;

    if (!session) {
      sessionId = randomUUID();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId!,
      });
      const server = createMcpServer(imap, pool);
      // Cast needed: SDK's StreamableHTTPServerTransport.onclose is (() => void) | undefined
      // but the Transport interface declares onclose: () => void (exactOptionalPropertyTypes mismatch)
      await server.connect(transport as Parameters<typeof server.connect>[0]);
      session = { transport };
      sessions.set(sessionId, session);
      logger.info({ sessionId }, '[http] new MCP session created');
    }

    try {
      await session.transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      logger.error({ err, sessionId }, '[http] error handling POST request');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500);
        reply.raw.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  });

  // ── GET /mcp — SSE stream (server → client) ───────────────────────────────
  app.get(config.basePath, async (req: FastifyRequest, reply: FastifyReply) => {
    reply.hijack();

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const session   = sessionId ? sessions.get(sessionId) : undefined;

    if (!session) {
      reply.raw.writeHead(404, { 'Content-Type': 'application/json' });
      reply.raw.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    try {
      await session.transport.handleRequest(req.raw, reply.raw);
    } catch (err) {
      logger.error({ err, sessionId }, '[http] error handling GET/SSE request');
    }
  });

  // ── DELETE /mcp — close session ───────────────────────────────────────────
  app.delete(config.basePath, async (req: FastifyRequest, reply: FastifyReply) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (session) {
        await session.transport.close().catch(() => {});
        sessions.delete(sessionId);
        logger.info({ sessionId }, '[http] MCP session closed');
      }
    }

    await reply.code(204).send();
  });

  return app;
}
