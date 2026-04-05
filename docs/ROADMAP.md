# Roadmap

proton-bridge-mcp — An MCP server to expose Proton Mail via its Proton Mail Bridge to AI agents.

## Design Goals

* A fully asynchronous HTTP based MCP server
* Use a secure mechanism to ensure no mischieveous use the MCP server
* Use IMAP connection pooling
* Enable audit logging of mutating operations on mailboxes from the very beginning
* All operations should be batch operations
* Apply IMAP locking smartly to batch operations - do not acquire locks for the same folders multiple times in a single batch
* Keep inputs and output sets stable, i.e. the tool result should match the sequence of the email identifiers given in a tool call
* Expose underlying errors well

### Startup

* Use command line and environment variables to configure the MCP server
* Environment variables are used if command line args aren't given
* Provide help for the command line arguments in standard ways
* Implement sanity checking during startup (all parameters given)

### IMAP Connection Pooling

* Implement a smart IMAP connection pool
* Make the pool size configurable
* Do not push all operations via a single IMAP connection
* If an IMAP connection has any kind of backend related error, remove it from the pool
* Drain the pool smartly back to minimum if connections aren't used.
* Empty the pool if the MCP server hasn't been used for 5 minutes (configurable)

## Milestones

### MVP [DONE - v0.2.0]

* Scaffolding is implemented
* The MCP server can be accessed by Claude
* The MCP server exposes a secured MCP over HTTP interface
* IMAP connection pooling is implemented
* Smart auditing for any mail operation is implemented
* Implement a verify_connectivity tool to check whether the MCP can connect to the Proton Mail bridge
* Claude can list the folders in a mailbox
* Provide a command line argument to run the MCP server in a verify mode (verify connectivity and exit with status/printed message)

### M1 [DONE - v0.2.0]

* Claude can list all messages in a folder using pagination mechanisms
* Claude can fetch a specific message based on its identifier

### M2

* ~~Implement STDIO support according to https://github.com/grover/proton-bridge-mcp/issues/10~~ [DONE - v0.2.0]
* Implement OAuth 2.0 support according to https://github.com/grover/proton-bridge-mcp/issues/7 [DELAYED]

### M3 [DONE]

See [M3 PRD](plans/m3-folders-labels-revert.md) for full tool specifications, implementation steps, and acceptance criteria.

* `get_folders` — enriched folder listing with filtering rules (#13)
* `get_labels` — label listing (#16)
* `create_folder` — create new user folders (#14)
* `create_label` — create Proton Mail labels (#17)
* `delete_folder` — delete user folders, irreversible via `@IrreversibleWhen` (#15)
* `delete_label` — delete Proton labels, irreversible via `@IrreversibleWhen` (#18)
* `add_labels` — bulk copy emails into label folders (#19)
* `remove_labels` — bulk remove emails from label folders via Message-ID search (#20)
* `revert_operations` — undo tool with `OperationLog` ring buffer (#21)
* `@Tracked` / `@IrreversibleWhen` / `@Irreversible` decorators
* `OperationLogInterceptor` — GoF Decorator wrapping ImapClient for operation tracking
* `openWorldHint` annotations on all tools + `MAINTENANCE` preset (#42)
* `add_labels` response fix — return `{ labelName, applied }` instead of internal `{ labelPath, newId }` (#54)

### M4 [FUTURE]

See [M4 PRD](plans/prd-m4-disabled-tools.md) for full specification.

* `--disabled-tools` — selectively hide tools from AI clients via CLI flag, env var, or MCPB config
* Tool category shortcuts: `read`, `mutating`, `destructive`, `maintenance`
* Central `isToolAllowed()` gate on tool registration
* Startup logging of active/disabled tools

### M5 [FUTURE]

* Claude can delete emails with a trash tool
* Exposure of this tool is configurable

### M6 [FUTURE]

* Claude can create draft emails and store them in the IMAP server
