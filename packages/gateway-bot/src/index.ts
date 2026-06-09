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
  }
}

// Entrypoint when run directly
const { Pool: PgPool } = await import('pg');
const pool = new PgPool({ connectionString: process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/graph' });
const bot = new GatewayBot(pool);
await bot.start();
