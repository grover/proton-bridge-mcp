import { simpleParser } from 'mailparser';
import type { ImapFlow, FetchMessageObject, MessageAddressObject } from 'imapflow';
import { Audited } from './decorators.js';
import type { AuditLogger } from './audit.js';
import type { ImapConnectionPool } from './pool.js';
import type { AppLogger } from '../logger.js';
import type {
  EmailId,
  EmailAddress,
  EmailSummary,
  EmailMessage,
  AttachmentMetadata,
  AttachmentContent,
  FolderInfo,
  MoveBatchResult,
  FlagBatchResult,
  BatchItemResult,
  MoveResult,
  FlagResult,
} from '../types/index.js';

export class ImapClient {
  readonly audit: AuditLogger;
  readonly #pool: ImapConnectionPool;
  readonly #logger: AppLogger;

  constructor(pool: ImapConnectionPool, audit: AuditLogger, logger: AppLogger) {
    this.#pool  = pool;
    this.audit  = audit;
    this.#logger = logger;
  }

  @Audited('list_folders')
  async listFolders(): Promise<FolderInfo[]> {
    const conn = await this.#pool.acquire();
    try {
      const mailboxes = await conn.list();
      return mailboxes.map(mb => ({
        path:      mb.path,
        name:      mb.name,
        delimiter: mb.delimiter ?? '/',
        flags:     [...mb.flags],
        ...(mb.specialUse ? { specialUse: mb.specialUse } : {}),
      }));
    } finally {
      this.#pool.release(conn);
    }
  }

  @Audited('list_mailbox')
  async listMailbox(
    mailbox: string,
    limit:   number,
    offset:  number,
  ): Promise<EmailSummary[]> {
    const conn = await this.#pool.acquire();
    const lock = await conn.getMailboxLock(mailbox);
    try {
      const total = conn.mailbox !== false ? (conn.mailbox.exists ?? 0) : 0;
      if (total === 0) return [];

      // Message sequence numbers: 1 = oldest, total = newest
      const end   = Math.max(0, total - offset);
      const start = Math.max(1, end - limit + 1);
      if (end < start) return [];

      const summaries: EmailSummary[] = [];
      for await (const msg of conn.fetch(`${start}:${end}`, {
        uid:           true,
        flags:         true,
        envelope:      true,
        size:          true,
        bodyStructure: true,
      })) {
        summaries.push(toEmailSummary(msg, mailbox));
      }
      return summaries.reverse(); // newest first
    } finally {
      lock.release();
      this.#pool.release(conn);
    }
  }

