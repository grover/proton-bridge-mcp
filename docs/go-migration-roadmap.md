# Go Migration Roadmap for `proton-mail-mcp`

> This document is a roadmap for migrating the proton-bridge-mcp TypeScript project to a new Go project called `proton-mail-mcp`. It is **written for Claude as the executor** in the new repo. Read it cold, follow the phases in order, verify each phase before moving to the next.

## Reference repos

You will reference two existing repositories throughout this work:

- **`~/Projects/proton-bridge-mcp`** — the TypeScript implementation being replaced. Use it as a reference for tool semantics, design decisions, test scenarios, and documentation patterns. Do not copy code; copy concepts.
- **`~/Projects/proton-bridge`** — Proton's official Bridge, written in Go. It is the canonical example of how to use `go-proton-api` correctly. When in doubt about Go patterns or API usage, look here first.

## Background reading (do this before Phase 0)

Read these files in `~/Projects/proton-bridge-mcp` before starting. They contain context that this roadmap assumes you understand:

1. [docs/proton/authentication-flows.md](proton/authentication-flows.md) — how Proton authenticates, what go-proton-api handles for you, and the TOTP/CAPTCHA discussion. The "Porting Evaluation" section explains why this migration is happening.
2. [docs/proton/bridge-label-implementation.md](proton/bridge-label-implementation.md) — how Proton Bridge virtualizes labels as IMAP folders. This is the complexity the new server escapes by going direct to the API.
3. [docs/impl/label-handling.md](impl/label-handling.md) — the rule that no virtualized path may leak into tool responses. Still applies in Go, but easier to honor because labels are native.
4. [docs/impl/operation-log-revert.md](impl/operation-log-revert.md) — the operation log + revert design. You will reimplement this in Go in Phase 5.
5. [docs/impl/mcp-tool-interfaces.md](impl/mcp-tool-interfaces.md) — tool result types (`SingleToolResult`, `BatchToolResult`, `ListToolResult`). Translate these to Go structs.

## What this migration achieves

The current TypeScript MCP server talks to ProtonMail through the Bridge IMAP daemon. This forces the server to deal with IMAP's virtualization of labels-as-folders, COPYUID resolution for label copies, Message-ID searches to find virtualized copies, UID rewriting during revert, and a connection pool. About a thousand lines of code exist solely to manage IMAP and undo its virtualization.

The Go version eliminates IMAP entirely. It uses `go-proton-api` directly — the same library that Bridge uses internally. Labels become native label IDs. UIDs become stable MessageIDs. The connection pool disappears. The label devirtualization layer disappears. Authentication is handled by go-proton-api in a single function call.

The end state is a single static Go binary that depends on no external runtime, talks directly to Proton's API, and exposes the same MCP tool surface as the TypeScript version (with two intentional changes documented below).

## Recommendation: new repo, not fork

Create a new GitHub repo named `proton-mail-mcp`. Do not fork `proton-bridge-mcp`. Reasons:

- Different language entirely — no source is reused, only concepts and documentation
- The new server doesn't depend on Bridge, so dropping "bridge" from the name reflects reality
- A fork carries npm/Node.js git history that's irrelevant to a Go project
- The new module path is `github.com/grover/proton-mail-mcp` — clean, no suffix
- Forking implies incremental migration; this is a clean rewrite

You will selectively copy documentation, design decisions, and assets from `~/Projects/proton-bridge-mcp` into the new repo. The old repo stays alive as the TypeScript implementation until Phase 9 cutover.

## What to retain from the old repo

### Documentation

Copy these files into the new repo with minor edits where noted:

| Source | Destination | Adaptation |
|---|---|---|
| `docs/proton/bridge-label-implementation.md` | Same path | None — historical reference |
| `docs/proton/webclient-api-extraction.md` | Same path | Add a note: "Go path was chosen — see `authentication-flows.md`" |
| `docs/proton/authentication-flows.md` | Same path | None — directly applicable |
| `docs/impl/label-handling.md` | Same path | Update opening paragraph: labels are now native, not virtualized; the no-leak rule still applies but for different reasons (consistency with input format, not protecting against IMAP UID confusion) |
| `docs/impl/operation-log-revert.md` | Same path | Translate code snippets from TypeScript to Go in Phase 5 |
| `docs/impl/mcp-tool-interfaces.md` | Same path | Translate type examples to Go structs |
| `docs/tools/README.md` | Same path | Will be updated per phase as tools land |
| `docs/visuals.md` | Same path | Branding info you want, and visual style guide |

### Documentation to drop entirely

- `docs/IMAP.md` — no IMAP in the new server
- `docs/bridge-repair/` — Bridge-specific reference content
- `docs/plans/edd-*.md` and `docs/plans/prd-*.md` — TypeScript-specific implementation plans
- `docs/ROADMAP.md` — replaced by this roadmap

### Conventions to port (new CLAUDE.md)

The old `CLAUDE.md` defines project conventions and the orchestrator workflow. Most of it is language-agnostic and worth keeping. The Go-adapted version should retain:

- Operation modes (STDIO is primary; HTTP/HTTPS comes in Phase 11)
- Tool categories (`read`, `mutating`, `destructive`, `maintenance`) and annotation presets (`READ_ONLY`, `MUTATING`, `DESTRUCTIVE`)
- Operation log + revert design summary
- Interface segregation principle: tool handlers depend on interfaces, not concrete types
- Branch policy: `{type}/{issue#}-{title}` where type ∈ `bug`, `feat`, `refactor`, `docs`
- Concurrent agent safety guidance
- The orchestrator/QE/SWE/Reviewer persona rotation
- EDD/PRD format for non-trivial changes
- Engineering principles (TDD, clean code, fail fast, no fallbacks)

The Go-adapted version should drop or replace:

- Pre-commit checklist: replace `npm install -> lint -> build -> npm ci` with `go mod tidy -> go vet ./... -> golangci-lint run -> go test ./... -> go build ./...`
- TypeScript-specific notes (Zod, NodeNext ESM imports, ts-jest)
- npm-related sections (releases via release-it, MCPB packaging via build-mcpb.sh)
- Smoke test commands (replace with `go run ./cmd/smoketest`)

### Design concepts to re-implement in Go

These are patterns from the TypeScript code that should be reproduced in idiomatic Go. They are not files to copy — they are designs to translate:

1. **Tool result types** — `SingleToolResult[T]`, `BatchToolResult[T]`, `ListToolResult[T]` with a `status` field. Use Go generics (Go 1.18+).
2. **Tool categories and annotations** — same taxonomy
3. **Operation log** — ring buffer, monotonic IDs, FIFO eviction at 100 entries, no persistence
4. **Interface segregation** — `ReadOnlyMailOps` and `MutatingMailOps` become Go interfaces; tool handlers accept these as parameters
5. **`LabelInfo` with name only** — never expose IMAP paths or label IDs; same rule as TypeScript version
6. **`CreateLabelResult { Name, Created }`** — same shape, no path leakage
7. **No-op detection** — mutating operations compare before/after state, do not generate reversal entries for no-ops
8. **`--login` CLI subcommand** for first-run auth (TOTP only, no CAPTCHA, no two-password mode)
9. **MCP elicitation** for in-protocol prompts when the client supports it
10. **Encrypted session vault** — analogous to Bridge's `vault.enc`, stores `{ AuthUID, RefreshToken, KeyPass }`

### Cross-cutting concerns: the Go "middleware" pattern

The TypeScript code uses `@Audited`, `@Tracked`, and `@IrreversibleWhen` decorators. Go has no decorators. The equivalent pattern is **wrapper functions that take a closure and return a wrapped version with cross-cutting behavior added**.

Pattern:

```go
// AuditLogger writes JSONL audit events
type AuditLogger interface {
    Log(entry AuditEntry)
}

// Audited wraps a function call with audit logging.
// Generic over the return type T.
func Audited[T any](logger AuditLogger, op string, input any, fn func() (T, error)) (T, error) {
    start := time.Now()
    result, err := fn()
    logger.Log(AuditEntry{
        Operation: op,
        Input:     input,
        Duration:  time.Since(start),
        Error:     errString(err),
    })
    return result, err
}

// Usage in a method:
func (c *ProtonClient) MoveEmails(ctx context.Context, ids []EmailID, target string) (BatchResult[MoveResult], error) {
    return Audited(c.audit, "move_emails", map[string]any{"ids": ids, "target": target},
        func() (BatchResult[MoveResult], error) {
            // actual implementation
            return c.doMoveEmails(ctx, ids, target)
        })
}
```

This is the Go-idiomatic equivalent of decorators. It's slightly more verbose than TypeScript decorators but explicit — there is no hidden behavior. The same pattern works for `Tracked` (records reversal in operation log) and `IrreversibleWhen` (conditionally clears the log).

You will implement these helper functions in Phase 5 when the operation log lands.

### Tool catalog

Reuse the exact tool names and semantics from the TypeScript implementation, with two intentional changes:

| Category | Tools |
|---|---|
| **read** | `get_folders`, `get_labels`, `list_mailbox`, `fetch_summaries`, `fetch_message`, `fetch_attachment`, `search_mailbox` |
| **mutating** | `create_folder`, `create_label`, `mark_read`, `mark_unread`, `add_labels` |
| **destructive** | `move_emails`, `remove_labels`, `delete_folder`, `delete_label`, `revert_operations` |
| **maintenance** | `verify_session` |

**Change 1: `verify_connectivity` → `verify_session`.** The TypeScript tool tested IMAP connectivity by acquiring a connection from the pool and measuring round-trip latency. There is no IMAP pool in the Go version. The new `verify_session` instead:

- Verifies the stored auth session is still valid (not expired or revoked)
- Calls `client.GetUser()` as a lightweight authenticated round-trip
- Returns the user's primary email and session expiry information
- Lets agents check "is the connection working?" before attempting heavier operations

The semantics are similar (health check), but the implementation is fundamentally different. The new name reflects this.

**Change 2: `drain_connections` is dropped.** The TypeScript version drained the IMAP connection pool. There is no connection pool in the Go version — go-proton-api manages a single HTTP client internally. The maintenance category contains only `verify_session`.

### Artwork to copy

Copy these files from `~/Projects/proton-bridge-mcp/assets/` into `assets/` in the new repo. Same product, different implementation — keep the branding:

- `icon.svg`
- `small-icon.svg`
- `logo.svg`
- `icon-256.png`, `icon-64.png`, `icon-32.png`, `icon-16.png`

### What to drop entirely

- All TypeScript source under `src/`
- `package.json`, `package-lock.json`, `node_modules/`
- `tsconfig.json`, `tsconfig.test.json`, `jest.config.ts`
- `eslint.config.js`, `.prettierrc`
- `scripts/run_smoketest.sh`, `scripts/run_inspector.sh` (replaced by `go run ./cmd/smoketest`)
- All TypeScript tests
- `.release-it.json` (release-it is npm-based — replaced by `goreleaser`)

### What to adapt, not drop

- **`manifest.json`** — the MCPB format is a zip with a manifest. For the Go binary, the manifest references the compiled binary as the entrypoint instead of a Node.js script. Claude Desktop MCPB packaging is **retained** because it's the easiest install path for end users; only the manifest contents change. You will adapt this in Phase 2.

---

## Phase 0: Project Bootstrap

**Goal:** A new GitHub repo with an empty Go project that builds and passes CI.

### Tasks

- [x] Create a new GitHub repo `proton-mail-mcp` (private initially; make public after Phase 2 release)
- [x] Clone it locally to `~/Projects/proton-mail-mcp`
- [x] Run `go mod init github.com/grover/proton-mail-mcp`
- [x] Add base dependencies:
  ```bash
  go get github.com/ProtonMail/go-proton-api
  go get github.com/modelcontextprotocol/go-sdk/mcp
  go get github.com/spf13/cobra
  go get github.com/joho/godotenv
  ```
- [ ] Create the directory layout:
  ```
  proton-mail-mcp/
  ├── cmd/
  │   └── proton-mail-mcp/
  │       └── main.go         # Cobra root command
  ├── internal/
  │   ├── auth/               # Phase 1: SRP login, vault, refresh
  │   ├── proton/             # Phase 2: ProtonClient wrapper, rate limit
  │   ├── mcp/                # Phase 2: MCP server, tool registration
  │   ├── ops/                # Phase 5: operation log, reversal specs
  │   ├── tools/              # Phase 4+: tool handlers
  │   └── audit/              # Phase 2: audit logger
  ├── assets/                 # Copied from old repo
  ├── docs/                   # Copied selectively from old repo
  ├── .github/
  │   └── workflows/
  │       ├── ci.yml          # vet + lint + test + build
  │       └── release.yml     # goreleaser, added in Phase 2
  ├── .golangci.yml           # Linter config
  ├── go.mod
  ├── go.sum
  ├── LICENSE                 # GPL-3.0 (matches go-proton-api license)
  ├── README.md               # Minimal stub for now
  ├── CLAUDE.md               # Adapted from old repo
  └── CHANGELOG.md            # Empty [Unreleased] section
  ```
- [ ] Copy `assets/` from old repo
- [ ] Copy `LICENSE` (GPL-3.0) — must match go-proton-api's license, the project is already GPL-anchored
- [ ] Write minimal `cmd/proton-mail-mcp/main.go`:
  ```go
  package main

  import (
      "fmt"
      "os"

      "github.com/spf13/cobra"
  )

  var rootCmd = &cobra.Command{
      Use:   "proton-mail-mcp",
      Short: "MCP server for ProtonMail via go-proton-api",
  }

  func main() {
      if err := rootCmd.Execute(); err != nil {
          fmt.Fprintln(os.Stderr, err)
          os.Exit(1)
      }
  }
  ```
- [ ] Configure `.golangci.yml` with sensible defaults: `errcheck`, `gosimple`, `govet`, `ineffassign`, `staticcheck`, `unused`, `gofmt`, `goimports`, `revive`
- [ ] Create `.github/workflows/ci.yml`:
  ```yaml
  name: CI
  on: [push, pull_request]
  jobs:
    test:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-go@v5
          with: { go-version: '1.22' }
        - run: go mod download
        - run: go vet ./...
        - uses: golangci/golangci-lint-action@v6
          with: { version: latest }
        - run: go test ./...
        - run: go build ./...
  ```
- [ ] Adapt `CLAUDE.md` from the old repo following the conventions list above
- [ ] Initial `CHANGELOG.md` with empty `[Unreleased]` section
- [ ] Initial `README.md` with project description and "under active development" warning

### Build tooling decision: no Makefile

Makefiles are not idiomatic for Go projects. Use the `go` command directly for everything:

- `go build ./...` — build all packages
- `go test ./...` — run all tests
- `go vet ./...` — static analysis
- `golangci-lint run` — comprehensive linting
- `go run ./cmd/proton-mail-mcp serve` — run the server in dev mode

For complex multi-step tasks (smoke tests, releases), put the orchestration logic in a `cmd/<task>/main.go` file and invoke with `go run ./cmd/<task>`. This keeps everything in Go, avoids shell escaping, works cross-platform, and adds no dependencies.

Examples in the new repo:
- `cmd/proton-mail-mcp/main.go` — the main binary (login + serve subcommands)
- `cmd/smoketest/main.go` — smoke test harness (added in Phase 3)

There is no `Makefile`. There are no shell scripts in `scripts/`. Every developer task runs through `go run` or `go test`.

### Verification

- [ ] `go build ./...` succeeds with no warnings
- [ ] `go vet ./...` produces no output
- [ ] `golangci-lint run` produces no findings
- [ ] CI workflow runs and passes on push
- [ ] `go run ./cmd/proton-mail-mcp` prints help text
- [ ] `git log --oneline` shows a clean initial commit + bootstrap commit

### Commit

```
chore: bootstrap proton-mail-mcp project structure

Initial Go module, directory layout, CI workflow, and adapted CLAUDE.md.
Assets and core docs copied from proton-bridge-mcp.
```

---

## Phase 1: Authentication MVP

**Goal:** A working `proton-mail-mcp login` subcommand that authenticates against the real Proton API, stores the session encrypted on disk, and refreshes the token on subsequent runs.

### Background

Read [docs/proton/authentication-flows.md](proton/authentication-flows.md) section "Recommendation for MCP Server Auth" before starting. The recommended design is "first run interactive, steady state headless". This phase implements the first run.

The reference implementation for SRP login + token storage is `~/Projects/proton-bridge/internal/bridge/user.go`, function `LoginFull` (lines 194-247). Read it. You will implement essentially the same flow, minus the GUI callback indirection.

### Tasks

