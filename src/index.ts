import 'dotenv/config';
import { loadConfig }         from './config.js';
import { createLogger }       from './logger.js';
import { AuditLogger }        from './bridge/audit.js';
import { ImapConnectionPool } from './bridge/pool.js';
import { ImapClient }         from './bridge/imap.js';
import { createHttpApp }      from './http.js';

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
  const app  = await createHttpApp(imap, pool, config.http, logger);

  await app.listen({ host: config.http.host, port: config.http.port });

  logger.info(
    { host: config.http.host, port: config.http.port, basePath: config.http.basePath },
    'MCP server listening',
  );

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutdown signal received');
    await app.close();
    await pool.stop();
    process.exit(0);
  };

  process.on('SIGINT',  () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  // Intentional console.error: logger may not be initialised yet
  console.error('[startup] Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
