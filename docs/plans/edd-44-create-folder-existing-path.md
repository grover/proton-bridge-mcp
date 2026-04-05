# EDD: `create_folder` throws "Command failed" on existing path

**Issue:** [#44 — bug: create_folder throws 'Command failed' on existing path](https://github.com/grover/proton-bridge-mcp/issues/44)

## Goal

When `create_folder` is called with a path that already exists, return `{ status: 'succeeded', data: { path, created: false }, operationId }` instead of throwing "Command failed".

## Approach

Add a LIST fallback in the `ImapClient.createFolder` catch block. When `isAlreadyExistsError` fails to recognize the error (Proton Bridge sends a bare IMAP NO without RFC 5530 `ALREADYEXISTS` code), verify by listing mailboxes. If the target path exists, it was an "already exists" error.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Widen regex in `isAlreadyExistsError` | Don't know exact Proton Bridge error text; fragile across versions |
| Pre-check with LIST before CREATE | TOCTOU race; penalizes happy path with extra round-trip |
| STATUS check for specific mailbox | imapflow's `status()` falls back to LIST internally anyway; ambiguous return on error |

## Changes

### `src/bridge/imap.ts` — `createFolder` catch block (lines 78–82)

**Before:**
```typescript
} catch (err: unknown) {
  if (isAlreadyExistsError(err)) {
    return { path, created: false };
  }
  throw err;
}
```

**After:**
```typescript
} catch (err: unknown) {
  if (isAlreadyExistsError(err)) {
    return { path, created: false };
  }
  // Proton Bridge sends bare NO without ALREADYEXISTS code.
  // Verify by checking if the mailbox exists on the server.
  const mailboxes = await conn.list();
  if (mailboxes.some(mb => mb.path === path)) {
    return { path, created: false };
  }
  throw err;
}
```

- `isAlreadyExistsError` stays as fast path (avoids LIST round-trip for recognizable errors)
- Reuses the already-acquired `conn` — no extra pool acquisition
- If `conn.list()` itself fails, the error propagates (fail-fast)
- `finally` block still releases the connection

### No other production files change

`src/bridge/errors.ts`, `src/tools/create-folder.ts`, `src/bridge/operation-log-interceptor.ts` — unchanged.

## Files Changed

| File | Change |
|---|---|
| `src/bridge/imap.ts` | Add LIST fallback in `createFolder` catch block |
| `src/bridge/__tests__/imap-create-folder.test.ts` | New: unit tests for `createFolder` LIST fallback |

## What Does NOT Change

- `isAlreadyExistsError` function — kept as fast path
- `OperationLogInterceptor.createFolder` — delegates unchanged
- `handleCreateFolder` tool handler — validates path, delegates unchanged
- Other `ImapClient` methods

## Edge Cases

| Scenario | Behavior |
|---|---|
| Server returns RFC 5530 ALREADYEXISTS | Fast path: `isAlreadyExistsError` catches it, no LIST needed |
| Server returns bare NO, mailbox exists | LIST fallback confirms existence, returns `{ created: false }` |
| Server returns bare NO, mailbox doesn't exist | LIST fallback finds nothing, rethrows original error |
| LIST call fails (connection dropped) | LIST error propagates (fail-fast) |
| Race: mailbox created between CREATE and LIST | Returns `{ created: false }` — correct, mailbox exists |

## Idempotency Analysis

`create_folder` with an existing path is the idempotent case. After this fix:
- First call: `{ created: true }` + `operationId`
- Subsequent calls: `{ created: false }` + `operationId` (noop reversal)
- Response shape is stable across both cases

## Smoke Test Scenarios

1. **Create new folder:** `create_folder` with `Folders/SmokeTest44` — returns `created: true`
2. **Create existing folder (the bug):** `create_folder` with `Folders/SmokeTest44` again — returns `created: false`, no error
3. **Invalid path:** `create_folder` with `BadPrefix/Folder` — throws `INVALID_PATH`

## Unit Test Plan

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Happy path — mailbox created | `mailboxCreate` resolves `{ path, created: true }` | Returns `{ path, created: true }`. `list` NOT called |
| 2 | Fast path — ALREADYEXISTS code | `mailboxCreate` rejects with `{ serverResponseCode: 'ALREADYEXISTS' }` | Returns `{ path, created: false }`. `list` NOT called |
| 3 | Fast path — matching error text | `mailboxCreate` rejects with `{ response: 'mailbox already exists' }` | Returns `{ path, created: false }`. `list` NOT called |
| 4 | Bug fix — bare NO, mailbox exists | `mailboxCreate` rejects plain `Error('Command failed')`. `list` returns array with target path | Returns `{ path, created: false }` |
| 5 | Bare NO, mailbox NOT exist | `mailboxCreate` rejects. `list` returns array without target | Original error rethrown |
| 6 | LIST itself fails | `mailboxCreate` rejects. `list` rejects | LIST error propagates |
| 7 | Connection always released | All error scenarios | `pool.release(conn)` called |
