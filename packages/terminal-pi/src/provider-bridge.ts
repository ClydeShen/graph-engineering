/**
 * Provider bridge (ADR-57 D-2, build-out line #1) — MemexTerminal's Pi loop
 * borrows MemexCore's onboarded provider via CONFIG-SHARE, not in-process
 * delegation.
 *
 * Why config-share: Core's LLMProvider is chat(messages)->string (non-streaming,
 * no native tool-call protocol); Pi's agent loop needs native OpenAI streaming +
 * tool-calling. So we share Core's provider CONFIG (baseUrl/apiKey/model/api) —
 * Pi dials the same OpenAI-compatible endpoint, one brain, one key, native
 * protocol. (Verified live: a real NVIDIA qwen3.5 turn replied through Pi —
 * see .planning/spikes/009-pi-embed/run-nvidia.mjs.)
 *
 * @see docs/adr/0066-adr57-memexterminal-pi-embed.md D-2
 */

import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  ModelRegistry,
  AuthStorage,
  type ToolDefinition,
  type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
import { loadMemexConfig, resolveProfile } from '@graph/shared';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface CoreProvider {
  name: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  api: 'openai-completions' | 'anthropic-messages';
}

/**
 * Read Core's highest-priority onboarded provider from ~/.memex/config.json, and
 * resolve api/baseUrl/apiKey EXACTLY as Core does (from-config.ts buildOne +
 * resolveProfile) — never hardcode. The earlier hardcode (api='openai-completions',
 * baseUrl ?? nvidia) sent e.g. a Gemini model to NVIDIA's endpoint → 400. Mirroring
 * resolveProfile means each provider type (gemini → openai-compat at Google's
 * baseUrl, anthropic → anthropic-messages, nvidia/ollama/openrouter → their own
 * baseUrl) dials its real endpoint, just like the channel conversation core.
 */
export function resolveCoreProvider(): CoreProvider {
  const cfg = loadMemexConfig();
  const entries = cfg?.providers ?? [];
  if (entries.length === 0) throw new Error('no onboarded provider — run `memex onboard`');
  const e = [...entries].sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9))[0]!;
  const profile = resolveProfile(e);
  return {
    name: e.name,
    model: e.model,
    baseUrl: e.baseUrl ?? profile.baseUrl ?? '',
    apiKey: e.apiKey ?? (profile.envVar ? process.env[profile.envVar] ?? '' : ''),
    api: profile.api,
  };
}

/**
 * pi-ai compat overrides for OpenAI-compat endpoints pi does NOT recognize as
 * non-standard (its detectCompat list omits them), so it would send OpenAI-only
 * params they reject. Gemini's openai endpoint 400s on `store` ("Unknown name
 * store") — pi only sends it when compat.supportsStore is true (the default for
 * unrecognized hosts). We force the Gemini-safe set; other providers (nvidia,
 * ollama, openrouter…) are recognized by pi, so we leave compat unset for them.
 */
function compatFor(p: CoreProvider): Record<string, unknown> | undefined {
  if (!p.baseUrl.includes('generativelanguage.googleapis.com')) return undefined;
  return {
    supportsStore: false, // the actual 400 culprit
    supportsReasoningEffort: false,
    supportsDeveloperRole: false, // Gemini uses the system role, not "developer"
    supportsStrictMode: false,
    supportsLongCacheRetention: false,
    maxTokensField: 'max_tokens', // verified working against the Gemini endpoint
  };
}

/** Core provider -> pi models.json ({ providers: { <name>: ProviderConfig } }). */
function writeModelsJson(p: CoreProvider): string {
  const dir = mkdtempSync(join(tmpdir(), 'memex-pi-'));
  const path = join(dir, 'models.json');
  const compat = compatFor(p);
  writeFileSync(
    path,
    JSON.stringify({
      providers: {
        [p.name]: {
          baseUrl: p.baseUrl,
          apiKey: p.apiKey,
          api: p.api,
          authHeader: true,
          models: [
            {
              id: p.model,
              name: p.model,
              reasoning: false,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              // Headroom so a long reply + a tool-call JSON aren't truncated
              // mid-stream (a truncated tool-call argument surfaces in pi-ai as
              // "Unexpected end of JSON input").
              maxTokens: 8192,
              ...(compat ? { compat } : {}),
            },
          ],
        },
      },
    }),
  );
  return path;
}

/**
 * Embed isolation flags — MemexTerminal is hermetic: it derives everything from
 * Core (config-share brain + C3 projection + Core tools + our in-process
 * factories). Disabling filesystem discovery keeps the user's external Pi
 * install (~/.pi: `memex connect pi` extensions, skills, themes) and cwd
 * AGENTS.md out of the embed. Without it, getActiveToolNames() leaked
 * pi-extension's spawn_task/complete_task into the session — BYO bleeding into
 * the product surface. Inline extensionFactories still load (noExtensions only
 * drops discovered paths; factories are always appended).
 */
export const EMBED_RESOURCE_ISOLATION = {
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
} as const;

/**
 * Resolve Core's onboarded provider into a Pi ModelRegistry (config-share, D-2).
 * Shared by buildSessionWithCoreBrain and the MemexTerminal runtime factory
 * (terminal.ts) so both dial the same brain the same way. The Model is resolved
 * by the caller via resolveCoreModel() (its type — pi-ai's Model — can't be
 * named in an exported signature, so it stays local to each caller).
 */
export function buildCoreModelRegistry(): {
  core: CoreProvider;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
} {
  const core = resolveCoreProvider();
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage, writeModelsJson(core));
  modelRegistry.refresh();
  return { core, authStorage, modelRegistry };
}

/**
 * Build a Pi AgentSession whose brain is Core's onboarded provider. Pi builtins
 * are suppressed (noTools:'builtin') — only the supplied Core tools surface, so
 * raw bash never bypasses Core's CommandGate/containment.
 */
export async function buildSessionWithCoreBrain(opts: {
  customTools?: ToolDefinition[];
  cwd?: string;
  /**
   * C3 hooks (ADR-57 D-3): in-process extensions that inject the graph
   * projection at before_agent_start and flush the turn at agent_end.
   */
  extensionFactories?: ExtensionFactory[];
} = {}) {
  const { core, authStorage, modelRegistry } = buildCoreModelRegistry();
  const model = modelRegistry.find(core.name, core.model);
  if (!model) throw new Error(`${core.name}/${core.model} not in registry: ${modelRegistry.getError() ?? '?'}`);

  const services = await createAgentSessionServices({
    cwd: opts.cwd ?? process.cwd(),
    authStorage,
    modelRegistry,
    resourceLoaderOptions: {
      ...EMBED_RESOURCE_ISOLATION,
      ...(opts.extensionFactories ? { extensionFactories: opts.extensionFactories } : {}),
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(),
    model,
    noTools: 'builtin',
    customTools: opts.customTools ?? [],
  });
  return { session, core };
}
