/**
 * Stable email identifier.
 * IMAP UIDs are per-mailbox — always carry the mailbox alongside the UID.
 */
export interface EmailId {
  uid:     number;
  mailbox: string;
}

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

/** IMAP mailbox/folder descriptor returned by get_folders */
export interface FolderInfo {
  path:         string;           // full hierarchy path, e.g. "INBOX", "Folders/Work"
  name:         string;           // leaf name, e.g. "Work"
  delimiter:    string;           // hierarchy delimiter, usually "/"
  listed:       boolean;          // appeared in the LIST response
  subscribed:   boolean;          // folder is subscribed
  flags:        string[];         // IMAP folder attributes, e.g. "\\HasNoChildren"
  specialUse?:  string;           // RFC 6154 special-use: \\Sent, \\Drafts, \\Trash, \\Junk, etc.
  messageCount: number;           // total messages (STATUS MESSAGES)
  unreadCount:  number;           // unseen messages (STATUS UNSEEN)
  uidNext:      number;           // next UID to be assigned (STATUS UIDNEXT)
}
