import { telegramFetch } from '../channel-http.js';
import { isChatAuthorized, allowlistStartupWarning } from '../channel-allowlist.js';

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
  };
}

type OnMessage = (chatId: string, text: string, updateId: number) => Promise<string>;

async function sendMessage(token: string, chatId: string, text: string): Promise<void> {
  // telegramFetch = proxy + SNI-preserving IP fallback (channel-http.ts, ported
  // from hermes). Reaches api.telegram.org on networks where plain fetch can't.
  await telegramFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

/** Resolve after `ms`, or immediately when `signal` aborts (clean shutdown). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

export interface LongPollOptions {
  /** First retry delay; doubles each consecutive failure up to maxDelayMs. */
  baseDelayMs?: number;
  /** Backoff ceiling. */
  maxDelayMs?: number;
  /**
   * Authorized chat IDs (TELEGRAM_ALLOWED_CHATS). Empty = allow all (with a
   * startup warning); '*' = explicit allow-all. Unlisted chats are dropped at
   * the edge — they never reach the agent. See channel-allowlist.ts.
   */
  allowlist?: string[];
}

export async function startLongPoll(
  token: string,
  onMessage: OnMessage,
  signal?: AbortSignal,
  opts: LongPollOptions = {},
): Promise<void> {
  let offset = 0;
  const base = `https://api.telegram.org/bot${token}`;
  const baseDelay = opts.baseDelayMs ?? 5_000;
  const maxDelay = opts.maxDelayMs ?? 300_000; // 5-min ceiling
  const allowlist = opts.allowlist ?? [];
  // Startup marker — without it a live channel is indistinguishable from a
  // dead one in the logs (UX-audit U14/U20 verification hatch).
  console.log('[telegram] long-poll started');
  const warning = allowlistStartupWarning('telegram', 'TELEGRAM_ALLOWED_CHATS', allowlist);
  if (warning) console.warn(warning);

  // Exponential backoff with log de-duplication: a misconfigured token or a
  // machine with no route to api.telegram.org otherwise floods `memex log`
  // with one identical "fetch failed" per poll. Log the first occurrence and
  // every reason change, then only a periodic heartbeat — never every retry.
  let failures = 0;
  let lastReason = '';
  let lastDeniedChat = ''; // de-dup denied-chat logs (an unauthorized spammer must not flood the log)
  const backoff = async (reason: string): Promise<void> => {
    failures += 1;
    const delay = Math.min(baseDelay * 2 ** (failures - 1), maxDelay);
    if (reason !== lastReason || failures % 12 === 0) {
      console.error(`[telegram] poll failing: ${reason} — retrying in ${Math.round(delay / 1000)}s (attempt ${failures})`);
      lastReason = reason;
    }
    await sleep(delay, signal);
  };

  while (!signal?.aborted) {
    let updates: TelegramUpdate[] = [];
    try {
      const res = await telegramFetch(`${base}/getUpdates?timeout=30&offset=${offset}`, { signal });
      const data = (await res.json()) as { ok: boolean; result: TelegramUpdate[]; description?: string };
      if (!data.ok) {
        // ok:false (e.g. 401 from a bad token) — back off; otherwise this is a
        // zero-delay tight loop hammering the API.
        await backoff(data.description ? `Telegram API: ${data.description}` : `HTTP ${res.status}`);
        continue;
      }
      updates = data.result;
      if (failures > 0) {
        console.log('[telegram] poll recovered');
        failures = 0;
        lastReason = '';
      }
    } catch (err) {
      if (signal?.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      // undici's bare "fetch failed" tells the user nothing (cf. terminal U6).
      const reason = /fetch failed/i.test(msg)
        ? 'cannot reach api.telegram.org (no network/DNS/firewall, or invalid token)'
        : msg;
      await backoff(reason);
      continue;
    }

    for (const update of updates) {
      const text = update.message?.text ?? '';
      const chatId = String(update.message?.chat?.id ?? '');
      if (chatId && text) {
        // Edge authorization: an unlisted chat is dropped here — it never
        // reaches dispatchMessage / the agent core (which can run execute_bash).
        if (!isChatAuthorized(chatId, allowlist).allowed) {
          if (chatId !== lastDeniedChat) {
            console.warn(`[telegram] dropped message from unauthorized chat ${chatId} (not in TELEGRAM_ALLOWED_CHATS)`);
            lastDeniedChat = chatId;
          }
          offset = update.update_id + 1;
          continue;
        }
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
  allowlist: string[] = [],
): Promise<void> {
  const warning = allowlistStartupWarning('telegram', 'TELEGRAM_ALLOWED_CHATS', allowlist);
  if (warning) console.warn(warning);
  // secret_token: Telegram echoes it in X-Telegram-Bot-Api-Secret-Token on every
  // webhook POST, so the endpoint can reject forged updates from anyone who
  // learns the URL. Ported from hermes's webhook validation. Optional — only
  // enforced when TELEGRAM_WEBHOOK_SECRET is set.
  const secret = process.env['TELEGRAM_WEBHOOK_SECRET']?.trim();
  await telegramFetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl, ...(secret ? { secret_token: secret } : {}) }),
  });

  const { Hono } = await import('hono');
  const { serve } = await import('@hono/node-server');
  const app = new Hono();

  app.post('/telegram/webhook', async (c) => {
    // Reject forged updates: the secret must match what Telegram echoes back.
    if (secret && c.req.header('x-telegram-bot-api-secret-token') !== secret) {
      return c.json({ ok: false }, 403);
    }
    const update = (await c.req.json()) as TelegramUpdate;
    const text = update.message?.text ?? '';
    const chatId = String(update.message?.chat?.id ?? '');
    if (chatId && text && isChatAuthorized(chatId, allowlist).allowed) {
      const reply = await onMessage(chatId, text, update.update_id);
      await sendMessage(token, chatId, reply);
    }
    return c.json({ ok: true });
  });

  serve({ fetch: app.fetch, port });
}
