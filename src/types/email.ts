import { z } from 'zod';

/**
 * Stable email identifier.
 * IMAP UIDs are per-mailbox — always carry the mailbox alongside the UID.
 */
export interface EmailId {
  uid:     number;
  mailbox: string;
}

/** Format an EmailId as `"Mailbox:UID"` for tool output. */
export function formatEmailId(id: EmailId): string {
  return `${id.mailbox}:${id.uid}`;
}

/**
 * Parse a `"Mailbox:UID"` string into an EmailId.
 * Splits on the LAST colon to handle mailbox names containing colons.
 */
export function parseEmailId(str: string): EmailId {
  const lastColon = str.lastIndexOf(':');
  if (lastColon < 1) throw new Error(`Invalid EmailId "${str}": expected "Mailbox:UID" format`);

  const mailbox = str.slice(0, lastColon);
  const uidStr = str.slice(lastColon + 1);
  const uid = Number(uidStr);

  if (!Number.isInteger(uid) || uid < 1) {
    throw new Error(`Invalid EmailId "${str}": UID must be a positive integer`);
  }

  return { uid, mailbox };
}

/** Type guard: true when value is a plain object with exactly `uid` (number) and `mailbox` (string). */
export function isEmailId(value: unknown): value is EmailId {
  if (typeof value !== 'object' || value === null) return false;
  const keys = Object.keys(value);
  return keys.length === 2
    && 'uid' in value && typeof (value as Record<string, unknown>).uid === 'number'
    && 'mailbox' in value && typeof (value as Record<string, unknown>).mailbox === 'string';
}

/**
 * Shared Zod schema for EmailId string input on tool interfaces.
 * Accepts `"Mailbox:UID"` strings and transforms them to EmailId objects.
 */
export const emailIdStringSchema = z.string()
  .min(3)
  .describe('Email ID in "Mailbox:UID" format (e.g. "INBOX:42")')
  .transform((str) => parseEmailId(str));

/** RFC 5321 address with optional display name */
export interface EmailAddress {
  address: string;
  name?:   string;
}

/**
 * Email summary — envelope fields only, no body content.
 * Suitable for list and search results.
 */
export interface EmailSummary {
  id:             EmailId;
  messageId:      string | undefined;
  from:           EmailAddress;
  to:             EmailAddress[];
  cc:             EmailAddress[];
  replyTo:        EmailAddress[];
  subject:        string;
  date:           Date | undefined;
  size:           number | undefined;   // message size in bytes
  flags:          string[];             // e.g. \Seen, \Answered, \Flagged, \Deleted, \Draft
  hasAttachments: boolean;
}

/**
 * Attachment metadata — no content.
 * Use partId with fetch_attachment to download content.
 */
export interface AttachmentMetadata {
  partId:      string;             // IMAP body part identifier, e.g. '2' or '1.2'
  filename:    string | undefined;
  contentType: string;
  size:        number;             // bytes
}

/**
 * Full parsed email — body included, attachment content excluded.
 * Attachments are represented as metadata only; use fetch_attachment for content.
 */
export interface EmailMessage extends EmailSummary {
  textBody:    string | undefined;
  htmlBody:    string | undefined;
  attachments: AttachmentMetadata[];
}

/** Attachment content returned by fetch_attachment */
export interface AttachmentContent {
  emailId:     EmailId;
  partId:      string;
  filename:    string | undefined;
  contentType: string;
  data:        string;   // base64-encoded binary content
  size:        number;
}

/** Shared base fields for both folders and labels */
export interface MailboxBase {
  name:         string;           // leaf name, e.g. "Work"
  listed:       boolean;          // appeared in the LIST response
  subscribed:   boolean;          // folder/label is subscribed
  flags:        string[];         // IMAP folder attributes, e.g. "\\HasNoChildren"
  specialUse?:  string;           // RFC 6154 special-use: \\Sent, \\Drafts, \\Trash, \\Junk, etc.
  messageCount: number;           // total messages (STATUS MESSAGES)
  unreadCount:  number;           // unseen messages (STATUS UNSEEN)
  uidNext:      number;           // next UID to be assigned (STATUS UIDNEXT)
}

/** IMAP mailbox/folder descriptor returned by get_folders */
export interface FolderInfo extends MailboxBase {
  path:         string;           // full hierarchy path, e.g. "INBOX", "Folders/Work"
  delimiter:    string;           // hierarchy delimiter, usually "/"
}

/** Simplified label descriptor returned by get_labels (no path/delimiter to avoid confusing LLMs) */
export type LabelInfo = MailboxBase;
