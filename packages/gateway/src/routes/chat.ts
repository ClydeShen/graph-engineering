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

export function buildChatRoute(
  pool: Pool,
  wMax: number,
  embed: EmbeddingProvider | null,
  chat: LLMProvider | null,
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

    const result = await runConversationTurn(
      { pool, wMax, embed, chat },
      {
        scopeId: id,
        text: body.text,
        ...(c.req.header('X-Agent-ID') !== undefined
          ? { principal: c.req.header('X-Agent-ID') }
          : {}),
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
