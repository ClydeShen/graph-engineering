/**
 * TelegramConnector — reference implementation of the frozen ConnectorAdapter
 * contract (Phase 11 §6.1). Wraps the existing long-poll adapter; proves the
 * interface fits a real channel before Phase 12 implements four more against it.
 *
 * sender_id is channel-prefixed (`telegram:<chat_id>`) per the
 * ChannelPrefixedSenderId contract — Phase 13 identity unification consumes
 * this with zero migration.
 */

import type {
  ConnectorAdapter,
  ConnectorMetadata,
  ConnectorCheckResult,
  ChannelMessageEvent,
} from '@graph/types/connector';
import { startLongPoll } from '../adapters/telegram.js';

export class TelegramConnector implements ConnectorAdapter {
  readonly meta: ConnectorMetadata = {
    platform: 'telegram',
    required_env: ['TELEGRAM_BOT_TOKEN'],
    platform_hint: 'You are replying inside Telegram. Plain text only — no markdown tables.',
    pii_safe: false,
  };

  constructor(private readonly token: string) {}

  async check(): Promise<ConnectorCheckResult> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/getMe`);
      const body = (await res.json()) as { ok: boolean };
      return body.ok ? { ok: true } : { ok: false, detail: 'getMe returned not-ok' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  validateConfig(config: Record<string, unknown>): ConnectorCheckResult {
    const token = config['token'] ?? this.token;
    if (typeof token !== 'string' || token.length === 0) {
      return { ok: false, detail: 'telegram token missing' };
    }
    return { ok: true };
  }

  async start(
    onMessage: (evt: ChannelMessageEvent) => Promise<string>,
    signal?: AbortSignal,
  ): Promise<void> {
    await startLongPoll(
      this.token,
      async (chatId, text, updateId) =>
        onMessage({
          channel: 'telegram',
          sender_id: `telegram:${chatId}`,
          chat_id: chatId,
          text,
          message_id: String(updateId),
          received_at: new Date().toISOString(),
        }),
      signal,
    );
  }

  async send(target: string, text: string): Promise<void> {
    await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: target, text }),
    });
  }
}
