# Project

You work on proton-bridge-mcp - An MCP server bridging ProtonMail via the local Proton Bridge IMAP daemon.

Consult `README.md` for user facing project details

## Requirements

- Project is a background daemon
- Good logging in code necessary for diagnostics
- Every public `ImapClient` method must use `@Audited('operation_name')` — see `ARCHITECTURE.md` "decorators.ts" for mechanics.

### Operation modes
- **STDIO (default):** no flags needed; `src/stdio.ts` connects one `McpServer` to `StdioServerTransport`
- **HTTP:** `--http`; each session gets its own `McpServer` instance (created in `createHttpApp`)
- **HTTPS:** `--https`; same as HTTP but with TLS; auto-generates self-signed cert if no cert/key provided
- Transport mode is CLI-flag only — no env var (`PROTONMAIL_HTTPS` removed)
- `ImapClient` and `ImapConnectionPool` are shared singletons across all modes


### Standardized Tool Result Structure
- All tool responses include a top-level `status: ToolStatus` (`'succeeded' | 'partial' | 'failed'`).
  - **Batch tools:** `BatchToolResult<T>` — `{ status, items: BatchItemResult<T>[] }` with per-item `status: ItemStatus`
  - **List tools:** `ListToolResult<T>` — `{ status: 'succeeded', items: T[] }` (throw on failure)
  - **Single tools:** `SingleToolResult<T>` — `{ status, data: T }`
  - Use `batchStatus(items)` utility to compute top-level status from per-item results.

### Choosing a Result Type
- **BatchToolResult<T>**: Operations on `EmailId[]` where individual items can fail independently (move, mark, add_labels)
- **ListToolResult<T>**: Read operations returning collections that either fully succeed or throw (list_mailbox, get_folders, fetch_summaries, search_mailbox)
- **SingleToolResult<T>**: Operations on a single entity or returning a single result (fetch_attachment, verify_connectivity, drain_connections, create_folder)

### Tool Annotations
- All tools must declare `annotations` with `readOnlyHint` and `destructiveHint` booleans.
- Three annotation presets defined in `src/server.ts`: `READ_ONLY`, `MUTATING`, `DESTRUCTIVE`.
- See `docs/tools/README.md` for per-tool annotation values.

### Tool Categories
Tools belong to one of four categories (used by `--disabled-tools` and for annotation selection):

| Category | Annotation | Tools |
|---|---|---|
| **read** | `READ_ONLY` | `get_folders`, `get_labels`, `list_mailbox`, `fetch_summaries`, `fetch_message`, `fetch_attachment`, `search_mailbox` |
| **mutating** | `MUTATING` | `create_folder`, `mark_read`, `mark_unread`, `add_labels` |
| **destructive** | `DESTRUCTIVE` | `move_emails` |
| **maintenance** | `READ_ONLY` | `verify_connectivity`, `drain_connections` |

- **Maintenance** tools are idempotent, non-destructive operations on the IMAP connection pool — they do not affect the Proton Mail inbox. See `src/tools/verify-connectivity.ts` and `src/tools/drain-connections.ts`.
- When adding a new tool, assign it to the appropriate category and update `TOOL_CATEGORIES` in the source.


# Conventions
- **Autonomous execution:** Don't ask confirmation for routine ops (file edits, git, build, lint, start/stop servers)
- **Pre-commit:** rebase -> npm install -> lint -> build -> npm ci
- **Smoke test setup:** Start MCP server + inspector fully configured from .env; don't make user do manual setup
- **Smoke test failures:** Capture in GitHub issue acceptance criteria; repeat all prior failures when re-testing
- **Numbered workflows:** Are enforceable and cannot skip
- **Auto-update rule:** After each major code changes, new patterns, or learnings, update `CLAUDE.md`, `ARCHITECTURE.md`, or other documentation file.
- **PRD commits:** When committing a PRD, always update `docs/ROADMAP.md` in the same commit.
- **App logger** (`src/logger.ts`): pino → stderr (default) or `PROTONMAIL_LOG_PATH`
- **Audit logger** (`src/bridge/audit.ts`): JSONL → `PROTONMAIL_AUDIT_LOG_PATH` (file only, **never stderr**)
- stderr is reserved for operational/MCP/Fastify output

