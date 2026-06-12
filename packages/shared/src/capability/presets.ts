/**
 * Capability presets — category → recommended implementation directory
 * (Phase 18 deliverable #4, ADR-51).
 *
 * Categories are the stable vocabulary (Category Entities); implementations
 * are user-swappable and may arrive as a skill, an MCP server, or a CLI tool
 * — the entry declares its form and install path. Reuses existing machinery:
 * skill form → memex skills (Phase 16, guard-scanned), mcp form → optional-mcps
 * catalog (Phase 17), cli form → requires_bins + install hint, bundled form →
 * repo-shipped SKILL.md copied into the profile skills dir.
 *
 * The chosen binding is graph state (bindCategory — ADR-51 D-1), never config.
 */

export const CAPABILITY_CATEGORIES = [
  'browser',
  'search',
  'filesystem',
  'github',
  'meta',
] as const;

export type CapabilityCategory = (typeof CAPABILITY_CATEGORIES)[number];

export type PresetForm = 'skill' | 'mcp' | 'cli' | 'bundled-skill';

export interface CapabilityPreset {
  category: CapabilityCategory;
  /** Implementation name — the graph Implementation Entity identity. */
  name: string;
  form: PresetForm;
  description: string;
  /** mcp form: optional-mcps catalog manifest name (memex mcp install <ref>). */
  catalogRef?: string;
  /** skill form: registry search query (memex skills search <ref>). */
  registryQuery?: string;
  /** bundled-skill form: bundled-skills/<ref> directory in the repo. */
  bundledRef?: string;
  /** cli form: binaries that must be on PATH + how to get them. */
  requiresBins?: string[];
  installHint?: string;
  /** Pre-checked in the onboarding multiselect. */
  recommended?: boolean;
}

export const CAPABILITY_PRESETS: CapabilityPreset[] = [
  {
    category: 'browser',
    name: 'agent-browser',
    form: 'cli',
    description: 'Browser automation CLI for agents (vercel-labs/agent-browser)',
    requiresBins: ['agent-browser'],
    installHint: 'npm install -g agent-browser && agent-browser install',
  },
  {
    category: 'search',
    name: 'tavily',
    form: 'skill',
    description: 'Web search via Tavily (LLM-optimized results)',
    registryQuery: 'tavily search',
  },
  {
    category: 'filesystem',
    name: 'filesystem',
    form: 'mcp',
    description: 'Official MCP filesystem server (stdio)',
    catalogRef: 'filesystem',
  },
  {
    category: 'github',
    name: 'github',
    form: 'mcp',
    description: 'GitHub remote MCP server (OAuth)',
    catalogRef: 'github',
  },
  // Meta-skills: the prerequisite for agent-side capability acquisition
  // (Phase 20 deliverable #1 — find-skill must be in the system first).
  {
    category: 'meta',
    name: 'find-skill',
    form: 'bundled-skill',
    description: 'Teach the agent to search and install skills (memex skills / npx skills)',
    bundledRef: 'find-skill',
    recommended: true,
  },
  {
    category: 'meta',
    name: 'create-skill',
    form: 'bundled-skill',
    description: 'Teach the agent to author agentskills.io-compliant SKILL.md packages',
    bundledRef: 'create-skill',
    recommended: true,
  },
  {
    category: 'meta',
    name: 'skills-sh',
    form: 'bundled-skill',
    description: 'Use the skills.sh ecosystem CLI (npx skills) to discover and add skills',
    bundledRef: 'skills-sh',
    recommended: true,
  },
];

/** Presets for one category (binding candidates). */
export function presetsForCategory(category: CapabilityCategory): CapabilityPreset[] {
  return CAPABILITY_PRESETS.filter((p) => p.category === category);
}
