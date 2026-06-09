/**
 * Best-effort webhook notification. No-op when NOTIFY_WEBHOOK_URL is not set.
 * Compatible with Discord and Slack incoming webhooks ({ content: string }).
 *
 * Never throws — errors are caught and console.warn'd.
 */

export interface NotifyPayload {
  type: 'crystal' | 'lesson';
  scope_id?: string;
  fingerprint_id?: string;
  summary: string;
}

function formatMessage(payload: NotifyPayload): string {
  const icon = payload.type === 'crystal' ? '🔮 Crystal' : '📚 Lesson';
  const scope = payload.scope_id ?? payload.fingerprint_id ?? 'n/a';
  return `[graph-runtime] ${icon} | scope: ${scope} | ${payload.summary.slice(0, 200)}`;
}

export async function notify(payload: NotifyPayload): Promise<void> {
  const url = process.env['NOTIFY_WEBHOOK_URL'];
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: formatMessage(payload) }),
    });
  } catch (err) {
    console.warn('[notify] webhook delivery failed:', err);
  }
}
