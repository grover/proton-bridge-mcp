Proton Bridge MCP Server
---

# Goals

This is an MCP server to expose Proton Mail via its Proton Mail Bridge to AI agents. It's written in TypeScript, exposes the MCP interface via HTTP

## Design goals

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

### IMAP connection pooling

* Implement a smart IMAP connection pool
* Make the pool size configurable
* Do not push all operations via a single IMAP connection
* If an IMAP connection has any kind of backend related error, remove it from the pool
* Drain the pool smartly back to minimum if connections aren't used.
* Empty the pool if the MCP server hasn't been used for 5 minutes (configurable)

## Milestones

We'll work iteratively to create the MCP server:

### MVP

* Scaffolding is implemented
* The MCP server can be accessed by Claude
* The MCP server exposes a secured MCP over HTTP interface
* IMAP connection pooling is implemented
* Smart auditing for any mail operation is implemented
* Implement a verify_connectivity tool to check whether the MCP can connect to the Proton Mail bridge
* Claude can list the folders in a mailbox
* Provide a command line argument to run the MCP server in a verify mode (verify connectivity and exit with status/printed message)


### M1

* Claude can list all messages in a folder using pagination mechanisms
* Claude can fetch a specific message based on its identifier

### M2

* Implement OAuth 2.0 support according to https://github.com/grover/proton-bridge-mcp/issues/7
* Implement STDIO support according to https://github.com/grover/proton-bridge-mcp/issues/10

### M3

See [M3 PRD](docs/plans/m3-folders-labels-revert.md) for full tool specifications, implementation steps, and acceptance criteria.

#### Folder management

* `get_folders` replaces `list_folders` with an enriched schema and filtering rules.
  - Included: special-use folders (INBOX, Sent, Drafts, Trash, Junk, Archive, Spam) and all
    paths under `Folders/`.
  - Excluded: `Labels/` prefix, and the virtual roots `Starred` and `Labels`.
  - Schema per folder: `path`, `name`, `delimiter`, `listed`, `subscribed`, `flags`,
    `specialUse?`, `messageCount`, `unreadCount`, `uidNext`.
* `create_folder` — creates a new user folder. Accepts a `name` (may contain `/` for nested
  paths) and an optional `parent` (defaults to `Folders/`; must be rooted in `Folders/`).
  Full path = `parent + "/" + name`. Uses `conn.mailboxCreate(path)`. Revertable.
* `delete_folder` — deletes a folder under `Folders/` (cannot delete `Folders/` itself,
  special-use folders, or paths outside `Folders/`). Uses `conn.mailboxDelete(path)`.
  **Empties the operation log** via the `@Irreversible` decorator; no revert is possible
  after this call.

#### Label management

Labels are IMAP folders prefixed `Labels/`. A message can appear in multiple label folders
simultaneously (Proton Bridge virtualises this). Add-label = IMAP COPY; remove-label =
mechanism TBD during implementation (see PRD).

* `list_labels` — lists all `Labels/`-prefixed mailboxes with the same schema as `get_folders`.
  Read-only.
* `create_label` — creates `Labels/<name>` (flat — no nesting). Revertable.
* `delete_label` — deletes `Labels/<name>`. **Revertable**: captures all message IDs in the
  label before deletion. Does NOT clear the operation log. Cannot delete `Labels/` itself.
* `add_labels` — bulk copies emails into one or more label folders. Returns per-item results
  including new UIDs in each label folder (stored in log for revert).
* `remove_labels` — bulk removes emails from one or more label folders.

#### Reversible bulk operations

* All mutating tools participate in an in-memory `OperationLog` (ring buffer, 100 entries).
* Decoupled from `ImapClient` via an `OperationLogInterceptor` class. Tool handlers call the
  interceptor; ImapClient has no knowledge of the log.
* New `@Tracked` decorator: on success/partial, captures reversal state, pushes to log, extends
  result with `operationId`.
* New `@Irreversible` decorator: on success/partial, clears the log. Used only for `delete_folder`.
* `revert_operations(operationId)` unwinds all ops from most-recent down to and including the
  given ID, in reverse order. Fails with `UNKNOWN_OPERATION_ID` if the ID is not in the log.
* The log is in-memory only; resets on server restart.

### M4

* Claude can mark emails as read, unread, starred, etc.
* This should also be revertable with the revert tool

### M5

* Claude can delete emails with a trash tool
* Exposure of this tool is configurable

### M6

* Claude can create draft emails and store them in the IMAP server