import type { Pool } from 'pg';
import { buildSessionKey } from './session.js';
import { dispatchMessage } from './router.js';
import { startLongPoll, startWebhook } from './adapters/telegram.js';
import { buildDiscordApp, registerSlashCommand } from './adapters/discord.js';
import { parseAllowlist, isChatAuthorized, allowlistStartupWarning } from './channel-allowlist.js';

export class GatewayBot {
  constructor(private readonly pool: Pool) {}

  async start(): Promise<void> {
    const telegramToken = process.env['TELEGRAM_BOT_TOKEN'];
    const discordBotToken = process.env['DISCORD_BOT_TOKEN'];
    const discordAppId = process.env['DISCORD_APPLICATION_ID'];
    const discordPort = Number(process.env['DISCORD_PORT'] ?? '4001');
    const telegramWebhookUrl = process.env['TELEGRAM_WEBHOOK_URL'];

    // ADR 54: dispatchMessage now returns the assistant reply itself — channels
    // are conversational, not task-spawn acknowledgements.
    const onTelegramMessage = async (chatId: string, text: string, updateId: number): Promise<string> => {
      const sessionKey = buildSessionKey('telegram', chatId);
      return dispatchMessage(sessionKey, text, this.pool, String(updateId));
    };

    // Edge allowlist (DRY with Telegram — the same channel-agnostic gate). Empty
    // = allow all (start() warns); '*' = explicit allow-all; else listed IDs only.
    const discordAllowlist = parseAllowlist(process.env['DISCORD_ALLOWED_CHATS']);
    let lastDeniedDiscord = '';
    const onDiscordMessage = async (chatId: string, text: string, interactionId: string): Promise<string> => {
      if (!isChatAuthorized(chatId, discordAllowlist).allowed) {
        if (chatId !== lastDeniedDiscord) {
          console.warn(`[discord] denied unauthorized chat ${chatId}`);
          lastDeniedDiscord = chatId;
        }
        return '';
      }
      const sessionKey = buildSessionKey('discord', chatId);
      return dispatchMessage(sessionKey, text, this.pool, interactionId);
    };

    if (telegramToken) {
      // Edge allowlist: only these chat IDs reach the agent. Empty = allow all
      // (start() warns). See channel-allowlist.ts (hermes posture).
      const telegramAllowlist = parseAllowlist(process.env['TELEGRAM_ALLOWED_CHATS']);
      if (telegramWebhookUrl) {
        void startWebhook(telegramToken, telegramWebhookUrl, 4002, onTelegramMessage, telegramAllowlist);
      } else {
        void startLongPoll(telegramToken, onTelegramMessage, undefined, { allowlist: telegramAllowlist });
      }
    }

    if (discordBotToken && discordAppId) {
      const dwarn = allowlistStartupWarning('discord', 'DISCORD_ALLOWED_CHATS', discordAllowlist);
      if (dwarn) console.warn(dwarn);
      await registerSlashCommand(discordBotToken, discordAppId);
      const app = buildDiscordApp(onDiscordMessage);
      const { serve } = await import('@hono/node-server');
      serve({ fetch: app.fetch, port: discordPort });
    }

    // Slack (Phase 12 Socket Mode connector — outbound WSS, no inbound port;
    // same posture as Telegram long-poll). Started here so SLACK_* env actually
    // brings the connector up — it was implemented + unit-tested but never wired
    // into this entrypoint.
    const slackAppToken = process.env['SLACK_APP_TOKEN'];
    const slackBotToken = process.env['SLACK_BOT_TOKEN'];
    if (slackAppToken && slackBotToken) {
      // Edge allowlist parity with Telegram/Discord (closes the TD-N gap where
      // Slack accepted any inbound chat).
      const slackAllowlist = parseAllowlist(process.env['SLACK_ALLOWED_CHATS']);
      const swarn = allowlistStartupWarning('slack', 'SLACK_ALLOWED_CHATS', slackAllowlist);
      if (swarn) console.warn(swarn);
      let lastDeniedSlack = '';
      const { SlackConnector } = await import('./connectors/slack-connector.js');
      const slack = new SlackConnector({ appToken: slackAppToken, botToken: slackBotToken });
      const check = await slack.check();
      if (check.ok) {
        void slack.start(async (evt) => {
          if (!isChatAuthorized(evt.chat_id, slackAllowlist).allowed) {
            if (evt.chat_id !== lastDeniedSlack) {
              console.warn(`[slack] denied unauthorized chat ${evt.chat_id}`);
              lastDeniedSlack = evt.chat_id;
            }
            return '';
          }
          const sessionKey = buildSessionKey('slack', evt.chat_id);
          return dispatchMessage(sessionKey, evt.text, this.pool, evt.message_id);
        });
        console.log('[gateway-bot] slack connector (Socket Mode) started');
      } else {
        console.error(`[gateway-bot] slack configured but check failed: ${check.detail ?? ''}`);
      }
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
          return dispatchMessage(sessionKey, evt.text, this.pool, evt.message_id);
        });
        console.log('[gateway-bot] email connector polling');
      } else {
        console.error(`[gateway-bot] email configured but check failed: ${check.detail ?? ''}`);
      }
    }

    // Webhook (Phase 12 inbound HTTP channel — implemented + unit-tested but
    // never wired into start(), the same "written, not wired" gap Slack had).
    // Mandatory HMAC: refuses to start without MEMEX_WEBHOOK_HMAC_SECRET. An edge
    // allowlist gates senders (DRY with the other channels).
    const webhookSecret = process.env['MEMEX_WEBHOOK_HMAC_SECRET'];
    if (webhookSecret) {
      const { WebhookConnector } = await import('./connectors/webhook-connector.js');
      const webhook = new WebhookConnector(webhookSecret);
      const check = await webhook.check();
      if (check.ok) {
        const webhookAllowlist = parseAllowlist(process.env['WEBHOOK_ALLOWED_SENDERS']);
        const wwarn = allowlistStartupWarning('webhook', 'WEBHOOK_ALLOWED_SENDERS', webhookAllowlist);
        if (wwarn) console.warn(wwarn);
        let lastDeniedWebhook = '';
        await webhook.start(async (evt) => {
          if (!isChatAuthorized(evt.chat_id, webhookAllowlist).allowed) {
            if (evt.chat_id !== lastDeniedWebhook) {
              console.warn(`[webhook] denied unauthorized sender ${evt.chat_id}`);
              lastDeniedWebhook = evt.chat_id;
            }
            return '';
          }
          const sessionKey = buildSessionKey('webhook', evt.chat_id);
          return dispatchMessage(sessionKey, evt.text, this.pool, evt.message_id);
        });
        const webhookPort = Number(process.env['MEMEX_WEBHOOK_PORT'] ?? '4003');
        const { serve } = await import('@hono/node-server');
        serve({ fetch: webhook.buildRoute().fetch, port: webhookPort });
        console.log(`[gateway-bot] webhook connector listening on :${webhookPort}/hooks/inbound`);
      } else {
        console.error(`[gateway-bot] webhook configured but check failed: ${check.detail ?? ''}`);
      }
    }
  }
}

// Entrypoint when run directly
const { Pool: PgPool } = await import('pg');
const pool = new PgPool({ connectionString: process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/graph' });
const bot = new GatewayBot(pool);
await bot.start();
