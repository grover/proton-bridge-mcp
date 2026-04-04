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
} from './tools/index.js';

function toText(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

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

  server.tool(
    'list_folders',
    'List all IMAP mailboxes/folders available in the ProtonMail account. Returns folder paths, names, hierarchy delimiters, and special-use flags (Sent, Drafts, Trash, etc.).',
    listFoldersSchema,
    async () => ({
      content: [{ type: 'text', text: toText(await handleListFolders(imap)) }],
    }),
  );

  server.tool(
    'list_mailbox',
    'List emails in a ProtonMail mailbox, newest first. Returns envelope summaries (no body).',
    listMailboxSchema,
    async (args) => ({
      content: [{ type: 'text', text: toText(await handleListMailbox(args, imap)) }],
    }),
  );

  server.tool(
    'fetch_summaries',
    'Fetch envelope summaries for a list of known email IDs.',
    fetchSummariesSchema,
    async (args) => ({
      content: [{ type: 'text', text: toText(await handleFetchSummaries(args, imap)) }],
    }),
  );

  server.tool(
    'fetch_message',
    'Fetch full message content (text/HTML body + attachment metadata) for a list of email IDs. Attachment content is not included — use fetch_attachment for that.',
    fetchMessageSchema,
    async (args) => ({
      content: [{ type: 'text', text: toText(await handleFetchMessage(args, imap)) }],
    }),
  );

  server.tool(
    'fetch_attachment',
    'Download a single email attachment by its part ID (from fetch_message result). Returns base64-encoded content.',
    fetchAttachmentSchema,
    async (args) => ({
      content: [{ type: 'text', text: toText(await handleFetchAttachment(args, imap)) }],
    }),
  );

  server.tool(
    'search_mailbox',
    'Search for emails in a mailbox by text query. Returns summaries of matching emails.',
    searchMailboxSchema,
    async (args) => ({
      content: [{ type: 'text', text: toText(await handleSearchMailbox(args, imap)) }],
    }),
  );

  server.tool(
    'move_emails',
    'Move a batch of emails to a target mailbox. Returns per-email results with source/target info.',
    moveEmailsSchema,
    async (args) => ({
      content: [{ type: 'text', text: toText(await handleMoveEmails(args, imap)) }],
    }),
  );

  server.tool(
    'mark_read',
    'Mark a batch of emails as read (adds \\Seen IMAP flag).',
    markReadSchema,
    async (args) => ({
      content: [{ type: 'text', text: toText(await handleMarkRead(args, imap)) }],
    }),
  );

  server.tool(
    'mark_unread',
    'Mark a batch of emails as unread (removes \\Seen IMAP flag).',
    markUnreadSchema,
    async (args) => ({
      content: [{ type: 'text', text: toText(await handleMarkUnread(args, imap)) }],
    }),
  );

  server.tool(
    'verify_connectivity',
    'Test the connection to the Proton Bridge IMAP server. Returns success status and latency.',
    verifyConnectivitySchema,
    async () => ({
      content: [{ type: 'text', text: toText(await handleVerifyConnectivity(pool)) }],
    }),
  );

  server.tool(
    'drain_connections',
    'Close all connections in the IMAP connection pool immediately. Useful for forcing reconnection after a Proton Bridge restart.',
    drainConnectionsSchema,
    async () => ({
      content: [{ type: 'text', text: toText(await handleDrainConnections(pool)) }],
    }),
  );

  return server;
}
