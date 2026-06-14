/**
 * POST /v1/scopes/:id/chat — REST adapter for the conversation core (ADR 54).
 *
 * Channel bots (gateway-bot) and non-WS clients submit one conversation turn
 * and receive the full reply (no streaming on REST — the WS path streams).
 *
 * @see ../conversation/core.ts
 */

import { Hono } from 'hono';
import type { Pool } from 'pg';
import type { EmbeddingProvider, LLMProvider } from '@graph/shared';
import { validateScopeIdParam } from '../middleware/zod-guard.js';
import { runConversationTurn } from '../conversation/core.js';

/**
 * Recover the channel platform from a principal (X-Agent-ID). gateway-bot sets
 * it to the session key `<platform>::<chatId>` (buildSessionKey), so the prefix
 * before '::' is the platform. Console/CLI principals have no '::' → null (the
 * caller then uses the global default provider).
 */
export function platformFromPrincipal(principal: string | undefined): string | null {
  if (principal === undefined) return null;
  const i = principal.indexOf('::');
  return i > 0 ? principal.slice(0, i) : null;
}

export function buildChatRoute(
  pool: Pool,
  wMax: number,
  embed: EmbeddingProvider | null,
  chat: LLMProvider | null,
  /**
   * Per-channel provider resolver (CONSOLE-REDESIGN §11.2). Given the channel
   * platform, returns that channel's own provider or null to use the default.
   * Omitted in tests / when no per-channel config exists → always the default.
   */
  resolveChannelChat?: (platform: string) => LLMProvider | null,
): Hono {
  const app = new Hono();

  app.post('/:id/chat', async (c) => {
    const id = c.req.param('id');
    const invalid = validateScopeIdParam(c, id);
    if (invalid) return invalid;

    const body = await c.req.json<{ text?: string }>().catch(() => ({}) as { text?: string });
    if (typeof body.text !== 'string' || body.text.length === 0) {
      return c.json({ error: 'text is required' }, 400);
    }

    const principal = c.req.header('X-Agent-ID');
    // Per-channel agent identity: route to the channel's own model when set.
    const platform = platformFromPrincipal(principal);
    const channelChat =
      platform !== null && resolveChannelChat ? resolveChannelChat(platform) : null;
    const chatProvider = channelChat ?? chat;

    const result = await runConversationTurn(
      { pool, wMax, embed, chat: chatProvider },
      {
        scopeId: id,
        text: body.text,
        ...(principal !== undefined ? { principal } : {}),
      },
    );

    if (result.kind === 'suspended') return c.json({ error: 'scope suspended' }, 409);
    if (result.kind === 'error') return c.json({ error: result.message }, 422);
    return c.json({
      reply: result.reply,
      user_version_hash: result.user_version_hash,
      assistant_version_hash: result.assistant_version_hash,
    });
  });

  return app;
}
