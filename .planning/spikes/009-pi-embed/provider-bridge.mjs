// Build-out line #1 — provider wiring (ADR-57 D-2, config-share).
//
// Maps Core's onboarded provider config (~/.memex/config.json providers[] +
// ADR-56 profile) onto a pi-coding-agent ModelRegistry, so Pi's agent loop dials
// the SAME OpenAI-compatible endpoint/key/model as Core's chat — native pi-ai
// streaming + tool-calling, one brain, no second key.
//
// CORRECTION vs original D-2: do NOT delegate to Core's LLMProvider in-process.
// Core's LLMProvider is chat(messages)->string (non-streaming, no native
// tool-call protocol); Pi's loop needs the real OpenAI protocol. Share the
// CONFIG, not the object.
//
// Status: skeleton against the verified real API. The live turn is the in-repo
// build-out commit (import @graph/shared loadMemexConfig + resolveProfile там).
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  ModelRegistry,
  AuthStorage,
} from '@earendil-works/pi-coding-agent';

/**
 * Core providers[] entry + resolved profile -> pi ProviderConfig.
 * In-repo this reads via @graph/shared buildOne inputs; here it's the shape.
 * @param {{name:string, api?:string, model:string, baseUrl:string, apiKey:string}} core
 */
export function coreToPiProviderConfig(core) {
  return {
    name: core.name,
    baseUrl: core.baseUrl,
    apiKey: core.apiKey, // pi-ai supports literal | $ENV | ${ENV} | !command
    api: core.api ?? 'openai-completions', // NVIDIA/Ollama/most onboarded = OpenAI-compatible
    authHeader: true,
    models: [
      {
        id: core.model,
        name: core.model,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
  };
}

/**
 * Build a session whose brain = Core's onboarded provider.
 *
 * Two candidate registration routes (resolve in the build-out commit):
 *  (A) extension `pi.registerProvider(name, ProviderConfig)` via an in-process
 *      extension factory threaded through services.resourceLoader; or
 *  (B) generate a temp models.json from coreToPiProviderConfig() and
 *      ModelRegistry.create(authStorage, tempPath) — registry has no public
 *      add-provider method, custom providers load from models.json.
 * Route (B) is shown below as the more deterministic path.
 */
export async function buildSessionWithCoreBrain(core, { customTools = [], cwd = process.cwd() } = {}) {
  const authStorage = AuthStorage.create?.() ?? AuthStorage.inMemory?.();
  // TODO(build-out): write coreToPiProviderConfig(core) into a temp models.json
  //   (schema = { providers: { [name]: ProviderConfig } } — confirm via
  //   model-registry parseModels), then ModelRegistry.create(authStorage, path).
  const modelRegistry = ModelRegistry.create(authStorage /*, tempModelsJsonPath */);
  const model = modelRegistry.find(core.name, core.model);
  if (!model) throw new Error(`model ${core.name}/${core.model} not in registry — provider not injected yet`);

  const services = await createAgentSessionServices({ cwd, authStorage, modelRegistry });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(),
    model,
    noTools: 'builtin',   // suppress pi raw bash/edit/write; only Core tools surface
    customTools,
  });
  return session;
}
