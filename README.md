<p align="center">
  <img src="assets/logo.svg" alt="proton-bridge-mcp" width="480" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/MCP-Server-blue?style=flat-square" alt="MCP Server" />
  <img src="https://img.shields.io/badge/TypeScript-6-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 6" />
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A525.9-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js >= 25.9" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="MIT License" />
  <img src="https://img.shields.io/github/actions/workflow/status/grover/proton-bridge-mcp/ci.yml?branch=main&style=flat-square&label=CI" alt="CI Status" />
</p>

<h1 align="center">proton-bridge-mcp</h1>

<p align="center">
  <strong>Give your AI agent access to ProtonMail.</strong>
</p>

An [MCP](https://modelcontextprotocol.io/) server that bridges ProtonMail to AI agents via the local [Proton Bridge](https://proton.me/mail/bridge) IMAP daemon. Read, search, organize, and manage your encrypted email — all through the Model Context Protocol.

---

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Other Usage](#other-usage)
- [Authentication](#authentication)
- [Configuration Reference](#configuration-reference)
- [MCP Tools](#mcp-tools)
- [Claude Desktop Manual Configuration](#claude-desktop-manual-configuration)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Architecture](#architecture)
- [Contributing](#contributing)
- [Acknowledgements](#acknowledgements)
- [License](#license)

---

## Features

- **13 MCP tools** for reading, searching, and organizing email
- **Three transport modes** — STDIO, HTTP, and HTTPS
- **IMAP connection pooling** with configurable min/max connections and idle drain timers
- **Batch operations** with input-order stability and per-item error reporting
- **Audit logging** of all mutating operations (JSONL)
- **Claude Desktop packaging** via `.mcpb` bundles
- **Zero external services** — connects directly to your local Proton Bridge

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js >= 25.9** | See `.nvmrc` for exact version |
| **Proton Bridge** | Running locally with IMAP enabled (default port `1143`) |
| **Bridge mailbox password** | Found in Proton Bridge app under **Account > Mailbox password** |

> **Important:** The bridge mailbox password is _not_ your ProtonMail login password. Proton Bridge generates a separate password specifically for IMAP access.

## Quick Start

The fastest way to get started is to install the pre-built `.mcpb` package in Claude Desktop.

### 1. Install Proton Mail Bridge

Download and install [Proton Mail Bridge](https://proton.me/mail/bridge) from Proton. Sign in with your ProtonMail account and wait for the initial sync to complete.

### 2. Note Your Bridge Mailbox Password

In the Proton Bridge app, click on your account and copy the **Mailbox password**. This is a Bridge-generated password — it is **not** your ProtonMail login password.

### 3. Install the MCPB Package

Download `proton-bridge-mcp.mcpb` from the [latest GitHub release](https://github.com/grover/proton-bridge-mcp/releases/latest) and open it with Claude Desktop. The installer will prompt you to configure two required fields:

| Field | What to enter |
|---|---|
| **ProtonMail Address** | Your email address (e.g. `you@protonmail.com`) |
| **Bridge Mailbox Password** | The password you copied from Proton Bridge in step 2 |

All other settings (host, port, pool size, log level) have sensible defaults and can be left as-is.

### 4. Verify It Works

Once installed, ask Claude to check your email. The server runs in **STDIO mode** — Claude Desktop launches it as a subprocess, so there's no network listener and no auth token to manage. Behind the scenes, Claude will use the `verify_connectivity` tool to confirm the connection to Proton Bridge is healthy.

> **That's it.** You can now ask Claude to read, search, and organize your ProtonMail.

---

## Other Usage

Beyond the MCPB quick-start, you can run the server directly from a local build. It supports three transport modes.

### STDIO (Default)

The simplest mode — communicates over stdin/stdout. This is the default when no transport flag is provided and is ideal for **Claude Desktop** and other MCP clients that launch the server as a subprocess.

```bash
npm run build

node dist/index.js \
  --bridge-username your@protonmail.com \
  --bridge-password your-bridge-password
```

No auth token is needed — the process boundary _is_ the security boundary.

### HTTP

Runs a Fastify HTTP server with Bearer token authentication. Use this when the MCP client connects over the network or when you want to share one server across multiple sessions.

```bash
node dist/index.js --http \
  --bridge-username your@protonmail.com \
  --bridge-password your-bridge-password \
  --mcp-auth-token your-secret-token
```

The server listens on `127.0.0.1:3000/mcp` by default. Each HTTP session gets its own `McpServer` instance, while the IMAP pool is shared.

### HTTPS

Same as HTTP but with TLS. If you don't provide cert/key paths, the server **auto-generates a self-signed certificate** at startup.

```bash
# Auto-generated self-signed cert
node dist/index.js --https \
  --bridge-username your@protonmail.com \
  --bridge-password your-bridge-password \
  --mcp-auth-token your-secret-token

# Custom certificate
node dist/index.js --https \
  --bridge-username your@protonmail.com \
  --bridge-password your-bridge-password \
  --mcp-auth-token your-secret-token \
  --https-cert /path/to/cert.pem \
  --https-key /path/to/key.pem
```

---

## Authentication

> **Using the MCPB package?** The installer handles credential configuration for you — just enter your ProtonMail address and Bridge mailbox password during setup. The details below are for manual or advanced configurations.

### Bridge Authentication (IMAP)

All transport modes require bridge credentials to connect to Proton Bridge's IMAP server:

| Parameter | CLI Flag | Environment Variable |
|---|---|---|
| Username | `--bridge-username` | `PROTONMAIL_BRIDGE_USERNAME` |
| Password | `--bridge-password` | `PROTONMAIL_BRIDGE_PASSWORD` |

These are always required. The password is the bridge-generated mailbox password, not your ProtonMail account password. The MCPB manifest ([`manifest.json`](manifest.json)) configures these automatically from the values you enter during installation.

### MCP Authentication (HTTP/HTTPS only)

HTTP and HTTPS modes require a Bearer token for client authentication. This is **not needed for STDIO mode** (including MCPB installations), since the process boundary provides isolation.

| Parameter | CLI Flag | Environment Variable |
|---|---|---|
| Auth Token | `--mcp-auth-token` | `PROTONMAIL_MCP_AUTH_TOKEN` |

Clients must include the token in every request:

```
Authorization: Bearer your-secret-token
```

### OAuth 2.0 (Planned)

OAuth 2.0 support is planned for a future milestone but is not yet implemented. See [issue #7](https://github.com/grover/proton-bridge-mcp/issues/7) for tracking.

---

## Configuration Reference

Configuration follows the precedence: **CLI flags > Environment variables > Defaults**.

All environment variables use the `PROTONMAIL_` prefix. You can set them in a `.env` file (see [`.env.example`](.env.example)).

### Bridge Connection

| CLI Flag | Env Var | Default | Description |
|---|---|---|---|
| `--bridge-host` | `PROTONMAIL_BRIDGE_HOST` | `127.0.0.1` | Proton Bridge IMAP host |
| `--bridge-imap-port` | `PROTONMAIL_BRIDGE_IMAP_PORT` | `1143` | Proton Bridge IMAP port |
| `--bridge-username` | `PROTONMAIL_BRIDGE_USERNAME` | _(required)_ | ProtonMail email address |
| `--bridge-password` | `PROTONMAIL_BRIDGE_PASSWORD` | _(required)_ | Bridge mailbox password |

### Connection Pool

| CLI Flag | Env Var | Default | Description |
|---|---|---|---|
| `--pool-min` | `PROTONMAIL_CONNECTION_POOL_MIN` | `1` | Min idle connections |
| `--pool-max` | `PROTONMAIL_CONNECTION_POOL_MAX` | `5` | Max concurrent connections |
| `--pool-idle-drain-secs` | `PROTONMAIL_CONNECTION_POOL_IDLE_DRAIN_SECS` | `30` | Drain to min after N idle seconds |
| `--pool-idle-timeout-secs` | `PROTONMAIL_CONNECTION_POOL_IDLE_TIMEOUT_SECS` | `300` | Empty pool entirely after N idle seconds (0 = disabled) |

### HTTP/HTTPS Server

| CLI Flag | Env Var | Default | Description |
|---|---|---|---|
| `--http` | — | — | Enable HTTP transport |
| `--https` | — | — | Enable HTTPS transport |
| `--mcp-host` | `PROTONMAIL_MCP_HOST` | `127.0.0.1` | Server listen address |
| `--mcp-port` | `PROTONMAIL_MCP_PORT` | `3000` | Server listen port |
| `--mcp-base-path` | `PROTONMAIL_MCP_BASE_PATH` | `/mcp` | MCP endpoint path |
| `--mcp-auth-token` | `PROTONMAIL_MCP_AUTH_TOKEN` | _(required)_ | Bearer auth token |
| `--https-cert` | `PROTONMAIL_HTTPS_CERT_PATH` | _(auto-generated)_ | TLS certificate path |
| `--https-key` | `PROTONMAIL_HTTPS_KEY_PATH` | _(auto-generated)_ | TLS private key path |

### Operation Log

| CLI Flag | Env Var | Default | Description |
|---|---|---|---|
| `--operation-log-size` | `PROTONMAIL_OPERATION_LOG_SIZE` | `100` | Max entries in the in-memory revert log |

### Logging

| CLI Flag | Env Var | Default | Description |
|---|---|---|---|
| `--log-path` | `PROTONMAIL_LOG_PATH` | _(stderr)_ | Application log file path |
| `--log-level` | `PROTONMAIL_LOG_LEVEL` | `info` | Log level: `trace` `debug` `info` `warn` `error` |
| `--audit-log-path` | `PROTONMAIL_AUDIT_LOG_PATH` | `~/.proton-bridge-mcp/audit.jsonl` | Audit log file path |

### Utility

| CLI Flag | Description |
|---|---|
| `--verify` | Test IMAP connectivity and exit (status 0 = success, 1 = failure) |

---

## MCP Tools

The server exposes 13 tools that MCP clients can call. Each tool is annotated with `readOnlyHint` or `destructiveHint` so clients can present appropriate confirmation prompts.

For **full documentation** — including input schemas, return types, and example JSON — see the **[Tools Reference](docs/tools/README.md)**.

| Tool | Flags | Description |
|---|---|---|
| `get_folders` | read-only | List all mail folders with message counts, unread counts, and IMAP metadata (excludes Proton labels) |
| `get_labels` | read-only | List all Proton Mail labels with message counts, unread counts, and IMAP metadata |
| `create_folder` | mutating | Create a new mail folder under `Folders/` (supports nested paths) |
| `delete_folder` | destructive | Delete a mail folder under `Folders/` (clears operation history) |
| `list_mailbox` | read-only | Browse emails in a mailbox, newest first, with pagination |
| `fetch_summaries` | read-only | Fetch envelope data (from, to, subject, date, flags) for known email IDs |
| `fetch_message` | read-only | Fetch full message body (text/HTML) and attachment metadata |
| `fetch_attachment` | read-only | Download a single attachment by part ID (base64-encoded) |
| `search_mailbox` | read-only | Full-text IMAP search within a mailbox, with pagination |
| `move_emails` | destructive | Move a batch of emails to another mailbox |
| `mark_read` | mutating | Add the `\Seen` flag to a batch of emails |
| `mark_unread` | mutating | Remove the `\Seen` flag from a batch of emails |
| `add_labels` | mutating | Add Proton Mail labels to a batch of emails (IMAP COPY) |
| `verify_connectivity` | read-only | Test connection to Proton Bridge and report latency |
| `drain_connections` | read-only | Close all pooled connections (useful after a Bridge restart) |

All batch operations preserve input order in results and report per-item success/failure.

---

## Claude Desktop Manual Configuration

If you prefer not to use the MCPB package (see [Quick Start](#quick-start)), you can configure Claude Desktop manually by editing its config file.

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "proton-bridge-mcp": {
      "command": "node",
      "args": [
        "/path/to/proton-bridge-mcp/dist/index.js",
        "--bridge-username", "your@protonmail.com",
        "--bridge-password", "your-bridge-password"
      ]
    }
  }
}
```

This uses STDIO mode. For HTTP/HTTPS usage with Claude Desktop, see [Other Usage](#other-usage).

---

## Security

This server handles email credentials and provides access to your private mailbox. Take these precautions seriously.

### Choose STDIO When Possible

**STDIO mode is the recommended transport for local use**, even if your MCP client supports HTTP. In STDIO mode, credentials never leave the process boundary — there is no network listener, no auth token to leak, and no attack surface beyond the process itself.

Use HTTP or HTTPS only when you genuinely need network-based access (e.g., a remote MCP client, or multiple clients sharing one server).

### Bearer Token Security (HTTP/HTTPS)

When running in HTTP or HTTPS mode:

- **Generate a strong, random token** — at least 32 characters. Use `openssl rand -hex 32` or a password manager.
- **Never commit tokens to version control.** Use environment variables or a `.env` file (which is `.gitignore`'d).
- **HTTPS is strongly preferred over HTTP.** Plain HTTP transmits the Bearer token in cleartext on every request. Even on `localhost`, other processes or browser extensions could potentially intercept it. HTTPS mode auto-generates a self-signed certificate if you don't provide one — there's no reason not to use it.
- **Bind to `127.0.0.1`, not `0.0.0.0`.** The default listen address is `127.0.0.1`, which restricts access to the local machine. Changing this to `0.0.0.0` exposes the server to your entire network.

### OAuth 2.0 (Not Yet Implemented)

OAuth 2.0 support is tracked in [issue #7](https://github.com/grover/proton-bridge-mcp/issues/7) but is **not yet implemented**. Until then, Bearer token authentication is the only option for HTTP/HTTPS modes. Do not assume OAuth is available.

### Environment Variables and Secrets

Credentials can be passed via CLI flags or environment variables. Be aware of the tradeoffs:

| Method | Pros | Cons |
|---|---|---|
| CLI flags | Explicit, easy to audit | Visible in `ps` output and shell history |
| Environment variables | Not in `ps` output | Visible to child processes; may leak in crash dumps |
| `.env` file | Convenient for development | Must be excluded from version control |

For production use, consider a secrets manager or restricting file permissions on your `.env` file (`chmod 600 .env`).

### Firewall Recommendations

Proton Bridge exposes IMAP (default `1143`) and SMTP (default `1025`) on localhost. While these are bound to `127.0.0.1` by default, it's good practice to **firewall these ports** to prevent any unsolicited access:

**macOS (pf):**
```bash
# Block external access to Bridge ports (add to /etc/pf.conf)
block in on ! lo0 proto tcp to any port { 1143, 1025 }
```

**Linux (ufw):**
```bash
sudo ufw deny in on eth0 to any port 1143
sudo ufw deny in on eth0 to any port 1025
```

This ensures that even if Bridge's listen address is misconfigured, no external machine can reach it.

### Audit Logging

All mutating operations (move, mark read/unread) are logged to a JSONL audit file at `~/.proton-bridge-mcp/audit.jsonl` by default. Review this log periodically to verify that only expected operations are occurring:

```bash
tail -f ~/.proton-bridge-mcp/audit.jsonl | jq .
```

### What This Server Does NOT Do

- It does **not** store or cache your emails — all data is fetched live from Proton Bridge
- It does **not** send emails (no SMTP support yet)
- It does **not** phone home or contact any external service
- It does **not** modify Bridge settings or your ProtonMail account

---

## Troubleshooting

### Connection Refused on Port 1143

**Cause:** Proton Bridge is not running or IMAP is disabled.

**Fix:**
1. Launch Proton Mail Bridge and wait for it to fully start
2. Check that the status indicator shows green / "Connected"
3. Verify IMAP is enabled in Bridge settings (click your account > check IMAP toggle)
4. Ask your MCP client to call the `verify_connectivity` tool — it will report whether the connection succeeds and the round-trip latency

### Authentication Failed

**Cause:** Wrong password or account needs re-authentication in Bridge.

**Fix:**
1. Open Proton Bridge and click on your account
2. If prompted, sign in again
3. Copy the **Mailbox password** (not your ProtonMail login password!)
4. Update your `.env` or CLI flags with the new password

### Stale or Missing Emails

**Cause:** Proton Bridge's local sync database may be out of date or corrupted.

**Fix:**
1. Open Proton Bridge, click your account, and use the **Repair** function
2. Wait for the resync to complete
3. Use the `drain_connections` MCP tool to force fresh IMAP connections

See the [Bridge Repair Guide](docs/bridge-repair/README.md) for detailed step-by-step instructions.

### Bridge Crashes or Freezes

Proton Bridge can occasionally become unresponsive, especially after system sleep/wake cycles or network changes.

**Fix:**
1. Force-quit Bridge (Activity Monitor on macOS, Task Manager on Windows)
2. Restart Bridge
3. If crashes persist, try the [full reset procedure](docs/bridge-repair/README.md#full-reset-nuclear-option)

### "Too Many Connections" Errors

**Cause:** The connection pool max is set higher than Bridge can handle, or stale connections aren't being released.

**Fix:**
1. Lower `--pool-max` (try `3` instead of `5`)
2. Use the `drain_connections` tool to flush the pool
3. Restart the MCP server

### Self-Signed Certificate Warnings

When using `--https` without providing a certificate, the server generates a self-signed cert. MCP clients may warn about this.

**Fix:** Either provide a proper certificate via `--https-cert` and `--https-key`, or configure your client to trust the self-signed cert. For local development, self-signed is fine.

### Debugging Tips

- **Increase log verbosity:** `--log-level debug` (or `trace` for maximum detail)
- **Watch the audit log:** `tail -f ~/.proton-bridge-mcp/audit.jsonl | jq .`
- **Test with MCP Inspector:** `npm run inspector` launches an interactive web UI
- **Check Bridge logs:** Proton Bridge has its own logs — find them via Bridge Settings > Logs

---

## Development

### Setup

```bash
git clone https://github.com/grover/proton-bridge-mcp.git
cd proton-bridge-mcp
nvm use           # or volta, mise, asdf — picks up .nvmrc / volta pin
npm install
cp .env.example .env
# Fill in your bridge credentials in .env
```

### Scripts

| Script | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | Watch mode with tsx (auto-restart on changes) |
| `npm run lint` | ESLint with type-aware parsing |
| `npm test` | Run tests (vitest, when added) |
| `npm run inspector` | Build and launch MCP Inspector |
| `npm run package` | Build and create `.mcpb` bundle |

### Debugging with MCP Inspector

The [MCP Inspector](https://github.com/modelcontextprotocol/inspector) provides a web UI for testing tools interactively:

```bash
# HTTP mode
node dist/index.js --http \
  --bridge-username x --bridge-password y \
  --mcp-auth-token my-token &

npx @modelcontextprotocol/inspector http://127.0.0.1:3000/mcp
# Set the Authorization header to: Bearer my-token
```

### Watching the Audit Log

```bash
tail -f ~/.proton-bridge-mcp/audit.jsonl | jq .
```

### Project Structure

```
src/
  index.ts          Entry point — CLI parsing and transport dispatch
  config.ts         CLI flags, env vars, and config validation
  server.ts         MCP tool registration and handler logic
  stdio.ts          STDIO transport setup
  logger.ts         Pino app logger (stderr or file)
  bridge/
    imap.ts         ImapClient — all IMAP operations
    pool.ts         ImapConnectionPool with version-based drain
    audit.ts        JSONL audit logger for mutating operations
    decorators.ts   @Audited decorator
  types/
    config.ts       Config type definitions
    email.ts        Email, folder, and attachment types
  http/
    app.ts          Fastify HTTP/HTTPS app factory
```

### Code Conventions

- **ESM only** — all local imports must use `.js` extensions (`import { Foo } from './foo.js'`)
- **TypeScript 6** with `exactOptionalPropertyTypes` and strict mode
- **`@Audited` decorator** on every public `ImapClient` method
- **Batch-first** — all operations accept arrays and preserve input order
- **Config precedence** — CLI flags > env vars > defaults

---

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for full design detail. The high-level layer stack:

```
MCP Client (Claude, Inspector, etc.)
       |
  [ Transport Layer ]
  STDIO | HTTP | HTTPS (Fastify + Bearer auth)
       |
  [ MCP Server ]
  Tool registration, input validation (Zod)
       |
  [ ImapClient ]
  @Audited methods, batch grouping by mailbox
       |
  [ ImapConnectionPool ]
  Version-based drain, idle timers, min/max sizing
       |
  Proton Bridge IMAP (127.0.0.1:1143)
```

---

## Contributing

Contributions are welcome! Here's how to get started:

1. **Fork and clone** the repository
2. **Create a feature branch** from `main`:
   ```bash
   git checkout -b feat/your-feature
   ```
3. **Make your changes** — follow the code conventions above
4. **Run the pre-commit checklist** before every commit:
   ```bash
   npm install        # ensure lockfile is in sync
   npm run lint       # must pass with zero errors
   npm run build      # must compile clean
   npm ci             # verify lockfile consistency
   ```
5. **Push and open a PR** against `main`

### CI & Review

Every PR runs three parallel checks: **Lint**, **Build**, and **Test**. All three must pass before merging.

PRs are reviewed and merged by the maintainer. This is a side project — response times may vary, so please be patient. Quality contributions are always appreciated.

### Releases

Releases are managed with [release-it](https://github.com/release-it/release-it). Maintainers run `npx release-it` locally, which bumps the version, updates the changelog, and pushes a tag. CI then creates the GitHub Release automatically with:

- **`proton-bridge-mcp.mcpb`** — ready-to-install Claude Desktop package
- **`proton-bridge-mcp-X.Y.Z-source.tar.gz`** — source archive
- **npm** — the package is published to [npm](https://www.npmjs.com/package/proton-bridge-mcp) (`npm install -g proton-bridge-mcp`)

---

## Acknowledgements

### Built With

- **[Proton Mail Bridge](https://proton.me/mail/bridge)** — the local IMAP/SMTP gateway that makes this project possible. Proton Bridge decrypts your end-to-end encrypted ProtonMail locally so standard mail clients (and this MCP server) can access it.
- **[Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk)** — the TypeScript SDK for building MCP servers
- **[ImapFlow](https://github.com/postalsys/imapflow)** — modern, promise-based IMAP client for Node.js
- **[Fastify](https://fastify.dev/)** — high-performance HTTP framework powering the HTTP/HTTPS transport
- **[Pino](https://getpino.io/)** — super-fast JSON logger for Node.js
- **[Commander.js](https://github.com/tj/commander.js)** — CLI argument parsing
- **[Zod](https://zod.dev/)** — TypeScript-first schema validation for MCP tool inputs
- **[mailparser](https://nodemailer.com/extras/mailparser/)** — MIME message parsing for email bodies and attachments
- **[TypeScript](https://www.typescriptlang.org/)** 6 — the language this project is written in

### Created With

- **[Claude Code](https://claude.ai/claude-code)** by [Anthropic](https://www.anthropic.com/) — AI-assisted development
- **[Claude](https://claude.ai/)** by [Anthropic](https://www.anthropic.com/) — design, architecture, and code generation
- **[Visual Studio Code](https://code.visualstudio.com/)** — code editor
- **[GitHub](https://github.com/)** — source control, CI/CD, and collaboration

---

## License

[MIT](LICENSE) &copy; 2026 Michael Fröhlich and [Claude](https://claude.ai/) by [Anthropic](https://www.anthropic.com/)

---

<sub>Proton, Proton Mail, and Proton Mail Bridge are trademarks of [Proton AG](https://proton.me/). This project is not affiliated with, endorsed by, or sponsored by Proton AG. It is an independent open-source tool that interfaces with the locally installed Proton Mail Bridge application.</sub>
