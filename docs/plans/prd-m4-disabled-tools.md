# PRD: Disabled Tools

## Context

proton-bridge-mcp exposes a growing set of MCP tools to AI agents. Currently all tools are always registered — there is no way for an operator to restrict which tools are available. An operator may want to prevent an AI from performing destructive actions (e.g. `move_emails`) or limit the surface to read-only tools only. In the extreme case, an operator could disable all tools, effectively making the MCP server a no-op.

This feature follows the existing configuration pattern: **CLI flag > environment variable > default**, and is also exposed via the MCPB `user_config` in `manifest.json`.

---

## Feature: `--disabled-tools`

### Configuration

| CLI Flag | Env Var | Default | Description |
|---|---|---|---|
| `--disabled-tools <list>` | `PROTONMAIL_DISABLED_TOOLS` | _(none)_ | Comma-separated list of tool names or category shortcuts to hide from AI clients |

### Tool Categories

Tools are organized into four categories based on their behavior. Category shortcuts can be used in the disabled list alongside individual tool names.

| Category | Shortcut | Tools | Description |
|---|---|---|---|
| **read-only** | `read` | `get_folders`, `get_labels`, `list_mailbox`, `fetch_summaries`, `fetch_message`, `fetch_attachment`, `search_mailbox` | Read operations that do not modify any data |
| **mutating** | `mutating` | `create_folder`, `mark_read`, `mark_unread`, `add_labels` | Operations that modify mailbox state but are not destructive |
| **destructive** | `destructive` | `move_emails` | Operations that irreversibly change data (UIDs invalidated) |
| **maintenance** | `maintenance` | `verify_connectivity`, `drain_connections` | Idempotent server maintenance operations that do not directly affect the Proton Mail inbox |

> **Note on maintenance tools:** `verify_connectivity` and `drain_connections` are idempotent, non-destructive operations. They manage the MCP server's IMAP connection pool — not the mailbox itself. They are in their own category because they are neither read-only (they affect server state) nor mutating/destructive (they don't touch mail data). See `src/tools/verify-connectivity.ts` and `src/tools/drain-connections.ts`.

**Accepted values:** Any combination of:
- **Individual tool names:** `get_folders`, `get_labels`, `create_folder`, `list_mailbox`, `fetch_summaries`, `fetch_message`, `fetch_attachment`, `search_mailbox`, `move_emails`, `mark_read`, `mark_unread`, `add_labels`, `verify_connectivity`, `drain_connections`
- **Category shortcuts:** `read`, `mutating`, `destructive`, `maintenance`

Categories are expanded before deduplication — mixing categories and individual names is fine.

### Examples

```bash
# Disable all destructive tools (just move_emails currently)
node dist/index.js --disabled-tools destructive

# Disable destructive + mutating — read-only mode (keeps maintenance tools)
node dist/index.js --disabled-tools destructive,mutating

# Mix categories and individual names
node dist/index.js --disabled-tools destructive,drain_connections

# Via environment variable
PROTONMAIL_DISABLED_TOOLS=destructive,mutating node dist/index.js

# Disable everything (empty MCP server)
node dist/index.js --disabled-tools read,mutating,destructive,maintenance
```

### MCPB manifest (`manifest.json`)

```json
"disabled_tools": {
  "type": "string",
  "title": "Disabled Tools",
  "description": "Comma-separated list of tool names or categories to hide from AI clients. Categories: 'read', 'mutating', 'destructive', 'maintenance'. Individual tools: 'get_folders', 'move_emails', etc. Example: 'destructive,mutating'",
  "default": "",
  "required": false
}
```

With corresponding `mcp_config.args` entry: `"--disabled-tools=${user_config.disabled_tools}"`

---

## Behavior

### Tool registration gate

A disabled tool is **never registered** with the MCP server — it does not appear in the tool list at all. The AI never sees the tool exists. Since the MCP SDK rejects calls to unregistered tools, no additional runtime guard is needed inside tool handlers (registration-only approach).

### Central check function

A single function `isToolAllowed(toolName, disabledTools)` is the authority for whether a tool is registered. Every `server.registerTool()` call in `createMcpServer` must consult this function. This keeps the disable logic in one place and makes it easy to audit.

