# EDD: `create_label` — create a Proton label

**Issue:** [#17 — M3: create_label — create a Proton label](https://github.com/grover/proton-bridge-mcp/issues/17)
**PRD:** [M3 Folders, Labels & Revert](m3-folders-labels-revert.md)

## Goal

Add a `create_label` MCP tool that creates flat Proton Mail labels (IMAP folders under `Labels/`).

## Approach

Refactor `create_folder`'s IMAP logic into a shared `#createMailbox(path)` helper, then add `create_label` as a thin wrapper. Tracked as noop for reversal (requires `deleteLabel` — existing deferred issue).

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Duplicate `createFolder` body for `createLabel` | Violates DRY — identical IMAP logic with different path prefix |
| Full reversal with `deleteLabel` | Out of scope for this ticket; tracked in separate issue |

## Changes

### Refactoring (no behavioral change)

1. **`src/types/operations.ts`** — Introduce `CreateMailboxResult` base type; `CreateFolderResult` becomes alias
2. **`src/bridge/imap.ts`** — Extract `#createMailbox(path)` private method; `createFolder` delegates
3. **`src/bridge/operation-log-interceptor.ts`** — Parameterize `buildCreateFolderReversal` into `buildCreateMailboxReversal(type)` factory

### New feature

4. **`src/types/operations.ts`** — Add `CreateLabelResult { name, created }` (own interface, not alias — see Deviations)
5. **`src/types/mail-ops.ts`** — Add `createLabel(name)` to `MutatingMailOps`
6. **`src/bridge/imap.ts`** — Add `createLabel(name)` delegating to `#createMailbox`, maps `path` to `name`
7. **`src/bridge/operation-log-interceptor.ts`** — Add `@Tracked('create_label', () => null)` wrapper (noop reversal)
8. **`src/tools/create-label.ts`** — New handler: validates no `/` in name, delegates to `ops.createLabel()`
9. **`src/tools/index.ts`** — Export
10. **`src/server.ts`** — Register with `MUTATING` annotation

## Files Changed

| File | Change |
|---|---|
| `src/types/operations.ts` | `CreateMailboxResult` base, `CreateLabelResult` alias |
| `src/types/mail-ops.ts` | `createLabel` in `MutatingMailOps` |
| `src/bridge/imap.ts` | Extract `#createMailbox`; add `createLabel` |
| `src/bridge/operation-log-interceptor.ts` | Factory reversal builder; `createLabel` noop-tracked |
| `src/tools/create-label.ts` | New: schema + handler |
| `src/tools/index.ts` | Export |
| `src/server.ts` | Register tool |

## What Does NOT Change

- `isAlreadyExistsError` — reused via `#createMailbox`
- `deleteFolder` / `deleteLabel` — out of scope
- `ReversalSpec` — no new variant (noop)
- `#executeReversal` — no new case

## Deviations

Originally `CreateLabelResult` was an alias for `CreateMailboxResult` (returning `path`). Changed during smoke testing to return `name` instead of `path` to prevent LLMs from passing `"Labels/X"` to label tools that expect plain names. `CreateLabelResult` is now its own interface `{ name, created }`. The mapping from `CreateMailboxResult.path` to `name` happens in `ImapClient.createLabel`.

## Edge Cases

| Scenario | Behavior |
|---|---|
| Name contains `/` | `INVALID_NAME` error from handler |
| Label already exists (ALREADYEXISTS) | Fast path: `{ created: false }` |
| Label already exists (bare NO) | LIST fallback: `{ created: false }` |
| Empty name | Zod rejects (min length 1) |

## Idempotency Analysis

- First call: `{ created: true }` + `operationId` (noop reversal)
- Subsequent calls: `{ created: false }` + `operationId` (noop reversal)
- Response shape stable across both cases

## Smoke Test Scenarios

| # | Action | Expected |
|---|--------|----------|
| 1 | `create_label` with `SmokeTest17` | `created: true`, path `Labels/SmokeTest17`, `operationId` present |
| 2 | `create_label` with `SmokeTest17` again | `created: false`, no error |
| 3 | `create_label` with `Nested/Bad` | `INVALID_NAME` error |
| 4 | `get_labels` | New label appears in list |

## Unit Test Plan

### ImapClient.createLabel (`src/bridge/imap-create-label.test.ts`)

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Happy path | `mailboxCreate('Labels/X')` called, returns `{ path, created: true }` |
| 2 | ALREADYEXISTS code | `{ created: false }`, `list` NOT called |
| 3 | Bare NO, LIST confirms | `{ created: false }`, `list` called |
| 4 | Bare NO, not found | Original error rethrown |
| 5 | Connection released | `pool.release` called always |

### handleCreateLabel (`src/tools/create-label.test.ts`)

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Valid name | Delegates to `ops.createLabel(name)` |
| 2 | Name with `/` | Throws `INVALID_NAME` |

### Interceptor (`src/bridge/operation-log-interceptor.test.ts`)

| # | Scenario | Expected |
|---|----------|----------|
| 1 | createLabel delegates + operationId | `imap.createLabel` called, result has `operationId` |
| 2 | Noop reversal recorded | Log has noop entry |
