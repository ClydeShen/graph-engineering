interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
  };
}

type OnMessage = (chatId: string, text: string, updateId: number) => Promise<string>;

async function sendMessage(token: string, chatId: string, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

export async function startLongPoll(
  token: string,
  onMessage: OnMessage,
  signal?: AbortSignal,
): Promise<void> {
  let offset = 0;
  const base = `https://api.telegram.org/bot${token}`;
  // Startup marker — without it a live channel is indistinguishable from a
  // dead one in the logs (UX-audit U14/U20 verification hatch).
  console.log('[telegram] long-poll started');

  while (!signal?.aborted) {
    let updates: TelegramUpdate[] = [];
    try {
      const res = await fetch(`${base}/getUpdates?timeout=30&offset=${offset}`, { signal });
      const data = (await res.json()) as { ok: boolean; result: TelegramUpdate[] };
      if (data.ok) updates = data.result;
    } catch (err) {
      if (signal?.aborted) return;
      console.error('[telegram] getUpdates error:', err instanceof Error ? err.message : String(err));
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    for (const update of updates) {
      const text = update.message?.text ?? '';
      const chatId = String(update.message?.chat?.id ?? '');
      if (chatId && text) {
        try {
          const reply = await onMessage(chatId, text, update.update_id);
          await sendMessage(token, chatId, reply);
        } catch (err) {
          console.error('[telegram] dispatch error:', err instanceof Error ? err.message : String(err));
        }
      }
      offset = update.update_id + 1;
    }
  }
}

export async function startWebhook(
  token: string,
  webhookUrl: string,
  port: number,
  onMessage: OnMessage,
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl }),
  });

  const { Hono } = await import('hono');
  const { serve } = await import('@hono/node-server');
  const app = new Hono();

  app.post('/telegram/webhook', async (c) => {
    const update = (await c.req.json()) as TelegramUpdate;
    const text = update.message?.text ?? '';
    const chatId = String(update.message?.chat?.id ?? '');
    if (chatId && text) {
      const reply = await onMessage(chatId, text, update.update_id);
      await sendMessage(token, chatId, reply);
    }
    return c.json({ ok: true });
  });

  serve({ fetch: app.fetch, port });
}
