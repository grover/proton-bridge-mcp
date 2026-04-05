import { formatEmailId, parseEmailId, isEmailId, emailIdStringSchema } from './email.js';

describe('formatEmailId', () => {
  it('formats a simple EmailId', () => {
    expect(formatEmailId({ uid: 42, mailbox: 'INBOX' })).toBe('INBOX:42');
  });

  it('formats with nested mailbox path', () => {
    expect(formatEmailId({ uid: 7, mailbox: 'Folders/Work' })).toBe('Folders/Work:7');
  });

  it('formats with mailbox containing colons', () => {
    expect(formatEmailId({ uid: 123, mailbox: 'Folders/My:Project' }))
      .toBe('Folders/My:Project:123');
  });
});

describe('parseEmailId', () => {
  it('parses a simple EmailId string', () => {
    expect(parseEmailId('INBOX:42')).toEqual({ uid: 42, mailbox: 'INBOX' });
  });

  it('parses with nested mailbox path', () => {
    expect(parseEmailId('Folders/Work:7')).toEqual({ uid: 7, mailbox: 'Folders/Work' });
  });

  it('splits on the last colon (mailbox with colons)', () => {
    expect(parseEmailId('Folders/My:Project:123'))
      .toEqual({ uid: 123, mailbox: 'Folders/My:Project' });
  });

  it('throws on missing colon', () => {
    expect(() => parseEmailId('nocolon')).toThrow();
  });

  it('throws on empty UID', () => {
    expect(() => parseEmailId('INBOX:')).toThrow();
  });

  it('throws on UID zero', () => {
    expect(() => parseEmailId('INBOX:0')).toThrow();
  });

  it('throws on negative UID', () => {
    expect(() => parseEmailId('INBOX:-1')).toThrow();
  });

  it('throws on non-integer UID', () => {
    expect(() => parseEmailId('INBOX:3.5')).toThrow();
  });

  it('throws on non-numeric UID', () => {
    expect(() => parseEmailId('INBOX:abc')).toThrow();
  });

  it('throws on empty mailbox', () => {
    expect(() => parseEmailId(':42')).toThrow();
  });
});

describe('isEmailId', () => {
  it('returns true for a valid EmailId object', () => {
    expect(isEmailId({ uid: 42, mailbox: 'INBOX' })).toBe(true);
  });

  it('returns false for null', () => {
    expect(isEmailId(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isEmailId(undefined)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isEmailId('INBOX:42')).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isEmailId(42)).toBe(false);
  });

  it('returns false for an array', () => {
    expect(isEmailId([42, 'INBOX'])).toBe(false);
  });

  it('returns false for EmailAddress (different key names)', () => {
    expect(isEmailId({ address: 'test@example.com', name: 'Test' })).toBe(false);
  });

  it('returns false for object with extra keys', () => {
    expect(isEmailId({ uid: 42, mailbox: 'INBOX', extra: true })).toBe(false);
  });

  it('returns false for object with uid as string', () => {
    expect(isEmailId({ uid: '42', mailbox: 'INBOX' })).toBe(false);
  });

  it('returns false for object with mailbox as number', () => {
    expect(isEmailId({ uid: 42, mailbox: 123 })).toBe(false);
  });

  it('returns false for empty object', () => {
    expect(isEmailId({})).toBe(false);
  });

  it('returns false for object with only uid', () => {
    expect(isEmailId({ uid: 42 })).toBe(false);
  });

  it('returns false for object with only mailbox', () => {
    expect(isEmailId({ mailbox: 'INBOX' })).toBe(false);
  });
});

describe('emailIdStringSchema', () => {
  it('accepts and transforms a valid EmailId string', async () => {
    const result = await emailIdStringSchema.parseAsync('INBOX:42');
    expect(result).toEqual({ uid: 42, mailbox: 'INBOX' });
  });

  it('rejects strings shorter than 3 characters', async () => {
    await expect(emailIdStringSchema.parseAsync('X:')).rejects.toThrow();
  });

  it('rejects non-string input', async () => {
    await expect(emailIdStringSchema.parseAsync(42)).rejects.toThrow();
  });

  it('rejects malformed EmailId strings', async () => {
    await expect(emailIdStringSchema.parseAsync('nocolon')).rejects.toThrow();
  });

  it('handles mailbox names with colons', async () => {
    const result = await emailIdStringSchema.parseAsync('Folders/My:Project:123');
    expect(result).toEqual({ uid: 123, mailbox: 'Folders/My:Project' });
  });
});
