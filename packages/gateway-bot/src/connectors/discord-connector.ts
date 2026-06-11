/**
 * DiscordConnector — wraps the Phase 6 Discord adapter (Ed25519-verified
 * interactions endpoint + webhook outbound) into the frozen ConnectorAdapter
 * contract.
 *
 * Discord is push-based (interactions endpoint), so start() arms the handler;
 * the Hono route built by the Phase 6 adapter does the inbound work.
 */

import type {
  ConnectorAdapter,
  ConnectorMetadata,
  ConnectorCheckResult,
  ChannelMessageEvent,
} from '@graph/types/connector';
import { sendToDiscord } from '../adapters/discord.js';

export class DiscordConnector implements ConnectorAdapter {
  readonly meta: ConnectorMetadata = {
    platform: 'discord',
    required_env: ['DISCORD_PUBLIC_KEY', 'DISCORD_WEBHOOK_URL'],
    platform_hint: 'You are replying inside Discord. Keep messages under 2000 characters.',
    pii_safe: false,
  };

  private onMessage: ((evt: ChannelMessageEvent) => Promise<string>) | null = null;

  constructor(
    private readonly publicKey: string,
    private readonly webhookUrl: string,
  ) {}

  async check(): Promise<ConnectorCheckResult> {
    if (this.publicKey.length === 0) return { ok: false, detail: 'DISCORD_PUBLIC_KEY missing' };
    if (this.webhookUrl.length === 0) return { ok: false, detail: 'DISCORD_WEBHOOK_URL missing' };
    return { ok: true };
  }

  validateConfig(config: Record<string, unknown>): ConnectorCheckResult {
    const key = (config['public_key'] as string | undefined) ?? this.publicKey;
    return typeof key === 'string' && key.length > 0
      ? { ok: true }
      : { ok: false, detail: 'discord public key missing' };
  }

  async start(onMessage: (evt: ChannelMessageEvent) => Promise<string>): Promise<void> {
    this.onMessage = onMessage;
  }

  /** Adapter bridge: the Phase 6 interactions route calls this per message. */
  async dispatch(chatId: string, text: string, interactionId: string): Promise<string> {
    if (this.onMessage === null) return '';
    return this.onMessage({
      channel: 'discord',
      sender_id: `discord:${chatId}`,
      chat_id: chatId,
      text,
      message_id: interactionId,
      received_at: new Date().toISOString(),
    });
  }

  async send(_target: string, text: string): Promise<void> {
    await sendToDiscord(this.webhookUrl, text);
  }
}
