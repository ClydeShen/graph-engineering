import type { Pool } from 'pg';
import { DEFAULT_GATEWAY_PORT, loadMemexConfig } from '@graph/shared';
import { resolveSessionScope } from './session-scope.js';

/** Gateway base URL for the conversation core (ADR 54 D-4). */
function gatewayBaseUrl(): string {
  const config = loadMemexConfig();
  return (
    process.env['MEMEX_GATEWAY_URL'] ??
    config?.shell?.gateway_url ??
    `http://127.0.0.1:${config?.gateway?.port ?? process.env['PORT'] ?? DEFAULT_GATEWAY_PORT}`
  );
}

/**
 * Route one channel message through the gateway conversation core and return
 * the assistant reply for the channel to send back (ADR 54 D-4 — conversation
 * messages no longer spawn required_skills tasks; skill routing stays for
 * asynchronous agentic work).
 *
 * TD-E session mapping is unchanged: same sessionKey → same scope while live.
 */
export async function dispatchMessage(
  sessionKey: string,
  text: string,
  pool: Pool,
  sourceMessageId: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const { scopeId } = await resolveSessionScope(pool, sessionKey);
  const res = await fetchFn(`${gatewayBaseUrl()}/v1/scopes/${scopeId}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Agent-ID': sessionKey },
    body: JSON.stringify({ text, source_message_id: sourceMessageId }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return `⚠ ${body.error ?? `gateway error ${res.status}`}`;
  }
  const body = (await res.json()) as { reply: string };
  return body.reply;
}