- [ ] Create `internal/auth/login.go` with the login flow:
  ```go
  package auth

  import (
      "context"
      "errors"
      "fmt"

      "github.com/ProtonMail/go-proton-api"
  )

  type Credentials struct {
      Username string
      Password string
  }

  type Session struct {
      AuthUID      string
      RefreshToken string
      KeyPass      []byte // Salted mailbox password for key decryption
      UserID       string
      PrimaryEmail string
  }

  func Login(ctx context.Context, manager *proton.Manager, creds Credentials, getTOTP func() (string, error)) (*Session, error) {
      client, auth, err := manager.NewClientWithLogin(ctx, creds.Username, []byte(creds.Password))
      if err != nil {
          return nil, fmt.Errorf("login failed: %w", err)
      }

      // Reject two-password mode — not supported in this server
      if auth.PasswordMode == proton.TwoPasswordMode {
          _ = client.AuthDelete(ctx)
          return nil, errors.New("two-password mode is not supported by proton-mail-mcp; please use single-password mode")
      }

      // Handle 2FA if required
      if auth.TwoFA.Enabled & proton.HasTOTP != 0 {
          totp, err := getTOTP()
          if err != nil {
              _ = client.AuthDelete(ctx)
              return nil, fmt.Errorf("TOTP required: %w", err)
          }
          if err := client.Auth2FA(ctx, proton.Auth2FAReq{TwoFactorCode: totp}); err != nil {
              _ = client.AuthDelete(ctx)
              return nil, fmt.Errorf("2FA failed: %w", err)
          }
      }

      // FIDO2 not supported
      if auth.TwoFA.Enabled & proton.HasFIDO2 != 0 && auth.TwoFA.Enabled & proton.HasTOTP == 0 {
          _ = client.AuthDelete(ctx)
          return nil, errors.New("FIDO2-only 2FA is not supported; please enable TOTP")
      }

      // Fetch user info and key salts
      user, err := client.GetUser(ctx)
      if err != nil {
          _ = client.AuthDelete(ctx)
          return nil, fmt.Errorf("get user failed: %w", err)
      }
      salts, err := client.GetSalts(ctx)
      if err != nil {
          _ = client.AuthDelete(ctx)
          return nil, fmt.Errorf("get salts failed: %w", err)
      }

      // Salt the password to derive the key password
      saltedKeyPass, err := salts.SaltForKey([]byte(creds.Password), user.Keys.Primary().ID)
      if err != nil {
          _ = client.AuthDelete(ctx)
          return nil, fmt.Errorf("salt for key failed: %w", err)
      }

      // Verify the key password actually unlocks the user's primary key
      if _, err := user.Keys.Unlock(saltedKeyPass, nil); err != nil {
          _ = client.AuthDelete(ctx)
          return nil, fmt.Errorf("key unlock failed: %w", err)
      }

      return &Session{
          AuthUID:      auth.UID,
          RefreshToken: auth.RefreshToken,
          KeyPass:      saltedKeyPass,
          UserID:       user.ID,
          PrimaryEmail: user.Email,
      }, nil
  }
  ```
- [ ] Create `internal/auth/vault.go` with AES-256-GCM encryption:
  ```go
  package auth

  import (
      "crypto/aes"
      "crypto/cipher"
      "crypto/rand"
      "encoding/json"
      "errors"
      "io"
      "os"
      "path/filepath"
  )

  const vaultFileName = "session.enc"

  // Save encrypts the session and writes it to disk
  func SaveSession(s *Session, vaultDir string, encryptionKey []byte) error {
      data, err := json.Marshal(s)
      if err != nil {
          return err
      }
      block, err := aes.NewCipher(encryptionKey)
      if err != nil {
          return err
      }
      gcm, err := cipher.NewGCM(block)
      if err != nil {
          return err
      }
      nonce := make([]byte, gcm.NonceSize())
      if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
          return err
      }
      ciphertext := gcm.Seal(nonce, nonce, data, nil)
      if err := os.MkdirAll(vaultDir, 0700); err != nil {
          return err
      }
      return os.WriteFile(filepath.Join(vaultDir, vaultFileName), ciphertext, 0600)
  }

  // Load reads and decrypts the session from disk
  func LoadSession(vaultDir string, encryptionKey []byte) (*Session, error) {
      ciphertext, err := os.ReadFile(filepath.Join(vaultDir, vaultFileName))
      if err != nil {
          return nil, err
      }
      block, err := aes.NewCipher(encryptionKey)
      if err != nil {
          return nil, err
      }
      gcm, err := cipher.NewGCM(block)
      if err != nil {
          return nil, err
      }
      if len(ciphertext) < gcm.NonceSize() {
          return nil, errors.New("vault file too short")
      }
      nonce := ciphertext[:gcm.NonceSize()]
      ct := ciphertext[gcm.NonceSize():]
      plaintext, err := gcm.Open(nil, nonce, ct, nil)
      if err != nil {
          return nil, err
      }
      var s Session
      if err := json.Unmarshal(plaintext, &s); err != nil {
          return nil, err
      }
      return &s, nil
  }
  ```
- [ ] Create `internal/auth/keyderive.go` to derive the vault encryption key. Use a combination of machine ID + a random salt stored alongside the vault. This protects against the vault file being copied to another machine. (Bridge does something similar with platform keychain integration; for simplicity, derive from `/etc/machine-id` on Linux, system UUID on macOS, machine GUID on Windows. Document this isn't bulletproof — it's a deterrent against accidental disclosure.)
- [ ] Create `internal/auth/refresh.go`:
  ```go
  package auth

  import (
      "context"
      "fmt"

      "github.com/ProtonMail/go-proton-api"
  )

  // Refresh creates a fresh authenticated client from a stored session
  func Refresh(ctx context.Context, manager *proton.Manager, s *Session) (*proton.Client, *Session, error) {
      client, newAuth, err := manager.NewClientWithRefresh(ctx, s.AuthUID, s.RefreshToken)
      if err != nil {
          return nil, nil, fmt.Errorf("refresh failed: %w", err)
      }
      // Update session with new tokens (refresh tokens rotate)
      s.AuthUID = newAuth.UID
      s.RefreshToken = newAuth.RefreshToken
      return client, s, nil
  }
  ```
- [ ] Add the `login` Cobra subcommand to `cmd/proton-mail-mcp/main.go`:
  ```go
  var loginCmd = &cobra.Command{
      Use:   "login",
      Short: "Authenticate with Proton and store an encrypted session",
      RunE:  runLogin,
  }

  func runLogin(cmd *cobra.Command, args []string) error {
      // Prompt for credentials via stdin
      // Call auth.Login with a TOTP callback that prompts via stdin
      // Save session via auth.SaveSession
      // Print success message with primary email
  }
  ```
- [ ] Use `golang.org/x/term` for password input that doesn't echo to the terminal
- [ ] Document failure modes in the error messages: two-password mode, FIDO2-only, human verification required (CAPTCHA), TOTP required but no TTY

### Verification

- [ ] `go run ./cmd/proton-mail-mcp login` prompts for username, password (hidden), TOTP if enabled
- [ ] On success, prints "Logged in as user@protonmail.com" and creates `~/.proton-mail-mcp/session.enc`
- [ ] The session file is mode 0600 and unreadable as plain text
- [ ] Running `login` again overwrites the previous session
- [ ] If Proton requires CAPTCHA (HV), the command exits with a clear error message instructing the user to wait or change network
- [ ] If the account uses two-password mode, the command exits with a clear error
- [ ] Unit tests for `vault.go` (encrypt/decrypt round-trip, tamper detection)
- [ ] Unit tests for the Cobra command structure (cobra makes this easy)

### Commit

```
feat: add login subcommand with SRP auth and encrypted session vault

Implements interactive login via go-proton-api SRP. Stores AuthUID,
RefreshToken, and salted key password in AES-256-GCM encrypted vault
at ~/.proton-mail-mcp/session.enc. Supports TOTP 2FA via stdin prompt.

Two-password mode and FIDO2-only 2FA are explicitly rejected.
CAPTCHA / human verification is not handled — user must wait or
change network.
```

---

## Phase 2: MCP Server Skeleton + Distribution + First Release

**Goal:** A working `proton-mail-mcp serve` subcommand that loads the encrypted session, refreshes the token, and exposes the `verify_session` tool over MCP STDIO. Plus full distribution: goreleaser, MCPB packaging, GitHub Releases. First installable artifact.

### Background

Read the Go MCP SDK documentation at `github.com/modelcontextprotocol/go-sdk` (the README and examples). The key concepts are `mcp.NewServer`, tool registration with `mcp.Tool`, and STDIO transport via `mcp.NewStdioServerTransport`.

This phase intentionally has only one tool (`verify_session`) so that all the infrastructure (server skeleton, audit logging, rate limiting, distribution, MCPB packaging, releases) is built and proven before any real tool work begins.

### Tasks

#### Server skeleton

- [ ] Create `internal/proton/client.go` — a thin wrapper around `proton.Client` that adds:
  - Rate limit handling (retry on 429 with `Retry-After`)
  - Structured error mapping (convert go-proton-api errors to MCP-friendly errors)
  - A reference to the `AuditLogger`
- [ ] Create `internal/audit/logger.go` — JSONL audit log to a file:
  ```go
  type AuditEntry struct {
      Timestamp time.Time `json:"ts"`
      Operation string    `json:"op"`
      Input     any       `json:"input,omitempty"`
      Duration  string    `json:"duration"`
      Error     string    `json:"error,omitempty"`
  }

  type AuditLogger interface {
      Log(entry AuditEntry)
      Close() error
  }
  ```
- [ ] Implement `Audited` generic helper in `internal/audit/middleware.go` per the pattern shown above
- [ ] Create `internal/proton/ratelimit.go` — wrap API calls in a retry loop:
  ```go
  func WithRateLimit[T any](ctx context.Context, fn func() (T, error)) (T, error) {
      const maxRetries = 5
      var zero T
      for attempt := 0; attempt <= maxRetries; attempt++ {
          result, err := fn()
          if err == nil {
              return result, nil
          }
          var apiErr *proton.APIError
          if errors.As(err, &apiErr) && apiErr.Status == 429 {
              retryAfter := parseRetryAfter(apiErr) // from header or default
              select {
              case <-ctx.Done():
                  return zero, ctx.Err()
              case <-time.After(retryAfter):
                  continue
              }
          }
          return zero, err
      }
      return zero, errors.New("rate limit exceeded after retries")
  }
  ```
- [ ] Create `internal/mcp/server.go` — initialize the MCP server, register tools:
  ```go
  package mcp

  import (
      "context"

      "github.com/modelcontextprotocol/go-sdk/mcp"
      "github.com/grover/proton-mail-mcp/internal/proton"
  )

  func NewServer(client *proton.Client) *mcp.Server {
      s := mcp.NewServer("proton-mail-mcp", "0.1.0")
      RegisterVerifySession(s, client)
      return s
  }
  ```
- [ ] Create `internal/mcp/tools/verify_session.go` — the first tool:
  ```go
  package tools

  import (
      "context"

      "github.com/modelcontextprotocol/go-sdk/mcp"
      "github.com/grover/proton-mail-mcp/internal/proton"
  )

  type VerifySessionResult struct {
      Email           string `json:"email"`
      UserID          string `json:"userId"`
      SessionValid    bool   `json:"sessionValid"`
  }

  func RegisterVerifySession(s *mcp.Server, client *proton.Client) {
      s.AddTool(mcp.Tool{
          Name:        "verify_session",
          Description: "Verify the Proton API session is valid. Returns the authenticated user's email.",
          // Annotations: ReadOnly hint, no destructive
      }, func(ctx context.Context, _ struct{}) (VerifySessionResult, error) {
          user, err := client.GetUser(ctx)
          if err != nil {
              return VerifySessionResult{SessionValid: false}, err
          }
          return VerifySessionResult{
              Email:        user.Email,
              UserID:       user.ID,
              SessionValid: true,
          }, nil
      })
  }
  ```
- [ ] Add the `serve` Cobra subcommand to `cmd/proton-mail-mcp/main.go`:
  ```go
  var serveCmd = &cobra.Command{
      Use:   "serve",
      Short: "Start the MCP server (STDIO transport)",
      RunE:  runServe,
  }

  func runServe(cmd *cobra.Command, args []string) error {
      ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
      defer cancel()

      // Load session from vault
      session, err := auth.LoadSession(vaultDir, encryptionKey)
      if err != nil {
          return fmt.Errorf("load session: %w (run 'proton-mail-mcp login' first)", err)
      }

      // Refresh token
      manager := proton.New(...)
      client, session, err := auth.Refresh(ctx, manager, session)
      if err != nil {
          return fmt.Errorf("refresh failed: %w", err)
      }
      // Save updated session (refresh tokens rotate)
      _ = auth.SaveSession(session, vaultDir, encryptionKey)

      // Wrap client with rate limit + audit
      protonClient := proton.NewClient(client, auditLogger)

      // Build MCP server
      mcpServer := mcp.NewServer(protonClient)

      // Run on STDIO transport
      transport := mcp.NewStdioServerTransport()
      return mcpServer.Serve(ctx, transport)
  }
  ```

#### Distribution

- [ ] Create `.goreleaser.yml`:
  ```yaml
  project_name: proton-mail-mcp
  builds:
    - main: ./cmd/proton-mail-mcp
      binary: proton-mail-mcp
      env: [CGO_ENABLED=0]
      goos: [linux, darwin, windows]
      goarch: [amd64, arm64]
      ignore:
        - { goos: windows, goarch: arm64 }
  archives:
    - format: tar.gz
      format_overrides:
        - { goos: windows, format: zip }
  release:
    github:
      owner: grover
      name: proton-mail-mcp
  changelog:
    sort: asc
  ```
- [ ] Create `.github/workflows/release.yml`:
  ```yaml
  name: Release
  on:
    push:
      tags: ['v*']
  jobs:
    goreleaser:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
          with: { fetch-depth: 0 }
        - uses: actions/setup-go@v5
          with: { go-version: '1.22' }
        - uses: goreleaser/goreleaser-action@v6
          with:
            args: release --clean
          env:
            GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        - name: Build MCPB package
          run: go run ./cmd/build-mcpb
        - name: Upload MCPB to release
          # ... attach proton-mail-mcp.mcpb to the release
  ```

#### MCPB packaging

- [ ] Create `manifest.json` in the repo root, adapted from the old repo. Reference the Go binary instead of a Node.js script. Read the old `manifest.json` first to understand the schema.
- [ ] Create `cmd/build-mcpb/main.go` — a Go program that builds the `.mcpb` zip:
  - Reads `manifest.json`
  - Includes `proton-mail-mcp` (the compiled binary for the current platform)
  - Includes `assets/icon.svg` and other assets referenced in the manifest
  - Zips everything to `proton-mail-mcp.mcpb`
- [ ] Document MCPB installation in `README.md`

#### Documentation

- [ ] Update `README.md` with:
  - Project description
  - Install instructions (download from releases, or `go install`)
  - Quickstart (`login`, then `serve`)
  - List of tools (just `verify_session` for now)
  - Note that this is v0.1.0 — feature parity work in progress
- [ ] Add `[v0.1.0]` section to `CHANGELOG.md`
- [ ] Document the configuration model in `docs/configuration.md` (currently just the vault location)

### Verification

- [ ] `go run ./cmd/proton-mail-mcp serve` (after `login`) starts the server, blocks on stdin
- [ ] Connect via the MCP Inspector (`npx @modelcontextprotocol/inspector`) using STDIO transport pointed at the serve command
- [ ] `verify_session` appears in the tool list
- [ ] Calling `verify_session` returns the real user's email
- [ ] Audit log file is created and contains a JSONL entry per tool call
- [ ] `goreleaser release --snapshot --clean` produces binaries for all platforms in `dist/`
- [ ] `go run ./cmd/build-mcpb` produces a valid `proton-mail-mcp.mcpb` file
- [ ] Installing the MCPB in Claude Desktop makes `verify_session` available
- [ ] CI passes
- [ ] Tag `v0.1.0` and verify the release workflow produces a GitHub Release with all binaries and the MCPB

### Commit and release

```
feat: add MCP server skeleton with verify_session and full distribution

- serve subcommand starts the MCP server on STDIO
- verify_session tool returns authenticated user info
- Rate limit handling via retry on 429 with Retry-After
- JSONL audit logger
- goreleaser config for cross-platform binaries
- Adapted manifest.json + build-mcpb for Claude Desktop packaging
- Tag v0.1.0
```

---

## Phase 3: Smoke Testing Infrastructure

**Goal:** A reliable smoke test harness that runs against both the real Proton API (interactive) and an in-process fake server (automated, headless, CI-suitable).

### Background

Read `~/Projects/proton-bridge/tests/api_test.go` to see how Bridge uses the `go-proton-api/server.Server` fake API server for its own integration tests. The fake server is part of the go-proton-api package and exposes the full API surface as an in-process HTTP server with a deterministic dataset.

### Tasks

- [ ] Create `cmd/smoketest/main.go` with two modes:
  ```go
  package main

  import (
      "flag"
      "log"
  )

  func main() {
      fakeMode := flag.Bool("fake", false, "Run against in-process fake server instead of real Proton API")
      flag.Parse()

      if *fakeMode {
          runFakeMode()
      } else {
          runRealMode()
      }
  }
  ```

