/**
 * Inbound authorization gate — ported (DRY) from hermes-agent's posture rather
 * than reinvented: gateway/run.py GatewayRunner._is_user_authorized + the
 * per-platform allowlist startup check.
 *
 * Why this exists: a channel connector hands raw inbound messages to the agent
 * conversation core, which can run execute_bash. Without a gate, anyone who
 * finds the bot's handle can drive the agent. hermes is secure-by-config:
 *
 *   - allowlist set      → only listed IDs pass (others are dropped, never
 *                          reach the agent — fail-closed at the edge);
 *   - allowlist empty    → everyone passes, but start() logs a one-time
 *                          security warning (an open agent should never be
 *                          silently world-reachable);
 *   - wildcard '*'       → explicit opt-in to allow-all; suppresses the warning.
 *
 * Kept channel-agnostic (parameterised by platform) so Slack/Discord can reuse
 * the same gate — hermes uses one authorization path for every platform.
 */

export interface AllowlistDecision {
  allowed: boolean;
  reason: 'no-allowlist' | 'wildcard' | 'listed' | 'denied';
}

/** Parse a comma-separated allowlist env value into trimmed, non-empty IDs. */
export function parseAllowlist(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Decide whether an inbound chat ID is authorized.
 * Empty allowlist = allow-all (open); '*' = explicit allow-all; otherwise the
 * ID must be listed.
 */
export function isChatAuthorized(chatId: string, allowlist: string[]): AllowlistDecision {
  if (allowlist.length === 0) return { allowed: true, reason: 'no-allowlist' };
  if (allowlist.includes('*')) return { allowed: true, reason: 'wildcard' };
  return allowlist.includes(chatId)
    ? { allowed: true, reason: 'listed' }
    : { allowed: false, reason: 'denied' };
}

/**
 * One-line startup warning when a live channel has no allowlist — mirrors
 * hermes's TestAllowlistStartupCheck. Returns the warning string (or null when
 * an allowlist/wildcard is set) so callers can log it through their own logger.
 */
export function allowlistStartupWarning(platform: string, envVar: string, allowlist: string[]): string | null {
  if (allowlist.length > 0) return null;
  return `[${platform}] no ${envVar} set — every chat that finds this bot can drive the agent (which can run shell commands); set ${envVar} to a comma-separated allowlist of chat IDs, or '*' to silence this and allow all`;
}