  @Audited('fetch_summaries')
  async fetchSummaries(ids: EmailId[]): Promise<EmailSummary[]> {
    return this.#fetchByIds(ids, async (conn, mailbox, mailboxIds) => {
      const uidSet = mailboxIds.map(id => id.uid).join(',');
      const results: EmailSummary[] = [];
      for await (const msg of conn.fetch(uidSet, {
        uid:           true,
        flags:         true,
        envelope:      true,
        size:          true,
        bodyStructure: true,
      }, { uid: true })) {
        results.push(toEmailSummary(msg, mailbox));
      }
      return results;
    });
  }

  @Audited('fetch_message')
  async fetchMessage(ids: EmailId[]): Promise<EmailMessage[]> {
    return this.#fetchByIds(ids, async (conn, mailbox, mailboxIds) => {
      const uidSet = mailboxIds.map(id => id.uid).join(',');
      const results: EmailMessage[] = [];
      for await (const msg of conn.fetch(uidSet, {
        uid:           true,
        flags:         true,
        envelope:      true,
        size:          true,
        bodyStructure: true,
        source:        true,
      }, { uid: true })) {
        if (!msg.source) {
          results.push({ ...toEmailSummary(msg, mailbox), textBody: undefined, htmlBody: undefined, attachments: [] });
          continue;
        }
        const parsed = await simpleParser(msg.source);
        const summary = toEmailSummary(msg, mailbox);
        const attachments: AttachmentMetadata[] = (parsed.attachments ?? []).map((att, idx) => ({
          partId:      String(idx + 1),
          filename:    att.filename ?? undefined,
          contentType: att.contentType,
          size:        att.size ?? 0,
        }));
        results.push({
          ...summary,
          textBody:    parsed.text    ?? undefined,
          htmlBody:    parsed.html    || undefined,  // html is string|false in mailparser
          attachments,
        });
      }
      return results;
    });
  }

  @Audited('fetch_attachment')
  async fetchAttachment(id: EmailId, partId: string): Promise<AttachmentContent> {
    const conn = await this.#pool.acquire();
    const lock = await conn.getMailboxLock(id.mailbox);
    try {
      let content: Buffer | undefined;
      let contentType = 'application/octet-stream';
      let filename: string | undefined;

      for await (const msg of conn.fetch(String(id.uid), {
        uid:           true,
        bodyStructure: true,
        source:        true,
      }, { uid: true })) {
        if (!msg.source) break;
        const parsed = await simpleParser(msg.source);
        const partIndex = parseInt(partId, 10) - 1;
        const att = parsed.attachments?.[partIndex];
        if (att) {
          content     = att.content;
          contentType = att.contentType;
          filename    = att.filename ?? undefined;
        }
      }

      if (!content) {
        throw new Error(`Attachment part ${partId} not found in email uid=${id.uid} mailbox=${id.mailbox}`);
      }

      return {
        emailId:     id,
        partId,
        filename,
        contentType,
        data:        content.toString('base64'),
        size:        content.length,
      };
    } finally {
      lock.release();
      this.#pool.release(conn);
    }
  }

  @Audited('search_mailbox')
  async searchMailbox(
    mailbox: string,
    query:   string,
    limit:   number,
    offset:  number,
  ): Promise<EmailSummary[]> {
    const conn = await this.#pool.acquire();
    const lock = await conn.getMailboxLock(mailbox);
    try {
      const uids = await conn.search({ text: query }, { uid: true });
      if (!uids || uids.length === 0) return [];

      const pageUids = uids.slice(offset, offset + limit);
      if (pageUids.length === 0) return [];

      const uidSet = pageUids.join(',');
      const summaries: EmailSummary[] = [];
      for await (const msg of conn.fetch(uidSet, {
        uid:           true,
        flags:         true,
        envelope:      true,
        size:          true,
        bodyStructure: true,
      }, { uid: true })) {
        summaries.push(toEmailSummary(msg, mailbox));
      }
      return summaries;
    } finally {
      lock.release();
      this.#pool.release(conn);
    }
  }

  @Audited('move_emails')
  async moveEmails(ids: EmailId[], targetMailbox: string): Promise<MoveBatchResult> {
    const results: Array<BatchItemResult<MoveResult>> = ids.map(id => ({ id }));

    // Group by source mailbox
    const groups = groupByMailbox(ids);

    for (const [mailbox, mailboxIds] of groups) {
      const conn = await this.#pool.acquire();
      const lock = await conn.getMailboxLock(mailbox);
      try {
        for (const id of mailboxIds) {
          const idx = ids.indexOf(id);
          try {
            const moved = await conn.messageMove(String(id.uid), targetMailbox, { uid: true });
            // moved.uidMap is Map<number,number>; false means the server gave no COPYUID response
            const targetUid = moved !== false ? moved.uidMap?.get(id.uid) : undefined;
            results[idx] = {
              id,
              data: {
                fromMailbox: mailbox,
                toMailbox:   targetMailbox,
                targetId:    targetUid ? { uid: targetUid, mailbox: targetMailbox } : undefined,
              },
            };
          } catch (err) {
            results[idx] = {
              id,
              error: { code: 'MOVE_FAILED', message: err instanceof Error ? err.message : String(err) },
            };
          }
        }
      } finally {
        lock.release();
        this.#pool.release(conn);
      }
    }

    return results as MoveBatchResult;
  }

  @Audited('set_flag')
  async setFlag(ids: EmailId[], flag: string, add: boolean): Promise<FlagBatchResult> {
    const results: Array<BatchItemResult<FlagResult>> = ids.map(id => ({ id }));
    const groups = groupByMailbox(ids);

    for (const [mailbox, mailboxIds] of groups) {
      const conn = await this.#pool.acquire();
      const lock = await conn.getMailboxLock(mailbox);
      try {
        for (const id of mailboxIds) {
          const idx = ids.indexOf(id);
          try {
            if (add) {
              await conn.messageFlagsAdd(String(id.uid), [flag], { uid: true });
            } else {
              await conn.messageFlagsRemove(String(id.uid), [flag], { uid: true });
            }
            // Fetch updated flags
            const flagsAfter: string[] = [];
            for await (const msg of conn.fetch(String(id.uid), { uid: true, flags: true }, { uid: true })) {
              flagsAfter.push(...(msg.flags ? [...msg.flags] : []));
            }
            results[idx] = { id, data: { flagsAfter } };
          } catch (err) {
            results[idx] = {
              id,
              error: { code: 'FLAG_FAILED', message: err instanceof Error ? err.message : String(err) },
            };
          }
        }
      } finally {
        lock.release();
        this.#pool.release(conn);
      }
    }

    return results as FlagBatchResult;
  }

  /** Shared helper: fetch per mailbox group, reorder to match input order */
  async #fetchByIds<T extends { id: EmailId }>(
    ids:     EmailId[],
    fetcher: (conn: ImapFlow, mailbox: string, mailboxIds: EmailId[]) => Promise<T[]>,
  ): Promise<T[]> {
    const groups  = groupByMailbox(ids);
    const byUid   = new Map<string, T>(); // "mailbox:uid" → result

    for (const [mailbox, mailboxIds] of groups) {
      const conn = await this.#pool.acquire();
      const lock = await conn.getMailboxLock(mailbox);
      try {
        const items = await fetcher(conn, mailbox, mailboxIds);
        for (const item of items) {
          byUid.set(`${item.id.mailbox}:${item.id.uid}`, item);
        }
      } finally {
        lock.release();
        this.#pool.release(conn);
      }
    }

    // Return in input order, skipping not-found
    return ids
      .map(id => byUid.get(`${id.mailbox}:${id.uid}`))
      .filter((item): item is T => item !== undefined);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function groupByMailbox(ids: EmailId[]): Map<string, EmailId[]> {
  const map = new Map<string, EmailId[]>();
  for (const id of ids) {
    const group = map.get(id.mailbox);
    if (group) {
      group.push(id);
    } else {
      map.set(id.mailbox, [id]);
    }
  }
  return map;
}

function toEmailAddress(addr: MessageAddressObject): EmailAddress {
  return {
    address: addr.address ?? '',
    ...(addr.name ? { name: addr.name } : {}),
  };
}

function toEmailAddresses(addrs: MessageAddressObject[] | undefined): EmailAddress[] {
  return (addrs ?? []).map(toEmailAddress);
}

function hasAttachments(msg: FetchMessageObject): boolean {
  const structure = msg.bodyStructure;
  if (!structure) return false;
  if (structure.disposition === 'attachment') return true;
  if (structure.childNodes) {
    return structure.childNodes.some(
      node => node.disposition === 'attachment',
    );
  }
  return false;
}

function toEmailSummary(msg: FetchMessageObject, mailbox: string): EmailSummary {
  return {
    id:          { uid: msg.uid, mailbox },
    messageId:   msg.envelope?.messageId ?? undefined,
    from:        msg.envelope?.from?.[0] ? toEmailAddress(msg.envelope.from[0]) : { address: '' },
    to:          toEmailAddresses(msg.envelope?.to),
    cc:          toEmailAddresses(msg.envelope?.cc),
    replyTo:     toEmailAddresses(msg.envelope?.replyTo),
    subject:     msg.envelope?.subject ?? '',
    date:        msg.envelope?.date ?? undefined,
    size:        msg.size ?? undefined,
    flags:       msg.flags ? [...msg.flags] : [],
    hasAttachments: hasAttachments(msg),
  };
}
