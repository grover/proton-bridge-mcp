# TODO

## Documentation
- [ ] Add screenshots to `docs/bridge-repair/README.md` (or remove placeholder comments)
- [ ] `docs/impl/auditing.md` — `@Audited` decorator, `AuditLogger.wrap()`, JSONL audit trail, outcome classification, input sanitization
- [ ] `docs/impl/mailbox-locking.md` — `getMailboxLock()` pattern, lock/release ordering, `groupByMailbox` for lock reduction, connection acquire/release discipline
- [ ] `docs/impl/mcp-tool-interfaces.md` — `BatchToolResult`/`ListToolResult`/`SingleToolResult` type system, `batchStatus()` utility, `toText()` serialization, choosing the right result type, semantic error codes, tool annotations
- [ ] `docs/impl/operation-log-revert.md` — `@Tracked` decorator, `OperationLog`, reversal specs, `revert_operations` tool, limitations (missing COPYUID impact on reversal)

## Features
- [ ] Add `@Tracked` to `createFolder` — requires `deleteFolder` on ImapClient (separate branch)
- [ ] Add `@Tracked` to `addLabels` — requires `deleteEmails` on ImapClient (separate branch)
- [ ] Add `@Audited` to `revertOperations` — currently individual IMAP ops are audited via ImapClient but the top-level revert is not
- [ ] Idempotency hints on tool annotations

## Security
- [ ] Security review per https://github.com/anthropics/claude-code-security-review
