import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as fs from 'node:fs';
import { buildSkillsRoute } from './skills.js';

// Two fixture skills to populate the temp directory
const SKILL_A_ID = 'a'.repeat(64); // 64-char hex-like id
const SKILL_B_ID = 'b'.repeat(64);

const SKILL_A_CONTENT = [
  '---',
  'name: my-skill-alpha',
  'description: A test skill about alpha',
  'source: graph-runtime',
  `fingerprint_id: ${'a'.repeat(64)}`,
  'requires:',
  '  bins: []',
  '  env: []',
  'always: false',
  '---',
  '',
  '# My Skill Alpha',
  'This is the full body of skill alpha.',
].join('\n');

const SKILL_B_CONTENT = [
  '---',
  'name: my-skill-beta',
  'description: A test skill about beta',
  'source: graph-runtime',
  `fingerprint_id: ${'b'.repeat(64)}`,
  'requires:',
  '  bins: []',
  '  env: []',
  'always: false',
  '---',
  '',
  '# My Skill Beta',
  'This is the full body of skill beta.',
].join('\n');

let tempDir: string;

describe('GET /v1/skills', () => {
  beforeEach(async () => {
    // Create a fresh temp directory with two skill subdirs
    tempDir = join(tmpdir(), `skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(tempDir, SKILL_A_ID), { recursive: true });
    await mkdir(join(tempDir, SKILL_B_ID), { recursive: true });
    await writeFile(join(tempDir, SKILL_A_ID, 'SKILL.md'), SKILL_A_CONTENT, 'utf8');
    await writeFile(join(tempDir, SKILL_B_ID, 'SKILL.md'), SKILL_B_CONTENT, 'utf8');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns { skills: [] } for an empty skills directory', async () => {
    const emptyDir = join(tmpdir(), `skills-empty-${Date.now()}`);
    await mkdir(emptyDir, { recursive: true });
    const app = buildSkillsRoute(emptyDir);
    const res = await app.fetch(new Request('http://localhost/skills'));
    expect(res.status).toBe(200);
    const body = await res.json() as { skills: unknown[] };
    expect(body.skills).toEqual([]);
    await rm(emptyDir, { recursive: true, force: true });
  });

  it('returns { skills: [] } when skills directory does not exist', async () => {
    const app = buildSkillsRoute('/nonexistent/skills/path/that/does/not/exist');
    const res = await app.fetch(new Request('http://localhost/skills'));
    expect(res.status).toBe(200);
    const body = await res.json() as { skills: unknown[] };
    expect(body.skills).toEqual([]);
  });

  it('returns list with fingerprintId, name, description for each skill (no body)', async () => {
    const app = buildSkillsRoute(tempDir);
    const res = await app.fetch(new Request('http://localhost/skills'));
    expect(res.status).toBe(200);
    const body = await res.json() as { skills: Array<{ fingerprintId: string; name: string; description: string }> };
    expect(body.skills).toHaveLength(2);

    const ids = body.skills.map(s => s.fingerprintId);
    expect(ids).toContain(SKILL_A_ID);
    expect(ids).toContain(SKILL_B_ID);

    const skillA = body.skills.find(s => s.fingerprintId === SKILL_A_ID)!;
    expect(skillA.name).toBe('my-skill-alpha');
    expect(skillA.description).toBe('A test skill about alpha');
    // Body text must not appear in list response
    expect(JSON.stringify(body)).not.toContain('full body of skill alpha');
  });

  it('list response does NOT include SKILL.md body text', async () => {
    const app = buildSkillsRoute(tempDir);
    const res = await app.fetch(new Request('http://localhost/skills'));
    const text = await res.text();
    expect(text).not.toContain('full body of skill alpha');
    expect(text).not.toContain('full body of skill beta');
  });
});

describe('GET /v1/skills/:id', () => {
  beforeEach(async () => {
    tempDir = join(tmpdir(), `skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(tempDir, SKILL_A_ID), { recursive: true });
    await writeFile(join(tempDir, SKILL_A_ID, 'SKILL.md'), SKILL_A_CONTENT, 'utf8');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns { content } for a valid fingerprintId', async () => {
    const app = buildSkillsRoute(tempDir);
    const res = await app.fetch(new Request(`http://localhost/skills/${SKILL_A_ID}`));
    expect(res.status).toBe(200);
    const body = await res.json() as { content: string };
    expect(body.content).toBe(SKILL_A_CONTENT);
  });

  it('returns 404 for an unknown (but valid format) fingerprintId', async () => {
    const unknownId = 'c'.repeat(64);
    const app = buildSkillsRoute(tempDir);
    const res = await app.fetch(new Request(`http://localhost/skills/${unknownId}`));
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('not found');
  });

  it('returns 400 for id containing non-hex chars (path traversal attempt)', async () => {
    // The regex /^[0-9a-f]{64}$/ blocks all path traversal because '.' and '/' are not hex chars.
    // Pass a 64-char string with dots to simulate a traversal attempt that bypasses URL normalization.
    const app = buildSkillsRoute(tempDir);
    const traversalId = '.'.repeat(64); // dots are not hex — regex blocks this
    const res = await app.fetch(new Request(`http://localhost/skills/${traversalId}`));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid id');
  });

  it('returns 400 for id containing / (URL-encoded slash)', async () => {
    const app = buildSkillsRoute(tempDir);
    // Encode a slash to avoid URL routing interference
    const res = await app.fetch(new Request(`http://localhost/skills/${'a'.repeat(32)}%2F${'b'.repeat(31)}`));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid id');
  });

  it('returns 400 for id that is too short', async () => {
    const app = buildSkillsRoute(tempDir);
    const res = await app.fetch(new Request(`http://localhost/skills/abc123`));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid id');
  });

  it('returns 400 for id with non-hex chars', async () => {
    const app = buildSkillsRoute(tempDir);
    const badId = 'g'.repeat(64); // 'g' is not hex
    const res = await app.fetch(new Request(`http://localhost/skills/${badId}`));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid id');
  });
});

