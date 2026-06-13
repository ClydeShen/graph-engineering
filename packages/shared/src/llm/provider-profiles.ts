/**
 * ProviderProfile registry — every inference provider Memex knows about,
 * declared once (ADR 56, Hermes providers/base.py pattern).
 *
 * Every consumer derives from this table instead of maintaining parallel data:
 *   - onboarding picker (packages/cli/src/onboard.ts)
 *   - doctor health probes (packages/cli/src/doctor.ts)
 *   - runtime provider construction (./from-config.ts)
 *
 * Adding a provider = one entry here. Do NOT add provider knowledge anywhere else.
 *
 * `supportsEmbedding` is conservative: true only where the OpenAI-compatible
 * /embeddings endpoint is documented to exist. Embedding is OPTIONAL system-wide
 * (ADR 55) — a profile with supportsEmbedding:false is a fully valid sole provider.
 */

import type { LLMApi } from './types.js';

export interface ProviderProfile {
  /** Registry key — stable identifier used in config.json providers[].name. */
  name: string;
  /** Human-readable label for pickers. */
  displayName: string;
  /** Transport protocol (ADR 22 factory selector). */
  api: LLMApi;
  /** Default endpoint. Undefined = user must supply (custom). */
  baseUrl?: string;
  /** Conventional API key env var. Undefined = no key needed (local). */
  envVar?: string;
  /** Where to get a key — shown during onboarding. */
  signupUrl?: string;
  /** Suggested default chat model (picker initial value). */
  defaultModel?: string;
  /** True when the endpoint serves OpenAI-compatible /embeddings. */
  supportsEmbedding: boolean;
  /** Suggested embedding model (only meaningful when supportsEmbedding). */
  defaultEmbeddingModel?: string;
  /** Localhost service — reachability depends on the user running it. */
  local?: boolean;
}

/**
 * Mainstream matrix (Hermes-aligned). Most providers ride the
 * openai-completions transport; Anthropic is the native-API exception.
 */
export const PROVIDER_PROFILES: readonly ProviderProfile[] = [
  {
    name: 'anthropic',
    displayName: 'Anthropic (Claude)',
    api: 'anthropic-messages',
    envVar: 'ANTHROPIC_API_KEY',
    signupUrl: 'https://console.anthropic.com/',
    defaultModel: 'claude-sonnet-4-6',
    supportsEmbedding: false, // Anthropic has no embeddings endpoint
  },
  {
    name: 'openai',
    displayName: 'OpenAI',
    api: 'openai-completions',
    baseUrl: 'https://api.openai.com/v1',
    envVar: 'OPENAI_API_KEY',
    signupUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-4o',
    supportsEmbedding: true,
    defaultEmbeddingModel: 'text-embedding-3-small',
  },
  {
    name: 'openrouter',
    displayName: 'OpenRouter (many models, one API)',
    api: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    envVar: 'OPENROUTER_API_KEY',
    signupUrl: 'https://openrouter.ai/keys',
    defaultModel: 'anthropic/claude-sonnet-4-6',
    supportsEmbedding: false, // chat-only router
  },
  {
    name: 'ollama',
    displayName: 'Ollama (local)',
    api: 'openai-completions',
    baseUrl: 'http://localhost:11434',
    defaultModel: 'llama3',
    supportsEmbedding: true,
    defaultEmbeddingModel: 'nomic-embed-text',
    local: true,
  },
  {
    name: 'vllm',
    displayName: 'vLLM (local)',
    api: 'openai-completions',
    baseUrl: 'http://localhost:8000',
    supportsEmbedding: true, // when serving an embedding model
    local: true,
  },
  {
    name: 'lmstudio',
    displayName: 'LM Studio (local)',
    api: 'openai-completions',
    baseUrl: 'http://localhost:1234',
    supportsEmbedding: true,
    local: true,
  },
  {
    name: 'llamacpp',
    displayName: 'llama.cpp (local llama-server)',
    api: 'openai-completions',
    baseUrl: 'http://localhost:8080', // llama-server default host:port
    supportsEmbedding: true, // /v1/embeddings exists when started with --embeddings
    local: true,
  },
  {
    name: 'omlx',
    displayName: 'oMLX (Apple silicon, local)',
    api: 'openai-completions',
    baseUrl: 'http://localhost:8000', // omlx serve default (jundot/omlx)
    // oMLX serves /v1/chat/completions, /v1/embeddings, and /v1/rerank —
    // chat + embedding are consumed here; rerank has no runtime slot yet.
    supportsEmbedding: true,
    local: true,
  },
  {
    name: 'deepseek',
    displayName: 'DeepSeek',
    api: 'openai-completions',
    baseUrl: 'https://api.deepseek.com',
    envVar: 'DEEPSEEK_API_KEY',
    signupUrl: 'https://platform.deepseek.com/',
    defaultModel: 'deepseek-chat',
    supportsEmbedding: false,
  },
  {
    name: 'gemini',
    displayName: 'Google Gemini',
    api: 'openai-completions',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envVar: 'GEMINI_API_KEY',
    signupUrl: 'https://aistudio.google.com/app/apikey',
    defaultModel: 'gemini-2.5-flash',
    supportsEmbedding: true,
    defaultEmbeddingModel: 'text-embedding-004',
  },
  {
    name: 'nvidia',
    displayName: 'NVIDIA NIM (build.nvidia.com)',
    api: 'openai-completions',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    envVar: 'NVIDIA_API_KEY',
    signupUrl: 'https://build.nvidia.com/',
    defaultModel: 'meta/llama-3.1-8b-instruct',
    // Chat-only here: NVIDIA's /embeddings needs an `input_type` (query/passage)
    // param the generic OpenAI embedding path doesn't send, so we don't claim it.
    supportsEmbedding: false,
  },
  {
    name: 'glm',
    displayName: 'z.ai / GLM (ZhipuAI)',
    api: 'openai-completions',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    envVar: 'GLM_API_KEY',
    signupUrl: 'https://z.ai/',
    supportsEmbedding: false,
  },
  {
    name: 'kimi',
    displayName: 'Kimi (Moonshot)',
    api: 'openai-completions',
    baseUrl: 'https://api.moonshot.ai/v1',
    envVar: 'KIMI_API_KEY',
    signupUrl: 'https://platform.moonshot.ai/',
    supportsEmbedding: false,
  },
  {
    name: 'minimax',
    displayName: 'MiniMax',
    api: 'openai-completions',
    baseUrl: 'https://api.minimax.io/v1',
    envVar: 'MINIMAX_API_KEY',
    signupUrl: 'https://www.minimax.io/',
    supportsEmbedding: false,
  },
  {
    name: 'custom',
    displayName: 'Custom (any OpenAI-compatible endpoint)',
    api: 'openai-completions',
    supportsEmbedding: true, // user-asserted: probed by doctor, degraded at runtime if wrong
  },
] as const;

/** Look up a profile by registry key. */
export function getProviderProfile(name: string): ProviderProfile | undefined {
  return PROVIDER_PROFILES.find((p) => p.name === name);
}

/**
 * Resolve a profile for a config providers[] entry. Matches by entry.name
 * first, then by legacy entry.type ('anthropic' | 'openai-compatible').
 * Unknown names fall back to the custom profile so old configs keep booting.
 */
export function resolveProfile(entry: { name: string; type?: string }): ProviderProfile {
  const byName = getProviderProfile(entry.name);
  if (byName) return byName;
  if (entry.type === 'anthropic') return getProviderProfile('anthropic')!;
  return getProviderProfile('custom')!;
}
