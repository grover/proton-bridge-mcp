import { Command } from 'commander';
import type { AppConfig } from './types/index.js';

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
    verify?:         boolean;
  }>();

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
