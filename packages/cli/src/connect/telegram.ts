/**
 * memex connect telegram — post-onboarding Telegram pairing (Phase 18
 * deliverable #5). Zero-SDK (Phase 12 ethos): validates the bot token with a
 * direct getMe call, writes channels.telegram.token to the active profile
 * config, and prints the pairing next step. The gateway-bot picks the token
 * up on next start.
 */

import { intro, outro, text, log, isCancel } from '@clack/prompts';
import { resolveConfigPath } from '@graph/shared';
import { readRawConfig, writeRawConfig } from '../mcp.js';

/** Validate a bot token against the Telegram API. Returns the bot username. */
export async function validateBotToken(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchFn(`https://api.telegram.org/bot${token}/getMe`, {
    signal: AbortSignal.timeout(10000),
  });
  const body = (await res.json()) as { ok?: boolean; result?: { username?: string } };
  if (!res.ok || body.ok !== true) throw new Error('Telegram rejected the token (getMe failed)');
  return body.result?.username ?? 'unknown';
}

/** Write the token reference into channels.telegram (raw file, structure-preserving). */
export function writeTelegramChannel(tokenRef: string, configPath: string = resolveConfigPath()): void {
  const cfg = readRawConfig(configPath);
  const channels = (cfg['channels'] ?? {}) as Record<string, Record<string, unknown>>;
  channels['telegram'] = { ...(channels['telegram'] ?? {}), token: tokenRef };
  writeRawConfig({ ...cfg, channels }, configPath);
}

export async function runConnectTelegram(): Promise<void> {
  intro('Connect Telegram');
  log.info('Create a bot with @BotFather (/newbot) and paste its token.');

  const token = await text({
    message: 'Bot token (validated, then stored as a ${TELEGRAM_BOT_TOKEN} reference)',
    validate: (v) => (/^\d+:[\w-]+$/.test(v) ? undefined : 'expected <digits>:<secret> shape'),
  });
  if (isCancel(token)) {
    outro('Cancelled.');
    return;
  }

  try {
    const username = await validateBotToken(token as string);
    log.success(`Token valid — bot @${username}`);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    outro('Token rejected — nothing written.');
    process.exitCode = 1;
    return;
  }

  // Store the REFERENCE; tell the user to export the value (config never
  // holds resolved secrets — loader.ts resolves ${VAR} at read time).
  writeTelegramChannel('${TELEGRAM_BOT_TOKEN}');
  log.success(`Wrote channels.telegram.token to ${resolveConfigPath()}`);
  log.warn('Export the secret in your shell profile:\n  export TELEGRAM_BOT_TOKEN=<the token>');
  outro('Restart the stack (npm run dev) — then just message your bot; every chat routes to the conversation core (ADR 54).');
}
