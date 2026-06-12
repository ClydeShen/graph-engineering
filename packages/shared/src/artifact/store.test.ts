import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  artifactEntityId,
  eraseArtifactsForScope,
  readArtifactContent,
  saveArtifact,
} from './store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memex-artifacts-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makePool(results: Array<{ rows: unknown[]; rowCount?: number }>): {
  pool: Pool;
  calls: Array<{ sql: string; params: unknown[] | undefined }>;
} {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  let i = 0;
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return results[Math.min(i++, results.length - 1)] ?? { rows: [], rowCount: 0 };
    }),
  } as unknown as Pool;
  return { pool, calls };
}

describe('saveArtifact', () => {
  it('hash-addresses content on disk and inserts the read-model row', async () => {
    const { pool, calls } = makePool([{ rows: [] }]);
    const content = '# research summary\n';
    const expectedHash = createHash('sha256').update(Buffer.from(content)).digest('hex');

    const out = await saveArtifact(
      pool,
      { scopeId: 's-1', content, kind: 'markdown', mediaType: 'text/markdown', label: 'summary' },
      dir,
    );

    expect(out.contentHash).toBe(expectedHash);
    expect(out.entityId).toBe(artifactEntityId(expectedHash));
    expect(existsSync(join(dir, expectedHash))).toBe(true);
    expect(calls[0]!.sql).toContain('ON CONFLICT (content_hash, scope_id) DO NOTHING');
    expect(calls[0]!.params).toEqual([
      expectedHash, 's-1', out.entityId, 'markdown', 'text/markdown', Buffer.byteLength(content), 'summary',
    ]);
  });

  it('same content twice = one file (idempotent write)', async () => {
    const { pool } = makePool([{ rows: [] }]);
    const a = await saveArtifact(pool, { scopeId: 's-1', content: 'x', kind: 'code', mediaType: 'text/plain' }, dir);
    const b = await saveArtifact(pool, { scopeId: 's-2', content: 'x', kind: 'code', mediaType: 'text/plain' }, dir);
    expect(a.contentHash).toBe(b.contentHash);
  });
});

describe('readArtifactContent', () => {
  it('refuses non-hash-shaped ids (traversal guard) and missing files', () => {
    expect(readArtifactContent('../../etc/passwd', dir)).toBeNull();
    expect(readArtifactContent('a'.repeat(64), dir)).toBeNull();
  });

  it('round-trips saved content', async () => {
    const { pool } = makePool([{ rows: [] }]);
    const { contentHash } = await saveArtifact(
      pool,
      { scopeId: 's-1', content: 'hello', kind: 'code', mediaType: 'text/plain' },
      dir,
    );
    expect(readArtifactContent(contentHash, dir)?.toString('utf8')).toBe('hello');
  });
});

describe('eraseArtifactsForScope (ADR-43 cascade)', () => {
  it('marks rows erased and unlinks only orphaned hashes', async () => {
    const hashShared = 'a'.repeat(64);
    const hashOrphan = 'b'.repeat(64);
    const { pool } = makePool([
      // UPDATE ... RETURNING content_hash
      { rows: [{ content_hash: hashShared }, { content_hash: hashOrphan }], rowCount: 2 },
      // live check for hashShared → another scope still references it
      { rows: [{ '?column?': 1 }] },
      // live check for hashOrphan → none
      { rows: [] },
    ]);
    const unlinked: string[] = [];
    const result = await eraseArtifactsForScope(pool, 's-1', dir, (p) => unlinked.push(p));
    expect(result).toEqual({ rows_erased: 2, files_deleted: 1 });
    expect(unlinked).toEqual([join(dir, hashOrphan)]);
  });
});
