# IMAP Error Handling & Resilience

This document covers IMAP error handling strategies, Proton Bridge-specific behaviors, UID stability concerns, connection resilience, and how errors are surfaced for LLM consumption. For IMAP implementation patterns (batching, locking, EmailId format), see `docs/IMAP.md`. For connection pool internals, see `docs/impl/connection-pool.md`.

## IMAP Error Landscape

IMAP errors fall into four categories, each handled differently:

| Category | Examples | imapflow Surface | Handling Strategy |
|----------|----------|-----------------|-------------------|
| **Connection-level** | Auth failure, TLS handshake, timeout, socket close | Exception on `connect()` or mid-operation | Fail fast, propagate to caller |
| **Protocol-level** | `NO` / `BAD` server responses | Exception with `serverResponseCode`, `responseText`, `response` properties | Inspect response code, fall back to text matching |
| **Mailbox-level** | Missing mailbox, lock contention | Exception during `getMailboxLock()` or mailbox operation | Fail fast for the affected mailbox group |
| **Per-message** | UID not found, flag operation rejected | Exception during per-UID operation | Catch per-item, record in `BatchItemResult` |

imapflow surfaces IMAP errors as JavaScript exceptions with these properties:

- `serverResponseCode` — RFC 5530 response code (e.g., `'ALREADYEXISTS'`, `'NONEXISTENT'`), when the server provides one
- `responseText` — human-readable server response text
- `response` — raw response line (fallback)

