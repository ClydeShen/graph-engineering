/**
 * memex skills search / install / inspect — the install side of the skill
 * ecosystem (Phase 16 G1; the export side shipped in Phase 5).
 *
 * Registry differences are confined to descriptor objects (one client, two
 * registries — 16-PHASE-SPEC §2a). API shapes follow the registries' public
 * docs and are correctable on first live call; the injectable fetch keeps the
 * whole flow unit-tested regardless.
 *
 * Every install runs the skills-guard scan BEFORE content reaches disk; the
 * caller decides whether findings block the install (CLI prompts, code only
 * reports).
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scanSkillContent, type GuardFinding } from './skills-guard.js';

export interface SkillSearchResult {
  registry: string;
  id: string;
  name: string;
  description: string;
}

export interface SkillRegistryDescriptor {
  name: string;
  searchUrl(query: string): string;
  /** Map a registry-specific search response to the common shape. */
  parseSearch(body: unknown): SkillSearchResult[];
  downloadUrl(id: string): string;
}

interface AgentSkillsItem {
  id?: string;
  name?: string;
  description?: string;
}

export const REGISTRIES: SkillRegistryDescriptor[] = [
  {
    name: 'agentskills.io',
    searchUrl: (q) => `https://agentskills.io/api/skills?q=${encodeURIComponent(q)}`,
    parseSearch: (body) => {
      const items = (body as { skills?: AgentSkillsItem[] })?.skills ?? [];
      return items.map((s) => ({
        registry: 'agentskills.io',
        id: String(s.id ?? s.name ?? ''),
        name: String(s.name ?? ''),
        description: String(s.description ?? ''),
      }));
    },
    downloadUrl: (id) => `https://agentskills.io/api/skills/${encodeURIComponent(id)}/SKILL.md`,
  },
  {
    name: 'clawhub',
    searchUrl: (q) => `https://clawhub.dev/api/v1/search?query=${encodeURIComponent(q)}`,
    parseSearch: (body) => {
      const items = (body as { results?: AgentSkillsItem[] })?.results ?? [];
      return items.map((s) => ({
        registry: 'clawhub',
        id: String(s.id ?? s.name ?? ''),
        name: String(s.name ?? ''),
        description: String(s.description ?? ''),
      }));
    },
    downloadUrl: (id) => `https://clawhub.dev/api/v1/skills/${encodeURIComponent(id)}/raw`,
  },
];

export async function searchSkills(
  fetchFn: typeof fetch,
  query: string,
  registries: SkillRegistryDescriptor[] = REGISTRIES,
): Promise<SkillSearchResult[]> {
  const results: SkillSearchResult[] = [];
  for (const reg of registries) {
    try {
      const res = await fetchFn(reg.searchUrl(query), { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue; // a down registry must not hide the other's results
      results.push(...reg.parseSearch(await res.json()));
    } catch {
      /* registry unreachable — skip */
    }
  }
  return results;
}

/** Safe install directory name: reject traversal-shaped skill names. */
export function safeSkillDirName(name: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..') ? name : null;
}

export interface InstallOutcome {
  dir: string;
  findings: GuardFinding[];
  /** True when content was written (caller withheld confirmation otherwise). */
  written: boolean;
}

/**
 * Download → guard-scan → (conditionally) write. When findings exist and
 * `confirmedDespiteFindings` is false, nothing touches disk — the caller shows
 * the report and re-invokes with confirmation.
 */
export async function installSkill(
  fetchFn: typeof fetch,
  registry: SkillRegistryDescriptor,
  id: string,
  skillName: string,
  skillsRoot: string,
  confirmedDespiteFindings = false,
): Promise<InstallOutcome> {
  const dirName = safeSkillDirName(skillName);
  if (!dirName) throw new Error(`unsafe skill name: ${skillName}`);

  const res = await fetchFn(registry.downloadUrl(id), { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`download failed: ${res.status} from ${registry.name}`);
  const content = await res.text();

  const findings = scanSkillContent(content);
  const dir = join(skillsRoot, dirName);
  if (findings.length > 0 && !confirmedDespiteFindings) {
    return { dir, findings, written: false };
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf8');
  return { dir, findings, written: true };
}

export interface InspectResult {
  name: string;
  findings: GuardFinding[];
}

/** Re-scan installed skills (guard patterns evolve; yesterday's clean scan may not hold). */
export function inspectSkills(skillsRoot: string, name?: string): InspectResult[] {
  if (!existsSync(skillsRoot)) return [];
  const dirs = name ? [name] : readdirSync(skillsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const results: InspectResult[] = [];
  for (const dir of dirs) {
    const file = join(skillsRoot, dir, 'SKILL.md');
    if (!existsSync(file)) continue;
    results.push({ name: dir, findings: scanSkillContent(readFileSync(file, 'utf8')) });
  }
  return results;
}
