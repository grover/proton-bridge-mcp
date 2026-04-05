import type { EmailId, EmailSummary, EmailMessage, AttachmentContent, FolderInfo, LabelInfo } from './email.js';
import type {
  CreateFolderResult,
  CreateLabelResult,
  DeleteFolderResult,
  AddLabelsBatchResult,
  BatchToolResult,
  SingleToolResult,
  MoveResult,
  FlagResult,
  RevertResult,
} from './operations.js';

/** Read-only mailbox operations — implemented by ImapClient. */
export interface ReadOnlyMailOps {
  getFolders(): Promise<FolderInfo[]>;
  getLabels(): Promise<LabelInfo[]>;
  listMailbox(mailbox: string, limit: number, offset: number): Promise<EmailSummary[]>;
  fetchSummaries(ids: EmailId[]): Promise<EmailSummary[]>;
  fetchMessage(ids: EmailId[]): Promise<EmailMessage[]>;
  fetchAttachment(id: EmailId, partId: string): Promise<AttachmentContent>;
  searchMailbox(mailbox: string, query: string, limit: number, offset: number): Promise<EmailSummary[]>;
}

/** Mutating mailbox operations — implemented by OperationLogInterceptor. */
export interface MutatingMailOps {
  moveEmails(ids: EmailId[], targetMailbox: string): Promise<BatchToolResult<MoveResult>>;
  markRead(ids: EmailId[]): Promise<BatchToolResult<FlagResult>>;
  markUnread(ids: EmailId[]): Promise<BatchToolResult<FlagResult>>;
  createFolder(path: string): Promise<SingleToolResult<CreateFolderResult>>;
  createLabel(name: string): Promise<SingleToolResult<CreateLabelResult>>;
  deleteFolder(path: string): Promise<SingleToolResult<DeleteFolderResult>>;
  addLabels(ids: EmailId[], labelNames: string[]): Promise<AddLabelsBatchResult>;
  revertOperations(operationId: number): Promise<RevertResult>;
}