**Important:** Not all servers populate `serverResponseCode` reliably. See [Proton Bridge Specifics](#proton-bridge-specifics) below.

## Proton Bridge Specifics

Proton Bridge uses **[ProtonMail/gluon](https://github.com/ProtonMail/gluon)** as its embedded IMAP server library. Most protocol-level quirks originate in gluon, not in proton-bridge itself. This section documents known behavioral differences from standard IMAP and their workarounds.

### Missing COPYUID in MOVE/COPY Responses

**Standard behavior:** [RFC 4315](https://datatracker.ietf.org/doc/html/rfc4315) (UIDPLUS) requires servers that advertise the capability to return a `COPYUID` response code on COPY and MOVE operations, providing the UID mapping between source and destination.

**Proton Bridge behavior:** Gluon advertises `UIDPLUS` but conditionally omits `COPYUID` when `destUIDs` is empty.

**Upstream source:** In [`gluon/internal/state/mailbox.go`](https://github.com/ProtonMail/gluon/blob/dev/internal/state/mailbox.go), both the `Copy` and `Move` methods only produce a `response.ItemCopyUID(...)` when `len(destUIDs) > 0`. When empty, `res` stays `nil`. The session handlers ([`handle_copy.go`](https://github.com/ProtonMail/gluon/blob/dev/internal/session/handle_copy.go), [`handle_move.go`](https://github.com/ProtonMail/gluon/blob/dev/internal/session/handle_move.go)) skip the item when nil, so the OK response is sent without a COPYUID code.

**Related issue:** [ProtonMail/proton-bridge#170](https://github.com/ProtonMail/proton-bridge/issues/170) documents client-side failures caused by missing UIDPLUS response codes.

**Our workaround** (`src/bridge/imap.ts:267-268`, `:352`):

```typescript
const moved = await conn.messageMove(String(id.uid), targetMailbox, { uid: true });
// moved is CopyResponseObject | false; false means no COPYUID response
const targetUid = moved !== false ? moved.uidMap?.get(id.uid) : undefined;
```

**Impact:** `targetId` in `MoveResult` and `newId` in `AddLabelsItemData` can be `undefined`. All consumers must handle the missing-UID case. This also affects operation reversal — without a `targetId`, the reversal spec cannot reliably reference the moved message.

### Non-standard ALREADYEXISTS Error Responses

**Standard behavior:** [RFC 5530](https://datatracker.ietf.org/doc/html/rfc5530) defines the `[ALREADYEXISTS]` response code for mailbox creation conflicts. A compliant response looks like: `tag NO [ALREADYEXISTS] Mailbox already exists`.

**Proton Bridge behavior:** Gluon sends a bare `NO` response without the response code: `tag NO a mailbox with that name already exists`.

**Upstream source:** Gluon defines `ErrExistingMailbox = errors.New("a mailbox with that name already exists")` in [`gluon/internal/state/errors.go`](https://github.com/ProtonMail/gluon/blob/dev/internal/state/errors.go). The `Create` method in [`state.go`](https://github.com/ProtonMail/gluon/blob/dev/internal/state/state.go) returns this error when the mailbox exists. The generic error handler in [`handle.go`](https://github.com/ProtonMail/gluon/blob/dev/internal/session/handle.go) converts it to a bare NO response without attaching the RFC 5530 code. The string `ALREADYEXISTS` does not appear anywhere in the gluon codebase.

**Related issue:** [ProtonMail/proton-bridge#337](https://github.com/ProtonMail/proton-bridge/issues/337) discusses mailbox name constraint failures.

**Our workaround** (`src/bridge/errors.ts`):

```typescript
export function isAlreadyExistsError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { serverResponseCode?: string; responseText?: string; response?: string };
  // Check RFC 5530 response code first (for spec-compliant servers)
  if (e.serverResponseCode === 'ALREADYEXISTS') return true;
  // Fall back to text matching for Proton Bridge bare NO responses
  const text = e.responseText || e.response || '';
  return /already.?exists|mailbox exists/i.test(text);
}
```

**Impact:** Any new error detection function for specific IMAP errors must include a text-matching fallback alongside `serverResponseCode` checks.

### Local TLS Configuration

Proton Bridge runs as a local daemon on `127.0.0.1`. Unlike remote IMAP servers, the connection uses `secure: false` with custom TLS options (`src/bridge/pool.ts:298`). This means connection errors differ from typical remote IMAP — expect localhost-specific failures (port not open, Bridge not running) rather than DNS/TLS certificate chain issues.

### imapflow/mailparser Type Quirks

These are library-level gotchas, not Proton-specific, but relevant to this integration:

- `conn.mailbox` is `false | MailboxObject` (not `null`/`undefined`) — guard with `conn.mailbox !== false`
- `ParsedMail.html` is `string | false` — use `|| undefined`, not `?? undefined` (nullish coalescing doesn't catch `false`)

### Discovering Future Quirks

When encountering unexpected IMAP behavior:

1. **Check gluon source first** — search for the IMAP command handler in [`ProtonMail/gluon`](https://github.com/ProtonMail/gluon) (e.g., `handle_copy.go` for COPY behavior)
2. **Cross-reference with the relevant RFC** to confirm whether it's a spec violation or optional behavior
3. **Search the proton-bridge issue tracker** at [`ProtonMail/proton-bridge/issues`](https://github.com/ProtonMail/proton-bridge/issues) for user reports
4. **Check this project's audit log** (`PROTONMAIL_AUDIT_LOG_PATH`) — grep for `"outcome":"error"` to find real-world error patterns
5. **Review imapflow behavior** at [`postalsys/imapflow`](https://github.com/postalsys/imapflow) for how protocol deviations are surfaced to Node.js

**Key RFCs:**

| RFC | Topic | Why It Matters |
|-----|-------|---------------|
| [RFC 3501](https://datatracker.ietf.org/doc/html/rfc3501) | IMAP4rev1 base spec | Baseline expected behavior |
| [RFC 4315](https://datatracker.ietf.org/doc/html/rfc4315) | UIDPLUS (COPYUID/APPENDUID) | Missing COPYUID workaround |
| [RFC 5530](https://datatracker.ietf.org/doc/html/rfc5530) | IMAP Response Codes | Non-standard error responses |
| [RFC 6851](https://datatracker.ietf.org/doc/html/rfc6851) | MOVE extension | Move semantics and UID handling |

## Error Handling Strategies

### Per-Item Error Isolation in Batch Operations

Batch operations (move, flag, label) catch errors per-item inside the processing loop. A single failure never aborts the entire batch.

Pattern used throughout `src/bridge/imap.ts`:

```typescript
// Initialize all results as failed
const results: Array<BatchItemResult<T>> = ids.map(id => ({ id, status: 'failed' as const }));

for (const { index, id } of entries) {
  try {
    // IMAP operation
    results[index] = { id, status: 'succeeded', data: { ... } };
  } catch (err) {
    results[index] = {
      id,
      status: 'failed',
      error: { code: 'MOVE_FAILED', message: err instanceof Error ? err.message : String(err) },
    };
  }
}
```

Key properties:
- Results are initialized as `failed` and upgraded to `succeeded` on success (safe default)
- Error codes are semantic: `MOVE_FAILED`, `FLAG_FAILED`, `COPY_FAILED`
- The `index` from `groupByMailbox` ensures result[i] always corresponds to input[i]

### Error-to-Data Conversion

Some IMAP errors represent expected domain conditions, not failures. These are caught and converted to normal return values:

- `isAlreadyExistsError` → `{ created: false }` (folder already exists is not a failure)

This keeps the error boundary clean: exceptions mean unexpected failures; expected conditions return data.

### Fail-Fast for Top-Level Errors

Connection and authentication failures are not caught at the per-item level. They propagate immediately as exceptions, becoming tool-level errors. This is intentional — if the connection is broken, per-item processing is pointless.

### No Retry Logic (Deliberate)

The codebase does **not** implement retry loops, exponential backoff, or circuit breakers. This is a deliberate design choice:

- The LLM has context about the user's intent and can make better retry decisions than blind retries
- Permanent failures (auth, missing mailbox) would waste time in retry loops
- Transient failures (connection hiccup) are better handled by the LLM calling `drain_connections` then retrying the operation

### Safe Logout Suppression

Throughout the pool and connection handling code:

```typescript
conn.logout().catch(() => {});
```

Logout failures are universally suppressed. A failed logout means the connection is already broken — there is nothing useful to do with the error.

### Unknown Error Coercion

All error message extraction uses the same pattern:

```typescript
err instanceof Error ? err.message : String(err)
```

This handles both proper `Error` objects and bare strings/objects thrown by imapflow or its dependencies.

## Connection Resilience

For detailed pool internals, see `docs/impl/connection-pool.md`. This section covers resilience-specific behavior.

### Stale Connection Detection

The pool uses version-based tracking. Each connection is stamped with the pool version at creation time. When `drain()` is called, the pool version increments. Connections with an older version are closed on release instead of returning to the pool.

This prevents stale connections (e.g., from before a Bridge restart) from silently failing operations.

### Idle Connection Recovery

Two idle thresholds manage connection lifecycle:

- **`idleDrainSecs`** (default 30s): drains available connections to the minimum pool size
- **`idleTimeoutSecs`** (default 300s): drains all connections to zero, increments pool version

This ensures connections don't accumulate during idle periods and that stale connections from long idle windows are discarded.

### Error Listener Auto-Recovery

Each connection registers `conn.on('error', ...)`. When triggered:

1. The connection is removed from the pool (available or in-use)
2. `replenish()` is called to maintain minimum pool size

This handles mid-operation connection drops without manual intervention.

### Explicit Recovery Tools

Two MCP tools support manual recovery:

- **`drain_connections`**: Forces a full pool drain (increments version, closes all connections). Use after Bridge restart or persistent connection errors.
- **`verify_connectivity`**: Creates a throwaway connection, sends NOOP, closes it. Returns latency or error. Does not affect pool state.

## UID Stability

### UIDs Are Per-Mailbox

IMAP UIDs are unique within a single mailbox, not globally. The `EmailId` type always carries both `uid` and `mailbox` to form a complete reference:

```typescript
interface EmailId { uid: number; mailbox: string; }
```

The string format `"Mailbox:UID"` (e.g., `"INBOX:42"`) is parsed by splitting on the **last** colon, handling mailbox names that contain colons (e.g., `"Folders/My:Project:123"` → `{ uid: 123, mailbox: "Folders/My:Project" }`).

### When UIDs Change

| Event | Effect | Mitigation |
|-------|--------|------------|
| **MOVE** | Email gets a new UID in the target mailbox; source UID is invalidated | Return `targetId` when available (but see COPYUID caveat) |
| **EXPUNGE** | UIDs of subsequent messages may shift | Do not cache UIDs across operations |
| **UIDValidity change** | All UIDs in the mailbox are invalidated | Rare; indicates server-side mailbox rebuild |

### Missing COPYUID and UID Tracking

Because Proton Bridge often omits COPYUID responses (see above), `targetId` after a move is frequently `undefined`. This means:

- Cross-mailbox identity cannot be reliably tracked after move operations
- Operation reversal specs store both source and target EmailIds, but missing `targetId` may prevent reversal
- Consumers must never assume `targetId` is present — always check before using

## Error Reporting for LLM Consumption

### Why Errors Are Data, Not Protocol Faults

IMAP errors are surfaced as structured data within tool results, not as MCP protocol-level error responses. This is a deliberate choice for LLM optimization:

- **Partial success is meaningful**: A batch move where 3/5 emails succeeded gives the LLM enough information to report partial results, retry failed items, or escalate — none of which is possible with a binary success/fail protocol error.
- **Semantic error codes** (`MOVE_FAILED`, `FLAG_FAILED`, `COPY_FAILED`) let the LLM categorize failures and decide next steps without parsing error messages.
- **Input-order preservation** (result[i] corresponds to input[i]) enables positional correlation — the LLM knows exactly which items failed.

The full MCP tool result type system (`BatchToolResult`, `ListToolResult`, `SingleToolResult`, `batchStatus()`) will be documented separately in `docs/impl/mcp-tool-interfaces.md`.

## Checklist for New IMAP Operations

When adding new IMAP operations, apply these error handling rules:

- [ ] **Handle missing COPYUID**: Any operation using `messageMove()` or `messageCopy()` must treat the return as `CopyResponseObject | false` — make `targetId`/`newId` optional in result types
- [ ] **Handle non-standard error responses**: If detecting specific IMAP errors (like ALREADYEXISTS), include a text-matching fallback alongside `serverResponseCode` checks — follow the `isAlreadyExistsError()` pattern
- [ ] **Isolate per-item errors**: In batch operations, catch errors per-item inside the loop. Never let one failure abort the batch. Initialize results as `failed`, upgrade to `succeeded` on success.
- [ ] **UID stability awareness**: After any operation that moves/copies emails, the source UID is invalidated. Do not cache or reuse UIDs across operations that mutate mailbox state.
- [ ] **Test with Proton Bridge**: Proton Bridge is the only supported IMAP backend. Always verify behavior against it, not just RFC expectations.

## Design Rationale

| Decision | Rationale |
|----------|-----------|
| No retries | LLM has user context; retrying blindly wastes time on permanent failures |
| Batch input-order preservation | LLMs correlate input[i] with result[i] positionally |
| Errors as structured data | Enables LLM to report partial success, retry specific items, or escalate |
| Safe cleanup in finally blocks | Connection/lock leaks are worse than swallowed logout errors |
| Per-item error isolation | Maximizes successful operations; LLM decides what to do with failures |
| No circuit breakers | `drain_connections` + `verify_connectivity` give the LLM explicit recovery tools |
