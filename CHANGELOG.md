# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `conn.mailbox` access in `ImapClient.listMailbox`: guarded `false | MailboxObject` union before accessing `.exists`
- `parsed.html` handling in `ImapClient.fetchMessage`: used `||` instead of `??` since mailparser types `html` as `string | false`
- `messageMove` result in `ImapClient.moveEmails`: used `moved.uidMap.get(uid)` (Map API) instead of bracket access after `false` guard
- `LogConfig.logPath` assignment: used conditional spread to satisfy `exactOptionalPropertyTypes`
- `server.connect(transport)`: added explicit cast for MCP SDK `onclose` optional/required mismatch under `exactOptionalPropertyTypes`
- Fastify `loggerInstance`: cast pino logger to `FastifyBaseLogger` to resolve generic type mismatch

### Changed

- `createHttpApp` now takes `(imap, pool, config, logger)` directly and creates `McpServer` per session internally (was planned as `(server, config, logger)`)

---

### Added

- Initial skeleton: Fastify HTTP MCP server with `StreamableHTTPServerTransport`
- 10 MCP tools: `list_mailbox`, `fetch_summaries`, `fetch_message`, `fetch_attachment`,
  `search_mailbox`, `move_emails`, `mark_read`, `mark_unread`, `verify_connectivity`,
  `drain_connections`
- `ImapConnectionPool` with pool version drain pattern (no `#draining` flag)
- `@Audited` TC39 Stage 3 method decorator for automatic IMAP operation auditing
- CLI configuration via `commander` with env var fallback; all vars prefixed `PROTONMAIL_`
- Bearer token authentication (`Authorization: Bearer`) on all MCP endpoints
- Pino application logger (stderr or file) separate from JSONL audit log (file only)
- `--verify` flag for IMAP connectivity pre-check before server start
- Index-stable batch operation results (`BatchItemResult<T>[]`)
- Per-item error reporting in batch operations (`{ id, error: { code, message } }`)
- Attachment lazy-loading: `fetch_message` returns metadata only; `fetch_attachment` fetches content
