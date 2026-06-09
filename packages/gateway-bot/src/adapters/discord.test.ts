import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, sign } from 'crypto';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeDiscordRequest(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'],
  body: unknown,
): Request {
  const bodyStr = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const msg = Buffer.from(timestamp + bodyStr);
  // Export raw 32-byte public key
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
  process.env['DISCORD_PUBLIC_KEY'] = Buffer.from(rawPub).toString('hex');
  const sig = sign(null, msg, privateKey).toString('hex');
  return new Request('http://localhost/discord/interactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signature-Ed25519': sig,
      'X-Signature-Timestamp': timestamp,
    },
    body: bodyStr,
  });
}

describe('Discord adapter', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env['DISCORD_PUBLIC_KEY'];
  });

  it('returns 401 for invalid X-Signature-Ed25519', async () => {
    process.env['DISCORD_PUBLIC_KEY'] = 'a'.repeat(64);
    const { buildDiscordApp } = await import('./discord.js');
    const app = buildDiscordApp(vi.fn());
    const res = await app.fetch(
      new Request('http://localhost/discord/interactions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature-Ed25519': 'dead'.repeat(16),
          'X-Signature-Timestamp': '1234567890',
        },
        body: JSON.stringify({ type: 1 }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('responds to PING (type 1) with PONG (type 1) given valid signature', async () => {
    const { buildDiscordApp } = await import('./discord.js');
    const app = buildDiscordApp(vi.fn());
    const req = makeDiscordRequest(privateKey, publicKey, { type: 1 });
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { type: number };
    expect(body.type).toBe(1);
  });

  it('sendToDiscord POSTs content to the webhook URL', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const { sendToDiscord } = await import('./discord.js');
    await sendToDiscord('https://discord.com/api/webhooks/test', 'hello from graph');
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://discord.com/api/webhooks/test');
    const body = JSON.parse(opts.body as string) as { content: string };
    expect(body.content).toBe('hello from graph');
  });
});
