export type AuditOutcome = 'success' | 'partial' | 'error';

export interface AuditEntry {
  timestamp:   string;          // ISO 8601
  operation:   string;          // e.g. 'list_mailbox', 'move_emails'
  durationMs:  number;
  input:       unknown;         // sanitized — passwords stripped
  outcome:     AuditOutcome;
  itemCount?:  number;          // batch ops: total items processed
  errorCount?: number;          // batch ops: items that failed
  error?:      string;          // top-level failure message
}
