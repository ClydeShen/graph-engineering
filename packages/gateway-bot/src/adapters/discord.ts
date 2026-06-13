import { createPublicKey, verify } from 'crypto';
import { Hono } from 'hono';
import { channelDispatcher } from '../channel-http.js';

type OnMessage = (chatId: string, text: string, interactionId: string) => Promise<string>;

// Shared proxy dispatcher (DISCORD_PROXY → standard proxy env → system proxy).
const discordDispatcher = () => channelDispatcher('DISCORD_PROXY', ['discord.com']);

// Discord uses Ed25519 signatures. The plan text says "HMAC-SHA256" — that is a
// misnomer; Discord's actual protocol is Ed25519 (X-Signature-Ed25519 header).
function verifyDiscordSignature(publicKeyHex: string, signature: string, timestamp: string, body: string): boolean {
  try {
    const rawKey = Buffer.from(publicKeyHex, 'hex');
    // Wrap raw 32-byte Ed25519 key into DER SubjectPublicKeyInfo format
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const spkiKey = Buffer.concat([spkiPrefix, rawKey]);
    const pubKey = createPublicKey({ key: spkiKey, format: 'der', type: 'spki' });
    const msg = Buffer.from(timestamp + body);
    const sig = Buffer.from(signature, 'hex');
    return verify(null, msg, pubKey, sig);
  } catch {
    return false;
  }
}

export async function sendToDiscord(webhookUrl: string, content: string): Promise<void> {
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
    dispatcher: discordDispatcher(),
  } as RequestInit);
}

export function buildDiscordApp(onMessage: OnMessage): Hono {
  const app = new Hono();

  app.post('/discord/interactions', async (c) => {
    const publicKey = process.env['DISCORD_PUBLIC_KEY'] ?? '';
    const signature = c.req.header('X-Signature-Ed25519') ?? '';
    const timestamp = c.req.header('X-Signature-Timestamp') ?? '';
    const rawBody = await c.req.text();

    if (!verifyDiscordSignature(publicKey, signature, timestamp, rawBody)) {
      return c.text('Invalid signature', 401);
    }

    const body = JSON.parse(rawBody) as { type: number; id?: string; data?: { options?: Array<{ value: string }> }; channel_id?: string };

    // Discord PING handshake (type 1)
    if (body.type === 1) {
      return c.json({ type: 1 });
    }

    // Slash command interaction (type 2)
    const text = body.data?.options?.[0]?.value ?? '';
    const chatId = body.channel_id ?? '';
    const interactionId = body.id ?? '';
    if (chatId && text) {
      const reply = await onMessage(chatId, text, interactionId);
      return c.json({ type: 4, data: { content: reply } });
    }

    return c.json({ type: 4, data: { content: 'No input received.' } });
  });

  return app;
}

export async function registerSlashCommand(
  botToken: string,
  applicationId: string,
): Promise<void> {
  await fetch(`https://discord.com/api/v10/applications/${applicationId}/commands`, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([
      {
        name: 'graph',
        description: 'Send a message to the graph runtime',
        options: [{ name: 'text', description: 'Your message', type: 3, required: true }],
      },
    ]),
    dispatcher: discordDispatcher(),
  } as RequestInit);
}