# Orchestrator Workflow

When working a ticket, you cycle through these personas as the orchestrator:

1. Responsible for project success
2. Actively seeks parallelization opportunity and possibly **delegate** to an agent
3. Receives a ticket to work on from **User**
4. Creates branch per policy
5. Spins up EDD workflow
6. Commits EDD, pushes branch
7. Spins up ticket workflow
8. **User smoke tests** - **Orchestrator** show what they're testing, test cases, previously failed tests in status dashboard
9. **Orchestrator** commits, pushes, creates PR
10. Ensures learnings are written to `CLAUDE.md`, `ARCHITECTURE.md` and `CHANGELOG.md` other files
11. User requests refactorings / bug fixes / changes at this stage: Create a ticket and start working on that

## Quality engineer (QE) persona
- Defines smoke tests with numbered scenarios (input, expected output, what it validates)
- Defines regression tests, updates GitHub issue description
- Reviews EDD for testability, enhances with unit test plan
- Writes unit tests against skeleton

## Software engineer (SWE) persona
- Implements code per EDD following Uncle Bob clean code
- Small, named, self-explanatory functions; public-first ordering; small focused commits
- Red-green-refactor cycle per unit test
- Acts on GitHub PR review comments -- fix, review, push without waiting for user

## Reviewer persona
- Strict code review -- iterates until clean, does not let marginal issues slide
- Reports findings as MUST FIX / SHOULD FIX / NITPICK
- Review checklist (all mandatory):
  - Clean code (Uncle Bob): SRP, DRY, meaningful names, no dead code, early returns
  - SOLID violations -> MUST FIX
  - Code smells -> SHOULD FIX
  - TOCTOU race conditions -- don't pre-validate mutable external state
  - Connection reuse -- single acquire, do all work, release once
  - Reusable type extraction -- shared types not inline/duplicated
  - Algorithm correctness and efficiency
  - Import hygiene (`.js` extensions for ESM)
  - Documentation accuracy (CLAUDE.md, ARCHITECTURE.md, CHANGELOG.md)
  - Security (OWASP)
- Detects
  - Long functions (>50 lines)
  - Large files (>500 lines)
  - God classes (>20 methods)
  - Deep nesting (>4 levels)
  - Too many parameters (>5)
  - High cyclomatic complexity (>7 branches)
  - Missing or wrong error handling
  - Unused imports
  - Magic numbers


# Branching policy

- Branch names are structured: `{type}/{issue#}-{title}`.
- Branch type is bug | feat | refactor -> analyze issue description to determine type
- Repository uses GitHub flow
- New branches always taken from latest `main` branch

## Concurrent agent safety

Assume another agent is working in the same repository at all times.

### Workstream isolation
- Use `isolation: "worktree"` when delegating to sub-agents — each gets its own git worktree with an isolated copy of the repo, preventing file conflicts with the main working directory and other agents.
- Each agent works on **its own branch** — never push to another agent's branch.
- Coordinate only via `main` — rebase from `origin/main`, never from another feature branch.
- If you encounter unexpected commits or changes on a branch, investigate before overwriting — it may be another agent's work.

### Git discipline
1. **Fetch before every branch operation** — `git fetch origin` before creating, switching, rebasing, or pushing branches. Never trust local refs; always use `origin/main`, not `main`.
2. **`--force-with-lease` only** — never `--force`. Lease rejects the push if the remote moved since your last fetch.
3. **Commit or stash before switching branches** — uncommitted changes carry across checkouts and can silently land on the wrong branch.
4. **Verify branch state after checkout** — `git log --oneline -3` to confirm HEAD is where you expect.
5. **Keep branches short-lived and narrowly scoped** — reduces collision surface with other agents.
6. **Don't rewrite history on shared branches without fetching first** — another agent may have pushed since your last fetch.