### Startup logging

The MCP server **always** logs the list of active tools at startup at `info` level, regardless of whether any tools are disabled:

```
Active tools: get_folders, get_labels, list_mailbox, ... (12 of 14 tools)
```

If tools were disabled, also log which ones and why:

```
Disabled tools: move_emails, drain_connections
```

If unknown names were encountered, log at `warn` level:

```
Unknown entries in disabled-tools ignored: movee_mails, foobar
```

If **all** tools are disabled, log at `warn` level:

```
All tools disabled by configuration — MCP server will expose no tools
```

### Parsing rules

1. Split the raw string on commas
2. Trim whitespace from each entry
3. Filter out empty strings (handles trailing commas, `""`, etc.)
4. Expand category shortcuts into their constituent tool names
5. **Warn and ignore** any unrecognized names (not a known tool name and not a category shortcut) — log at `warn` level
6. Deduplicate (set semantics)
7. Store as a `ReadonlySet<string>` in config for O(1) lookup

---

## Corner Cases

| Scenario | Behavior |
|---|---|
| Empty string / not provided | No tools disabled; all tools registered (default) |
| Unknown tool name in list | **Warn and ignore** — log the invalid name(s) at `warn` level, proceed with valid entries |
| Duplicate names | Deduplicated silently (set semantics) |
| Category + overlapping individual name | e.g. `destructive,move_emails` — deduplicated, no error |
| Trailing/leading commas | Ignored (`"move_emails,"` = `["move_emails"]`) |
| Whitespace around names | Trimmed (`"move_emails , drain_connections"` works) |
| All tools disabled | Valid — MCP server starts with zero tools; warn logged |
| Case sensitivity | Tool names and categories are **case-sensitive** (all lowercase). `Move_Emails` or `Destructive` triggers an unknown-name warning. |
| `--verify` mode | Disabled list is parsed but has no effect (verify mode doesn't register tools) |

---

## Implementation Guidelines

### Config layer (`src/config.ts`, `src/types/config.ts`)

- Add `--disabled-tools <list>` CLI option via Commander
- Parse with env fallback `PROTONMAIL_DISABLED_TOOLS`
- Add `disabledTools: ReadonlySet<string>` to `AppConfig`
- Define `TOOL_CATEGORIES` map and `KNOWN_TOOL_NAMES` set as constants
- Expand categories, warn on unknown names, deduplicate

### Tool registration (`src/server.ts`)

- `createMcpServer` receives `AppConfig` (or at minimum the disabled set)
- Add `isToolAllowed(name: string, disabledTools: ReadonlySet<string>): boolean`
- Gate each `server.registerTool()` call behind `isToolAllowed`
- Always log active tools after registration; log disabled tools if any

### MCPB manifest (`manifest.json`)

- Add `disabled_tools` to `user_config`
- Add `--disabled-tools=${user_config.disabled_tools}` to `mcp_config.args`

### Documentation

- **`README.md`**: Highlight the feature in the Features section; add row to Configuration Reference table
- **`docs/tools/README.md`**: Add a "Disabled Tools" section with the category table, usage examples, and corner case notes. This is the primary documentation location for tool-related configuration.

### Tests

- Unit tests for parsing logic (comma splitting, whitespace, empty string, dedup)
- Unit test for unknown name warning (should warn, not throw)
- Unit test for category expansion (`destructive` -> `["move_emails"]`, etc.)
- Unit test for mixed categories + individual names with dedup
- Unit test for `isToolAllowed` function
- Unit test verifying disabled tools are not registered on the MCP server
- Unit test verifying all tools registered when disabled list is empty

---

## What This Is NOT

- **Not an allow-list.** The default is "all tools enabled." You disable specific tools, not enable specific ones. An allow-list would be a breaking change for existing users.
- **Not per-session.** The disabled list is a server-wide configuration, not per-HTTP-session. All sessions see the same tool set.
- **Not runtime-mutable.** Changing the disabled list requires a server restart.
- **Not role-based.** There is no concept of "admin can use move_emails but regular users cannot." That would require auth-level tool gating, which is out of scope.
