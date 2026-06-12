import type { Pool } from 'pg';
import { buildSessionKey } from './session.js';
import { dispatchMessage } from './router.js';
import { startLongPoll, startWebhook } from './adapters/telegram.js';
import { buildDiscordApp, registerSlashCommand } from './adapters/discord.js';

export class GatewayBot {
  constructor(private readonly pool: Pool) {}

  async start(): Promise<void> {
    const telegramToken = process.env['TELEGRAM_BOT_TOKEN'];
    const discordBotToken = process.env['DISCORD_BOT_TOKEN'];
    const discordAppId = process.env['DISCORD_APPLICATION_ID'];
    const discordPort = Number(process.env['DISCORD_PORT'] ?? '4001');
    const telegramWebhookUrl = process.env['TELEGRAM_WEBHOOK_URL'];

    const onTelegramMessage = async (chatId: string, text: string, updateId: number): Promise<string> => {
      const sessionKey = buildSessionKey('telegram', chatId);
      const taskId = await dispatchMessage(sessionKey, text, this.pool, String(updateId));
      return `Task spawned: ${taskId}`;
    };

    const onDiscordMessage = async (chatId: string, text: string, interactionId: string): Promise<string> => {
      const sessionKey = buildSessionKey('discord', chatId);
      const taskId = await dispatchMessage(sessionKey, text, this.pool, interactionId);
      return `Task spawned: ${taskId}`;
    };

    if (telegramToken) {
      if (telegramWebhookUrl) {
        void startWebhook(telegramToken, telegramWebhookUrl, 4002, onTelegramMessage);
      } else {
        void startLongPoll(telegramToken, onTelegramMessage);
      }
    }

    if (discordBotToken && discordAppId) {
      await registerSlashCommand(discordBotToken, discordAppId);
      const app = buildDiscordApp(onDiscordMessage);
      const { serve } = await import('@hono/node-server');
      serve({ fetch: app.fetch, port: discordPort });
    }

    // Email (Phase 18: production binding of the Phase 12 transport seam).
    // Lazy imports: installs without email config never load imapflow/nodemailer.
    const { makeEmailTransportFromEnv } = await import('./connectors/email-transport.js');
    const emailTransport = makeEmailTransportFromEnv();
    if (emailTransport) {
      const { EmailConnector } = await import('./connectors/email-connector.js');
      const email = new EmailConnector({ transport: emailTransport });
      const check = await email.check();
      if (check.ok) {
        void email.start(async (evt) => {
          // chat_id = thread anchor (TD-E semantics: replies continue the session scope)
          const sessionKey = buildSessionKey('email', evt.chat_id);
          const taskId = await dispatchMessage(sessionKey, evt.text, this.pool, evt.message_id);
          return `Task spawned: ${taskId}`;
        });
        console.log('[gateway-bot] email connector polling');
      } else {
        console.error(`[gateway-bot] email configured but check failed: ${check.detail ?? ''}`);
      }
    }
  }
}

// Entrypoint when run directly
const { Pool: PgPool } = await import('pg');
const pool = new PgPool({ connectionString: process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/graph' });
const bot = new GatewayBot(pool);
await bot.start();
