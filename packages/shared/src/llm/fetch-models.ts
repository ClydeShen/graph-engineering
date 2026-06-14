/**
 * Live model listing — mirrors Hermes' ProviderProfile.fetch_models() hook
 * (hermes-research-B §1.2). Onboarding calls this right after the key is pasted
 * so the user PICKS a model the provider actually serves, instead of typing an
 * id from memory.
 *
 * Best-effort by contract: any failure (no key, offline, an endpoint that does
 * not implement /models, a slightly-wrong path for an edge provider) resolves to
 * [] so the caller falls back to free-text entry. This function NEVER throws.
 */

import type { LLMApi } from './types.js';

/** OpenAI list-models / Anthropic list-models share this envelope shape. */
interface ModelListResponse {
  data?: Array<{ id?: string }>;
}

/**
 * Build the models endpoint for an OpenAI-compatible base. The profile registry
 * is inconsistent about whether baseUrl already carries a version segment
 * (`https://api.openai.com/v1`, `.../v1beta/openai`) or is a bare host
 * (`http://localhost:11434`), so detect it: a versioned base just needs
 * `/models`; a bare host needs `/v1/models`.
 */
function openaiModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/v\d/.test(trimmed) ? `${trimmed}/models` : `${trimmed}/v1/models`;
}

export async function fetchModels(
  profile: { api: LLMApi },
  baseUrl: string | undefined,
  apiKey: string | undefined,
  timeoutMs = 8000,
): Promise<string[]> {
  try {
    let url: string;
    let headers: Record<string, string>;

    if (profile.api === 'anthropic-messages') {
      // Anthropic uses the SDK at runtime (no baseUrl in the profile); its list
      // endpoint is a fixed REST path needing x-api-key + a version header.
      if (apiKey === undefined || apiKey.length === 0) return [];
      url = 'https://api.anthropic.com/v1/models';
      headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    } else {
      if (baseUrl === undefined) return [];
      url = openaiModelsUrl(baseUrl);
      headers =
        apiKey !== undefined && apiKey.length > 0
          ? { Authorization: `Bearer ${apiKey}` }
          : {}; // local endpoints (ollama, lmstudio) need no key
    }

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return [];
    const json = (await res.json()) as ModelListResponse;
    return (json.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return []; // never throw — onboarding falls back to manual entry
  }
}
