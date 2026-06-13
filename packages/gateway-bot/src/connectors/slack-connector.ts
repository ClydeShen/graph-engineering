/**
 * SlackConnector — Socket Mode without the Slack SDK (Phase 12 deliverable #2).
 *
 * Socket Mode = outbound-only: apps.connections.open (app-level token) yields
 * a WSS URL; events arrive over the socket and must be ack'd by envelope_id;
 * replies go out via chat.postMessage (bot token). No inbound port — same
 * posture as Telegram long-poll.
 *
 * Transports are injectable (fetchFn / wsFactory) so the protocol logic is
 * fully unit-testable; defaults use global fetch/WebSocket (Node 22 / Bun).
 */

import type {
  ConnectorAdapter,
  ConnectorMetadata,
  ConnectorCheckResult,
  ChannelMessageEvent,
} from '@graph/types/connector';
import { channelDispatcher } from '../channel-http.js';

const SLACK_API_HOST = 'slack.com';

interface SlackEnvelope {
  envelope_id?: string;
  type?: string;
  payload?: {
    event?: {
      type?: string;
      user?: string;
      channel?: string;
      text?: string;
      ts?: string;
      bot_id?: string;
    };
  };
}

export interface SlackWsLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    cb: (evt: { data?: unknown }) => void,
  ): void;
}

export interface SlackConnectorOptions {
  /** xapp- app-level token (connections.open). */
  appToken: string;
  /** xoxb- bot token (chat.postMessage, auth.test). */
  botToken: string;
  fetchFn?: typeof fetch;
  wsFactory?: (url: string) => SlackWsLike;
  /** Reconnect backoff between socket sessions. */
  reconnectDelayMs?: number;
}

export class SlackConnector implements ConnectorAdapter {
  readonly meta: ConnectorMetadata = {
    platform: 'slack',
    required_env: ['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN'],
    platform_hint: 'You are replying inside Slack. mrkdwn formatting, no HTML.',
    pii_safe: false,
  };

  constructor(private readonly opts: SlackConnectorOptions) {}

  private get fetchFn(): typeof fetch {
    if (this.opts.fetchFn) return this.opts.fetchFn;
    // DRY with Telegram/Discord: route Slack API calls through channelDispatcher
    // (SLACK_PROXY → standard proxy env → system proxy) instead of bare fetch,
    // so proxy/restricted networks reach slack.com.
    return ((...args: Parameters<typeof fetch>) =>
      fetch(args[0], {
        ...args[1],
        dispatcher: channelDispatcher('SLACK_PROXY', [SLACK_API_HOST]),
      } as RequestInit)) as typeof fetch;
  }

  async check(): Promise<ConnectorCheckResult> {
    try {
      const res = await this.fetchFn('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.opts.botToken}` },
      });
      const body = (await res.json()) as { ok: boolean; error?: string };
      return body.ok ? { ok: true } : { ok: false, detail: body.error ?? 'auth.test failed' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  validateConfig(config: Record<string, unknown>): ConnectorCheckResult {
    const app = (config['app_token'] as string | undefined) ?? this.opts.appToken;
    const bot = (config['bot_token'] as string | undefined) ?? this.opts.botToken;
    if (!app?.startsWith('xapp-')) return { ok: false, detail: 'app token must be an xapp- token' };
    if (!bot?.startsWith('xoxb-')) return { ok: false, detail: 'bot token must be an xoxb- token' };
    return { ok: true };
  }

  /** Open one socket session. Resolves when the socket closes (caller reconnects). */
  async runSocketSession(
    onMessage: (evt: ChannelMessageEvent) => Promise<string>,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await this.fetchFn('https://slack.com/api/apps.connections.open', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.appToken}` },
    });
    const body = (await res.json()) as { ok: boolean; url?: string; error?: string };
    if (!body.ok || body.url === undefined) {
      throw new Error(`connections.open failed: ${body.error ?? 'no url'}`);
    }

    const factory =
      this.opts.wsFactory ??
      ((url: string) => {
        // undici's WebSocket accepts a WebSocketInit ({ dispatcher }) at runtime
        // (per undici docs); the DOM lib type only declares `protocols`, hence the
        // cast. Routes the Socket Mode socket through the same proxy as the API.
        const init = { dispatcher: channelDispatcher('SLACK_PROXY', [new URL(url).host]) };
        return new WebSocket(url, init as unknown as string[]) as unknown as SlackWsLike;
      });
    const ws = factory(body.url);

    return new Promise<void>((resolve) => {
      const stop = (): void => {
        ws.close();
        resolve();
      };
      signal?.addEventListener('abort', stop, { once: true });

      ws.addEventListener('close', () => resolve());
      ws.addEventListener('error', () => resolve());
      ws.addEventListener('message', (evt) => {
        void this.handleEnvelope(String(evt.data), ws, onMessage);
      });
    });
  }

  /** Parse one Socket Mode envelope: ack first, then dispatch message events. */
  async handleEnvelope(
    raw: string,
    ws: SlackWsLike,
    onMessage: (evt: ChannelMessageEvent) => Promise<string>,
  ): Promise<void> {
    let envelope: SlackEnvelope;
    try {
      envelope = JSON.parse(raw) as SlackEnvelope;
    } catch {
      return;
    }

    // Ack EVERY envelope immediately — Slack redelivers unacked envelopes.
    if (envelope.envelope_id !== undefined) {
      ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }

    if (envelope.type !== 'events_api') return;
    const event = envelope.payload?.event;
    if (event?.type !== 'message') return;
    if (event.bot_id !== undefined) return; // never loop on our own messages
    if (typeof event.text !== 'string' || event.text.length === 0) return;
    if (typeof event.channel !== 'string') return;

    const reply = await onMessage({
      channel: 'slack',
      sender_id: `slack:${event.user ?? 'unknown'}`,
      chat_id: event.channel,
      text: event.text,
      message_id: event.ts ?? `slack-${Date.now()}`,
      received_at: new Date().toISOString(),
    });
    if (reply.length > 0) {
      await this.send(event.channel, reply);
    }
  }

  async start(
    onMessage: (evt: ChannelMessageEvent) => Promise<string>,
    signal?: AbortSignal,
  ): Promise<void> {
    while (!signal?.aborted) {
      try {
        await this.runSocketSession(onMessage, signal);
      } catch {
        /* connections.open failure — back off and retry */
      }
      if (signal?.aborted) return;
      await new Promise((r) => setTimeout(r, this.opts.reconnectDelayMs ?? 5000));
    }
  }

  async send(target: string, text: string): Promise<void> {
    const res = await this.fetchFn('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.botToken}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: target, text }),
    });
    const body = (await res.json()) as { ok: boolean; error?: string };
    if (!body.ok) throw new Error(`chat.postMessage failed: ${body.error ?? 'unknown'}`);
  }
}
