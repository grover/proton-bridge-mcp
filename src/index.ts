#!/usr/bin/env node
import 'dotenv/config';
import { loadConfig }         from './config.js';
import { createLogger }       from './logger.js';
import { AuditLogger }        from './bridge/audit.js';
import { ImapConnectionPool } from './bridge/pool.js';
import { ImapClient }         from './bridge/imap.js';
import { createHttpApp }      from './http.js';
import { runStdioServer }     from './stdio.js';

async function main(): Promise<void> {
  const config = loadConfig(process.argv);
  const logger = createLogger(config.log);
  const audit  = new AuditLogger(config.log.auditLogPath);
  const pool   = new ImapConnectionPool(config.bridge, config.pool, logger);

  // ── --verify mode: test connectivity then exit ────────────────────────────
  if (config.verify) {
    logger.info('Running connectivity verification...');
    await pool.start();
    const result = await pool.verifyConnectivity();
    await pool.stop();

    if (result.success) {
      logger.info({ latencyMs: result.latencyMs }, 'Connectivity OK');
      process.exit(0);
    } else {
      logger.error({ error: result.error }, 'Connectivity check failed');
      process.exit(1);
    }
  }

  // ── Normal startup ────────────────────────────────────────────────────────
  await pool.start();

  const imap = new ImapClient(pool, audit, logger);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutdown signal received');
    await pool.stop();
    process.exit(0);
  };

  if (config.transport === 'stdio') {
    // ── STDIO mode ──────────────────────────────────────────────────────────
    const closeTransport = await runStdioServer(imap, pool);

    process.on('SIGINT',  () => void (async () => { await closeTransport(); await shutdown('SIGINT'); })());
    process.on('SIGTERM', () => void (async () => { await closeTransport(); await shutdown('SIGTERM'); })());
  } else {
    // ── HTTP / HTTPS mode ───────────────────────────────────────────────────
    const app = await createHttpApp(imap, pool, config.http!, logger);

    await app.listen({ host: config.http!.host, port: config.http!.port });

    const protocol = config.transport === 'https' ? 'https' : 'http';
    logger.info(
      { host: config.http!.host, port: config.http!.port, basePath: config.http!.basePath, protocol },
      'MCP server listening',
    );

    process.on('SIGINT',  () => void (async () => { await app.close(); await shutdown('SIGINT'); })());
    process.on('SIGTERM', () => void (async () => { await app.close(); await shutdown('SIGTERM'); })());
  }
}

main().catch((err: unknown) => {
  // Intentional console.error: logger may not be initialised yet
  console.error('[startup] Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
