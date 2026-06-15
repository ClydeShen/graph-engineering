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
} from '@earendil-works/pi-coding-agent';
import { loadMemexConfig } from '@graph/shared';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface CoreProvider {
  name: string;
  model: string;
  baseUrl: string;
  /** Already ${ENV}-interpolated by loadMemexConfig (real key value). */
  apiKey: string;
  /** OpenAI-compatible for NVIDIA/Ollama/most onboarded providers. */
  api: 'openai-completions' | 'anthropic-messages';
}

/** Read Core's highest-priority onboarded provider from ~/.memex/config.json. */
export function resolveCoreProvider(): CoreProvider {
  const cfg = loadMemexConfig();
  const entries = cfg?.providers ?? [];
  if (entries.length === 0) throw new Error('no onboarded provider — run `memex onboard`');
  const e = [...entries].sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9))[0]!;
  return {
    name: e.name,
    model: e.model,
    baseUrl: e.baseUrl ?? 'https://integrate.api.nvidia.com/v1',
    apiKey: e.apiKey ?? '', // loader already interpolated ${NVIDIA_API_KEY}
    api: 'openai-completions', // ADR-56 nvidia profile; Anthropic is the exception
  };
}

/** Core provider -> pi models.json ({ providers: { <name>: ProviderConfig } }). */
function writeModelsJson(p: CoreProvider): string {
  const dir = mkdtempSync(join(tmpdir(), 'memex-pi-'));
  const path = join(dir, 'models.json');
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
              maxTokens: 4096,
            },
          ],
        },
      },
    }),
  );
  return path;
}

/**
 * Build a Pi AgentSession whose brain is Core's onboarded provider. Pi builtins
 * are suppressed (noTools:'builtin') — only the supplied Core tools surface, so
 * raw bash never bypasses Core's CommandGate/containment.
 */
export async function buildSessionWithCoreBrain(opts: {
  customTools?: ToolDefinition[];
  cwd?: string;
} = {}) {
  const core = resolveCoreProvider();
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage, writeModelsJson(core));
  modelRegistry.refresh();
  const model = modelRegistry.find(core.name, core.model);
  if (!model) throw new Error(`${core.name}/${core.model} not in registry: ${modelRegistry.getError() ?? '?'}`);

  const services = await createAgentSessionServices({
    cwd: opts.cwd ?? process.cwd(),
    authStorage,
    modelRegistry,
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
