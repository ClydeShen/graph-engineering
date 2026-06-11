/**
 * webhook-connector.test.ts — Phase 12 DoD G2 (security gate):
 * unsigned/wrong-signature requests are 401 with ZERO message dispatch;
 * valid HMAC reaches onMessage with the untrusted flag.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';
import { WebhookConnector, verifyWebhookSignature } from './webhook-connector.js';

const SECRET = 'test-secret';

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

let connector: WebhookConnector;
let onMessage: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  connector = new WebhookConnector(SECRET);
  onMessage = vi.fn().mockResolvedValue('ack');
  await connector.start(onMessage);
});

describe('verifyWebhookSignature', () => {
  it('accepts a correct HMAC and rejects wrong/missing ones', () => {
    expect(verifyWebhookSignature('body', sign('body'), SECRET)).toBe(true);
    expect(verifyWebhookSignature('body', sign('other'), SECRET)).toBe(false);
    expect(verifyWebhookSignature('body', undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature('body', '', SECRET)).toBe(false);
  });
});

describe('WebhookConnector', () => {
  it('validateConfig refuses to start without an hmac secret (mandatory)', () => {
    const bare = new WebhookConnector('');
    expect(bare.validateConfig({}).ok).toBe(false);
    expect(connector.validateConfig({}).ok).toBe(true);
  });

  it('unsigned request → 401 and onMessage NEVER fires (zero graph writes)', async () => {
    const app = connector.buildRoute();
    const res = await app.request('/hooks/inbound', {
      method: 'POST',
      body: JSON.stringify({ sender: 'x', text: 'hi' }),
    });
    expect(res.status).toBe(401);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('wrong signature → 401 and onMessage never fires', async () => {
    const app = connector.buildRoute();
    const body = JSON.stringify({ sender: 'x', text: 'hi' });
    const res = await app.request('/hooks/inbound', {
      method: 'POST',
      headers: { 'X-Memex-Signature': sign('tampered') },
      body,
    });
    expect(res.status).toBe(401);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('valid HMAC dispatches a normalized, untrusted-flagged message', async () => {
    const app = connector.buildRoute();
    const body = JSON.stringify({ sender: 'ci-bot', chat_id: 'builds', text: 'build failed' });
    const res = await app.request('/hooks/inbound', {
      method: 'POST',
      headers: { 'X-Memex-Signature': sign(body) },
      body,
    });
    expect(res.status).toBe(200);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'webhook',
      sender_id: 'webhook:ci-bot',
      chat_id: 'builds',
      text: 'build failed',
      untrusted: true,
    }));
  });

  it('webhook is inbound-only: send() throws', async () => {
    await expect(connector.send('x', 'y')).rejects.toThrow('inbound-only');
  });

  it('meta carries the Phase 14 trust slots (trust_level + allowed_toolset)', () => {
    expect(connector.meta.trust_level).toBe('untrusted');
    expect(connector.meta.allowed_toolset).toEqual([]);
  });
});
