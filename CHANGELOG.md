# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `add_labels` MCP tool — add one or more Proton Mail labels to a batch of emails via IMAP COPY; returns per-email results including new UIDs in label folders
- `AddLabelsBatchResult`, `AddLabelsItem`, `AddLabelsItemData` types in `src/types/operations.ts`
- `create_folder` MCP tool — creates new mail folders under `Folders/` with recursive nested path support (e.g. `Folders/Work/Projects`); returns whether the folder was newly created or already existed

### Changed

- Simplified the release
- `get_folders` MCP tool replaces `list_folders` — enriched per-folder metadata (message count, unread count, UID next, listed/subscribed status) via inline STATUS query; filters out Proton labels (`Labels/`), the `Starred` virtual mailbox, and the `Labels` root

## [0.2.0] - 2026-04-04

### Added

- Release workflow attaches `proton-bridge-mcp.mcpb` and source archive (`proton-bridge-mcp-X.Y.Z-source.tar.gz`) to GitHub Releases
- npm publish on release via `NPM_TOKEN` secret; `package.json` `files` field limits tarball to `dist/`, `manifest.json`, `CHANGELOG.md`, and `LICENSE`
- GitHub Actions CI workflow (`.github/workflows/ci.yml`): parallel Lint, Build, Test jobs with concurrency cancellation and npm caching
- GitHub Actions release workflow (`.github/workflows/release.yml`): triggered on version tag push, extracts changelog section, creates GitHub Release
- `release-it` + `@release-it/keep-a-changelog` for local release automation (bumps version, rewrites `CHANGELOG.md`, pushes tag)
- `.nvmrc` and `package.json` `volta` pin for Node 25.9.0 local dev consistency
- `test` script stub in `package.json` (`--if-present` in CI; activates when vitest is added)
- `list_folders` MCP tool — IMAP LIST command enumerating all mailboxes with path, name, delimiter, flags, and RFC 6154 special-use attributes (Sent, Drafts, Trash, Junk, etc.)
- `FolderInfo` type in `src/types/email.ts`
- Idle pool drain timer in `ImapConnectionPool`:
  - `idleDrainSecs` (default 30 s, `--pool-idle-drain-secs` / `PROTONMAIL_CONNECTION_POOL_IDLE_DRAIN_SECS`): drains available connections above `min` after inactivity
  - `idleTimeoutSecs` (default 300 s, `--pool-idle-timeout-secs` / `PROTONMAIL_CONNECTION_POOL_IDLE_TIMEOUT_SECS`): empties all available connections after prolonged inactivity (pool version bumped; in-use connections discarded on release)
  - Timer checks every 10 s, is unref'd (won't block process exit), and is stopped on `pool.stop()`

### Fixed

- `conn.mailbox` access in `ImapClient.listMailbox`: guarded `false | MailboxObject` union before accessing `.exists`
- `parsed.html` handling in `ImapClient.fetchMessage`: used `||` instead of `??` since mailparser types `html` as `string | false`
- `messageMove` result in `ImapClient.moveEmails`: used `moved.uidMap.get(uid)` (Map API) instead of bracket access after `false` guard
- `LogConfig.logPath` assignment: used conditional spread to satisfy `exactOptionalPropertyTypes`
- `server.connect(transport)`: added explicit cast for MCP SDK `onclose` optional/required mismatch under `exactOptionalPropertyTypes`
- Fastify `loggerInstance`: cast pino logger to `FastifyBaseLogger` to resolve generic type mismatch

### Changed

- `createHttpApp` now takes `(imap, pool, config, logger)` directly and creates `McpServer` per session internally (was planned as `(server, config, logger)`)
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

## [0.1.0]

Unreleased.

[unreleased]: https://github.com/grover/proton-bridge-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/grover/proton-bridge-mcp/releases/tag/v0.2.0
