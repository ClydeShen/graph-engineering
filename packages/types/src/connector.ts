/**
 * ConnectorAdapter contract — FROZEN at Phase 11 (11-PHASE-SPEC §6.1).
 *
 * Phase 12 implements five connectors (Telegram, Discord, Slack, Email,
 * Webhook) against this interface — changing it then means re-touching all
 * five. Optional members exist precisely so Phase 12/14 fill them without an
 * interface change:
 *   - platform_hint / pii_safe              (hermes PlatformEntry parity)
 *   - trust_level / allowed_toolset          (Phase 14 trust→toolset mapping)
 *   - standalone send                        (cron delivery without a live gateway)
 *
 * This module is a leaf: it imports no @graph/* packages (only sibling ./core).
 */

import type { TrustLevel } from './core.js';

/**
 * Channel-prefixed sender identity, e.g. `telegram:12345678`.
 * Enforced at the type level so Phase 13 cross-channel identity unification
 * (same_as aliases) needs zero data migration (11-DESIGN-NOTES §5).
 */
export type ChannelPrefixedSenderId = `${string}:${string}`;

/** Normalized inbound message — every channel converges to this shape. */
export interface ChannelMessageEvent {
  /** Platform key, e.g. 'telegram', 'discord', 'slack', 'email', 'webhook'. */
  channel: string;
  /** Always channel-prefixed: `<channel>:<platform_user_id>`. */
  sender_id: ChannelPrefixedSenderId;
  /** Conversation/thread routing key within the channel. */
  chat_id: string;
  text: string;
  /** Platform-native message id (idempotency anchor). */
  message_id: string;
  received_at: string;
  /**
   * Set for channels that ingest third-party content (inbound webhook).
   * Phase 14: untrusted messages never reach file/exec tools.
   */
  untrusted?: boolean;
  /** Reserved (post-1.0 multimodal). */
  attachments?: unknown[];
}

/** Self-describing connector metadata (hermes PlatformEntry pattern). */
export interface ConnectorMetadata {
  platform: string;
  /** Env vars the connector needs; surfaced by setup UI / doctor. */
  required_env: string[];
  /** System-prompt context for this platform (e.g. "plain text only"). */
  platform_hint?: string;
  /** Whether session descriptions through this channel need PII redaction. */
  pii_safe?: boolean;
  /** Phase 14 slot: trust classification of content from this channel. */
  trust_level?: TrustLevel;
  /** Phase 14 slot: restricted tool allowlist for this channel's turns. */
  allowed_toolset?: string[];
}

export interface ConnectorCheckResult {
  ok: boolean;
  detail?: string;
}

/**
 * The connector contract. One instance per configured platform.
 *
 * start() runs the inbound loop (long-poll / socket / IMAP poll) and calls
 * onMessage for each normalized message; the returned string is the reply to
 * deliver back on the same channel. send() is the standalone delivery path
 * (DeliveryRouter / cron) that must work without the inbound loop running.
 */
export interface ConnectorAdapter {
  readonly meta: ConnectorMetadata;
  /** Dependency/connectivity probe — graceful skip when not ok. */
  check(): Promise<ConnectorCheckResult>;
  /** Config completeness validation before start (fail fast, not at connect). */
  validateConfig(config: Record<string, unknown>): ConnectorCheckResult;
  start(
    onMessage: (evt: ChannelMessageEvent) => Promise<string>,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Standalone outbound delivery: target is chat_id within this platform. */
  send(target: string, text: string): Promise<void>;
}
