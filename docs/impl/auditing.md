# Auditing

This document describes the audit logging mechanism: why it exists, what it records, privacy and security considerations, and requirements for future implementations. For error handling strategies, see `docs/impl/imap-error-handling.md`. For connection pool internals, see `docs/impl/connection-pool.md`.

## Why Auditing Matters

**Diagnostics.** The MCP server is a background daemon with no interactive UI. The audit log is the primary tool for understanding what happened and when — which operations ran, how long they took, and whether they succeeded.

**Accountability.** LLM agents perform autonomous email operations (move, flag, label) on behalf of users. The audit trail provides a record of what was done, enabling users to review agent actions after the fact.

**Debugging partial failures.** Batch operations can partially succeed. The audit log records `itemCount`/`errorCount` per operation, enabling post-hoc diagnosis without reproducing the scenario.

## Privacy and Security Considerations

### What Is Logged

The audit log records **operation metadata**, not email content:

| Logged | Not Logged |
|--------|------------|
| Operation name (e.g., `move_emails`) | Email body text or HTML |
| Timestamp and duration | Attachment contents |
| Email IDs (`{ uid, mailbox }`) | Email addresses (from/to/cc) |
| Mailbox names (e.g., `INBOX`, `Folders/Medical`) | Subject lines |
| Batch item counts and error counts | Message headers |
| Sanitized input parameters | Passwords, tokens, secrets |

### PII Considerations

Email IDs are opaque numeric identifiers (UIDs), not personally identifiable on their own. However, **mailbox names can be PII-adjacent** — a folder named `Folders/Medical` or `Folders/Legal-Dispute` reveals information about the user's email organization. This is an intentional trade-off: mailbox names are necessary for diagnosing failures and correlating with IMAP server logs.

### Input Sanitization

The `AuditLogger` redacts sensitive fields before writing. Any top-level object property whose key matches `/password|secret|token|auth/i` is replaced with `[REDACTED]`:

```typescript
{ password: 'hunter2', mailbox: 'INBOX' }
→ { password: '[REDACTED]', mailbox: 'INBOX' }
```

**Limitation:** Sanitization is shallow — nested objects are not traversed. If a new operation passes sensitive data in a nested structure, it will not be redacted automatically.

### File Permissions and Access

The audit log is written to a user-owned file (`~/.proton-bridge-mcp/audit.jsonl` by default). The daemon does not set file permissions explicitly — the file inherits the process umask. Operators should ensure the audit log directory is not world-readable, especially on multi-user systems.

### Retention

