import { describe, expect, it } from 'vitest';
import { parseImapUrl } from './email-transport.js';

describe('parseImapUrl', () => {
  it('parses imaps:// with default port 993 and decodes credentials', () => {
    expect(parseImapUrl('imaps://user%40example.com:p%40ss@imap.example.com')).toEqual({
      host: 'imap.example.com',
      port: 993,
      secure: true,
      auth: { user: 'user@example.com', pass: 'p@ss' },
    });
  });

  it('parses imap:// with default port 143 and explicit ports win', () => {
    expect(parseImapUrl('imap://u:p@h').port).toBe(143);
    expect(parseImapUrl('imap://u:p@h').secure).toBe(false);
    expect(parseImapUrl('imaps://u:p@h:9931').port).toBe(9931);
  });

  it('rejects non-imap protocols', () => {
    expect(() => parseImapUrl('smtp://u:p@h')).toThrow(/imap/);
  });
});