# Document naming in `docs/plans/`

- **PRDs:** `prd-{milestone}-{feature}.md` — product requirement documents scoped to a milestone (e.g. `prd-m4-disabled-tools.md`)
- **EDDs:** `edd-{issue#}-{title}.md` — engineering design documents tied to a GitHub issue (e.g. `edd-35-email-id-refactor.md`)

# EDD workflow

1. As a **QE**, you define smoke tests + regression tests, updates GitHub issue
2. As a **SWE**, you write an EDD in `docs/plans/edd-{issue#}-{title}.md`
3. As a **QE**, you review EDD, enhances with unit test plan
4. As a **Reviewer**, you reviews EDD
5. Loop steps 2-4 until EDD is ready for user review
6. **User approves EDD**


# Ticket workflow

1. As a **SWE**, you implement empty skeleton (no functionality)
2. As a **QE**, you implement unit tests per EDD against skeleton
3. As a **QE**, you verify that all new tests fail
4. As a **SWE**, you review tests, then red-green-refactor cycle:
  4.1. Execute test to prove it fails (red)
  4.2. Implement code until test pass (green)
  4.3. Refactor while maintaining green for all prior green tests
5. As a **Reviewer**, you review generated code (strict, iterate between 4 and 5 until all findings are resolved)


# Test methodologies

- Project relies heavily on unit & smoke testing
- Each feature defines smoke tests to ensure it works
- Test runner: **Jest** (not vitest) with `ts-jest` ESM preset
- Config: `jest.config.ts` (ESM preset + `.js` extension mapper), `tsconfig.test.json` (adds `"types": ["jest"]`), ESLint has a separate block for `*.test.ts` pointing at `tsconfig.test.json`
- Run: `npm test` → `node --experimental-vm-modules node_modules/.bin/jest`

# Engineering principles

- Apply TDD
- Clean code (Uncle Bob): SRP, DRY, meaningful names, no dead code, early returns, small functions, readable file structure
- Accurate minimal code documentation
- Fail fast: Write code with fail-fast logic by default. Do not swallow exceptions with errors or warnings
- No fallback logic: Do not add fallback logic unless explicitly told to and agreed with the user
- No guessing: Do not say "The issue is..." before you actually know what the issue is. Investigate first.

## Pre-commit Checklist

Before every commit:
1. `git fetch origin && git rebase origin/main` — keep the branch current before committing
2. `npm install` — regenerate `package-lock.json` if `package.json` changed; always run to ensure lockfile is in sync
3. `npm run lint` — must pass with zero errors
4. `npm run build` — must compile clean
5. `npm ci` — verify the lockfile is in sync (catches the case where `package.json` was edited without running `npm install`)

CI runs `npm ci`, which fails if `package-lock.json` is out of sync with `package.json`.

## Build & Run

```bash
npm install
npm run build          # compile TypeScript → dist/
npm run dev            # tsx watch (no compile, restarts on change)
npm run lint           # ESLint with type-aware parsing
npm test               # Jest with ts-jest (ESM)

node dist/index.js --verify          # test IMAP connectivity then exit
node dist/index.js \                 # STDIO mode (default) — minimum required args
  --bridge-username your@protonmail.com \
  --bridge-password bridge-generated-password

node dist/index.js --http \          # HTTP mode — requires auth token
  --bridge-username your@protonmail.com \
  --bridge-password bridge-generated-password \
  --mcp-auth-token your-secret-token

npm run smoketest              # build + start HTTP server + Inspector (verified startup, opens browser after 10s)
npm run inspector              # build + start HTTP server + Inspector (lightweight, immediate browser open)
npm run package                # build + create proton-bridge-mcp.mcpb for Claude Desktop
```

### Smoke Testing

