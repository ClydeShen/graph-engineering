/**
 * OpenAI-compatible endpoint URL construction — the SINGLE rule for turning a
 * configured baseUrl + a route into a request URL.
 *
 * Two baseUrl conventions coexist in the provider registry and in user configs:
 *   - versioned (OpenAI-SDK style): `https://api.openai.com/v1`,
 *     `https://integrate.api.nvidia.com/v1`, Gemini's `…/v1beta/openai`;
 *   - bare host (local servers): `http://localhost:11434`, `:8080`, `:1234`.
 *
 * The route ('chat/completions', 'embeddings', 'models') must be appended
 * WITHOUT re-adding a version segment to a versioned base — otherwise the URL
 * doubles to `…/v1/v1/…` and every strict gateway returns 404 (the bug this
 * file fixes). A bare host gets `/v1` added.
 *
 * Detection mirrors what fetch-models already used: any `/v<digit>` in the path
 * means "already versioned" (covers `/v1`, `/v1/`, and `/v1beta/openai`).
 */
export function openaiUrl(baseUrl: string, route: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  const versioned = /\/v\d/.test(trimmed);
  return versioned ? `${trimmed}/${route}` : `${trimmed}/v1/${route}`;
}
