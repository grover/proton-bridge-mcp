import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ImapClient }         from './bridge/imap.js';
import type { ImapConnectionPool } from './bridge/pool.js';
import {
  listFoldersSchema,        handleListFolders,
  listMailboxSchema,        handleListMailbox,
  fetchSummariesSchema,     handleFetchSummaries,
  fetchMessageSchema,       handleFetchMessage,
  fetchAttachmentSchema,    handleFetchAttachment,
  searchMailboxSchema,      handleSearchMailbox,
  moveEmailsSchema,         handleMoveEmails,
  markReadSchema,           handleMarkRead,
  markUnreadSchema,         handleMarkUnread,
  verifyConnectivitySchema, handleVerifyConnectivity,
  drainConnectionsSchema,   handleDrainConnections,
  addLabelsSchema,          handleAddLabels,
} from './tools/index.js';

function toText(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

const READ_ONLY   = { readOnlyHint: true,  destructiveHint: false } as const;
const MUTATING    = { readOnlyHint: false, destructiveHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true  } as const;

/**
 * Creates a new McpServer with all tools registered.
 * Called once per HTTP session — the ImapClient and ImapConnectionPool are shared singletons.
 */
export function createMcpServer(
  imap: ImapClient,
  pool: ImapConnectionPool,
): McpServer {
  const server = new McpServer({
    name:    'proton-bridge-mcp',
    version: '0.1.0',
  });

  server.registerTool(
    'list_folders',
    {
      description: 'List all IMAP mailboxes/folders available in the ProtonMail account. Returns folder paths, names, hierarchy delimiters, and special-use flags (Sent, Drafts, Trash, etc.).',
      inputSchema: listFoldersSchema,
      annotations: READ_ONLY,
    },
    async () => ({
      content: [{ type: 'text', text: toText(await handleListFolders(imap)) }],
    }),
  );

  server.registerTool(
    'list_mailbox',
    {
      description: 'List emails in a ProtonMail mailbox, newest first. Returns envelope summaries (no body).',
      inputSchema: listMailboxSchema,
      annotations: READ_ONLY,
    },
    async (args) => ({
      content: [{ type: 'text', text: toText(await handleListMailbox(args, imap)) }],
    }),
  );

  server.registerTool(
    'fetch_summaries',
    {
      description: 'Fetch envelope summaries for a list of known email IDs.',
      inputSchema: fetchSummariesSchema,
      annotations: READ_ONLY,
    },
    async (args) => ({
      content: [{ type: 'text', text: toText(await handleFetchSummaries(args, imap)) }],
    }),
  );

  server.registerTool(
    'fetch_message',
    {
      description: 'Fetch full message content (text/HTML body + attachment metadata) for a list of email IDs. Attachment content is not included — use fetch_attachment for that.',
      inputSchema: fetchMessageSchema,
      annotations: READ_ONLY,
    },
    async (args) => ({
      content: [{ type: 'text', text: toText(await handleFetchMessage(args, imap)) }],
    }),
  );

  server.registerTool(
    'fetch_attachment',
    {
      description: 'Download a single email attachment by its part ID (from fetch_message result). Returns base64-encoded content.',
      inputSchema: fetchAttachmentSchema,
      annotations: READ_ONLY,
    },
    async (args) => ({
      content: [{ type: 'text', text: toText(await handleFetchAttachment(args, imap)) }],
    }),
  );

  server.registerTool(
    'search_mailbox',
    {
      description: 'Search for emails in a mailbox by text query. Returns summaries of matching emails.',
      inputSchema: searchMailboxSchema,
      annotations: READ_ONLY,
    },
    async (args) => ({
      content: [{ type: 'text', text: toText(await handleSearchMailbox(args, imap)) }],
    }),
  );

  server.registerTool(
    'move_emails',
    {
      description: 'Move a batch of emails to a target mailbox. Returns per-email results with source/target info.',
      inputSchema: moveEmailsSchema,
      annotations: DESTRUCTIVE,
    },
    async (args) => ({
      content: [{ type: 'text', text: toText(await handleMoveEmails(args, imap)) }],
    }),
  );

  server.registerTool(
    'mark_read',
    {
      description: 'Mark a batch of emails as read (adds \\Seen IMAP flag).',
      inputSchema: markReadSchema,
      annotations: MUTATING,
    },
    async (args) => ({
      content: [{ type: 'text', text: toText(await handleMarkRead(args, imap)) }],
    }),
  );

  server.registerTool(
    'mark_unread',
    {
      description: 'Mark a batch of emails as unread (removes \\Seen IMAP flag).',
      inputSchema: markUnreadSchema,
      annotations: MUTATING,
    },
    async (args) => ({
      content: [{ type: 'text', text: toText(await handleMarkUnread(args, imap)) }],
    }),
  );

  server.registerTool(
    'verify_connectivity',
    {
      description: 'Test the connection to the Proton Bridge IMAP server. Returns success status and latency.',
      inputSchema: verifyConnectivitySchema,
      annotations: READ_ONLY,
    },
    async () => ({
      content: [{ type: 'text', text: toText(await handleVerifyConnectivity(pool)) }],
    }),
  );

  server.registerTool(
    'drain_connections',
    {
      description: 'Close all connections in the IMAP connection pool immediately. Useful for forcing reconnection after a Proton Bridge restart.',
      inputSchema: drainConnectionsSchema,
      annotations: READ_ONLY,
    },
    async () => ({
      content: [{ type: 'text', text: toText(await handleDrainConnections(pool)) }],
    }),
  );

  server.registerTool(
    'add_labels',
    {
      description: 'Add one or more Proton Mail labels to a batch of emails. Each email is copied into the corresponding label folder and simultaneously remains in its original folder. Supports up to 50 emails per call. Returns per-email results including the new UID in each label folder, which is used internally to enable label removal and revert.',
      inputSchema: addLabelsSchema,
      annotations: MUTATING,
    },
    async (args) => ({
      content: [{ type: 'text', text: toText(await handleAddLabels(args, imap)) }],
    }),
  );

  return server;
}