Smoke tests are always started using `npm run smoketest`. The script:
1. Builds the project
2. Loads `.env` credentials (uses stable `PROTONMAIL_MCP_AUTH_TOKEN` from `.env` if set, otherwise generates one)
3. Starts the MCP server in **HTTP mode** (`--http`)
4. **Verifies** the MCP server is listening on its port (fails with error if not)
5. Starts the MCP Inspector proxy
6. **Verifies** the Inspector proxy is listening (fails with error if not)
7. **Verifies** the Inspector UI is responding
8. Reports all **processes, PIDs, ports, and tokens** in a summary box
9. Opens the browser after **10 seconds** (gives everything time to settle)

When performing smoke tests, show the **User** the test scenarios to execute, expected outcomes, and any previously failed tests.

**First-time setup only:** Add an `Authorization` header in the Inspector sidebar and paste the Bearer token shown in the summary box. The Inspector persists this in `localStorage` — subsequent restarts reuse the same `.env` token if set.

**Debugging during smoke tests:** Use the "Debug MCP Smoke Test" launch config in VS Code. It launches the MCP server under the debugger with the Inspector as a pre-launch task, so you can set breakpoints in tool handlers while exercising them through the Inspector UI.

## CI & Release

### CI (`.github/workflows/ci.yml`)
Runs on every PR and push to `main`. Three parallel jobs: **Lint**, **Build**, **Test**.
- `Lint` and `Build` jobs are non-trivial (type-aware ESLint = tsc runs inside eslint)
- `Test` runs Jest via `npm test` (ESM mode with `--experimental-vm-modules`)
- `Build` uploads `dist/` as an artifact (SHA-keyed, 7-day retention)
- Concurrency: cancels in-progress PR runs on new push; `main` pushes never cancel each other

Required status checks to configure in GitHub branch protection: **Lint**, **Build**, **Test** (exact `name:` values).

### Release (`.release-it.json` + `.github/workflows/release.yml`)
1. Populate `[Unreleased]` in `CHANGELOG.md` (existing habit)
2. Run `npx release-it` locally — prompts for bump type, then:
   - Runs `lint` + `build` (pre-flight guard)
   - Moves `[Unreleased]` → `[x.y.z]` in `CHANGELOG.md`
   - Bumps `package.json` version
   - Commits `chore: release vX.Y.Z` and pushes tag
3. `release.yml` fires on the tag → builds → creates GitHub Release with:
   - `proton-bridge-mcp.mcpb` — Claude Desktop package
   - `proton-bridge-mcp-X.Y.Z-source.tar.gz` — source archive (excludes `node_modules`, `.git`, `dist`)
   - Changelog section extracted via `awk`
4. Same workflow publishes to npm (`npm publish --access public`)

`github.release: false` in `.release-it.json` — GitHub Release is always created by CI, never from a local machine.
npm publish is enabled (`"publish": true`); requires `NPM` secret in GitHub repo settings.
`package.json` `files` field limits the npm tarball to `dist/`, `manifest.json`, `CHANGELOG.md`, and `LICENSE`.

# Node, TypeScript, libraries...

## Version pinning
- TypeScript 6
- `.nvmrc`: `25.9.0` — nvm/mise/asdf local dev
- `package.json` `volta.node`: `25.9.0` — Volta local dev
- `env.NODE_VERSION` in each workflow file — single source per file

## NodeNext ESM Import Rule
All local imports MUST use `.js` extension:
```typescript
import { ImapClient } from './bridge/imap.js';  // ✓
import { ImapClient } from './bridge/imap';      // ✗ fails at runtime
```

## Zod `.transform()` in MCP Tool Schemas
The MCP SDK supports Zod `.transform()` in `inputSchema`. The JSON Schema converter uses `pipeStrategy: 'input'`, so clients see the **input** type (e.g. `string`) while handlers receive the **transformed** output (e.g. `EmailId`). Use this for tool input parsing — e.g. `z.string().transform(parseEmailId)`.

## Technical References
- **IMAP patterns (locking, batching, groupByMailbox, EmailId):** `docs/IMAP.md`
- **Type hierarchy:** `ARCHITECTURE.md` "Type Hierarchy"
- **Tool schemas, annotations, examples:** `docs/tools/README.md`
- **Config precedence & all settings:** `README.md` "Configuration Reference"