#### Mode A: Real account

- [ ] `go run ./cmd/smoketest` (no `--fake`):
  - Pre-flight: kill any process holding the Inspector port (use `lsof -ti tcp:6277 | xargs kill` style logic from the old repo's `run_smoketest.sh`)
  - Load `.env` via `github.com/joho/godotenv`
  - Verify the user has run `proton-mail-mcp login` previously (check vault file exists). **Do not** prompt for TOTP from the smoke test command — that's a manual one-time setup step.
  - Start `proton-mail-mcp serve` as a subprocess
  - Start the MCP Inspector pointed at the serve subprocess
  - Print connection details to stdout
  - Wait for SIGINT to clean up

#### Mode B: Fake server (CI-suitable)

- [ ] `go run ./cmd/smoketest --fake`:
  - Spin up `go-proton-api/server.Server` in-process
  - Pre-populate it with deterministic test data:
    - A test user with a known password
    - Several labels (system + custom)
    - Several folders
    - Messages in INBOX with a mix of: read/unread, with/without attachments, in various labels
  - Authenticate against the fake server (using the test password)
  - Start the MCP server pointing at the fake server URL
  - Run scripted scenarios as direct MCP protocol calls (no Inspector UI)
  - Assert expected outcomes
  - Tear down everything cleanly
  - Exit non-zero on any assertion failure

- [ ] Create `internal/testfixtures/fakeserver.go` with helpers to set up the fake server with deterministic data
- [ ] Create `internal/testfixtures/scenarios.go` with the scripted scenarios per phase

### Scenarios per phase

The fake-server scenarios grow as each phase adds tools:

| Phase | Scenarios |
|---|---|
| 3 (this phase) | `verify_session` returns the test user's email — proves end-to-end harness works |
| 4 | + `get_folders`, `get_labels`, `list_mailbox`, `fetch_summaries`, verify attachment metadata in summaries |
| 5 | + `mark_read` an email, verify it's read, `revert_operations`, verify it's unread again |
| 6 | + `create_folder` with a path, verify it appears in `get_folders`, `delete_folder`, verify it's gone |
| 7 | + `move_emails` from INBOX to a folder, verify; `add_labels` then `remove_labels`, verify |
| 8 | + `fetch_message` returns a body; `fetch_attachment` returns base64 content |

`verify_session` is included in **every** phase's scenarios as a sanity check.

### Tasks for documentation

- [ ] Create `docs/smoke-tests.md` listing all current scenarios
- [ ] Update `README.md` with the smoke test instructions
- [ ] Add a CI job that runs `go run ./cmd/smoketest --fake` on every push

### Verification

- [ ] `go run ./cmd/smoketest --fake` runs end-to-end against the fake server in <10 seconds, exits 0
- [ ] CI runs the fake-mode smoke test and reports pass/fail
- [ ] `go run ./cmd/smoketest` (real mode) starts the Inspector, connects to the real Proton account, and `verify_session` returns the user's email
- [ ] The fake server scenarios are documented in `docs/smoke-tests.md`

### Commit

```
test: add smoke test infrastructure with fake server automation

Mode A: interactive harness against real Proton account via Inspector.
Mode B: headless scripted scenarios against go-proton-api fake server.
CI runs Mode B on every push.
```

---

## Phase 4: Read Tools (with redesigned summaries from day one)

**Goal:** Ship the four basic read tools (`get_folders`, `get_labels`, `list_mailbox`, `fetch_summaries`) with attachment metadata in summaries from the start. Release v0.2.0.

### Background

The TypeScript implementation has open issue #57 to move attachment metadata from `fetch_message` into `EmailSummary`. The Go port should ship the redesigned shape from the very first read tool — no later breaking change.

Read `~/Projects/proton-bridge/internal/services/imapservice/connector.go` for how Bridge calls `client.GetMessageMetadataPage` and similar methods. The pagination patterns and label filtering are the relevant references.

### Tasks

#### Types

- [ ] Create `internal/types/email.go` with the data types:
  ```go
  package types

  type EmailID = string // ProtonMail message ID, opaque

  type AttachmentMetadata struct {
      Filename    string `json:"filename"`
      Size        int    `json:"size"`
      ContentType string `json:"contentType"`
      PartID      string `json:"partId"`
  }

  type EmailSummary struct {
      ID          EmailID              `json:"id"`
      Subject     string               `json:"subject"`
      From        string               `json:"from"`
      To          []string             `json:"to"`
      Date        time.Time            `json:"date"`
      Unread      bool                 `json:"unread"`
      LabelIDs    []string             `json:"labelIds"`
      Attachments []AttachmentMetadata `json:"attachments,omitempty"`
  }

  type FolderInfo struct {
      ID           string `json:"id"`
      Path         string `json:"path"`
      MessageCount int    `json:"messageCount"`
      UnreadCount  int    `json:"unreadCount"`
  }

  type LabelInfo struct {
      // No path, no ID — labels expose name only
      Name         string `json:"name"`
      MessageCount int    `json:"messageCount"`
      UnreadCount  int    `json:"unreadCount"`
  }
  ```
  Note: `LabelInfo` deliberately omits the label ID. The MCP server uses label names externally and resolves them to IDs internally. This matches the TypeScript design.

#### Tool result types

- [ ] Create `internal/mcp/results.go` with the generic result wrappers:
  ```go
  type ToolStatus string

  const (
      StatusSucceeded ToolStatus = "succeeded"
      StatusPartial   ToolStatus = "partial"
      StatusFailed    ToolStatus = "failed"
  )

  type SingleToolResult[T any] struct {
      Status ToolStatus `json:"status"`
      Data   T          `json:"data"`
  }

  type ListToolResult[T any] struct {
      Status ToolStatus `json:"status"`
      Items  []T        `json:"items"`
  }

  type BatchItemResult[T any] struct {
      ID     string  `json:"id"`
      Status string  `json:"status"`
      Data   *T      `json:"data,omitempty"`
      Error  *string `json:"error,omitempty"`
  }

  type BatchToolResult[T any] struct {
      Status ToolStatus            `json:"status"`
      Items  []BatchItemResult[T]  `json:"items"`
  }
  ```

#### Tools

- [ ] Implement `internal/mcp/tools/get_folders.go`:
  - Calls `client.GetLabels()` (which returns ALL labels including system, folder, label)
  - Filters to `LabelTypeFolder` + system folders (Inbox, Sent, Drafts, Trash, etc.)
  - Maps each to `FolderInfo` with its path
  - Returns `ListToolResult[FolderInfo]`
- [ ] Implement `internal/mcp/tools/get_labels.go`:
  - Calls `client.GetLabels()`
  - Filters to `LabelTypeLabel` only
  - Maps each to `LabelInfo` (name only — no ID, no path)
  - Returns `ListToolResult[LabelInfo]`
- [ ] Implement `internal/mcp/tools/list_mailbox.go`:
  - Input: `{ mailbox: string, limit: int, offset: int }`
  - Resolves the mailbox name to a label ID (system folders use known IDs; user folders/labels via `GetLabels()` lookup)
  - Calls `client.GetMessageMetadataPage()` with pagination
  - Maps each `proton.MessageMetadata` to `EmailSummary`, including attachment metadata from `AttachmentInfo`
  - Returns `ListToolResult[EmailSummary]`
- [ ] Implement `internal/mcp/tools/fetch_summaries.go`:
  - Input: `{ ids: []string }`
  - Calls `client.GetMessageMetadataPage()` filtered by IDs
  - Same mapping as `list_mailbox`
  - Returns `ListToolResult[EmailSummary]`
- [ ] Register all four tools in `internal/mcp/server.go`
- [ ] Add unit tests for the type mapping (proton.MessageMetadata -> EmailSummary)

#### Tests

- [ ] Add scenarios to `cmd/smoketest/main.go` Mode B:
  - List folders, assert INBOX is present
  - List labels, assert no IDs leak in the output
  - List INBOX, assert at least one summary has attachment metadata
  - Fetch summaries by ID, assert same shape as list_mailbox

#### Documentation

- [ ] Add tool entries to `docs/tools/README.md`
- [ ] Update `[Unreleased]` in `CHANGELOG.md`
- [ ] Update `README.md` to list the new tools

### Verification

- [ ] All four tools work via the MCP Inspector against a real account
- [ ] Fake-server smoke test passes for Phase 4 scenarios
- [ ] `LabelInfo` JSON output contains no `id` or `path` field — only `name`, `messageCount`, `unreadCount`
- [ ] Summaries with attachments have populated `attachments` arrays
- [ ] Tag `v0.2.0` and release

### Commit and release

```
feat: add read tools (get_folders, get_labels, list_mailbox, fetch_summaries)

EmailSummary includes attachment metadata from day one (issue #57 from
the TypeScript repo). LabelInfo exposes name only — no IDs or paths.

Tag v0.2.0
```

---

## Phase 5: Operation Log + First Reversible Tools

**Goal:** Build the operation log infrastructure and ship the simplest reversible tools (`mark_read`, `mark_unread`) plus `revert_operations`. Release v0.3.0.

### Background

Read [docs/impl/operation-log-revert.md](impl/operation-log-revert.md) for the design rationale. Translate the TypeScript snippets to Go. The Go version is structurally simpler because there's no IMAP UID instability — MessageIDs are stable, so the UID rewriting chain from the TypeScript implementation doesn't apply.

### Tasks

#### Operation log

- [ ] Create `internal/ops/log.go`:
  ```go
  package ops

  import (
      "sync"
      "time"
  )

  type ReversalSpec interface {
      reversalSpec() // marker method
  }

  type NoopReversal struct{}
  func (NoopReversal) reversalSpec() {}

  type MarkReadReversal struct {
      IDs []string
  }
  func (MarkReadReversal) reversalSpec() {}

  type MarkUnreadReversal struct {
      IDs []string
  }
  func (MarkUnreadReversal) reversalSpec() {}

  // ... more reversal types added in later phases

  type OperationRecord struct {
      ID        int64
      Tool      string
      Reversal  ReversalSpec
      Timestamp time.Time
  }

  const maxLogSize = 100

  type Log struct {
      mu      sync.Mutex
      seq     int64
      records []OperationRecord
  }

  func NewLog() *Log {
      return &Log{records: make([]OperationRecord, 0, maxLogSize)}
  }

  func (l *Log) Push(tool string, reversal ReversalSpec) int64 {
      l.mu.Lock()
      defer l.mu.Unlock()
      l.seq++
      record := OperationRecord{
          ID:        l.seq,
          Tool:      tool,
          Reversal:  reversal,
          Timestamp: time.Now(),
      }
      l.records = append(l.records, record)
      if len(l.records) > maxLogSize {
          l.records = l.records[len(l.records)-maxLogSize:]
      }
      return record.ID
  }

  // GetFrom returns records from the given ID forward, in reverse-chronological order
  func (l *Log) GetFrom(id int64) []OperationRecord {
      l.mu.Lock()
      defer l.mu.Unlock()
      var found []OperationRecord
      for _, r := range l.records {
          if r.ID >= id {
              found = append(found, r)
          }
      }
      // Reverse for chronological-newest-first
      for i, j := 0, len(found)-1; i < j; i, j = i+1, j-1 {
          found[i], found[j] = found[j], found[i]
      }
      return found
  }

  func (l *Log) Has(id int64) bool {
      l.mu.Lock()
      defer l.mu.Unlock()
      for _, r := range l.records {
          if r.ID == id {
              return true
          }
      }
      return false
  }

  func (l *Log) Clear() {
      l.mu.Lock()
      defer l.mu.Unlock()
      l.records = l.records[:0]
  }
  ```

#### Tracked middleware

- [ ] Create `internal/ops/middleware.go`:
  ```go
  // Tracked wraps a tool call and records its reversal in the operation log on success.
  // The buildReversal callback receives the result and returns either a reversal spec
  // or NoopReversal (for no-op cases like marking an already-read email as read).
  func Tracked[T any](
      log *Log,
      tool string,
      fn func() (T, error),
      buildReversal func(T) ReversalSpec,
  ) (T, int64, error) {
      result, err := fn()
      if err != nil {
          var zero T
          return zero, 0, err
      }
      reversal := buildReversal(result)
      opID := log.Push(tool, reversal)
      return result, opID, nil
  }

  // IrreversibleWhen clears the entire log if the predicate returns true after success.
  // Used by destructive operations like delete_folder where reversal of prior operations
  // becomes impossible.
  func IrreversibleWhen[T any](
      log *Log,
      fn func() (T, error),
      shouldClear func(T) bool,
  ) (T, error) {
      result, err := fn()
      if err == nil && shouldClear(result) {
          log.Clear()
      }
      return result, err
  }
  ```

#### Tools

- [ ] Implement `internal/mcp/tools/mark_read.go`:
  - Input: `{ ids: []string }`
  - Idempotency: fetch metadata first, only mark unread emails as read
  - Call `client.MarkMessagesRead(ctx, ids...)`
  - Build reversal: `MarkReadReversal{IDs: actuallyChangedIDs}` (or NoopReversal if nothing changed)
  - Return `BatchToolResult[MarkReadResult]` with `operationId`
- [ ] Implement `internal/mcp/tools/mark_unread.go` — same pattern, inverted
- [ ] Implement `internal/mcp/tools/revert_operations.go`:
  - Input: `{ operationId: int64 }`
  - Validates the operation ID exists in the log (else `UNKNOWN_OPERATION_ID`)
  - Walks log from the given ID forward in reverse-chronological order
  - For each record, executes the reversal:
    - `MarkReadReversal` -> `client.MarkMessagesUnread(ids)`
    - `MarkUnreadReversal` -> `client.MarkMessagesRead(ids)`
    - `NoopReversal` -> do nothing
  - Returns `RevertResult` with per-step status
- [ ] Wire `mark_read` and `mark_unread` to use `Tracked` middleware

#### Tests

- [ ] Add scenarios to fake-server smoke test:
  - Mark an unread email as read, verify it's read
  - Capture the operationId from the response
  - Call `revert_operations` with that ID
  - Verify the email is unread again
  - Mark an already-read email as read, verify NoopReversal was recorded

#### Documentation

- [ ] Document the operation log pattern in `docs/impl/operation-log-revert.md` (port from TS version with Go snippets)
- [ ] Add tool entries to `docs/tools/README.md`
- [ ] Update `[Unreleased]` in `CHANGELOG.md`

### Verification

- [ ] Mark/unmark round-trip via the Inspector
- [ ] Revert restores state
- [ ] Idempotency: marking an already-read email as read records a NoopReversal
- [ ] Fake-server smoke test passes
- [ ] Tag `v0.3.0` and release

### Commit and release

```
feat: add operation log + mark_read/mark_unread + revert_operations

Implements the operation log ring buffer (100 entries, monotonic IDs)
and the Tracked/IrreversibleWhen middleware helpers. mark_read and
mark_unread are the first reversible tools, with idempotency-aware
no-op detection.

Tag v0.3.0
```

---

## Phase 6: Folder/Label Management

**Goal:** Ship `create_folder`, `create_label`, `delete_folder`, `delete_label`. Release v0.4.0.

### Tasks

- [ ] Add reversal types to `internal/ops/log.go`:
  ```go
  type CreateFolderReversal struct {
      Path string
  }
  func (CreateFolderReversal) reversalSpec() {}

  type CreateLabelReversal struct {
      Name string
  }
  func (CreateLabelReversal) reversalSpec() {}
  ```
- [ ] Implement `internal/mcp/tools/create_folder.go`:
  - Input: `{ path: string }`
  - Validate path starts with `Folders/` and is non-trivial
  - Call `client.CreateLabel(LabelTypeFolder, ...)` with parent ID resolution for nested paths (see Bridge's `createFolder` in `connector.go` for reference)
  - On success: `CreateFolderReversal{Path: path}` for the operation log
  - Return `SingleToolResult[CreateFolderResult]` with `{ path, created }`
  - Idempotency: if the folder already exists, return `{ created: false }` and `NoopReversal`
- [ ] Implement `internal/mcp/tools/create_label.go`:
  - Input: `{ name: string }`
  - Validate name does not contain `/`
  - Call `client.CreateLabel(LabelTypeLabel, name)` (no parent — labels are flat)
  - On success: `CreateLabelReversal{Name: name}`
  - Return `{ name, created }` (NOT `path` — see [docs/impl/label-handling.md](impl/label-handling.md))
  - Idempotency: if the label already exists, return `{ created: false }` and `NoopReversal`
- [ ] Implement `internal/mcp/tools/delete_folder.go`:
  - Input: `{ path: string }`
  - Validate path starts with `Folders/`
  - Reject if it's a special-use folder
  - Call `client.DeleteLabel(folderID)`
  - Use `IrreversibleWhen` middleware: when `deleted == true`, clear the entire operation log
  - Return `{ path, deleted }`
  - Idempotency: if the folder doesn't exist, return `{ deleted: false }` (do not clear log)
- [ ] Implement `internal/mcp/tools/delete_label.go`:
  - Input: `{ name: string }`
  - Resolve name -> label ID
  - Call `client.DeleteLabel(labelID)`
  - Use `IrreversibleWhen` middleware
  - Return `{ name, deleted }`
- [ ] Add reversal execution for `CreateFolderReversal` and `CreateLabelReversal` in `revert_operations`:
  - `CreateFolderReversal{Path}` -> `delete_folder(path)`
  - `CreateLabelReversal{Name}` -> `delete_label(name)`
- [ ] Add scenarios to fake-server smoke test:
  - Create a folder, assert it appears in `get_folders`
  - Delete it, assert it's gone
  - Create a label, assert it appears in `get_labels`
  - Delete it
  - Create-then-revert: verify the folder/label is deleted by the revert

### Documentation

- [ ] Tool entries in `docs/tools/README.md`
- [ ] CHANGELOG entry

### Verification

- [ ] All four tools work via Inspector
- [ ] Fake-server smoke test passes
- [ ] Idempotency verified
- [ ] `delete_folder` clearing the log is verified by attempting a revert after a delete (should fail with UNKNOWN_OPERATION_ID)
- [ ] Tag `v0.4.0` and release

### Commit

```
feat: add folder/label CRUD tools

create_folder, create_label, delete_folder, delete_label.
Idempotent — repeated calls are no-ops. delete_folder and delete_label
are IrreversibleWhen, clearing the operation log on actual deletion.

Tag v0.4.0
```

---

## Phase 7: Email Movement and Labels

**Goal:** Ship `move_emails`, `add_labels`, `remove_labels`. Release v0.5.0.

### Background

Read `~/Projects/proton-bridge/internal/services/imapservice/connector.go` `MoveMessages` (around line 506) for the asymmetric label/folder MOVE logic. The bridge handles:
- Moving between labels: label destination, unlabel source
- Moving label -> folder: label destination, unlabel source
- Moving folder -> label: label destination, source stays (this is unusual!)
- Moving folder -> folder: relies on `shouldExpungeOldLocation` flag

Your Go MCP version doesn't need to mirror exactly because it's not constrained by IMAP semantics. But the underlying API calls (`client.LabelMessages`, `client.UnlabelMessages`) are the same.

### Tasks

- [ ] Add reversal types:
  ```go
  type MoveBatchReversal struct {
      Moves []struct {
          IDs       []string
          FromLabel string
          ToLabel   string
      }
  }

  type AddLabelsReversal struct {
      IDs       []string
      LabelName string
  }

  type RemoveLabelsReversal struct {
      IDs       []string
      LabelName string
  }
  ```
- [ ] Implement `internal/mcp/tools/move_emails.go`:
  - Input: `{ ids: []string, targetMailbox: string }`
  - Resolve target mailbox name to label ID
  - Group input emails by their current label (need to fetch current state)
  - For each source label, call `client.LabelMessages(ids, targetID)` then `client.UnlabelMessages(ids, sourceID)`
  - Build reversal: swap source/target for each group
  - Return `BatchToolResult[MoveResult]` with `operationId`
- [ ] Implement `internal/mcp/tools/add_labels.go`:
  - Input: `{ ids: []string, labelNames: []string }`
  - Resolve each label name to ID
  - Call `client.LabelMessages(ids, labelID)` for each label
  - **Response shape: `{ labelName, applied: bool }`** — no path, no IDs
  - Return `BatchToolResult` with per-email per-label results
  - Reversal: `RemoveLabelsReversal{IDs, LabelName}` for each successfully applied label
- [ ] Implement `internal/mcp/tools/remove_labels.go`:
  - Input: `{ ids: []string, labelNames: []string }`
  - Resolve each label name to ID
  - Call `client.UnlabelMessages(ids, labelID)` for each label
  - Response: `{ labelName, removed: bool }`
  - Reversal: `AddLabelsReversal{IDs, LabelName}`
- [ ] Implement reversal execution for the new reversal types
- [ ] Add fake-server smoke test scenarios:
  - Move email INBOX -> Folders/Test, verify
  - Move back via revert, verify
  - Add label, verify it's applied (no path leaks in response!)
  - Remove label, verify
  - Round-trip add/remove via revert

### Documentation

- [ ] Tool entries in `docs/tools/README.md` — emphasize no-leak rule for `add_labels` response
- [ ] CHANGELOG entry — explicitly mention this fixes the TS issue #54 (`add_labels` path leakage) by design

### Verification

- [ ] All three tools work via Inspector
- [ ] `add_labels` response contains `labelName` and `applied`, never `labelPath` or `newId`
- [ ] Fake-server smoke test passes
- [ ] Tag `v0.5.0` and release

### Commit

```
feat: add move_emails, add_labels, remove_labels

add_labels response uses { labelName, applied } — no IMAP path or
copy UID leakage (fixes TS issue #54 by design). All three tools are
fully reversible via revert_operations.

Tag v0.5.0
```

---

## Phase 8: Message Body, Search, and Attachment Tools

**Goal:** Ship `fetch_message` (body-only, redesigned per TS issue #58), `fetch_attachment`, `search_mailbox`. Release v0.6.0.

### Background

This is the first phase that touches PGP decryption. Read `~/Projects/proton-bridge/internal/services/imapservice/connector.go` function `GetMessageLiteral` (around line 216) for how Bridge fetches and decrypts a message. The pattern uses `gopenpgp` (which is already a dependency of `go-proton-api`).

The redesigned `fetch_message` returns only the body (text/html), not the envelope fields. The envelope is already in the summary that the agent has from `list_mailbox` or `fetch_summaries`. Avoid re-duplication.

### Tasks

- [ ] Add types:
  ```go
  type EmailBody struct {
      ID          EmailID `json:"id"`
      ContentType string  `json:"contentType"` // "text/plain" or "text/html"
      Body        string  `json:"body"`
  }

  type AttachmentContent struct {
      EmailID     EmailID `json:"emailId"`
      PartID      string  `json:"partId"`
      Filename    string  `json:"filename"`
      ContentType string  `json:"contentType"`
      Data        string  `json:"data"` // base64
      Size        int     `json:"size"`
  }
  ```
- [ ] Implement `internal/mcp/tools/fetch_message.go`:
  - Input: `{ id: string }`
  - Call `client.GetFullMessage(ctx, id)` — returns the encrypted message
  - Use the user's keyring (from session.KeyPass) to decrypt the body via gopenpgp
  - Return `SingleToolResult[EmailBody]` — body content only
- [ ] Implement `internal/mcp/tools/fetch_attachment.go`:
  - Input: `{ emailId: string, partId: string }`
  - Call `client.GetAttachment(ctx, partId)` — returns encrypted attachment
  - Decrypt via gopenpgp using the appropriate key
  - Return `SingleToolResult[AttachmentContent]` with base64-encoded data
- [ ] Implement `internal/mcp/tools/search_mailbox.go`:
  - Input: `{ mailbox: string, query: string, limit: int, offset: int }`
  - Call `client.GetMessageMetadataPage()` with `Keyword` parameter
  - Return `ListToolResult[EmailSummary]` (same shape as `list_mailbox`, includes attachment metadata)
- [ ] Set up keyring management in `internal/proton/keys.go`:
  - On `serve` startup, after refreshing the token, load and decrypt the user's primary key using `session.KeyPass`
  - Store the keyring on the `ProtonClient` wrapper for use by decrypt operations
  - Refresh keyring on token refresh

### Tests

- [ ] Add fake-server scenarios:
  - Fetch a message body, assert it's decrypted plaintext/HTML (the fake server should provide test messages)
  - Fetch an attachment, assert base64 length matches expected size
  - Search for a keyword that exists in test data, assert at least one result with attachment metadata

### Documentation

- [ ] Tool entries in `docs/tools/README.md`
- [ ] CHANGELOG entry — note `fetch_message` returns body only (TS issue #58 fixed by design)

### Verification

- [ ] Fetch a real message body via Inspector against a real account
- [ ] Download a real attachment, verify it opens correctly
- [ ] Search returns expected results
- [ ] Fake-server smoke test passes
- [ ] Tag `v0.6.0` and release

### Commit

```
feat: add fetch_message, fetch_attachment, search_mailbox

PGP decryption via gopenpgp using the stored salted key password.
fetch_message returns body only — no envelope re-duplication
(fixes TS issue #58 by design).

Tag v0.6.0
```

---

## Phase 9: Cutover

**Goal:** Migrate users from `proton-bridge-mcp` to `proton-mail-mcp`. No release.

### Tasks

- [ ] Open a PR against `~/Projects/proton-bridge-mcp` updating the README:
  - Add a deprecation banner at the top: "This project is in maintenance mode. The actively developed Go version is at https://github.com/grover/proton-mail-mcp"
  - Add a "Migration Guide" section linking to a new doc
- [ ] Create `docs/migration-from-typescript.md` in the new repo:
  - For users coming from `proton-bridge-mcp`
  - How to install the new MCPB
  - How to migrate Claude Desktop configuration (the tool names are the same, so most existing usage should just work)
  - Notes on the two tool changes: `verify_connectivity` -> `verify_session`, `drain_connections` removed
  - Notes on the response shape changes: `fetch_message` body-only, `add_labels` no path
- [ ] Update the new repo's README to link the migration guide
- [ ] Add a section to the old repo's CHANGELOG noting the deprecation
- [ ] Old repo enters maintenance mode: only security fixes
- [ ] Set milestone in the old repo to track final maintenance work

This phase produces no release. Cutover is a meta step.

### Verification

- [ ] Old repo README clearly directs users to the new one
- [ ] Migration guide exists and is accurate
- [ ] No silent breakage: users following the guide can install the new MCPB and continue with their existing Claude Desktop setup

---

## Phase 10: Cross-cutting Improvements

**Goal:** Operational quality improvements after users have migrated. Release v0.7.0.

### Tasks

- [ ] **Audit log rotation** — port the design from TS issue #40. Use `gopkg.in/natefinch/lumberjack.v2` or implement simple size-based rotation in `internal/audit/`
- [ ] **Better error mapping** — define structured error codes for the MCP responses:
  - `AUTH_EXPIRED` — session needs re-login
  - `RATE_LIMITED` — Proton API returned 429
  - `LABEL_NOT_FOUND` — label name doesn't exist
  - `EMAIL_NOT_FOUND` — message ID doesn't exist
  - `INVALID_INPUT` — schema validation failure
  - `INTERNAL` — anything else
  - Return these codes in the MCP error responses so agents can react
- [ ] **Rate limit refinements** — basic retry shipped in Phase 2, this phase adds:
  - Configurable retry budget per call
  - Metrics for rate-limit hits (logged via slog)
  - Backoff jitter
- [ ] **Telemetry / structured event logging** — use `log/slog` consistently across the codebase, ensure every tool call logs a structured event for production debugging
- [ ] **Troubleshooting documentation** — create `docs/troubleshooting.md`:
  - "Authentication errors" — what to do when refresh fails
  - "Rate limit errors" — what they mean, how to back off
  - "CAPTCHA / human verification" — how to recover (wait, change network, re-login)
  - "Session expired mid-conversation" — instructing users to re-run `login`

### Verification

- [ ] Audit log rotates at the configured size
- [ ] All error responses include structured error codes
- [ ] Troubleshooting doc covers common failure modes
- [ ] Tag `v0.7.0` and release

### Commit

```
feat: cross-cutting improvements (audit log rotation, error codes, telemetry)

Audit log size-based rotation. Structured MCP error codes for
AUTH_EXPIRED, RATE_LIMITED, LABEL_NOT_FOUND, etc. Slog-based
structured event logging for production debugging. Troubleshooting
guide.

Tag v0.7.0
```

---

## Phase 11: HTTP/HTTPS Transports (Last)

**Goal:** Add HTTP and HTTPS transports for non-STDIO use cases. Release v1.0.0 — feature parity with the TypeScript version.

### Background

Read `~/Projects/proton-bridge-mcp/src/http.ts` for the per-session model the TypeScript version uses. The Go MCP SDK should provide HTTP transport primitives — check its docs.

### Tasks

- [ ] Add `--http` flag to `serve`:
  - Starts an HTTP server on a configurable port
  - Bearer token auth via the `Authorization` header
  - Per-session MCP server instances (one `mcp.Server` per HTTP session, keyed by session ID)
- [ ] Add `--https` flag:
  - Same as `--http` but with TLS
  - Auto-generates a self-signed certificate if `--cert` and `--key` are not provided
  - Use `crypto/tls` and `crypto/x509` from stdlib
- [ ] Configuration via flags or env vars:
  - `--port` / `PROTONMAIL_MCP_PORT`
  - `--mcp-auth-token` / `PROTONMAIL_MCP_AUTH_TOKEN`
  - `--cert`, `--key` (HTTPS)
- [ ] Update the manifest.json to support HTTP mode if needed
- [ ] Add fake-server smoke test scenarios for HTTP mode (Mode A only — Mode B can stay STDIO)
- [ ] Document the configuration in `docs/configuration.md`

### Verification

- [ ] `proton-mail-mcp serve --http --port 6283 --mcp-auth-token secret` starts HTTP server
- [ ] MCP Inspector connects via HTTP with the Bearer header
- [ ] Requests without the token return 401
- [ ] HTTPS variant works with auto-generated cert
- [ ] Multiple concurrent sessions work without cross-contamination
- [ ] Tag `v1.0.0` and release

### Commit and release

```
feat: add HTTP/HTTPS transports — v1.0.0 feature parity

proton-mail-mcp serve --http and --https with bearer token auth and
per-session MCP server instances. Auto-generates self-signed cert
for HTTPS if not provided.

This release marks feature parity with proton-bridge-mcp.

Tag v1.0.0
```

---

## Documentation Maintenance

Documentation is **not** a separate phase. Each phase that adds or changes a tool must, in the same commit series:

- Add or update entries in `docs/tools/README.md`
- Add an entry to `CHANGELOG.md` under `[Unreleased]`, then promote to a versioned section on release
- Update `README.md` quickstart if relevant
- Update `ARCHITECTURE.md` if the structure changes

Don't defer documentation. It's part of the work.

## Release Cadence Summary

| Phase | Release | Tools / focus |
|---|---|---|
| 2 | v0.1.0 | `verify_session` + skeleton + MCPB + goreleaser + rate limit handling |
| 4 | v0.2.0 | + `get_folders`, `get_labels`, `list_mailbox`, `fetch_summaries` (with attachment metadata) |
| 5 | v0.3.0 | + `mark_read`, `mark_unread`, `revert_operations` (operation log online) |
| 6 | v0.4.0 | + `create_folder`, `create_label`, `delete_folder`, `delete_label` |
| 7 | v0.5.0 | + `move_emails`, `add_labels`, `remove_labels` |
| 8 | v0.6.0 | + `fetch_message` (body only), `fetch_attachment`, `search_mailbox` |
| 10 | v0.7.0 | Audit log rotation, error mapping, telemetry |
| 11 | v1.0.0 | + HTTP/HTTPS transports — feature parity |

Phase 3 (smoke test infrastructure) and Phase 9 (cutover) produce no release.

## A short Go primer

This appendix is for the user reading along, not for Claude. Claude should already know Go. If you're the user and you're new to Go, here are the absolute minimum concepts to recognize what's in this roadmap:

**Packages**: A directory of `.go` files. Imported by path: `import "github.com/grover/proton-mail-mcp/internal/auth"`. Function visibility is by capitalization: `Login` is exported (public), `login` is package-private.

**Methods on structs**: Go has no classes. A "method" is a function whose first parameter is the receiver, written as `func (s *Session) Refresh() error`. The `*` means pointer (mutable reference), like `Session&` in C++.

**Interfaces**: A list of method signatures. Any type that implements those methods automatically satisfies the interface — no `implements` keyword needed. Go's "duck typing" with compile-time checks.

**Errors**: Returned as the last value alongside a result. Always check `if err != nil { return err }`. Wrapping: `fmt.Errorf("context: %w", err)`.

**Context**: `context.Context` is passed as the first parameter to every function that does I/O. It carries cancellation signals and deadlines. Always pass it through.

**Goroutines and channels**: Go's concurrency primitives. You probably won't need them much in this roadmap — most of the work is sequential request/response.

**Generics**: Added in Go 1.18. Used for the tool result types: `SingleToolResult[T any]`. The syntax is similar to TypeScript generics.

**`go run` vs `go build`**: `go run ./cmd/X` compiles and runs in one step (slower, good for dev). `go build ./...` produces a binary you can ship.

**The standard library is huge**: `net/http`, `encoding/json`, `crypto/aes`, `os`, `time`, `log/slog`, `context`, `sync` — almost everything you need is in the stdlib. Be skeptical of adding dependencies.

**Read Bridge**: When you're stuck on a Go pattern, look at how `~/Projects/proton-bridge` does it. It's a 70k-line production Go codebase using the same library. You will rarely have to invent a pattern from scratch.

# Go Migration Roadmap for `proton-mcp`

> This document is a roadmap for migrating the proton-bridge-mcp TypeScript project to a new Go project called `proton-mcp`. It is **written for Claude as the executor** in the new repo. Read it cold, follow the phases in order, verify each phase before moving to the next.

## Reference repos

You will reference two existing repositories throughout this work:

- **`~/Projects/proton-bridge-mcp`** — the TypeScript implementation being replaced. Use it as a reference for tool semantics, design decisions, test scenarios, and documentation patterns. Do not copy code; copy concepts.
- **`~/Projects/proton-bridge`** — Proton's official Bridge, written in Go. It is the canonical example of how to use `go-proton-api` correctly. When in doubt about Go patterns or API usage, look here first.

## Background reading (do this before Phase 0)

Read these files in `~/Projects/proton-bridge-mcp` before starting. They contain context that this roadmap assumes you understand:

1. [docs/proton/authentication-flows.md](proton/authentication-flows.md) — how Proton authenticates, what go-proton-api handles for you, and the TOTP/CAPTCHA discussion. The "Porting Evaluation" section explains why this migration is happening.
2. [docs/proton/bridge-label-implementation.md](proton/bridge-label-implementation.md) — how Proton Bridge virtualizes labels as IMAP folders. This is the complexity the new server escapes by going direct to the API.
3. [docs/impl/label-handling.md](impl/label-handling.md) — the rule that no virtualized path may leak into tool responses. Still applies in Go, but easier to honor because labels are native.
4. [docs/impl/operation-log-revert.md](impl/operation-log-revert.md) — the operation log + revert design. You will reimplement this in Go in Phase 5.
5. [docs/impl/mcp-tool-interfaces.md](impl/mcp-tool-interfaces.md) — tool result types (`SingleToolResult`, `BatchToolResult`, `ListToolResult`). Translate these to Go structs.

## What this migration achieves

The current TypeScript MCP server talks to ProtonMail through the Bridge IMAP daemon. This forces the server to deal with IMAP's virtualization of labels-as-folders, COPYUID resolution for label copies, Message-ID searches to find virtualized copies, UID rewriting during revert, and a connection pool. About a thousand lines of code exist solely to manage IMAP and undo its virtualization.

The Go version eliminates IMAP entirely. It uses `go-proton-api` directly — the same library that Bridge uses internally. Labels become native label IDs. UIDs become stable MessageIDs. The connection pool disappears. The label devirtualization layer disappears. Authentication is handled by go-proton-api in a single function call.

The end state is a single static Go binary that depends on no external runtime, talks directly to Proton's API, and exposes the same MCP tool surface as the TypeScript version (with two intentional changes documented below).

## Recommendation: new repo, not fork

Create a new GitHub repo named `proton-mcp`. Do not fork `proton-bridge-mcp`. Reasons:

- Different language entirely — no source is reused, only concepts and documentation
- The new server doesn't depend on Bridge, so dropping "bridge" from the name reflects reality
- A fork carries npm/Node.js git history that's irrelevant to a Go project
- The new module path is `github.com/grover/proton-mcp` — clean, no suffix
- Forking implies incremental migration; this is a clean rewrite

You will selectively copy documentation, design decisions, and assets from `~/Projects/proton-bridge-mcp` into the new repo. The old repo stays alive as the TypeScript implementation until Phase 9 cutover.

## What to retain from the old repo

### Documentation

Copy these files into the new repo with minor edits where noted:

| Source | Destination | Adaptation |
|---|---|---|
| `docs/proton/bridge-label-implementation.md` | Same path | None — historical reference |
| `docs/proton/webclient-api-extraction.md` | Same path | Add a note: "Go path was chosen — see `authentication-flows.md`" |
| `docs/proton/authentication-flows.md` | Same path | None — directly applicable |
| `docs/impl/label-handling.md` | Same path | Update opening paragraph: labels are now native, not virtualized; the no-leak rule still applies but for different reasons (consistency with input format, not protecting against IMAP UID confusion) |
| `docs/impl/operation-log-revert.md` | Same path | Translate code snippets from TypeScript to Go in Phase 5 |
| `docs/impl/mcp-tool-interfaces.md` | Same path | Translate type examples to Go structs |
| `docs/tools/README.md` | Same path | Will be updated per phase as tools land |

### Documentation to drop entirely

- `docs/IMAP.md` — no IMAP in the new server
- `docs/bridge-repair/` — Bridge-specific reference content
- `docs/plans/edd-*.md` and `docs/plans/prd-*.md` — TypeScript-specific implementation plans
- `docs/ROADMAP.md` — replaced by this roadmap
- `docs/visuals.md` — keep if it has branding info you want, drop otherwise

### Conventions to port (new CLAUDE.md)

The old `CLAUDE.md` defines project conventions and the orchestrator workflow. Most of it is language-agnostic and worth keeping. The Go-adapted version should retain:

- Operation modes (STDIO is primary; HTTP/HTTPS comes in Phase 11)
- Tool categories (`read`, `mutating`, `destructive`, `maintenance`) and annotation presets (`READ_ONLY`, `MUTATING`, `DESTRUCTIVE`)
- Operation log + revert design summary
- Interface segregation principle: tool handlers depend on interfaces, not concrete types
- Branch policy: `{type}/{issue#}-{title}` where type ∈ `bug`, `feat`, `refactor`, `docs`
- Concurrent agent safety guidance
- The orchestrator/QE/SWE/Reviewer persona rotation
- EDD/PRD format for non-trivial changes
- Engineering principles (TDD, clean code, fail fast, no fallbacks)

The Go-adapted version should drop or replace:

- Pre-commit checklist: replace `npm install -> lint -> build -> npm ci` with `go mod tidy -> go vet ./... -> golangci-lint run -> go test ./... -> go build ./...`
- TypeScript-specific notes (Zod, NodeNext ESM imports, ts-jest)
- npm-related sections (releases via release-it, MCPB packaging via build-mcpb.sh)
- Smoke test commands (replace with `go run ./cmd/smoketest`)

### Design concepts to re-implement in Go

These are patterns from the TypeScript code that should be reproduced in idiomatic Go. They are not files to copy — they are designs to translate:

1. **Tool result types** — `SingleToolResult[T]`, `BatchToolResult[T]`, `ListToolResult[T]` with a `status` field. Use Go generics (Go 1.18+).
2. **Tool categories and annotations** — same taxonomy
3. **Operation log** — ring buffer, monotonic IDs, FIFO eviction at 100 entries, no persistence
4. **Interface segregation** — `ReadOnlyMailOps` and `MutatingMailOps` become Go interfaces; tool handlers accept these as parameters
5. **`LabelInfo` with name only** — never expose IMAP paths or label IDs; same rule as TypeScript version
6. **`CreateLabelResult { Name, Created }`** — same shape, no path leakage
7. **No-op detection** — mutating operations compare before/after state, do not generate reversal entries for no-ops
8. **`--login` CLI subcommand** for first-run auth (TOTP only, no CAPTCHA, no two-password mode)
9. **MCP elicitation** for in-protocol prompts when the client supports it
10. **Encrypted session vault** — analogous to Bridge's `vault.enc`, stores `{ AuthUID, RefreshToken, KeyPass }`

### Cross-cutting concerns: the Go "middleware" pattern

The TypeScript code uses `@Audited`, `@Tracked`, and `@IrreversibleWhen` decorators. Go has no decorators. The equivalent pattern is **wrapper functions that take a closure and return a wrapped version with cross-cutting behavior added**.

Pattern:

```go
// AuditLogger writes JSONL audit events
type AuditLogger interface {
    Log(entry AuditEntry)
}

// Audited wraps a function call with audit logging.
// Generic over the return type T.
func Audited[T any](logger AuditLogger, op string, input any, fn func() (T, error)) (T, error) {
    start := time.Now()
    result, err := fn()
    logger.Log(AuditEntry{
        Operation: op,
        Input:     input,
        Duration:  time.Since(start),
        Error:     errString(err),
    })
    return result, err
}

// Usage in a method:
func (c *ProtonClient) MoveEmails(ctx context.Context, ids []EmailID, target string) (BatchResult[MoveResult], error) {
    return Audited(c.audit, "move_emails", map[string]any{"ids": ids, "target": target},
        func() (BatchResult[MoveResult], error) {
            // actual implementation
            return c.doMoveEmails(ctx, ids, target)
        })
}
```

This is the Go-idiomatic equivalent of decorators. It's slightly more verbose than TypeScript decorators but explicit — there is no hidden behavior. The same pattern works for `Tracked` (records reversal in operation log) and `IrreversibleWhen` (conditionally clears the log).

You will implement these helper functions in Phase 5 when the operation log lands.

### Tool catalog

Reuse the exact tool names and semantics from the TypeScript implementation, with two intentional changes:

| Category | Tools |
|---|---|
| **read** | `get_folders`, `get_labels`, `list_mailbox`, `fetch_summaries`, `fetch_message`, `fetch_attachment`, `search_mailbox` |
| **mutating** | `create_folder`, `create_label`, `mark_read`, `mark_unread`, `add_labels` |
| **destructive** | `move_emails`, `remove_labels`, `delete_folder`, `delete_label`, `revert_operations` |
| **maintenance** | `verify_session` |

**Change 1: `verify_connectivity` → `verify_session`.** The TypeScript tool tested IMAP connectivity by acquiring a connection from the pool and measuring round-trip latency. There is no IMAP pool in the Go version. The new `verify_session` instead:

- Verifies the stored auth session is still valid (not expired or revoked)
- Calls `client.GetUser()` as a lightweight authenticated round-trip
- Returns the user's primary email and session expiry information
- Lets agents check "is the connection working?" before attempting heavier operations

The semantics are similar (health check), but the implementation is fundamentally different. The new name reflects this.

**Change 2: `drain_connections` is dropped.** The TypeScript version drained the IMAP connection pool. There is no connection pool in the Go version — go-proton-api manages a single HTTP client internally. The maintenance category contains only `verify_session`.

### Artwork to copy

Copy these files from `~/Projects/proton-bridge-mcp/assets/` into `assets/` in the new repo. Same product, different implementation — keep the branding:

- `icon.svg`
- `small-icon.svg`
- `logo.svg`
- `icon-256.png`, `icon-64.png`, `icon-32.png`, `icon-16.png`

### What to drop entirely

- All TypeScript source under `src/`
- `package.json`, `package-lock.json`, `node_modules/`
- `tsconfig.json`, `tsconfig.test.json`, `jest.config.ts`
- `eslint.config.js`, `.prettierrc`
- `scripts/run_smoketest.sh`, `scripts/run_inspector.sh` (replaced by `go run ./cmd/smoketest`)
- All TypeScript tests
- `.release-it.json` (release-it is npm-based — replaced by `goreleaser`)

### What to adapt, not drop

- **`manifest.json`** — the MCPB format is a zip with a manifest. For the Go binary, the manifest references the compiled binary as the entrypoint instead of a Node.js script. Claude Desktop MCPB packaging is **retained** because it's the easiest install path for end users; only the manifest contents change. You will adapt this in Phase 2.

---

## Phase 0: Project Bootstrap

**Goal:** A new GitHub repo with an empty Go project that builds and passes CI.

### Tasks

- [ ] Create a new GitHub repo `proton-mcp` (private initially; make public after Phase 2 release)
- [ ] Clone it locally to `~/Projects/proton-mcp`
- [ ] Run `go mod init github.com/grover/proton-mcp`
- [ ] Add base dependencies:
  ```bash
  go get github.com/ProtonMail/go-proton-api
  go get github.com/modelcontextprotocol/go-sdk/mcp
  go get github.com/spf13/cobra
  go get github.com/joho/godotenv
  ```
- [ ] Create the directory layout:
  ```
  proton-mcp/
  ├── cmd/
  │   └── proton-mcp/
  │       └── main.go         # Cobra root command
  ├── internal/
  │   ├── auth/               # Phase 1: SRP login, vault, refresh
  │   ├── proton/             # Phase 2: ProtonClient wrapper, rate limit
  │   ├── mcp/                # Phase 2: MCP server, tool registration
  │   ├── ops/                # Phase 5: operation log, reversal specs
  │   ├── tools/              # Phase 4+: tool handlers
  │   └── audit/              # Phase 2: audit logger
  ├── assets/                 # Copied from old repo
  ├── docs/                   # Copied selectively from old repo
  ├── .github/
  │   └── workflows/
  │       ├── ci.yml          # vet + lint + test + build
  │       └── release.yml     # goreleaser, added in Phase 2
  ├── .golangci.yml           # Linter config
  ├── go.mod
  ├── go.sum
  ├── LICENSE                 # GPL-3.0 (matches go-proton-api license)
  ├── README.md               # Minimal stub for now
  ├── CLAUDE.md               # Adapted from old repo
  └── CHANGELOG.md            # Empty [Unreleased] section
  ```
- [ ] Copy `assets/` from old repo
- [ ] Copy `LICENSE` (GPL-3.0) — must match go-proton-api's license, the project is already GPL-anchored
- [ ] Write minimal `cmd/proton-mcp/main.go`:
  ```go
  package main

  import (
      "fmt"
      "os"

      "github.com/spf13/cobra"
  )

  var rootCmd = &cobra.Command{
      Use:   "proton-mcp",
      Short: "MCP server for ProtonMail via go-proton-api",
  }

  func main() {
      if err := rootCmd.Execute(); err != nil {
          fmt.Fprintln(os.Stderr, err)
          os.Exit(1)
      }
  }
  ```
- [ ] Configure `.golangci.yml` with sensible defaults: `errcheck`, `gosimple`, `govet`, `ineffassign`, `staticcheck`, `unused`, `gofmt`, `goimports`, `revive`
- [ ] Create `.github/workflows/ci.yml`:
  ```yaml
  name: CI
  on: [push, pull_request]
  jobs:
    test:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-go@v5
          with: { go-version: '1.22' }
        - run: go mod download
        - run: go vet ./...
        - uses: golangci/golangci-lint-action@v6
          with: { version: latest }
        - run: go test ./...
        - run: go build ./...
  ```
- [ ] Adapt `CLAUDE.md` from the old repo following the conventions list above
- [ ] Initial `CHANGELOG.md` with empty `[Unreleased]` section
- [ ] Initial `README.md` with project description and "under active development" warning

### Build tooling decision: no Makefile

Makefiles are not idiomatic for Go projects. Use the `go` command directly for everything:

- `go build ./...` — build all packages
- `go test ./...` — run all tests
- `go vet ./...` — static analysis
- `golangci-lint run` — comprehensive linting
- `go run ./cmd/proton-mcp serve` — run the server in dev mode

For complex multi-step tasks (smoke tests, releases), put the orchestration logic in a `cmd/<task>/main.go` file and invoke with `go run ./cmd/<task>`. This keeps everything in Go, avoids shell escaping, works cross-platform, and adds no dependencies.

Examples in the new repo:
- `cmd/proton-mcp/main.go` — the main binary (login + serve subcommands)
- `cmd/smoketest/main.go` — smoke test harness (added in Phase 3)

There is no `Makefile`. There are no shell scripts in `scripts/`. Every developer task runs through `go run` or `go test`.

### Verification

- [ ] `go build ./...` succeeds with no warnings
- [ ] `go vet ./...` produces no output
- [ ] `golangci-lint run` produces no findings
- [ ] CI workflow runs and passes on push
- [ ] `go run ./cmd/proton-mcp` prints help text
- [ ] `git log --oneline` shows a clean initial commit + bootstrap commit

### Commit

```
chore: bootstrap proton-mcp project structure

Initial Go module, directory layout, CI workflow, and adapted CLAUDE.md.
Assets and core docs copied from proton-bridge-mcp.
```

---

## Phase 1: Authentication MVP

**Goal:** A working `proton-mcp login` subcommand that authenticates against the real Proton API, stores the session encrypted on disk, and refreshes the token on subsequent runs.

### Background

Read [docs/proton/authentication-flows.md](proton/authentication-flows.md) section "Recommendation for MCP Server Auth" before starting. The recommended design is "first run interactive, steady state headless". This phase implements the first run.

The reference implementation for SRP login + token storage is `~/Projects/proton-bridge/internal/bridge/user.go`, function `LoginFull` (lines 194-247). Read it. You will implement essentially the same flow, minus the GUI callback indirection.

### Tasks

- [ ] Create `internal/auth/login.go` with the login flow:
  ```go
  package auth

  import (
      "context"
      "errors"
      "fmt"

      "github.com/ProtonMail/go-proton-api"
  )

  type Credentials struct {
      Username string
      Password string
  }

  type Session struct {
      AuthUID      string
      RefreshToken string
      KeyPass      []byte // Salted mailbox password for key decryption
      UserID       string
      PrimaryEmail string
  }

  func Login(ctx context.Context, manager *proton.Manager, creds Credentials, getTOTP func() (string, error)) (*Session, error) {
      client, auth, err := manager.NewClientWithLogin(ctx, creds.Username, []byte(creds.Password))
      if err != nil {
          return nil, fmt.Errorf("login failed: %w", err)
      }

      // Reject two-password mode — not supported in this server
      if auth.PasswordMode == proton.TwoPasswordMode {
          _ = client.AuthDelete(ctx)
          return nil, errors.New("two-password mode is not supported by proton-mcp; please use single-password mode")
      }

      // Handle 2FA if required
      if auth.TwoFA.Enabled & proton.HasTOTP != 0 {
          totp, err := getTOTP()
          if err != nil {
              _ = client.AuthDelete(ctx)
              return nil, fmt.Errorf("TOTP required: %w", err)
          }
          if err := client.Auth2FA(ctx, proton.Auth2FAReq{TwoFactorCode: totp}); err != nil {
              _ = client.AuthDelete(ctx)
              return nil, fmt.Errorf("2FA failed: %w", err)
          }
      }

      // FIDO2 not supported
      if auth.TwoFA.Enabled & proton.HasFIDO2 != 0 && auth.TwoFA.Enabled & proton.HasTOTP == 0 {
          _ = client.AuthDelete(ctx)
          return nil, errors.New("FIDO2-only 2FA is not supported; please enable TOTP")
      }

      // Fetch user info and key salts
      user, err := client.GetUser(ctx)
      if err != nil {
          _ = client.AuthDelete(ctx)
          return nil, fmt.Errorf("get user failed: %w", err)
      }
      salts, err := client.GetSalts(ctx)
      if err != nil {
          _ = client.AuthDelete(ctx)
          return nil, fmt.Errorf("get salts failed: %w", err)
      }

      // Salt the password to derive the key password
      saltedKeyPass, err := salts.SaltForKey([]byte(creds.Password), user.Keys.Primary().ID)
      if err != nil {
          _ = client.AuthDelete(ctx)
          return nil, fmt.Errorf("salt for key failed: %w", err)
      }

      // Verify the key password actually unlocks the user's primary key
      if _, err := user.Keys.Unlock(saltedKeyPass, nil); err != nil {
          _ = client.AuthDelete(ctx)
          return nil, fmt.Errorf("key unlock failed: %w", err)
      }

      return &Session{
          AuthUID:      auth.UID,
          RefreshToken: auth.RefreshToken,
          KeyPass:      saltedKeyPass,
          UserID:       user.ID,
          PrimaryEmail: user.Email,
      }, nil
  }
  ```
- [ ] Create `internal/auth/vault.go` with AES-256-GCM encryption:
  ```go
  package auth

  import (
      "crypto/aes"
      "crypto/cipher"
      "crypto/rand"
      "encoding/json"
      "errors"
      "io"
      "os"
      "path/filepath"
  )

  const vaultFileName = "session.enc"

  // Save encrypts the session and writes it to disk
  func SaveSession(s *Session, vaultDir string, encryptionKey []byte) error {
      data, err := json.Marshal(s)
      if err != nil {
          return err
      }
      block, err := aes.NewCipher(encryptionKey)
      if err != nil {
          return err
      }
      gcm, err := cipher.NewGCM(block)
      if err != nil {
          return err
      }
      nonce := make([]byte, gcm.NonceSize())
      if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
          return err
      }
      ciphertext := gcm.Seal(nonce, nonce, data, nil)
      if err := os.MkdirAll(vaultDir, 0700); err != nil {
          return err
      }
      return os.WriteFile(filepath.Join(vaultDir, vaultFileName), ciphertext, 0600)
  }

  // Load reads and decrypts the session from disk
  func LoadSession(vaultDir string, encryptionKey []byte) (*Session, error) {
      ciphertext, err := os.ReadFile(filepath.Join(vaultDir, vaultFileName))
      if err != nil {
          return nil, err
      }
      block, err := aes.NewCipher(encryptionKey)
      if err != nil {
          return nil, err
      }
      gcm, err := cipher.NewGCM(block)
      if err != nil {
          return nil, err
      }
      if len(ciphertext) < gcm.NonceSize() {
          return nil, errors.New("vault file too short")
      }
      nonce := ciphertext[:gcm.NonceSize()]
      ct := ciphertext[gcm.NonceSize():]
      plaintext, err := gcm.Open(nil, nonce, ct, nil)
      if err != nil {
          return nil, err
      }
      var s Session
      if err := json.Unmarshal(plaintext, &s); err != nil {
          return nil, err
      }
      return &s, nil
  }
  ```
- [ ] Create `internal/auth/keyderive.go` to derive the vault encryption key. Use a combination of machine ID + a random salt stored alongside the vault. This protects against the vault file being copied to another machine. (Bridge does something similar with platform keychain integration; for simplicity, derive from `/etc/machine-id` on Linux, system UUID on macOS, machine GUID on Windows. Document this isn't bulletproof — it's a deterrent against accidental disclosure.)
- [ ] Create `internal/auth/refresh.go`:
  ```go
  package auth

  import (
      "context"
      "fmt"

      "github.com/ProtonMail/go-proton-api"
  )

  // Refresh creates a fresh authenticated client from a stored session
  func Refresh(ctx context.Context, manager *proton.Manager, s *Session) (*proton.Client, *Session, error) {
      client, newAuth, err := manager.NewClientWithRefresh(ctx, s.AuthUID, s.RefreshToken)
      if err != nil {
          return nil, nil, fmt.Errorf("refresh failed: %w", err)
      }
      // Update session with new tokens (refresh tokens rotate)
      s.AuthUID = newAuth.UID
      s.RefreshToken = newAuth.RefreshToken
      return client, s, nil
  }
  ```
- [ ] Add the `login` Cobra subcommand to `cmd/proton-mcp/main.go`:
  ```go
  var loginCmd = &cobra.Command{
      Use:   "login",
      Short: "Authenticate with Proton and store an encrypted session",
      RunE:  runLogin,
  }

  func runLogin(cmd *cobra.Command, args []string) error {
      // Prompt for credentials via stdin
      // Call auth.Login with a TOTP callback that prompts via stdin
      // Save session via auth.SaveSession
      // Print success message with primary email
  }
  ```
- [ ] Use `golang.org/x/term` for password input that doesn't echo to the terminal
- [ ] Document failure modes in the error messages: two-password mode, FIDO2-only, human verification required (CAPTCHA), TOTP required but no TTY

### Verification

- [ ] `go run ./cmd/proton-mcp login` prompts for username, password (hidden), TOTP if enabled
- [ ] On success, prints "Logged in as user@protonmail.com" and creates `~/.proton-mcp/session.enc`
- [ ] The session file is mode 0600 and unreadable as plain text
- [ ] Running `login` again overwrites the previous session
- [ ] If Proton requires CAPTCHA (HV), the command exits with a clear error message instructing the user to wait or change network
- [ ] If the account uses two-password mode, the command exits with a clear error
- [ ] Unit tests for `vault.go` (encrypt/decrypt round-trip, tamper detection)
- [ ] Unit tests for the Cobra command structure (cobra makes this easy)

### Commit

```
feat: add login subcommand with SRP auth and encrypted session vault

Implements interactive login via go-proton-api SRP. Stores AuthUID,
RefreshToken, and salted key password in AES-256-GCM encrypted vault
at ~/.proton-mcp/session.enc. Supports TOTP 2FA via stdin prompt.

Two-password mode and FIDO2-only 2FA are explicitly rejected.
CAPTCHA / human verification is not handled — user must wait or
change network.
```

---

## Phase 2: MCP Server Skeleton + Distribution + First Release

**Goal:** A working `proton-mcp serve` subcommand that loads the encrypted session, refreshes the token, and exposes the `verify_session` tool over MCP STDIO. Plus full distribution: goreleaser, MCPB packaging, GitHub Releases. First installable artifact.

### Background

Read the Go MCP SDK documentation at `github.com/modelcontextprotocol/go-sdk` (the README and examples). The key concepts are `mcp.NewServer`, tool registration with `mcp.Tool`, and STDIO transport via `mcp.NewStdioServerTransport`.

This phase intentionally has only one tool (`verify_session`) so that all the infrastructure (server skeleton, audit logging, rate limiting, distribution, MCPB packaging, releases) is built and proven before any real tool work begins.

### Tasks

#### Server skeleton

- [ ] Create `internal/proton/client.go` — a thin wrapper around `proton.Client` that adds:
  - Rate limit handling (retry on 429 with `Retry-After`)
  - Structured error mapping (convert go-proton-api errors to MCP-friendly errors)
  - A reference to the `AuditLogger`
- [ ] Create `internal/audit/logger.go` — JSONL audit log to a file:
  ```go
  type AuditEntry struct {
      Timestamp time.Time `json:"ts"`
      Operation string    `json:"op"`
      Input     any       `json:"input,omitempty"`
      Duration  string    `json:"duration"`
      Error     string    `json:"error,omitempty"`
  }

  type AuditLogger interface {
      Log(entry AuditEntry)
      Close() error
  }
  ```
- [ ] Implement `Audited` generic helper in `internal/audit/middleware.go` per the pattern shown above
- [ ] Create `internal/proton/ratelimit.go` — wrap API calls in a retry loop:
  ```go
  func WithRateLimit[T any](ctx context.Context, fn func() (T, error)) (T, error) {
      const maxRetries = 5
      var zero T
      for attempt := 0; attempt <= maxRetries; attempt++ {
          result, err := fn()
          if err == nil {
              return result, nil
          }
          var apiErr *proton.APIError
          if errors.As(err, &apiErr) && apiErr.Status == 429 {
              retryAfter := parseRetryAfter(apiErr) // from header or default
              select {
              case <-ctx.Done():
                  return zero, ctx.Err()
              case <-time.After(retryAfter):
                  continue
              }
          }
          return zero, err
      }
      return zero, errors.New("rate limit exceeded after retries")
  }
  ```
- [ ] Create `internal/mcp/server.go` — initialize the MCP server, register tools:
  ```go
  package mcp

  import (
      "context"

      "github.com/modelcontextprotocol/go-sdk/mcp"
      "github.com/grover/proton-mcp/internal/proton"
  )

  func NewServer(client *proton.Client) *mcp.Server {
      s := mcp.NewServer("proton-mcp", "0.1.0")
      RegisterVerifySession(s, client)
      return s
  }
  ```
- [ ] Create `internal/mcp/tools/verify_session.go` — the first tool:
  ```go
  package tools

  import (
      "context"

      "github.com/modelcontextprotocol/go-sdk/mcp"
      "github.com/grover/proton-mcp/internal/proton"
  )

  type VerifySessionResult struct {
      Email           string `json:"email"`
      UserID          string `json:"userId"`
      SessionValid    bool   `json:"sessionValid"`
  }

  func RegisterVerifySession(s *mcp.Server, client *proton.Client) {
      s.AddTool(mcp.Tool{
          Name:        "verify_session",
          Description: "Verify the Proton API session is valid. Returns the authenticated user's email.",
          // Annotations: ReadOnly hint, no destructive
      }, func(ctx context.Context, _ struct{}) (VerifySessionResult, error) {
          user, err := client.GetUser(ctx)
          if err != nil {
              return VerifySessionResult{SessionValid: false}, err
          }
          return VerifySessionResult{
              Email:        user.Email,
              UserID:       user.ID,
              SessionValid: true,
          }, nil
      })
  }
  ```
- [ ] Add the `serve` Cobra subcommand to `cmd/proton-mcp/main.go`:
  ```go
  var serveCmd = &cobra.Command{
      Use:   "serve",
      Short: "Start the MCP server (STDIO transport)",
      RunE:  runServe,
  }

  func runServe(cmd *cobra.Command, args []string) error {
      ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
      defer cancel()

      // Load session from vault
      session, err := auth.LoadSession(vaultDir, encryptionKey)
      if err != nil {
          return fmt.Errorf("load session: %w (run 'proton-mcp login' first)", err)
      }

      // Refresh token
      manager := proton.New(...)
      client, session, err := auth.Refresh(ctx, manager, session)
      if err != nil {
          return fmt.Errorf("refresh failed: %w", err)
      }
      // Save updated session (refresh tokens rotate)
      _ = auth.SaveSession(session, vaultDir, encryptionKey)

      // Wrap client with rate limit + audit
      protonClient := proton.NewClient(client, auditLogger)

      // Build MCP server
      mcpServer := mcp.NewServer(protonClient)

      // Run on STDIO transport
      transport := mcp.NewStdioServerTransport()
      return mcpServer.Serve(ctx, transport)
  }
  ```

#### Distribution

- [ ] Create `.goreleaser.yml`:
  ```yaml
  project_name: proton-mcp
  builds:
    - main: ./cmd/proton-mcp
      binary: proton-mcp
      env: [CGO_ENABLED=0]
      goos: [linux, darwin, windows]
      goarch: [amd64, arm64]
      ignore:
        - { goos: windows, goarch: arm64 }
  archives:
    - format: tar.gz
      format_overrides:
        - { goos: windows, format: zip }
  release:
    github:
      owner: grover
      name: proton-mcp
  changelog:
    sort: asc
  ```
- [ ] Create `.github/workflows/release.yml`:
  ```yaml
  name: Release
  on:
    push:
      tags: ['v*']
  jobs:
    goreleaser:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
          with: { fetch-depth: 0 }
        - uses: actions/setup-go@v5
          with: { go-version: '1.22' }
        - uses: goreleaser/goreleaser-action@v6
          with:
            args: release --clean
          env:
            GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        - name: Build MCPB package
          run: go run ./cmd/build-mcpb
        - name: Upload MCPB to release
          # ... attach proton-mcp.mcpb to the release
  ```

#### MCPB packaging

- [ ] Create `manifest.json` in the repo root, adapted from the old repo. Reference the Go binary instead of a Node.js script. Read the old `manifest.json` first to understand the schema.
- [ ] Create `cmd/build-mcpb/main.go` — a Go program that builds the `.mcpb` zip:
  - Reads `manifest.json`
  - Includes `proton-mcp` (the compiled binary for the current platform)
  - Includes `assets/icon.svg` and other assets referenced in the manifest
  - Zips everything to `proton-mcp.mcpb`
- [ ] Document MCPB installation in `README.md`

#### Documentation

- [ ] Update `README.md` with:
  - Project description
  - Install instructions (download from releases, or `go install`)
  - Quickstart (`login`, then `serve`)
  - List of tools (just `verify_session` for now)
  - Note that this is v0.1.0 — feature parity work in progress
- [ ] Add `[v0.1.0]` section to `CHANGELOG.md`
- [ ] Document the configuration model in `docs/configuration.md` (currently just the vault location)

### Verification

- [ ] `go run ./cmd/proton-mcp serve` (after `login`) starts the server, blocks on stdin
- [ ] Connect via the MCP Inspector (`npx @modelcontextprotocol/inspector`) using STDIO transport pointed at the serve command
- [ ] `verify_session` appears in the tool list
- [ ] Calling `verify_session` returns the real user's email
- [ ] Audit log file is created and contains a JSONL entry per tool call
- [ ] `goreleaser release --snapshot --clean` produces binaries for all platforms in `dist/`
- [ ] `go run ./cmd/build-mcpb` produces a valid `proton-mcp.mcpb` file
- [ ] Installing the MCPB in Claude Desktop makes `verify_session` available
- [ ] CI passes
- [ ] Tag `v0.1.0` and verify the release workflow produces a GitHub Release with all binaries and the MCPB

### Commit and release

```
feat: add MCP server skeleton with verify_session and full distribution

- serve subcommand starts the MCP server on STDIO
- verify_session tool returns authenticated user info
- Rate limit handling via retry on 429 with Retry-After
- JSONL audit logger
- goreleaser config for cross-platform binaries
- Adapted manifest.json + build-mcpb for Claude Desktop packaging
- Tag v0.1.0
```

---

## Phase 3: Smoke Testing Infrastructure

**Goal:** A reliable smoke test harness that runs against both the real Proton API (interactive) and an in-process fake server (automated, headless, CI-suitable).

### Background

Read `~/Projects/proton-bridge/tests/api_test.go` to see how Bridge uses the `go-proton-api/server.Server` fake API server for its own integration tests. The fake server is part of the go-proton-api package and exposes the full API surface as an in-process HTTP server with a deterministic dataset.

### Tasks

- [ ] Create `cmd/smoketest/main.go` with two modes:
  ```go
  package main

  import (
      "flag"
      "log"
  )

  func main() {
      fakeMode := flag.Bool("fake", false, "Run against in-process fake server instead of real Proton API")
      flag.Parse()

      if *fakeMode {
          runFakeMode()
      } else {
          runRealMode()
      }
  }
  ```

#### Mode A: Real account

- [ ] `go run ./cmd/smoketest` (no `--fake`):
  - Pre-flight: kill any process holding the Inspector port (use `lsof -ti tcp:6277 | xargs kill` style logic from the old repo's `run_smoketest.sh`)
  - Load `.env` via `github.com/joho/godotenv`
  - Verify the user has run `proton-mcp login` previously (check vault file exists). **Do not** prompt for TOTP from the smoke test command — that's a manual one-time setup step.
  - Start `proton-mcp serve` as a subprocess
  - Start the MCP Inspector pointed at the serve subprocess
  - Print connection details to stdout
  - Wait for SIGINT to clean up

#### Mode B: Fake server (CI-suitable)

- [ ] `go run ./cmd/smoketest --fake`:
  - Spin up `go-proton-api/server.Server` in-process
  - Pre-populate it with deterministic test data:
    - A test user with a known password
    - Several labels (system + custom)
    - Several folders
    - Messages in INBOX with a mix of: read/unread, with/without attachments, in various labels
  - Authenticate against the fake server (using the test password)
  - Start the MCP server pointing at the fake server URL
  - Run scripted scenarios as direct MCP protocol calls (no Inspector UI)
  - Assert expected outcomes
  - Tear down everything cleanly
  - Exit non-zero on any assertion failure

- [ ] Create `internal/testfixtures/fakeserver.go` with helpers to set up the fake server with deterministic data
- [ ] Create `internal/testfixtures/scenarios.go` with the scripted scenarios per phase

### Scenarios per phase

The fake-server scenarios grow as each phase adds tools:

| Phase | Scenarios |
|---|---|
| 3 (this phase) | `verify_session` returns the test user's email — proves end-to-end harness works |
| 4 | + `get_folders`, `get_labels`, `list_mailbox`, `fetch_summaries`, verify attachment metadata in summaries |
| 5 | + `mark_read` an email, verify it's read, `revert_operations`, verify it's unread again |
| 6 | + `create_folder` with a path, verify it appears in `get_folders`, `delete_folder`, verify it's gone |
| 7 | + `move_emails` from INBOX to a folder, verify; `add_labels` then `remove_labels`, verify |
| 8 | + `fetch_message` returns a body; `fetch_attachment` returns base64 content |

`verify_session` is included in **every** phase's scenarios as a sanity check.

### Tasks for documentation

- [ ] Create `docs/smoke-tests.md` listing all current scenarios
- [ ] Update `README.md` with the smoke test instructions
- [ ] Add a CI job that runs `go run ./cmd/smoketest --fake` on every push

### Verification

- [ ] `go run ./cmd/smoketest --fake` runs end-to-end against the fake server in <10 seconds, exits 0
- [ ] CI runs the fake-mode smoke test and reports pass/fail
- [ ] `go run ./cmd/smoketest` (real mode) starts the Inspector, connects to the real Proton account, and `verify_session` returns the user's email
- [ ] The fake server scenarios are documented in `docs/smoke-tests.md`

### Commit

```
test: add smoke test infrastructure with fake server automation

Mode A: interactive harness against real Proton account via Inspector.
Mode B: headless scripted scenarios against go-proton-api fake server.
CI runs Mode B on every push.
```

---

## Phase 4: Read Tools (with redesigned summaries from day one)

**Goal:** Ship the four basic read tools (`get_folders`, `get_labels`, `list_mailbox`, `fetch_summaries`) with attachment metadata in summaries from the start. Release v0.2.0.

### Background

The TypeScript implementation has open issue #57 to move attachment metadata from `fetch_message` into `EmailSummary`. The Go port should ship the redesigned shape from the very first read tool — no later breaking change.

Read `~/Projects/proton-bridge/internal/services/imapservice/connector.go` for how Bridge calls `client.GetMessageMetadataPage` and similar methods. The pagination patterns and label filtering are the relevant references.

### Tasks

#### Types

- [ ] Create `internal/types/email.go` with the data types:
  ```go
  package types

  type EmailID = string // ProtonMail message ID, opaque

  type AttachmentMetadata struct {
      Filename    string `json:"filename"`
      Size        int    `json:"size"`
      ContentType string `json:"contentType"`
      PartID      string `json:"partId"`
  }

  type EmailSummary struct {
      ID          EmailID              `json:"id"`
      Subject     string               `json:"subject"`
      From        string               `json:"from"`
      To          []string             `json:"to"`
      Date        time.Time            `json:"date"`
      Unread      bool                 `json:"unread"`
      LabelIDs    []string             `json:"labelIds"`
      Attachments []AttachmentMetadata `json:"attachments,omitempty"`
  }

  type FolderInfo struct {
      ID           string `json:"id"`
      Path         string `json:"path"`
      MessageCount int    `json:"messageCount"`
      UnreadCount  int    `json:"unreadCount"`
  }

  type LabelInfo struct {
      // No path, no ID — labels expose name only
      Name         string `json:"name"`
      MessageCount int    `json:"messageCount"`
      UnreadCount  int    `json:"unreadCount"`
  }
  ```
  Note: `LabelInfo` deliberately omits the label ID. The MCP server uses label names externally and resolves them to IDs internally. This matches the TypeScript design.

#### Tool result types

- [ ] Create `internal/mcp/results.go` with the generic result wrappers:
  ```go
  type ToolStatus string

  const (
      StatusSucceeded ToolStatus = "succeeded"
      StatusPartial   ToolStatus = "partial"
      StatusFailed    ToolStatus = "failed"
  )

  type SingleToolResult[T any] struct {
      Status ToolStatus `json:"status"`
      Data   T          `json:"data"`
  }

  type ListToolResult[T any] struct {
      Status ToolStatus `json:"status"`
      Items  []T        `json:"items"`
  }

  type BatchItemResult[T any] struct {
      ID     string  `json:"id"`
      Status string  `json:"status"`
      Data   *T      `json:"data,omitempty"`
      Error  *string `json:"error,omitempty"`
  }

  type BatchToolResult[T any] struct {
      Status ToolStatus            `json:"status"`
      Items  []BatchItemResult[T]  `json:"items"`
  }
  ```

#### Tools

- [ ] Implement `internal/mcp/tools/get_folders.go`:
  - Calls `client.GetLabels()` (which returns ALL labels including system, folder, label)
  - Filters to `LabelTypeFolder` + system folders (Inbox, Sent, Drafts, Trash, etc.)
  - Maps each to `FolderInfo` with its path
  - Returns `ListToolResult[FolderInfo]`
- [ ] Implement `internal/mcp/tools/get_labels.go`:
  - Calls `client.GetLabels()`
  - Filters to `LabelTypeLabel` only
  - Maps each to `LabelInfo` (name only — no ID, no path)
  - Returns `ListToolResult[LabelInfo]`
- [ ] Implement `internal/mcp/tools/list_mailbox.go`:
  - Input: `{ mailbox: string, limit: int, offset: int }`
  - Resolves the mailbox name to a label ID (system folders use known IDs; user folders/labels via `GetLabels()` lookup)
  - Calls `client.GetMessageMetadataPage()` with pagination
  - Maps each `proton.MessageMetadata` to `EmailSummary`, including attachment metadata from `AttachmentInfo`
  - Returns `ListToolResult[EmailSummary]`
- [ ] Implement `internal/mcp/tools/fetch_summaries.go`:
  - Input: `{ ids: []string }`
  - Calls `client.GetMessageMetadataPage()` filtered by IDs
  - Same mapping as `list_mailbox`
  - Returns `ListToolResult[EmailSummary]`
- [ ] Register all four tools in `internal/mcp/server.go`
- [ ] Add unit tests for the type mapping (proton.MessageMetadata -> EmailSummary)

#### Tests

- [ ] Add scenarios to `cmd/smoketest/main.go` Mode B:
  - List folders, assert INBOX is present
  - List labels, assert no IDs leak in the output
  - List INBOX, assert at least one summary has attachment metadata
  - Fetch summaries by ID, assert same shape as list_mailbox

#### Documentation

- [ ] Add tool entries to `docs/tools/README.md`
- [ ] Update `[Unreleased]` in `CHANGELOG.md`
- [ ] Update `README.md` to list the new tools

### Verification

- [ ] All four tools work via the MCP Inspector against a real account
- [ ] Fake-server smoke test passes for Phase 4 scenarios
- [ ] `LabelInfo` JSON output contains no `id` or `path` field — only `name`, `messageCount`, `unreadCount`
- [ ] Summaries with attachments have populated `attachments` arrays
- [ ] Tag `v0.2.0` and release

### Commit and release

```
feat: add read tools (get_folders, get_labels, list_mailbox, fetch_summaries)

EmailSummary includes attachment metadata from day one (issue #57 from
the TypeScript repo). LabelInfo exposes name only — no IDs or paths.

Tag v0.2.0
```

---

## Phase 5: Operation Log + First Reversible Tools

**Goal:** Build the operation log infrastructure and ship the simplest reversible tools (`mark_read`, `mark_unread`) plus `revert_operations`. Release v0.3.0.

### Background

Read [docs/impl/operation-log-revert.md](impl/operation-log-revert.md) for the design rationale. Translate the TypeScript snippets to Go. The Go version is structurally simpler because there's no IMAP UID instability — MessageIDs are stable, so the UID rewriting chain from the TypeScript implementation doesn't apply.

### Tasks

#### Operation log

- [ ] Create `internal/ops/log.go`:
  ```go
  package ops

  import (
      "sync"
      "time"
  )

  type ReversalSpec interface {
      reversalSpec() // marker method
  }

  type NoopReversal struct{}
  func (NoopReversal) reversalSpec() {}

  type MarkReadReversal struct {
      IDs []string
  }
  func (MarkReadReversal) reversalSpec() {}

  type MarkUnreadReversal struct {
      IDs []string
  }
  func (MarkUnreadReversal) reversalSpec() {}

  // ... more reversal types added in later phases

  type OperationRecord struct {
      ID        int64
      Tool      string
      Reversal  ReversalSpec
      Timestamp time.Time
  }

  const maxLogSize = 100

  type Log struct {
      mu      sync.Mutex
      seq     int64
      records []OperationRecord
  }

  func NewLog() *Log {
      return &Log{records: make([]OperationRecord, 0, maxLogSize)}
  }

  func (l *Log) Push(tool string, reversal ReversalSpec) int64 {
      l.mu.Lock()
      defer l.mu.Unlock()
      l.seq++
      record := OperationRecord{
          ID:        l.seq,
          Tool:      tool,
          Reversal:  reversal,
          Timestamp: time.Now(),
      }
      l.records = append(l.records, record)
      if len(l.records) > maxLogSize {
          l.records = l.records[len(l.records)-maxLogSize:]
      }
      return record.ID
  }

  // GetFrom returns records from the given ID forward, in reverse-chronological order
  func (l *Log) GetFrom(id int64) []OperationRecord {
      l.mu.Lock()
      defer l.mu.Unlock()
      var found []OperationRecord
      for _, r := range l.records {
          if r.ID >= id {
              found = append(found, r)
          }
      }
      // Reverse for chronological-newest-first
      for i, j := 0, len(found)-1; i < j; i, j = i+1, j-1 {
          found[i], found[j] = found[j], found[i]
      }
      return found
  }

  func (l *Log) Has(id int64) bool {
      l.mu.Lock()
      defer l.mu.Unlock()
      for _, r := range l.records {
          if r.ID == id {
              return true
          }
      }
      return false
  }

  func (l *Log) Clear() {
      l.mu.Lock()
      defer l.mu.Unlock()
      l.records = l.records[:0]
  }
  ```

#### Tracked middleware

- [ ] Create `internal/ops/middleware.go`:
  ```go
  // Tracked wraps a tool call and records its reversal in the operation log on success.
  // The buildReversal callback receives the result and returns either a reversal spec
  // or NoopReversal (for no-op cases like marking an already-read email as read).
  func Tracked[T any](
      log *Log,
      tool string,
      fn func() (T, error),
      buildReversal func(T) ReversalSpec,
  ) (T, int64, error) {
      result, err := fn()
      if err != nil {
          var zero T
          return zero, 0, err
      }
      reversal := buildReversal(result)
      opID := log.Push(tool, reversal)
      return result, opID, nil
  }

  // IrreversibleWhen clears the entire log if the predicate returns true after success.
  // Used by destructive operations like delete_folder where reversal of prior operations
  // becomes impossible.
  func IrreversibleWhen[T any](
      log *Log,
      fn func() (T, error),
      shouldClear func(T) bool,
  ) (T, error) {
      result, err := fn()
      if err == nil && shouldClear(result) {
          log.Clear()
      }
      return result, err
  }
  ```

#### Tools

- [ ] Implement `internal/mcp/tools/mark_read.go`:
  - Input: `{ ids: []string }`
  - Idempotency: fetch metadata first, only mark unread emails as read
  - Call `client.MarkMessagesRead(ctx, ids...)`
  - Build reversal: `MarkReadReversal{IDs: actuallyChangedIDs}` (or NoopReversal if nothing changed)
  - Return `BatchToolResult[MarkReadResult]` with `operationId`
- [ ] Implement `internal/mcp/tools/mark_unread.go` — same pattern, inverted
- [ ] Implement `internal/mcp/tools/revert_operations.go`:
  - Input: `{ operationId: int64 }`
  - Validates the operation ID exists in the log (else `UNKNOWN_OPERATION_ID`)
  - Walks log from the given ID forward in reverse-chronological order
  - For each record, executes the reversal:
    - `MarkReadReversal` -> `client.MarkMessagesUnread(ids)`
    - `MarkUnreadReversal` -> `client.MarkMessagesRead(ids)`
    - `NoopReversal` -> do nothing
  - Returns `RevertResult` with per-step status
- [ ] Wire `mark_read` and `mark_unread` to use `Tracked` middleware

#### Tests

- [ ] Add scenarios to fake-server smoke test:
  - Mark an unread email as read, verify it's read
  - Capture the operationId from the response
  - Call `revert_operations` with that ID
  - Verify the email is unread again
  - Mark an already-read email as read, verify NoopReversal was recorded

#### Documentation

- [ ] Document the operation log pattern in `docs/impl/operation-log-revert.md` (port from TS version with Go snippets)
- [ ] Add tool entries to `docs/tools/README.md`
- [ ] Update `[Unreleased]` in `CHANGELOG.md`

### Verification

- [ ] Mark/unmark round-trip via the Inspector
- [ ] Revert restores state
- [ ] Idempotency: marking an already-read email as read records a NoopReversal
- [ ] Fake-server smoke test passes
- [ ] Tag `v0.3.0` and release

### Commit and release

```
feat: add operation log + mark_read/mark_unread + revert_operations

Implements the operation log ring buffer (100 entries, monotonic IDs)
and the Tracked/IrreversibleWhen middleware helpers. mark_read and
mark_unread are the first reversible tools, with idempotency-aware
no-op detection.

Tag v0.3.0
```

---

## Phase 6: Folder/Label Management

**Goal:** Ship `create_folder`, `create_label`, `delete_folder`, `delete_label`. Release v0.4.0.

### Tasks

- [ ] Add reversal types to `internal/ops/log.go`:
  ```go
  type CreateFolderReversal struct {
      Path string
  }
  func (CreateFolderReversal) reversalSpec() {}

  type CreateLabelReversal struct {
      Name string
  }
  func (CreateLabelReversal) reversalSpec() {}
  ```
- [ ] Implement `internal/mcp/tools/create_folder.go`:
  - Input: `{ path: string }`
  - Validate path starts with `Folders/` and is non-trivial
  - Call `client.CreateLabel(LabelTypeFolder, ...)` with parent ID resolution for nested paths (see Bridge's `createFolder` in `connector.go` for reference)
  - On success: `CreateFolderReversal{Path: path}` for the operation log
  - Return `SingleToolResult[CreateFolderResult]` with `{ path, created }`
  - Idempotency: if the folder already exists, return `{ created: false }` and `NoopReversal`
- [ ] Implement `internal/mcp/tools/create_label.go`:
  - Input: `{ name: string }`
  - Validate name does not contain `/`
  - Call `client.CreateLabel(LabelTypeLabel, name)` (no parent — labels are flat)
  - On success: `CreateLabelReversal{Name: name}`
  - Return `{ name, created }` (NOT `path` — see [docs/impl/label-handling.md](impl/label-handling.md))
  - Idempotency: if the label already exists, return `{ created: false }` and `NoopReversal`
- [ ] Implement `internal/mcp/tools/delete_folder.go`:
  - Input: `{ path: string }`
  - Validate path starts with `Folders/`
  - Reject if it's a special-use folder
  - Call `client.DeleteLabel(folderID)`
  - Use `IrreversibleWhen` middleware: when `deleted == true`, clear the entire operation log
  - Return `{ path, deleted }`
  - Idempotency: if the folder doesn't exist, return `{ deleted: false }` (do not clear log)
- [ ] Implement `internal/mcp/tools/delete_label.go`:
  - Input: `{ name: string }`
  - Resolve name -> label ID
  - Call `client.DeleteLabel(labelID)`
  - Use `IrreversibleWhen` middleware
  - Return `{ name, deleted }`
- [ ] Add reversal execution for `CreateFolderReversal` and `CreateLabelReversal` in `revert_operations`:
  - `CreateFolderReversal{Path}` -> `delete_folder(path)`
  - `CreateLabelReversal{Name}` -> `delete_label(name)`
- [ ] Add scenarios to fake-server smoke test:
  - Create a folder, assert it appears in `get_folders`
  - Delete it, assert it's gone
  - Create a label, assert it appears in `get_labels`
  - Delete it
  - Create-then-revert: verify the folder/label is deleted by the revert

### Documentation

- [ ] Tool entries in `docs/tools/README.md`
- [ ] CHANGELOG entry

### Verification

- [ ] All four tools work via Inspector
- [ ] Fake-server smoke test passes
- [ ] Idempotency verified
- [ ] `delete_folder` clearing the log is verified by attempting a revert after a delete (should fail with UNKNOWN_OPERATION_ID)
- [ ] Tag `v0.4.0` and release

### Commit

```
feat: add folder/label CRUD tools

create_folder, create_label, delete_folder, delete_label.
Idempotent — repeated calls are no-ops. delete_folder and delete_label
are IrreversibleWhen, clearing the operation log on actual deletion.

Tag v0.4.0
```

---

## Phase 7: Email Movement and Labels

**Goal:** Ship `move_emails`, `add_labels`, `remove_labels`. Release v0.5.0.

### Background

Read `~/Projects/proton-bridge/internal/services/imapservice/connector.go` `MoveMessages` (around line 506) for the asymmetric label/folder MOVE logic. The bridge handles:
- Moving between labels: label destination, unlabel source
- Moving label -> folder: label destination, unlabel source
- Moving folder -> label: label destination, source stays (this is unusual!)
- Moving folder -> folder: relies on `shouldExpungeOldLocation` flag

Your Go MCP version doesn't need to mirror exactly because it's not constrained by IMAP semantics. But the underlying API calls (`client.LabelMessages`, `client.UnlabelMessages`) are the same.

### Tasks

- [ ] Add reversal types:
  ```go
  type MoveBatchReversal struct {
      Moves []struct {
          IDs       []string
          FromLabel string
          ToLabel   string
      }
  }

  type AddLabelsReversal struct {
      IDs       []string
      LabelName string
  }

  type RemoveLabelsReversal struct {
      IDs       []string
      LabelName string
  }
  ```
- [ ] Implement `internal/mcp/tools/move_emails.go`:
  - Input: `{ ids: []string, targetMailbox: string }`
  - Resolve target mailbox name to label ID
  - Group input emails by their current label (need to fetch current state)
  - For each source label, call `client.LabelMessages(ids, targetID)` then `client.UnlabelMessages(ids, sourceID)`
  - Build reversal: swap source/target for each group
  - Return `BatchToolResult[MoveResult]` with `operationId`
- [ ] Implement `internal/mcp/tools/add_labels.go`:
  - Input: `{ ids: []string, labelNames: []string }`
  - Resolve each label name to ID
  - Call `client.LabelMessages(ids, labelID)` for each label
  - **Response shape: `{ labelName, applied: bool }`** — no path, no IDs
  - Return `BatchToolResult` with per-email per-label results
  - Reversal: `RemoveLabelsReversal{IDs, LabelName}` for each successfully applied label
- [ ] Implement `internal/mcp/tools/remove_labels.go`:
  - Input: `{ ids: []string, labelNames: []string }`
  - Resolve each label name to ID
  - Call `client.UnlabelMessages(ids, labelID)` for each label
  - Response: `{ labelName, removed: bool }`
  - Reversal: `AddLabelsReversal{IDs, LabelName}`
- [ ] Implement reversal execution for the new reversal types
- [ ] Add fake-server smoke test scenarios:
  - Move email INBOX -> Folders/Test, verify
  - Move back via revert, verify
  - Add label, verify it's applied (no path leaks in response!)
  - Remove label, verify
  - Round-trip add/remove via revert

### Documentation

- [ ] Tool entries in `docs/tools/README.md` — emphasize no-leak rule for `add_labels` response
- [ ] CHANGELOG entry — explicitly mention this fixes the TS issue #54 (`add_labels` path leakage) by design

### Verification

- [ ] All three tools work via Inspector
- [ ] `add_labels` response contains `labelName` and `applied`, never `labelPath` or `newId`
- [ ] Fake-server smoke test passes
- [ ] Tag `v0.5.0` and release

### Commit

```
feat: add move_emails, add_labels, remove_labels

add_labels response uses { labelName, applied } — no IMAP path or
copy UID leakage (fixes TS issue #54 by design). All three tools are
fully reversible via revert_operations.

Tag v0.5.0
```

---

## Phase 8: Message Body, Search, and Attachment Tools

**Goal:** Ship `fetch_message` (body-only, redesigned per TS issue #58), `fetch_attachment`, `search_mailbox`. Release v0.6.0.

### Background

This is the first phase that touches PGP decryption. Read `~/Projects/proton-bridge/internal/services/imapservice/connector.go` function `GetMessageLiteral` (around line 216) for how Bridge fetches and decrypts a message. The pattern uses `gopenpgp` (which is already a dependency of `go-proton-api`).

The redesigned `fetch_message` returns only the body (text/html), not the envelope fields. The envelope is already in the summary that the agent has from `list_mailbox` or `fetch_summaries`. Avoid re-duplication.

### Tasks

- [ ] Add types:
  ```go
  type EmailBody struct {
      ID          EmailID `json:"id"`
      ContentType string  `json:"contentType"` // "text/plain" or "text/html"
      Body        string  `json:"body"`
  }

  type AttachmentContent struct {
      EmailID     EmailID `json:"emailId"`
      PartID      string  `json:"partId"`
      Filename    string  `json:"filename"`
      ContentType string  `json:"contentType"`
      Data        string  `json:"data"` // base64
      Size        int     `json:"size"`
  }
  ```
- [ ] Implement `internal/mcp/tools/fetch_message.go`:
  - Input: `{ id: string }`
  - Call `client.GetFullMessage(ctx, id)` — returns the encrypted message
  - Use the user's keyring (from session.KeyPass) to decrypt the body via gopenpgp
  - Return `SingleToolResult[EmailBody]` — body content only
- [ ] Implement `internal/mcp/tools/fetch_attachment.go`:
  - Input: `{ emailId: string, partId: string }`
  - Call `client.GetAttachment(ctx, partId)` — returns encrypted attachment
  - Decrypt via gopenpgp using the appropriate key
  - Return `SingleToolResult[AttachmentContent]` with base64-encoded data
- [ ] Implement `internal/mcp/tools/search_mailbox.go`:
  - Input: `{ mailbox: string, query: string, limit: int, offset: int }`
  - Call `client.GetMessageMetadataPage()` with `Keyword` parameter
  - Return `ListToolResult[EmailSummary]` (same shape as `list_mailbox`, includes attachment metadata)
- [ ] Set up keyring management in `internal/proton/keys.go`:
  - On `serve` startup, after refreshing the token, load and decrypt the user's primary key using `session.KeyPass`
  - Store the keyring on the `ProtonClient` wrapper for use by decrypt operations
  - Refresh keyring on token refresh

### Tests

- [ ] Add fake-server scenarios:
  - Fetch a message body, assert it's decrypted plaintext/HTML (the fake server should provide test messages)
  - Fetch an attachment, assert base64 length matches expected size
  - Search for a keyword that exists in test data, assert at least one result with attachment metadata

### Documentation

- [ ] Tool entries in `docs/tools/README.md`
- [ ] CHANGELOG entry — note `fetch_message` returns body only (TS issue #58 fixed by design)

### Verification

- [ ] Fetch a real message body via Inspector against a real account
- [ ] Download a real attachment, verify it opens correctly
- [ ] Search returns expected results
- [ ] Fake-server smoke test passes
- [ ] Tag `v0.6.0` and release

### Commit

```
feat: add fetch_message, fetch_attachment, search_mailbox

PGP decryption via gopenpgp using the stored salted key password.
fetch_message returns body only — no envelope re-duplication
(fixes TS issue #58 by design).

Tag v0.6.0
```

---

## Phase 9: Cutover

**Goal:** Migrate users from `proton-bridge-mcp` to `proton-mcp`. No release.

### Tasks

- [ ] Open a PR against `~/Projects/proton-bridge-mcp` updating the README:
  - Add a deprecation banner at the top: "This project is in maintenance mode. The actively developed Go version is at https://github.com/grover/proton-mcp"
  - Add a "Migration Guide" section linking to a new doc
- [ ] Create `docs/migration-from-typescript.md` in the new repo:
  - For users coming from `proton-bridge-mcp`
  - How to install the new MCPB
  - How to migrate Claude Desktop configuration (the tool names are the same, so most existing usage should just work)
  - Notes on the two tool changes: `verify_connectivity` -> `verify_session`, `drain_connections` removed
  - Notes on the response shape changes: `fetch_message` body-only, `add_labels` no path
- [ ] Update the new repo's README to link the migration guide
- [ ] Add a section to the old repo's CHANGELOG noting the deprecation
- [ ] Old repo enters maintenance mode: only security fixes
- [ ] Set milestone in the old repo to track final maintenance work

This phase produces no release. Cutover is a meta step.

### Verification

- [ ] Old repo README clearly directs users to the new one
- [ ] Migration guide exists and is accurate
- [ ] No silent breakage: users following the guide can install the new MCPB and continue with their existing Claude Desktop setup

---

## Phase 10: Cross-cutting Improvements

**Goal:** Operational quality improvements after users have migrated. Release v0.7.0.

### Tasks

- [ ] **Audit log rotation** — port the design from TS issue #40. Use `gopkg.in/natefinch/lumberjack.v2` or implement simple size-based rotation in `internal/audit/`
- [ ] **Better error mapping** — define structured error codes for the MCP responses:
  - `AUTH_EXPIRED` — session needs re-login
  - `RATE_LIMITED` — Proton API returned 429
  - `LABEL_NOT_FOUND` — label name doesn't exist
  - `EMAIL_NOT_FOUND` — message ID doesn't exist
  - `INVALID_INPUT` — schema validation failure
  - `INTERNAL` — anything else
  - Return these codes in the MCP error responses so agents can react
- [ ] **Rate limit refinements** — basic retry shipped in Phase 2, this phase adds:
  - Configurable retry budget per call
  - Metrics for rate-limit hits (logged via slog)
  - Backoff jitter
- [ ] **Telemetry / structured event logging** — use `log/slog` consistently across the codebase, ensure every tool call logs a structured event for production debugging
- [ ] **Troubleshooting documentation** — create `docs/troubleshooting.md`:
  - "Authentication errors" — what to do when refresh fails
  - "Rate limit errors" — what they mean, how to back off
  - "CAPTCHA / human verification" — how to recover (wait, change network, re-login)
  - "Session expired mid-conversation" — instructing users to re-run `login`

### Verification

- [ ] Audit log rotates at the configured size
- [ ] All error responses include structured error codes
- [ ] Troubleshooting doc covers common failure modes
- [ ] Tag `v0.7.0` and release

### Commit

```
feat: cross-cutting improvements (audit log rotation, error codes, telemetry)

Audit log size-based rotation. Structured MCP error codes for
AUTH_EXPIRED, RATE_LIMITED, LABEL_NOT_FOUND, etc. Slog-based
structured event logging for production debugging. Troubleshooting
guide.

Tag v0.7.0
```

---

## Phase 11: HTTP/HTTPS Transports (Last)

**Goal:** Add HTTP and HTTPS transports for non-STDIO use cases. Release v1.0.0 — feature parity with the TypeScript version.

### Background

Read `~/Projects/proton-bridge-mcp/src/http.ts` for the per-session model the TypeScript version uses. The Go MCP SDK should provide HTTP transport primitives — check its docs.

### Tasks

- [ ] Add `--http` flag to `serve`:
  - Starts an HTTP server on a configurable port
  - Bearer token auth via the `Authorization` header
  - Per-session MCP server instances (one `mcp.Server` per HTTP session, keyed by session ID)
- [ ] Add `--https` flag:
  - Same as `--http` but with TLS
  - Auto-generates a self-signed certificate if `--cert` and `--key` are not provided
  - Use `crypto/tls` and `crypto/x509` from stdlib
- [ ] Configuration via flags or env vars:
  - `--port` / `PROTONMAIL_MCP_PORT`
  - `--mcp-auth-token` / `PROTONMAIL_MCP_AUTH_TOKEN`
  - `--cert`, `--key` (HTTPS)
- [ ] Update the manifest.json to support HTTP mode if needed
- [ ] Add fake-server smoke test scenarios for HTTP mode (Mode A only — Mode B can stay STDIO)
- [ ] Document the configuration in `docs/configuration.md`

### Verification

- [ ] `proton-mcp serve --http --port 6283 --mcp-auth-token secret` starts HTTP server
- [ ] MCP Inspector connects via HTTP with the Bearer header
- [ ] Requests without the token return 401
- [ ] HTTPS variant works with auto-generated cert
- [ ] Multiple concurrent sessions work without cross-contamination
- [ ] Tag `v1.0.0` and release

### Commit and release

```
feat: add HTTP/HTTPS transports — v1.0.0 feature parity

proton-mcp serve --http and --https with bearer token auth and
per-session MCP server instances. Auto-generates self-signed cert
for HTTPS if not provided.

This release marks feature parity with proton-bridge-mcp.

Tag v1.0.0
```

---

## Documentation Maintenance

Documentation is **not** a separate phase. Each phase that adds or changes a tool must, in the same commit series:

- Add or update entries in `docs/tools/README.md`
- Add an entry to `CHANGELOG.md` under `[Unreleased]`, then promote to a versioned section on release
- Update `README.md` quickstart if relevant
- Update `ARCHITECTURE.md` if the structure changes

Don't defer documentation. It's part of the work.

## Release Cadence Summary

| Phase | Release | Tools / focus |
|---|---|---|
| 2 | v0.1.0 | `verify_session` + skeleton + MCPB + goreleaser + rate limit handling |
| 4 | v0.2.0 | + `get_folders`, `get_labels`, `list_mailbox`, `fetch_summaries` (with attachment metadata) |
| 5 | v0.3.0 | + `mark_read`, `mark_unread`, `revert_operations` (operation log online) |
| 6 | v0.4.0 | + `create_folder`, `create_label`, `delete_folder`, `delete_label` |
| 7 | v0.5.0 | + `move_emails`, `add_labels`, `remove_labels` |
| 8 | v0.6.0 | + `fetch_message` (body only), `fetch_attachment`, `search_mailbox` |
| 10 | v0.7.0 | Audit log rotation, error mapping, telemetry |
| 11 | v1.0.0 | + HTTP/HTTPS transports — feature parity |

Phase 3 (smoke test infrastructure) and Phase 9 (cutover) produce no release.

## A short Go primer

This appendix is for the user reading along, not for Claude. Claude should already know Go. If you're the user and you're new to Go, here are the absolute minimum concepts to recognize what's in this roadmap:

**Packages**: A directory of `.go` files. Imported by path: `import "github.com/grover/proton-mcp/internal/auth"`. Function visibility is by capitalization: `Login` is exported (public), `login` is package-private.

**Methods on structs**: Go has no classes. A "method" is a function whose first parameter is the receiver, written as `func (s *Session) Refresh() error`. The `*` means pointer (mutable reference), like `Session&` in C++.

**Interfaces**: A list of method signatures. Any type that implements those methods automatically satisfies the interface — no `implements` keyword needed. Go's "duck typing" with compile-time checks.

**Errors**: Returned as the last value alongside a result. Always check `if err != nil { return err }`. Wrapping: `fmt.Errorf("context: %w", err)`.

**Context**: `context.Context` is passed as the first parameter to every function that does I/O. It carries cancellation signals and deadlines. Always pass it through.

**Goroutines and channels**: Go's concurrency primitives. You probably won't need them much in this roadmap — most of the work is sequential request/response.

**Generics**: Added in Go 1.18. Used for the tool result types: `SingleToolResult[T any]`. The syntax is similar to TypeScript generics.

**`go run` vs `go build`**: `go run ./cmd/X` compiles and runs in one step (slower, good for dev). `go build ./...` produces a binary you can ship.

**The standard library is huge**: `net/http`, `encoding/json`, `crypto/aes`, `os`, `time`, `log/slog`, `context`, `sync` — almost everything you need is in the stdlib. Be skeptical of adding dependencies.

**Read Bridge**: When you're stuck on a Go pattern, look at how `~/Projects/proton-bridge` does it. It's a 70k-line production Go codebase using the same library. You will rarely have to invent a pattern from scratch.
