/**
 * Detects whether an imapflow error indicates a mailbox already exists.
 * Checks the RFC 5530 response code first, then falls back to text matching
 * for servers (like Proton Bridge) that send bare NO responses.
 */
export function isAlreadyExistsError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { serverResponseCode?: string; responseText?: string; response?: string };
  if (e.serverResponseCode === 'ALREADYEXISTS') return true;
  const text = e.responseText || e.response || '';
  return /already.?exists|mailbox exists/i.test(text);
}
