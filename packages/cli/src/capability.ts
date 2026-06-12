/**
 * memex capability — capability preset directory + category bindings
 * (Phase 18 deliverable #4, ADR-51).
 *
 *   list                     presets × installed state × current bindings × stats
 *   bind <category> <impl>   record binding (graph Snapshot chain, D-1)
 *   install <preset>         install by declared form (bundled-skill copies,
 *                            mcp delegates to the catalog flow, skill/cli print
 *                            their install path)
 *
 * Bindings are GRAPH state — `memex capability bind` is the canonical entry;
 * onboarding's preset step calls the same functions best-effort (DB may not
 * be up during first onboarding; binding then happens post-hoc).
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPABILITY_CATEGORIES,
  CAPABILITY_PRESETS,
  capabilityStats,
  findCapabilityScope,
  resolveBindings,
  bindCategory,
  CAPABILITY_SCOPE_INTENT,
  profileDir,
  type CapabilityPreset,
} from '@graph/shared';

/** Repo bundled-skills root; MEMEX_BUNDLED_SKILLS_DIR overrides. */
export function bundledSkillsRoot(): string {
  if (process.env['MEMEX_BUNDLED_SKILLS_DIR']) return process.env['MEMEX_BUNDLED_SKILLS_DIR'];
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'bundled-skills');
}

/** Copy a bundled skill into the active profile's skills dir. */
export function installBundledSkill(
  preset: CapabilityPreset,
  skillsRoot: string = join(profileDir(), 'skills'),
  bundleRoot: string = bundledSkillsRoot(),
): string {
  if (preset.form !== 'bundled-skill' || !preset.bundledRef) {
    throw new Error(`${preset.name} is not a bundled skill`);
  }
  const src = join(bundleRoot, preset.bundledRef);
  if (!existsSync(join(src, 'SKILL.md'))) {
    throw new Error(`bundled skill missing: ${src}`);
  }
  const dest = join(skillsRoot, preset.bundledRef);
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  return dest;
}

/** One-line install instruction per form (printed for non-automatable forms). */
export function installInstruction(preset: CapabilityPreset): string {
  switch (preset.form) {
    case 'bundled-skill':
      return `memex capability install ${preset.name}`;
    case 'mcp':
      return `memex mcp install ${preset.catalogRef}`;
    case 'skill':
      return `memex skills search ${preset.registryQuery}`;
    case 'cli':
      return preset.installHint ?? `install: ${(preset.requiresBins ?? []).join(', ')}`;
  }
}

async function withPool<T>(fn: (pool: import('pg').Pool) => Promise<T>): Promise<T | null> {
  let dbUrl = process.env['DATABASE_URL'];
  if (!dbUrl) {
    const { loadMemexConfig } = await import('@graph/shared');
    dbUrl = loadMemexConfig()?.database?.url;
  }
  if (!dbUrl) return null;
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/** Bind via graph (ensures the registry scope; CLI/operator right per ADR-35). */
export async function bindCategoryCli(category: string, implementation: string): Promise<boolean> {
  const done = await withPool(async (pool) => {
    let scopeId = await findCapabilityScope(pool);
    if (!scopeId) {
      const { nestScope } = await import('@graph/control-plane/nesting');
      scopeId = (await nestScope(pool, CAPABILITY_SCOPE_INTENT)).scopeId;
    }
    await bindCategory(pool, scopeId, category, implementation);
    return true;
  });
  return done === true;
}

export async function runCapabilityCommand(): Promise<void> {
  const action = process.argv[3];

  if (action === 'list' || action === undefined) {
    const live = await withPool(async (pool) => ({
      bindings: await resolveBindings(pool),
      stats: await capabilityStats(pool),
    })).catch(() => null);
    const bindings = live?.bindings ?? {};
    const statsByImpl = new Map((live?.stats ?? []).map((s) => [s.implementation, s]));

    for (const category of CAPABILITY_CATEGORIES) {
      const bound = bindings[category];
      console.log(`${category}${bound ? `  → ${bound}` : ''}`);
      for (const p of CAPABILITY_PRESETS.filter((x) => x.category === category)) {
        const s = statsByImpl.get(p.name);
        const stat = s ? `  [${s.successes}/${s.activations} converged]` : '';
        console.log(`    ${p.name} (${p.form})${p.recommended ? ' *' : ''}${stat} — ${p.description}`);
        console.log(`      install: ${installInstruction(p)}`);
      }
    }
    if (!live) console.log('\n(no DATABASE_URL — bindings/stats unavailable)');
    return;
  }

  if (action === 'bind') {
    const [, , , , category, impl] = process.argv;
    if (!category || !impl) throw new Error('usage: memex capability bind <category> <implementation>');
    if (!(CAPABILITY_CATEGORIES as readonly string[]).includes(category)) {
      throw new Error(`unknown category '${category}' (known: ${CAPABILITY_CATEGORIES.join(', ')})`);
    }
    const ok = await bindCategoryCli(category, impl);
    if (!ok) throw new Error('no DATABASE_URL — bindings are graph state and need the DB up');
    console.log(`bound: ${category} → ${impl} (graph Snapshot chain)`);
    return;
  }

  if (action === 'install') {
    const name = process.argv[4];
    const preset = CAPABILITY_PRESETS.find((p) => p.name === name);
    if (!preset) throw new Error(`unknown preset '${name}' (memex capability list)`);
    if (preset.form === 'bundled-skill') {
      const dest = installBundledSkill(preset);
      console.log(`installed bundled skill: ${dest}`);
      // binding is meaningful immediately for single-impl categories
      if (await bindCategoryCli(preset.category, preset.name)) {
        console.log(`bound: ${preset.category} → ${preset.name}`);
      }
      return;
    }
    console.log(`'${preset.name}' is ${preset.form}-form — install via:\n  ${installInstruction(preset)}`);
    console.log(`then bind it: memex capability bind ${preset.category} ${preset.name}`);
    return;
  }

  throw new Error('usage: memex capability <list|bind|install>');
}
