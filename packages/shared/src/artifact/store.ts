/**
 * Artifact store (ADR-52 / Phase 19) — deliverable work products as graph
 * citizens.
 *
 * Content is SHA-256 hash-addressed on disk (<profile>/artifacts/<hash> —
 * same content-hash semantics as Snapshots); metadata is the `artifact` read
 * model (migration 018). The ledger references artifacts through producer
 * result payloads (artifact_hash field) — never through mid-scope infra
 * events, which would claim the agent's OCC predecessor slot.
 *
 * ADR-43: erase(scope) cascades here — provenance rows get erased_at, and the
 * disk file is unlinked once no live row references its hash.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { profileDir } from '../config/loader.js';

/** Disk root for artifact content in the active profile. */
export function artifactsDir(): string {
  return join(profileDir(), 'artifacts');
}

/** Artifact Entity id — content-derived, stable across re-declarations. */
export function artifactEntityId(contentHash: string): string {
  const h = createHash('sha256').update(`artifact|${contentHash}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export type ArtifactKind = 'markdown' | 'code' | 'html' | 'image' | 'binary';

export interface ArtifactMeta {
  content_hash: string;
  scope_id: string;
  entity_id: string;
  kind: ArtifactKind;
  media_type: string;
  byte_size: number;
  label: string;
  created_at: string;
  erased_at: string | null;
  /**
   * Working-folder cluster the producing scope ran in (CONSOLE-REDESIGN §11.1 —
   * "artifact inherits the scope's project"). Only populated by the global
   * Workspace feed (listAllArtifacts); null when the scope has no project.
   */
  project?: string | null;
}

export interface SaveArtifactInput {
  scopeId: string;
  content: string | Buffer;
  kind: ArtifactKind;
  mediaType: string;
  label?: string;
}

/**
 * Persist content (idempotent: same content in the same scope is one row,
 * one file) and return its addressable identity.
 */
export async function saveArtifact(
  pool: Pool,
  input: SaveArtifactInput,
  dir: string = artifactsDir(),
): Promise<{ contentHash: string; entityId: string; path: string }> {
  const buf = typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : input.content;
  const contentHash = createHash('sha256').update(buf).digest('hex');
  const path = join(dir, contentHash);

  mkdirSync(dir, { recursive: true });
  if (!existsSync(path)) writeFileSync(path, buf);

  const entityId = artifactEntityId(contentHash);
  await pool.query(
    `INSERT INTO artifact (content_hash, scope_id, entity_id, kind, media_type, byte_size, label)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (content_hash, scope_id) DO NOTHING`,
    [contentHash, input.scopeId, entityId, input.kind, input.mediaType, buf.byteLength, input.label ?? ''],
  );
  return { contentHash, entityId, path };
}

/** Content bytes; null when unknown or erased from disk. */
export function readArtifactContent(contentHash: string, dir: string = artifactsDir()): Buffer | null {
  // hash-shaped only — refuse anything path-like
  if (!/^[0-9a-f]{64}$/.test(contentHash)) return null;
  const path = join(dir, contentHash);
  return existsSync(path) ? readFileSync(path) : null;
}

/** Artifacts produced in a scope (read model query; newest first). */
export async function listArtifacts(pool: Pool, scopeId: string): Promise<ArtifactMeta[]> {
  const res = await pool.query<ArtifactMeta>(
    `SELECT content_hash, scope_id, entity_id, kind, media_type,
            byte_size::int AS byte_size, label,
            created_at::text AS created_at, erased_at::text AS erased_at
     FROM artifact WHERE scope_id = $1 ORDER BY created_at DESC`,
    [scopeId],
  );
  return res.rows;
}

/** All artifacts across every scope (global Workspace list; newest first).
 *  CONSOLE-REDESIGN §11.1 — each artifact inherits its producing scope's project
 *  (working folder) via a LEFT JOIN so the Workspace page can group deliverables
 *  by project. LEFT JOIN keeps artifacts whose scope row is gone or has no
 *  project (project → null). */
export async function listAllArtifacts(pool: Pool, limit = 200): Promise<ArtifactMeta[]> {
  const res = await pool.query<ArtifactMeta>(
    `SELECT a.content_hash, a.scope_id, a.entity_id, a.kind, a.media_type,
            a.byte_size::int AS byte_size, a.label,
            a.created_at::text AS created_at, a.erased_at::text AS erased_at,
            sl.project
     FROM artifact a
     LEFT JOIN scope_lineage sl ON sl.scope_id = a.scope_id
     ORDER BY a.created_at DESC LIMIT $1`,
    [limit],
  );
  return res.rows;
}

/** Metadata for one artifact hash (any provenance row, prefer non-erased). */
export async function getArtifactMeta(pool: Pool, contentHash: string): Promise<ArtifactMeta | null> {
  const res = await pool.query<ArtifactMeta>(
    `SELECT content_hash, scope_id, entity_id, kind, media_type,
            byte_size::int AS byte_size, label,
            created_at::text AS created_at, erased_at::text AS erased_at
     FROM artifact WHERE content_hash = $1
     ORDER BY (erased_at IS NULL) DESC LIMIT 1`,
    [contentHash],
  );
  return res.rows[0] ?? null;
}

/**
 * ADR-43 cascade: mark this scope's artifact rows erased; unlink disk content
 * whose hash has no surviving live reference. Injectable unlink for tests.
 */
export async function eraseArtifactsForScope(
  pool: Pool,
  scopeId: string,
  dir: string = artifactsDir(),
  unlink: (path: string) => void = (p) => {
    if (existsSync(p)) unlinkSync(p);
  },
): Promise<{ rows_erased: number; files_deleted: number }> {
  const erased = await pool.query<{ content_hash: string }>(
    `UPDATE artifact SET erased_at = NOW()
     WHERE scope_id = $1 AND erased_at IS NULL
     RETURNING content_hash`,
    [scopeId],
  );
  let filesDeleted = 0;
  for (const row of erased.rows) {
    const live = await pool.query(
      `SELECT 1 FROM artifact WHERE content_hash = $1 AND erased_at IS NULL LIMIT 1`,
      [row.content_hash],
    );
    if (live.rows.length === 0) {
      unlink(join(dir, row.content_hash));
      filesDeleted++;
    }
  }
  return { rows_erased: erased.rowCount ?? 0, files_deleted: filesDeleted };
}