There is no automatic rotation or retention policy. The audit log grows unbounded. Operators are responsible for log rotation (e.g., `logrotate`) and retention compliance. Built-in rotation is tracked in [#40](https://github.com/grover/proton-bridge-mcp/issues/40).

### Trade-off Summary

The audit log prioritizes **operational diagnostics** over **privacy minimization**. The data logged (UIDs, mailbox names, timing, error counts) is the minimum needed to diagnose issues without access to email content. If stricter privacy is required, access-control the audit log at the filesystem level or disable it by pointing the path to `/dev/null`.

## How It Works

Every public `ImapClient` method is wrapped by the `@Audited` decorator, which records a JSONL entry per operation. The audit log is written to a file, **never to stderr** (stderr is reserved for MCP protocol traffic and operational logging).

### Flow

```
Tool call
  → @Audited intercepts
    → AuditLogger.wrap() starts timer
      → Original method executes
    → Outcome classified (success / partial / error)
  → JSONL entry appended to audit log file
→ Result returned to caller (or exception re-thrown)
```

### AuditLogger (`src/bridge/audit.ts`)

A single `AuditLogger` instance is created at startup and injected into `ImapClient`:

```
src/index.ts:  const audit = new AuditLogger(config.log.auditLogPath);
src/index.ts:  const imap  = new ImapClient(pool, audit, logger);
```

The logger exposes one public method:

```typescript
async wrap<T>(operation: string, input: unknown, fn: () => Promise<T>): Promise<T>
```

`wrap()` starts a timer, executes `fn`, classifies the outcome, sanitizes the input, and appends a JSONL entry. On error, it logs the entry **then re-throws** — auditing never swallows exceptions.

### @Audited Decorator (`src/bridge/decorators.ts`)

```typescript
@Audited('operation_name')
async someMethod(args: T): Promise<R> { ... }
```

The decorator wraps the method body in `this.audit.wrap(operation, args[0], ...)`. It requires the host class to expose a public `audit: AuditLogger` property. The first argument (`args[0]`) is passed as the `input` for the audit entry.

### AuditEntry Type (`src/types/audit.ts`)

```typescript
type AuditOutcome = 'success' | 'partial' | 'error';

interface AuditEntry {
  timestamp:   string;          // ISO 8601
  operation:   string;          // e.g. 'list_mailbox', 'move_emails'
  durationMs:  number;
  input:       unknown;         // sanitized — passwords/tokens stripped
  outcome:     AuditOutcome;
  itemCount?:  number;          // batch ops: total items processed
  errorCount?: number;          // batch ops: items that failed
  error?:      string;          // top-level failure message
}
```

## Outcome Classification

`wrap()` classifies outcomes automatically based on the method's return value:

| Scenario | Outcome | Additional Fields |
|----------|---------|-------------------|
| Method succeeds, result is not an array | `success` | — |
| Method succeeds, result is an array with no items having an `error` property | `success` | `itemCount` |
| Method succeeds, result is an array where some items have a truthy `error` property | `partial` | `itemCount`, `errorCount` |
| Method throws an exception | `error` | `error` (message string) |

The batch detection works by inspecting the result array: any element that is an object with a truthy `error` property is counted as failed. This aligns with the `BatchItemResult<T>` structure where failed items carry `error: { code, message }`.

**Important:** The detection checks the **top-level return value**. If a batch method wraps its results in a container (e.g., `{ items: BatchItemResult<T>[] }`), the array is not detected and the outcome will be classified as `success` even with partial failures. Batch methods on `ImapClient` return raw arrays for this reason.

## Write Safety

Audit log writes are wrapped in a silent try/catch:

```typescript
async #write(entry: AuditEntry): Promise<void> {
  try {
    await appendFile(this.#filePath, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Audit write failure must not crash the application
  }
}
```

The daemon's primary job is mail operations. A failing audit log (full disk, permission issue) must not prevent email processing. The silent catch is intentional.

The trade-off is that audit gaps can go unnoticed. A future improvement would log a warning to the app logger (stderr/pino) on first write failure, then suppress subsequent warnings to avoid log spam.

## Configuration

| Source | Setting | Default |
|--------|---------|---------|
| CLI | `--audit-log-path <path>` | `~/.proton-bridge-mcp/audit.jsonl` |
| Env | `PROTONMAIL_AUDIT_LOG_PATH` | `~/.proton-bridge-mcp/audit.jsonl` |

CLI takes precedence over environment variable. The audit log is always written to a file — it is never written to stderr or stdout.

## Audited Operations

Every public `ImapClient` method carries `@Audited`:

| Operation Name | Method | Input Logged |
|----------------|--------|-------------|
| `get_folders` | `getFolders()` | `null` (no args) |
| `get_labels` | `getLabels()` | `null` (no args) |
| `create_folder` | `createFolder(path)` | `path` string |
| `list_mailbox` | `listMailbox(mailbox, limit, offset)` | `mailbox` string |
| `fetch_summaries` | `fetchSummaries(ids)` | `EmailId[]` |
| `fetch_message` | `fetchMessage(ids)` | `EmailId[]` |
| `fetch_attachment` | `fetchAttachment(id, partId)` | `EmailId` |
| `search_mailbox` | `searchMailbox(mailbox, query, limit)` | `mailbox` string |
| `move_emails` | `moveEmails(ids, targetMailbox)` | `EmailId[]` |
| `set_flag` | `setFlag(ids, flag, add)` | `EmailId[]` |
| `add_labels` | `addLabels(ids, labelNames)` | `EmailId[]` |

Note: The decorator passes `args[0]` as the input. For methods with multiple parameters (e.g., `moveEmails(ids, targetMailbox)`), only the first argument is logged. The first argument is the primary input; additional parameters provide context but are less useful for audit correlation.

## Sample Audit Log

```jsonl
{"timestamp":"2026-04-05T10:00:01.234Z","operation":"get_folders","durationMs":45,"input":null,"outcome":"success"}
{"timestamp":"2026-04-05T10:00:02.567Z","operation":"list_mailbox","durationMs":120,"input":"INBOX","outcome":"success","itemCount":25}
{"timestamp":"2026-04-05T10:00:05.890Z","operation":"fetch_message","durationMs":340,"input":[{"uid":42,"mailbox":"INBOX"},{"uid":43,"mailbox":"INBOX"}],"outcome":"success","itemCount":2}
{"timestamp":"2026-04-05T10:00:08.123Z","operation":"move_emails","durationMs":580,"input":[{"uid":42,"mailbox":"INBOX"},{"uid":43,"mailbox":"INBOX"},{"uid":44,"mailbox":"INBOX"}],"outcome":"partial","itemCount":3,"errorCount":1}
{"timestamp":"2026-04-05T10:00:10.456Z","operation":"create_folder","durationMs":90,"input":"Folders/Archive/2026","outcome":"success"}
{"timestamp":"2026-04-05T10:00:12.789Z","operation":"search_mailbox","durationMs":200,"input":"INBOX","outcome":"error","error":"Connection closed unexpectedly"}
{"timestamp":"2026-04-05T10:00:15.012Z","operation":"set_flag","durationMs":150,"input":[{"uid":50,"mailbox":"INBOX"}],"outcome":"success","itemCount":1}
```

Reading the sample:

- **Line 1** — `get_folders` succeeded in 45ms. Input is `null` because `getFolders()` takes no arguments.
- **Line 2** — `list_mailbox` on `INBOX` returned 25 items. The `itemCount` is present because the method returned an array.
- **Line 3** — `fetch_message` fetched 2 emails successfully. Both items in the result array had no `error` property.
- **Line 4** — `move_emails` had **partial** success: 3 items processed, 1 failed. The tool response contains per-item error details; the audit log records only the aggregate counts.
- **Line 5** — `create_folder` succeeded. No `itemCount` because the result is not an array.
- **Line 6** — `search_mailbox` threw an exception. The `outcome` is `error` with the message captured in the `error` field. The exception was re-thrown after logging.
- **Line 7** — `set_flag` on a single email succeeded.

## Requirements for Future Implementations

### Every public ImapClient method MUST be audited

Add `@Audited('operation_name')` to every new public method on `ImapClient`. The operation name must match the MCP tool name that exposes it (e.g., tool `delete_emails` → `@Audited('delete_emails')`).

This is an enforced project requirement (see `CLAUDE.md`: *"Every public `ImapClient` method must use `@Audited('operation_name')`"*).

### The class must expose `audit: AuditLogger` as a public property

The `@Audited` decorator accesses `this.audit`. If you create a new class that uses `@Audited`, it must have a public `audit` property of type `AuditLogger`. Currently only `ImapClient` uses this decorator.

### Batch methods must return arrays for outcome detection

The automatic `partial` outcome detection relies on the result being a **top-level array** where failed items have an `error` property. If a new batch method wraps results in a container (e.g., `{ items: [...] }`), `wrap()` will classify the outcome as `success` even with partial failures.

To ensure correct outcome classification, return `BatchItemResult<T>[]` directly from the `ImapClient` method. The wrapping in `BatchToolResult` (adding top-level `status`) should happen in the layer above (e.g., `OperationLogInterceptor` or tool handler).

### Sensitive input keys must use standard names

The sanitizer redacts keys matching `/password|secret|token|auth/i`. If a new operation accepts sensitive input, use these key names. Non-standard names like `credentials` or `apiKey` will **not** be redacted.

### Audit writes must never crash the daemon

If you modify `AuditLogger` or add new write paths, maintain the silent-catch pattern. A diagnostic log is never worth crashing the mail server.

### Audit output is file-only

Never write audit entries to stderr or stdout. These channels are reserved for MCP protocol traffic and operational logging. The audit log path is configured separately from the application log.

### Do not log email content or PII

New operations must not log email body content, attachment data, subject lines, or email addresses. The audit log should contain only operation metadata: identifiers (UIDs, mailbox names), timing, and outcome. See [Privacy and Security Considerations](#privacy-and-security-considerations) for the rationale.
