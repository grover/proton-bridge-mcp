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

* Claude can move emails
* A revert tool enables Claude to reverse any action it's done (limited to the past 100 actions taken.)

### M3

* Claude can mark emails as read, unread, starred, etc.
* This should also be revertable with the revert tool

### M4

* Claude can delete emails with a trash tool
* Exposure of this tool is configurable

### M5

* Claude can create draft emails and store them in the IMAP server