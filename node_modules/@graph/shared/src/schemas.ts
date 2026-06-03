/**
 * Zod validation schemas shared across Gateway and Workers.
 * @see ADR 24 — Zod validation UUID v4 + hash regex, 400 on failure
 */

import { z } from 'zod';

/**
 * UUID v4 regex — matches the variant bits [89ab] in the third group.
 * @see ADR 24
 */
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * SHA-256 hex digest — exactly 64 lowercase hex characters.
 * Used for all hash fields: predecessor_hash, version_hash.
 * @see ADR 24
 */
export const HASH_HEX64 = /^[0-9a-f]{64}$/;

/**
 * Schema for POST /v1/scopes — create a new Scope.
 * intent: the business task description (1–4096 chars).
 */
export const CreateScopeSchema = z.object({
  intent: z.string().min(1).max(4096),
});

/**
 * Schema for POST /v1/scopes/:id/events — submit an event to an existing Scope.
 * Note: plan_created and scope_closed are infrastructure events — not submitted by external agents.
 * @see ADR 24, ADR 12
 */
export const EventBodySchema = z.object({
  event_type: z.enum(['task_spawned', 'memory_updated']),
  entity_id: z.string().regex(UUID_V4),
  predecessor_hash: z.string().regex(HASH_HEX64),
  payload: z.record(z.string(), z.unknown()),
});

export type CreateScopeInput = z.infer<typeof CreateScopeSchema>;
export type EventBodyInput = z.infer<typeof EventBodySchema>;
