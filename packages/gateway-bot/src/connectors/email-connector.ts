/**
 * EmailConnector — IMAP poll + SMTP send over an injectable transport
 * (Phase 12 deliverable #2).
 *
 * The EmailTransport seam keeps the connector logic library-agnostic and
 * fully testable: production binds an imapflow/nodemailer-backed transport at
 * install time; tests inject a fake. Thread → sessionKey mapping reuses the
 * TD-E semantics: chat_id = normalized thread id, so replies in the same
 * email thread continue the same session scope, and Phase 13 identity
 * unification sees `email:<address>` sender ids with zero migration.
 *
 * Attachments are out of scope (12-PHASE-SPEC); the type slot exists.
 */

import type {
  ConnectorAdapter,
  ConnectorMetadata,
  ConnectorCheckResult,
  ChannelMessageEvent,
} from '@graph/types/connector';

export interface InboundEmail {
  from: string;
  subject: string;
  text: string;
  message_id: string;
  /** In-Reply-To / References root — thread anchor. */
  thread_id?: string;
}

/** Library-agnostic transport seam (bind imapflow/nodemailer in production). */
export interface EmailTransport {
  /** Fetch unseen messages and mark them seen. */
  fetchUnseen(): Promise<InboundEmail[]>;
  sendMail(to: string, subject: string, text: string): Promise<void>;
  /** Connectivity probe. */
  verify(): Promise<void>;
}

export interface EmailConnectorOptions {
  transport: EmailTransport;
  /** Poll interval. */
  pollIntervalMs?: number;
}

/** Normalize a thread anchor: thread_id when present, else the message id. */
export function emailThreadKey(mail: InboundEmail): string {
  return mail.thread_id ?? mail.message_id;
}

export class EmailConnector implements ConnectorAdapter {
  readonly meta: ConnectorMetadata = {
    platform: 'email',
    required_env: ['MEMEX_IMAP_URL', 'MEMEX_SMTP_URL'],
    platform_hint: 'You are replying by email. Write a complete, self-contained reply; no chat shorthand.',
    pii_safe: true,
  };

  constructor(private readonly opts: EmailConnectorOptions) {}

  async check(): Promise<ConnectorCheckResult> {
    try {
      await this.opts.transport.verify();
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  validateConfig(config: Record<string, unknown>): ConnectorCheckResult {
    const imap = (config['imap_url'] as string | undefined) ?? process.env['MEMEX_IMAP_URL'];
    const smtp = (config['smtp_url'] as string | undefined) ?? process.env['MEMEX_SMTP_URL'];
    if (!imap) return { ok: false, detail: 'imap_url missing' };
    if (!smtp) return { ok: false, detail: 'smtp_url missing' };
    return { ok: true };
  }

  /** One poll pass — exported for tests and for the cron-style loop. */
  async pollOnce(onMessage: (evt: ChannelMessageEvent) => Promise<string>): Promise<number> {
    const mails = await this.opts.transport.fetchUnseen();
    for (const mail of mails) {
      const reply = await onMessage({
        channel: 'email',
        sender_id: `email:${mail.from}`,
        chat_id: emailThreadKey(mail),
        text: `${mail.subject}\n\n${mail.text}`,
        message_id: mail.message_id,
        received_at: new Date().toISOString(),
      });
      if (reply.length > 0) {
        await this.opts.transport.sendMail(mail.from, `Re: ${mail.subject}`, reply);
      }
    }
    return mails.length;
  }

  async start(
    onMessage: (evt: ChannelMessageEvent) => Promise<string>,
    signal?: AbortSignal,
  ): Promise<void> {
    while (!signal?.aborted) {
      try {
        await this.pollOnce(onMessage);
      } catch {
        /* poll failure — keep the loop alive */
      }
      await new Promise((r) => setTimeout(r, this.opts.pollIntervalMs ?? 60_000));
    }
  }

  async send(target: string, text: string): Promise<void> {
    await this.opts.transport.sendMail(target, 'Message from MemexOS', text);
  }
}
