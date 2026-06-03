/**
 * Zod guard middleware for the HTTP Gateway.
 *
 * Validates all incoming request parameters and bodies against Zod schemas
 * BEFORE any database access. Failure returns HTTP 400 immediately.
 *
 * @see ADR 24 — Zod/Regex iron gate; 400 before any DB touch
 * @see REQ-16 — Zod validation UUID v4 + hash regex
 */

export { zValidator } from '@hono/zod-validator';

import type { Context } from 'hono';
import { UUID_V4 } from '@shared/schemas';

/**
 * Validate a scope UUID param and return a 400 response if invalid.
 * Must be called BEFORE any DB access in route handlers.
 *
 * @param c   Hono context
 * @param id  Raw string from c.req.param('id')
 * @returns   A Response with status 400, or undefined if valid
 */
export function validateScopeIdParam(
  c: Context,
  id: string,
): Response | undefined {
  if (!UUID_V4.test(id)) {
    return c.json({ error: 'invalid scope_id: must be a UUID v4' }, 400) as Response;
  }
  return undefined;
}
