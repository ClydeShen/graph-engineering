/**
 * Production EmailTransport — imapflow (IMAP poll) + nodemailer (SMTP send),
 * clearing the Phase 12 leftover (TD: "Email 生产绑定"). Implements the
 * library-agnostic seam from email-connector.ts; all connector logic stays
 * transport-blind and unit-tested against fakes.
 *
 * URLs: standard imap(s):// and smtp(s):// connection strings, e.g.
 *   MEMEX_IMAP_URL=imaps://user:pass@imap.example.com:993
 *   MEMEX_SMTP_URL=smtps://user:pass@smtp.example.com:465
 * Credentials embedded in the URL come from env (config keeps ${VAR} refs).
 */

import { ImapFlow } from 'imapflow';
import { createTransport, type Transporter } from 'nodemailer';
import type { EmailTransport, InboundEmail } from './email-connector.js';

/** Parse an imap(s):// URL into ImapFlow constructor options. */
export function parseImapUrl(url: string): {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
} {
  const u = new URL(url);
  if (u.protocol !== 'imap:' && u.protocol !== 'imaps:') {
    throw new Error(`expected imap(s):// URL, got ${u.protocol}//`);
  }
  const secure = u.protocol === 'imaps:';
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : secure ? 993 : 143,
    secure,
    auth: { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) },
  };
}

export class ImapSmtpTransport implements EmailTransport {
  private readonly smtp: Transporter;
  private readonly fromAddress: string;

  constructor(
    private readonly imapUrl: string,
    smtpUrl: string,
  ) {
    this.smtp = createTransport(smtpUrl);
    this.fromAddress = decodeURIComponent(new URL(smtpUrl).username);
  }

  /**
   * One IMAP session per poll: connect, fetch UNSEEN, mark seen, logout.
   * Sessions are short-lived on purpose — a 60s poll cadence does not justify
   * IDLE connection management, and reconnect-per-poll is self-healing.
   */
  async fetchUnseen(): Promise<InboundEmail[]> {
    const client = new ImapFlow({ ...parseImapUrl(this.imapUrl), logger: false });
    await client.connect();
    const mails: InboundEmail[] = [];
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = await client.search({ seen: false });
        for (const uid of uids === false ? [] : uids) {
          const msg = await client.fetchOne(String(uid), { envelope: true, bodyParts: ['text'] });
          if (!msg) continue;
          const envelope = msg.envelope;
          const textPart = msg.bodyParts?.get('text');
          mails.push({
            from: envelope?.from?.[0]?.address ?? 'unknown',
            subject: envelope?.subject ?? '(no subject)',
            text: textPart ? textPart.toString('utf8') : '',
            message_id: envelope?.messageId ?? `imap-uid-${uid}`,
            ...(envelope?.inReplyTo ? { thread_id: envelope.inReplyTo } : {}),
          });
          await client.messageFlagsAdd(String(uid), ['\\Seen']);
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {
        /* already disconnected */
      });
    }
    return mails;
  }

  async sendMail(to: string, subject: string, text: string): Promise<void> {
    await this.smtp.sendMail({ from: this.fromAddress, to, subject, text });
  }

  async verify(): Promise<void> {
    // SMTP verify is a protocol-level handshake; IMAP verify = connect+logout.
    await this.smtp.verify();
    const client = new ImapFlow({ ...parseImapUrl(this.imapUrl), logger: false });
    await client.connect();
    await client.logout();
  }
}

/** Build from env; null when email is not configured (graceful skip). */
export function makeEmailTransportFromEnv(env: NodeJS.ProcessEnv = process.env): ImapSmtpTransport | null {
  const imap = env['MEMEX_IMAP_URL'];
  const smtp = env['MEMEX_SMTP_URL'];
  if (!imap || !smtp) return null;
  return new ImapSmtpTransport(imap, smtp);
}
