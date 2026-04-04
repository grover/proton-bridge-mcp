import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import selfsigned from 'selfsigned';
import type { AppConfig, McpHttpTlsConfig } from './types/index.js';

function requireValue(
  cliValue: string | undefined,
  envName:  string,
  label:    string,
): string {
  const value = cliValue ?? process.env[envName];
  if (!value) {
    throw new Error(
      `Missing required value: "${label}" (--${label.replace(/_/g, '-')} or ${envName})`,
    );
  }
  return value;
}

function optionalValue(
  cliValue: string | undefined,
  envName:  string,
): string | undefined {
  return cliValue ?? process.env[envName] ?? undefined;
}

function intValue(
  cliValue: string | undefined,
  envName:  string,
  defaultValue: number,
): number {
  const raw = cliValue ?? process.env[envName];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) throw new Error(`Invalid integer for ${envName}: "${raw}"`);
  return parsed;
}

function buildTlsConfig(
  httpsEnabled: boolean,
  certPath:     string | undefined,
  keyPath:      string | undefined,
): McpHttpTlsConfig | undefined {
  if (!httpsEnabled) return undefined;

  if (certPath && keyPath) {
    return {
      cert: readFileSync(certPath, 'utf8'),
      key:  readFileSync(keyPath,  'utf8'),
    };
  }

  if (certPath || keyPath) {
    throw new Error('Both --https-cert and --https-key must be provided together');
  }

  // Auto-generate a self-signed certificate
  const attrs = [{ name: 'commonName', value: 'proton-bridge-mcp' }];
  const generated = selfsigned.generate(attrs, { days: 365, keySize: 2048 });
  return { cert: generated.cert, key: generated.private };
}

export function loadConfig(argv: string[]): AppConfig {
  const program = new Command();

  program
    .name('proton-bridge-mcp')
    .description('MCP server bridging ProtonMail via Proton Bridge IMAP')
    .option('--bridge-host <host>',           'Proton Bridge IMAP host')
    .option('--bridge-imap-port <port>',      'Proton Bridge IMAP port')
    .option('--bridge-username <username>',   'ProtonMail address (required)')
    .option('--bridge-password <password>',   'Bridge-generated password (required)')
    .option('--pool-min <n>',                 'Min IMAP connections in pool')
    .option('--pool-max <n>',                 'Max IMAP connections in pool')
    .option('--mcp-host <host>',              'MCP HTTP server host')
    .option('--mcp-port <port>',              'MCP HTTP server port')
    .option('--mcp-base-path <path>',         'MCP HTTP base path')
    .option('--mcp-auth-token <token>',       'Bearer token for MCP auth (required)')
    .option('--audit-log-path <path>',        'Audit log file path (required)')
    .option('--log-path <path>',              'Application log file path (stderr if omitted)')
    .option('--log-level <level>',            'Log level: trace|debug|info|warn|error')
    .option('--https',                        'Enable HTTPS (env: PROTONMAIL_HTTPS)')
    .option('--https-cert <path>',            'Path to PEM certificate file (env: PROTONMAIL_HTTPS_CERT_PATH)')
    .option('--https-key <path>',             'Path to PEM private key file (env: PROTONMAIL_HTTPS_KEY_PATH)')
    .option('--verify',                       'Verify IMAP connectivity then exit')
    .allowUnknownOption(false)
    .parse(argv);

  const opts = program.opts<{
    bridgeHost?:     string;
    bridgeImapPort?: string;
    bridgeUsername?: string;
    bridgePassword?: string;
    poolMin?:        string;
    poolMax?:        string;
    mcpHost?:        string;
    mcpPort?:        string;
    mcpBasePath?:    string;
    mcpAuthToken?:   string;
    auditLogPath?:   string;
    logPath?:        string;
    logLevel?:       string;
    https?:          boolean;
    httpsCert?:      string;
    httpsKey?:       string;
    verify?:         boolean;
  }>();

  const httpsTls = buildTlsConfig(
    opts.https ?? (process.env['PROTONMAIL_HTTPS'] === 'true'),
    optionalValue(opts.httpsCert, 'PROTONMAIL_HTTPS_CERT_PATH'),
    optionalValue(opts.httpsKey,  'PROTONMAIL_HTTPS_KEY_PATH'),
  );

  return {
    bridge: {
      host:     opts.bridgeHost     ?? process.env['PROTONMAIL_BRIDGE_HOST']     ?? '127.0.0.1',
      imapPort: intValue(opts.bridgeImapPort, 'PROTONMAIL_BRIDGE_IMAP_PORT', 1143),
      username: requireValue(opts.bridgeUsername, 'PROTONMAIL_BRIDGE_USERNAME', 'bridge-username'),
      password: requireValue(opts.bridgePassword, 'PROTONMAIL_BRIDGE_PASSWORD', 'bridge-password'),
      tls:      { rejectUnauthorized: false },
    },
    pool: {
      min: intValue(opts.poolMin, 'PROTONMAIL_CONNECTION_POOL_MIN', 1),
      max: intValue(opts.poolMax, 'PROTONMAIL_CONNECTION_POOL_MAX', 5),
    },
    http: {
      host:      opts.mcpHost     ?? process.env['PROTONMAIL_MCP_HOST']       ?? '127.0.0.1',
      port:      intValue(opts.mcpPort, 'PROTONMAIL_MCP_PORT', 3000),
      basePath:  opts.mcpBasePath ?? process.env['PROTONMAIL_MCP_BASE_PATH']  ?? '/mcp',
      authToken: requireValue(opts.mcpAuthToken, 'PROTONMAIL_MCP_AUTH_TOKEN', 'mcp-auth-token'),
      ...(httpsTls ? { tls: httpsTls } : {}),
    },
    log: (() => {
      const logPath = optionalValue(opts.logPath, 'PROTONMAIL_LOG_PATH') || undefined;
      return {
        ...(logPath !== undefined ? { logPath } : {}),
        auditLogPath: requireValue(opts.auditLogPath, 'PROTONMAIL_AUDIT_LOG_PATH', 'audit-log-path'),
        logLevel:     opts.logLevel ?? process.env['PROTONMAIL_LOG_LEVEL'] ?? 'info',
      };
    })(),
    verify: opts.verify ?? false,
  };
}
