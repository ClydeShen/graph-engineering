/**
 * Artifact routes (ADR-52 / Phase 19) — Console artifact preview consumes
 * these.
 *
 *   GET /v1/scopes/:id/artifacts   — read-model list for a scope
 *   GET /v1/artifacts/:hash        — content bytes with the stored media type
 *                                    (410 Gone once erased, 404 when unknown)
 */

import { Hono } from 'hono';
import type { Pool } from 'pg';
import { getArtifactMeta, listArtifacts, readArtifactContent } from '@graph/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;

export function buildArtifactsRoute(pool: Pool): Hono {
  const app = new Hono();

  app.get('/scopes/:id/artifacts', async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'invalid scope id' }, 400);
    try {
      return c.json(await listArtifacts(pool, id));
    } catch {
      // migration 018 absent — an empty system has no artifacts
      return c.json([]);
    }
  });

  app.get('/artifacts/:hash', async (c) => {
    const hash = c.req.param('hash');
    if (!HASH_RE.test(hash)) return c.json({ error: 'invalid artifact hash' }, 400);

    const meta = await getArtifactMeta(pool, hash).catch(() => null);
    if (meta === null) return c.json({ error: 'artifact not found' }, 404);
    if (meta.erased_at !== null) return c.json({ error: 'artifact erased (ADR-43)' }, 410);

    const content = readArtifactContent(hash);
    if (content === null) return c.json({ error: 'artifact content missing from disk' }, 404);

    return c.body(new Uint8Array(content), 200, {
      'content-type': meta.media_type,
      'content-length': String(content.byteLength),
      // hash-addressed = immutable forever
      'cache-control': 'public, max-age=31536000, immutable',
    });
  });

  return app;
}
