/**
 * slack-email.test.ts — Slack Socket Mode envelope handling + Email poll loop
 * (Phase 12 DoD G1/G7 unit level, injectable transports).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackConnector, type SlackWsLike } from './slack-connector.js';
import { EmailConnector, emailThreadKey, type EmailTransport, type InboundEmail } from './email-connector.js';

// ── Slack ────────────────────────────────────────────────────────────────────

function makeSlack(fetchImpl: (url: string) => unknown) {
  const fetchFn = vi.fn((url: string) =>
    Promise.resolve({ json: () => Promise.resolve(fetchImpl(url)) }),
  ) as unknown as typeof fetch;
  return { connector: new SlackConnector({ appToken: 'xapp-1', botToken: 'xoxb-1', fetchFn }), fetchFn: fetchFn as unknown as ReturnType<typeof vi.fn> };
}

function fakeWs(): SlackWsLike & { sent: string[] } {
  return {
    sent: [],
    send(d: string) { this.sent.push(d); },
    close() {},
    addEventListener() {},
  };
}

describe('SlackConnector', () => {
  it('validateConfig enforces xapp-/xoxb- token prefixes', () => {
    const { connector } = makeSlack(() => ({ ok: true }));
    expect(connector.validateConfig({}).ok).toBe(true);
    expect(connector.validateConfig({ app_token: 'wrong' }).ok).toBe(false);
    expect(connector.validateConfig({ bot_token: 'wrong' }).ok).toBe(false);
  });

  it('acks every envelope by envelope_id before dispatching', async () => {
    const { connector } = makeSlack(() => ({ ok: true }));
    const ws = fakeWs();
    const onMessage = vi.fn().mockResolvedValue('');
    await connector.handleEnvelope(
      JSON.stringify({ envelope_id: 'env-1', type: 'hello' }),
      ws,
      onMessage,
    );
    expect(JSON.parse(ws.sent[0]!)).toEqual({ envelope_id: 'env-1' });
    expect(onMessage).not.toHaveBeenCalled(); // hello is not an events_api envelope
  });

  it('dispatches message events with slack: prefixed sender and replies via chat.postMessage', async () => {
    const calls: string[] = [];
    const { connector } = makeSlack((url) => {
      calls.push(url);
      return { ok: true };
    });
    const ws = fakeWs();
    const onMessage = vi.fn().mockResolvedValue('the answer');

    await connector.handleEnvelope(
      JSON.stringify({
        envelope_id: 'env-2',
        type: 'events_api',
        payload: { event: { type: 'message', user: 'U7', channel: 'C9', text: 'question', ts: '1.2' } },
      }),
      ws,
      onMessage,
    );

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'slack',
      sender_id: 'slack:U7',
      chat_id: 'C9',
      text: 'question',
      message_id: '1.2',
    }));
    expect(calls).toContain('https://slack.com/api/chat.postMessage');
  });

  it('ignores bot messages (no self-loop)', async () => {
    const { connector } = makeSlack(() => ({ ok: true }));
    const onMessage = vi.fn();
    await connector.handleEnvelope(
      JSON.stringify({
        envelope_id: 'env-3',
        type: 'events_api',
        payload: { event: { type: 'message', bot_id: 'B1', channel: 'C9', text: 'self' } },
      }),
      fakeWs(),
      onMessage,
    );
    expect(onMessage).not.toHaveBeenCalled();
  });
});

// ── Email ────────────────────────────────────────────────────────────────────

function makeTransport(unseen: InboundEmail[]): EmailTransport & { sent: Array<[string, string, string]> } {
  return {
    sent: [],
    fetchUnseen: vi.fn().mockResolvedValue(unseen),
    async sendMail(to: string, subject: string, text: string) {
      this.sent.push([to, subject, text]);
    },
    verify: vi.fn().mockResolvedValue(undefined),
  };
}

describe('EmailConnector', () => {
  beforeEach(() => {
    process.env['MEMEX_IMAP_URL'] = 'imap://x';
    process.env['MEMEX_SMTP_URL'] = 'smtp://x';
  });

  it('pollOnce normalizes mail to email:-prefixed sender with thread-keyed chat_id and replies', async () => {
    const transport = makeTransport([
      { from: 'alice@example.com', subject: 'PR review', text: 'please look', message_id: 'm1', thread_id: 'th-9' },
    ]);
    const connector = new EmailConnector({ transport });
    const onMessage = vi.fn().mockResolvedValue('done, merged');

    const n = await connector.pollOnce(onMessage);

    expect(n).toBe(1);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'email',
      sender_id: 'email:alice@example.com',
      chat_id: 'th-9',
      message_id: 'm1',
    }));
    expect(transport.sent).toEqual([['alice@example.com', 'Re: PR review', 'done, merged']]);
  });

  it('thread key falls back to message_id when no thread anchor exists (same thread → same session)', () => {
    expect(emailThreadKey({ from: 'x', subject: 's', text: 't', message_id: 'm2' })).toBe('m2');
    expect(emailThreadKey({ from: 'x', subject: 's', text: 't', message_id: 'm2', thread_id: 'th' })).toBe('th');
  });

  it('empty reply sends nothing', async () => {
    const transport = makeTransport([
      { from: 'b@x.com', subject: 's', text: 't', message_id: 'm3' },
    ]);
    const connector = new EmailConnector({ transport });
    await connector.pollOnce(vi.fn().mockResolvedValue(''));
    expect(transport.sent).toHaveLength(0);
  });

  it('check surfaces transport verify failures as not-ok', async () => {
    const transport = makeTransport([]);
    (transport.verify as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('imap down'));
    const connector = new EmailConnector({ transport });
    expect(await connector.check()).toEqual({ ok: false, detail: 'imap down' });
  });
});
