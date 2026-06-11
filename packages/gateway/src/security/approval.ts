/**
 * Cross-channel approval state machine (ADR-47 D-2).
 *
 * pending → approved | denied | timed_out. "Silence is not consent": the
 * timeout sweep denies anything pending past the deadline. Decision scopes:
 * once / session (scope-lifetime) / always (config allowlist — the WRITE of
 * an always-rule itself requires an approval; this module only reports it).
 *
 * approval_request (migration 016) is the queryable projection; every
 * transition writes a memex::security::approval_* audit event (D-8).
 * Push goes through the DeliveryRouter (expects_reply — Phase 12 slot).
 */

import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { canonicalJson, writeInfraEvent } from '@graph/shared';

export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'timed_out';
export type DecisionKind = 'once' | 'session' | 'always';

export interface ApprovalPush {
  deliver(req: {
    deliver: string;
    text: string;
    expects_reply?: boolean;
    scope_id?: string;
  }): Promise<unknown>;
}

async function audit(
  pool: Pool,
  scopeId: string,
  kind: string,
  fields: Record<string, unknown>,
): Promise<void> {
  await writeInfraEvent(
    pool,
    scopeId,
    'memory_updated',
    canonicalJson({ kind, ...fields, at: new Date().toISOString() }),
    'archived',
  ).catch(() => {
    /* audit is best-effort — the state machine row is authoritative */
  });
}

export class ApprovalService {
  constructor(
    private readonly pool: Pool,
    private readonly push: ApprovalPush | null = null,
    private readonly homeTarget: string = 'origin',
  ) {}

  /** File a request, push it to the home channel, return its id. */
  async request(scopeId: string, principal: string, command: string): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO approval_request (id, scope_id, principal, command)
       VALUES ($1, $2, $3, $4)`,
      [id, scopeId, principal, command],
    );
    await audit(this.pool, scopeId, 'memex::security::approval_requested', {
      approval_id: id, principal, command,
    });
    if (this.push !== null) {
      await this.push.deliver({
        deliver: this.homeTarget,
        text:
          `⚠ Approval needed (${id.slice(0, 8)})\n` +
          `agent: ${principal}\ncommand: ${command}\n` +
          `Reply /approve ${id.slice(0, 8)} or /deny ${id.slice(0, 8)} — silence (5 min) = deny.`,
        expects_reply: true,
        scope_id: scopeId,
      }).catch(() => {
        /* push failure must not lose the pending row — timeout still governs */
      });
    }
    return id;
  }

  /** Record a human decision. Returns false if the request was not pending. */
  async decide(
    approvalId: string,
    approve: boolean,
    kind: DecisionKind = 'once',
  ): Promise<boolean> {
    const status: ApprovalStatus = approve ? 'approved' : 'denied';
    const { rows } = await this.pool.query<{ scope_id: string; command: string }>(
      `UPDATE approval_request
       SET status = $2, decision_kind = $3, decided_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING scope_id, command`,
      [approvalId, status, approve ? kind : null],
    );
    if (rows.length === 0) return false;
    await audit(this.pool, rows[0]!.scope_id,
      approve ? 'memex::security::approval_granted' : 'memex::security::approval_denied',
      { approval_id: approvalId, decision_kind: kind, command: rows[0]!.command });
    return true;
  }

  /** Current status, or null when unknown. */
  async status(approvalId: string): Promise<ApprovalStatus | null> {
    const { rows } = await this.pool.query<{ status: ApprovalStatus }>(
      `SELECT status FROM approval_request WHERE id = $1`,
      [approvalId],
    );
    return rows.length > 0 ? rows[0]!.status : null;
  }

  /**
   * Silence is not consent: deny everything pending past the deadline.
   * Returns the number of requests timed out.
   */
  async sweepTimeouts(timeoutMs: number = APPROVAL_TIMEOUT_MS): Promise<number> {
    const { rows } = await this.pool.query<{ id: string; scope_id: string }>(
      `UPDATE approval_request
       SET status = 'timed_out', decided_at = NOW()
       WHERE status = 'pending'
         AND requested_at < NOW() - ($1 || ' milliseconds')::interval
       RETURNING id, scope_id`,
      [String(timeoutMs)],
    );
    for (const row of rows) {
      await audit(this.pool, row.scope_id, 'memex::security::approval_timeout', {
        approval_id: row.id,
      });
    }
    return rows.length;
  }

  /** Session-scope standing approval: was this command approved for the scope? */
  async hasSessionApproval(scopeId: string, command: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM approval_request
       WHERE scope_id = $1 AND command = $2
         AND status = 'approved' AND decision_kind IN ('session', 'always')
       LIMIT 1`,
      [scopeId, command],
    );
    return rows.length > 0;
  }
}

/**
 * aux-LLM smart approval (CommandGate tier 3, ADR-47 D-3) — TIGHTEN-ONLY.
 * The LLM verdict can escalate an allowed command to approval; it can NEVER
 * downgrade a pattern verdict. "LLM says safe" is not a pass.
 */
export async function auxLlmTighten(
  patternAllowed: boolean,
  llmJudge: (command: string) => Promise<'dangerous' | 'safe'>,
  command: string,
): Promise<{ requiresApproval: boolean }> {
  if (!patternAllowed) return { requiresApproval: true }; // pattern verdict stands
  try {
    const verdict = await llmJudge(command);
    return { requiresApproval: verdict === 'dangerous' };
  } catch {
    // Judge unavailable → fall back to the pattern verdict (allowed).
    return { requiresApproval: false };
  }
}
