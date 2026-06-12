/**
 * Human decision entry points (ADR-53 / Phase 20):
 *
 *   POST /v1/approvals/:id/decide   {approve: bool, kind?: once|session|always}
 *   POST /v1/questions/:id/answer   {answer: string}
 *
 * These are the Console/operator paths; chat-command routing (/approve,
 * /answer over Telegram etc.) joins the live-wiring batch. Realtime auth
 * middleware applies at mount (same token as /ws — deciding approvals is a
 * privileged operation).
 */

import { Hono } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';
import { ApprovalService } from '../security/approval.js';
import { AskUserService } from '../security/ask-user.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DecideSchema = z.object({
  approve: z.boolean(),
  kind: z.enum(['once', 'session', 'always']).default('once'),
});

const AnswerSchema = z.object({ answer: z.string().min(1).max(8000) });

export function buildDecisionsRoute(pool: Pool): Hono {
  const app = new Hono();
  const approvals = new ApprovalService(pool);
  const questions = new AskUserService(pool);

  app.post('/approvals/:id/decide', async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'invalid approval id' }, 400);
    const parsed = DecideSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'body must be {approve: boolean, kind?}' }, 400);
    const ok = await approvals.decide(id, parsed.data.approve, parsed.data.kind);
    return ok
      ? c.json({ status: parsed.data.approve ? 'approved' : 'denied' })
      : c.json({ error: 'not pending (already decided, timed out, or unknown)' }, 409);
  });

  app.post('/questions/:id/answer', async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'invalid question id' }, 400);
    const parsed = AnswerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'body must be {answer: string}' }, 400);
    const ok = await questions.answer(id, parsed.data.answer);
    return ok
      ? c.json({ status: 'answered' })
      : c.json({ error: 'not pending (already answered, timed out, or unknown)' }, 409);
  });

  return app;
}