describe('GET /v1/skills mtime cache', () => {
  beforeEach(async () => {
    tempDir = join(tmpdir(), `skills-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(tempDir, SKILL_A_ID), { recursive: true });
    await writeFile(join(tempDir, SKILL_A_ID, 'SKILL.md'), SKILL_A_CONTENT, 'utf8');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns consistent results on repeated calls (cache is stable)', async () => {
    // Build a fresh app so the cache starts empty for this instance
    const app = buildSkillsRoute(tempDir);

    // First call — populates the cache
    const res1 = await app.fetch(new Request('http://localhost/skills'));
    const body1 = await res1.json() as { skills: Array<{ fingerprintId: string }> };
    expect(body1.skills).toHaveLength(1);

    // Second call — directory mtime unchanged; cache serves same result
    const res2 = await app.fetch(new Request('http://localhost/skills'));
    const body2 = await res2.json() as { skills: Array<{ fingerprintId: string }> };
    expect(body2.skills).toHaveLength(1);
    expect(body2.skills[0].fingerprintId).toBe(body1.skills[0].fingerprintId);
  });

  it('reflects new skills after directory mtime changes', async () => {
    const app = buildSkillsRoute(tempDir);

    // First call — cache populated with 1 skill
    const res1 = await app.fetch(new Request('http://localhost/skills'));
    const body1 = await res1.json() as { skills: unknown[] };
    expect(body1.skills).toHaveLength(1);

    // Add a new skill directory — this changes the directory mtime
    const newId = '1'.repeat(64);
    await mkdir(join(tempDir, newId), { recursive: true });
    await writeFile(join(tempDir, newId, 'SKILL.md'), SKILL_B_CONTENT, 'utf8');

    // Wait a small amount to ensure the mtime changes (Windows has 100ms resolution)
    // We force mtime change by directly updating via utimes
    const now = Date.now() + 200;
    fs.utimesSync(tempDir, now / 1000, now / 1000);

    // Second call — directory mtime strictly increased; cache should be invalidated
    const res2 = await app.fetch(new Request('http://localhost/skills'));
    const body2 = await res2.json() as { skills: unknown[] };
    expect(body2.skills).toHaveLength(2);
  });
});
