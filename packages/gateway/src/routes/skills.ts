/**
 * GET /v1/skills — list skill summaries (two-phase loading)
 * GET /v1/skills/:id — full SKILL.md body for a named skill
 *
 * Two-phase loading: Phase 1 reads only YAML frontmatter (name, description).
 * Phase 2 returns the full SKILL.md content on demand. This reduces context
 * consumption for agents with 10+ skills by ≥50% vs loading all bodies upfront.
 *
 * Directory layout: ${skillsDir}/{fingerprintId}/SKILL.md
 * mtime cache: the full list is cached against the directory mtime.
 * Invalidation uses strictly-greater-than (>) not >= to handle Windows 100ms
 * filesystem resolution (see RESEARCH.md §ARCH-05 risk flag 4).
 *
 * Security: GET /v1/skills/:id validates id matches /^[0-9a-f]{64}$/ before
 * constructing any filesystem path — prevents path traversal (T-05-05-01).
 */

import { Hono } from 'hono';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { logger } from '@shared/logger';
import { memexHome } from '@graph/shared';

const log = logger.child({ component: 'gateway', route: 'GET /v1/skills' });

/** SHA-256 hex string — fingerprint form of a skill id */
const FINGERPRINT_ID_RE = /^[0-9a-f]{64}$/;
/** CLI-installed skill directory name (memex skills install <reg> <id> [name]) */
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface SkillSummary {
  fingerprintId: string;
  name: string;
  description: string;
}

/** Parse YAML frontmatter from a SKILL.md file (no external YAML dependency). */
export function parseFrontmatter(content: string): { name: string; description: string; fingerprintId: string } {
  const parts = content.split('---');
  // parts[0] is empty (before the first ---), parts[1] is the frontmatter block
  const block = parts[1] ?? '';
  const lines = block.split('\n');

  const name = lines.find(l => l.startsWith('name:'))?.slice('name:'.length).trim() ?? '';
  const description = lines.find(l => l.startsWith('description:'))?.slice('description:'.length).trim() ?? '';
  const fingerprintId = lines.find(l => l.startsWith('fingerprint_id:'))?.slice('fingerprint_id:'.length).trim() ?? '';

  return { name, description, fingerprintId };
}

/**
 * Build a Hono router for the skills endpoints.
 *
 * @param skillsDir  Directory to scan for skills. Defaults to SKILLS_DIR env var,
 *                   falling back to './skills'. No Pool required — filesystem only.
 */
export function buildSkillsRoute(
  // Default to the global install root the CLI writes to (~/.memex/skills) —
  // './skills' pointed at the gateway cwd, so the console never saw installed
  // skills (UX-audit U18). SKILLS_DIR still overrides.
  skillsDir = process.env['SKILLS_DIR'] ?? join(memexHome(), 'skills'),
): Hono {
  const app = new Hono();

  // Per-instance cache — isolated per buildSkillsRoute() call (important for tests)
  let instanceCachedList: SkillSummary[] | null = null;
  let instanceCachedMtime = 0;

  app.get('/skills', (c) => {
    let dirStat: fs.Stats;
    try {
      dirStat = fs.statSync(skillsDir);
    } catch {
      // Directory does not exist
      return c.json({ skills: [] });
    }

    // Invalidate cache when mtime strictly increased (> not >= per Windows 100ms resolution)
    if (instanceCachedList !== null && dirStat.mtimeMs <= instanceCachedMtime) {
      return c.json({ skills: instanceCachedList });
    }

    // Rebuild the cached list
    const skills: SkillSummary[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(skillsDir, { withFileTypes: true }) as fs.Dirent[];
    } catch (err) {
      log.warn({ err }, 'skills.list.readdirSync.failed');
      return c.json({ skills: [] });
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFilePath = join(skillsDir, entry.name, 'SKILL.md');
      try {
        const content = fs.readFileSync(skillFilePath, 'utf8');
        const { name, description, fingerprintId } = parseFrontmatter(content);
        skills.push({
          fingerprintId: fingerprintId || entry.name,
          name,
          description,
        });
      } catch (err) {
        log.warn({ err, entry: entry.name }, 'skills.list.read.skipped');
      }
    }

    instanceCachedList = skills;
    instanceCachedMtime = dirStat.mtimeMs;

    return c.json({ skills });
  });

  app.get('/skills/:id', (c) => {
    const id = c.req.param('id');

    // SECURITY: validate id before constructing any path — prevents traversal
    // (T-05-05-01). Accepted forms: SHA-256 fingerprint, or a plain directory
    // name as written by `memex skills install` (no separators or dots, so no
    // way out of skillsDir).
    if (!FINGERPRINT_ID_RE.test(id) && !SKILL_NAME_RE.test(id)) {
      return c.json({ error: 'invalid id' }, 400);
    }

    const skillFilePath = join(skillsDir, id, 'SKILL.md');
    try {
      const content = fs.readFileSync(skillFilePath, 'utf8');
      return c.json({ content });
    } catch {
      return c.json({ error: 'not found' }, 404);
    }
  });

  return app;
}
