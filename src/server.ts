import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ImapConnectionPool }  from './bridge/pool.js';
import type { ReadOnlyMailOps, MutatingMailOps } from './types/mail-ops.js';
import { isEmailId, formatEmailId } from './types/email.js';
import {
  getFoldersSchema,             handleGetFolders,
  createFolderSchema,           handleCreateFolder,
  createLabelSchema,            handleCreateLabel,
  deleteFolderSchema,           handleDeleteFolder,
  deleteLabelSchema,            handleDeleteLabel,
  listMailboxSchema,            handleListMailbox,
  fetchSummariesSchema,         handleFetchSummaries,
  fetchMessageSchema,           handleFetchMessage,
  fetchAttachmentSchema,        handleFetchAttachment,
  searchMailboxSchema,          handleSearchMailbox,
  moveEmailsSchema,             handleMoveEmails,
  markReadSchema,               handleMarkRead,
  markUnreadSchema,             handleMarkUnread,
  verifyConnectivitySchema,     handleVerifyConnectivity,
  drainConnectionsSchema,       handleDrainConnections,
  addLabelsSchema,              handleAddLabels,
  removeLabelsSchema,           handleRemoveLabels,
  getLabelsSchema,              handleGetLabels,
  revertOperationsSchema,       handleRevertOperations,
} from './tools/index.js';

function toText(data: unknown): string {
  return JSON.stringify(data, (_key, value) => {
    if (isEmailId(value)) return formatEmailId(value);
    return value;
  }, 2);
}

const READ_ONLY   = { readOnlyHint: true,  destructiveHint: false } as const;
const MUTATING    = { readOnlyHint: false, destructiveHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true  } as const;

/**
 * Creates a new McpServer with all tools registered.
 * Called once per HTTP session — the ImapClient, ImapConnectionPool, and
 * OperationLogInterceptor are shared singletons.
 */
export function createMcpServer(
  readOps: ReadOnlyMailOps,
  pool:    ImapConnectionPool,
  mutOps:  MutatingMailOps,
): McpServer {
  const server = new McpServer({
    name:    'proton-bridge-mcp',
    version: '0.1.0',
  });

  server.registerTool(
    'get_folders',
    {
      description: 'List all mail folders with detailed metadata — message counts, unread counts, next UID, subscription status, and IMAP flags. Includes INBOX, special-use folders (Sent, Drafts, Trash, Archive, Junk, Spam), and user-created folders under Folders/. Proton labels, the virtual Starred mailbox, and the Labels root are excluded.',
      inputSchema: getFoldersSchema,
      annotations: READ_ONLY,
    },
    async () => ({
      content: [{ type: 'text', text: toText(await handleGetFolders(readOps)) }],
    }),
  );

  server.registerTool(
    'create_folder',
    {
      description: "Create a new mail folder at the given path. The path must start with 'Folders/' and may include nested segments (e.g. 'Folders/Work/Projects') which are created recursively. Returns the full path and whether it was newly created or already existed.",
      inputSchema: createFolderSchema,
      annotations: MUTATING,
    },
    async (args) => ({
      content: [{ type: 'text', text: toText(await handleCreateFolder(args, mutOps)) }],
    }),
  );

  server.registerTool(
    'create_label',
    {
      description: "Create a new Proton Mail label. The name must be plain text without '/' characters. Returns the full IMAP path (Labels/<name>) and whether it was newly created or already existed.",
      inputSchema: createLabelSchema,
      annotations: MUTATING,
    },
    async (args) => ({
      content: [{ type: 'text', text: toText(await handleCreateLabel(args, mutOps)) }],
    }),
  );

  server.registerTool(
    'delete_label',
    {
      description: "Delete a Proton Mail label. The underlying emails remain in their original folders — only the label view is removed. Warning: this operation clears the operation history — no prior operations can be reverted after calling delete_label.",
      inputSchema: deleteLabelSchema,
      annotations: DESTRUCTIVE,
    },
    async (args) => ({
      content: [{ type: 'text', text: toText(await handleDeleteLabel(args, mutOps)) }],
    }),
  );

  server.registerTool(
    'delete_folder',
    {
      description: "Delete a mail folder. The path must be under Folders/ — Folders/ itself, special-use folders (INBOX, Sent, Drafts, Trash, etc.), and paths outside Folders/ are rejected. Emails are retained in Proton's backend. Warning: this operation clears the operation history — no prior operations can be reverted after calling delete_folder.",
      inputSchema: deleteFolderSchema,
      annotations: DESTRUCTIVE,
    },
    async (args) => ({
      content: [{ type: 'text', text: toText(await handleDeleteFolder(args, mutOps)) }],
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
      content: [{ type: 'text', text: toText(await handleListMailbox(args, readOps)) }],
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
      content: [{ type: 'text', text: toText(await handleFetchSummaries(args, readOps)) }],
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
      content: [{ type: 'text', text: toText(await handleFetchMessage(args, readOps)) }],
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
      content: [{ type: 'text', text: toText(await handleFetchAttachment(args, readOps)) }],
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
      content: [{ type: 'text', text: toText(await handleSearchMailbox(args, readOps)) }],
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
      content: [{ type: 'text', text: toText(await handleMoveEmails(args, mutOps)) }],
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
      content: [{ type: 'text', text: toText(await handleMarkRead(args, mutOps)) }],
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
      content: [{ type: 'text', text: toText(await handleMarkUnread(args, mutOps)) }],
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
      annotations: DESTRUCTIVE,
    },
    async () => ({
      content: [{ type: 'text', text: toText(await handleDrainConnections(pool)) }],
    }),
  );

  server.registerTool(
    'get_labels',
    {
      description: 'List all Proton Mail labels with detailed metadata — message counts, unread counts, next UID, subscription status, and IMAP flags. Returns only label folders (under Labels/), excluding regular mail folders, the virtual Starred mailbox, and the Labels root.',
      inputSchema: getLabelsSchema,
      annotations: READ_ONLY,
    },
    async () => ({
      content: [{ type: 'text', text: toText(await handleGetLabels(readOps)) }],
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
      content: [{ type: 'text', text: toText(await handleAddLabels(args, mutOps)) }],
    }),
  );

  server.registerTool(
    'remove_labels',
    {
      description: 'Remove one or more Proton Mail labels from a batch of emails. Removes the email copies from label folders; originals remain in their source mailboxes. Supports up to 50 emails per call.',
      inputSchema: removeLabelsSchema,
      annotations: DESTRUCTIVE,
    },
    async (args) => ({
      content: [{ type: 'text', text: toText(await handleRemoveLabels(args, mutOps)) }],
    }),
  );

  server.registerTool(
    'revert_operations',
    {
      description: 'Reverse all operations from the most recent back to and including the specified operation ID, in reverse chronological order. This is a destructive operation: emails may be moved, folders deleted, and flags changed. Fails with UNKNOWN_OPERATION_ID if the given ID is not in the log.',
      inputSchema: revertOperationsSchema,
      annotations: DESTRUCTIVE,
    },
    async (args) => ({
      content: [{ type: 'text', text: toText(await handleRevertOperations(args, mutOps)) }],
    }),
  );

  return server;
}
