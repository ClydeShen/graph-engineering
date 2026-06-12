/**
 * ask_user service (ADR-53 / Phase 20 #2) — the approval state machine
 * generalized from binary approve/deny to free-form Q&A.
 *
 * pending → answered | timed_out. Same "silence is not consent" sweep
 * discipline as ApprovalService; same DeliveryRouter push slot; same audit
 * pattern (memex::ask_user::* events — Q&A pairs are first-class trail data:
 * "the agent always asks at this step" is a Trail Discovery signal).
 *
 * Replies route back via POST /v1/questions/:id/answer (Console/Terminal) —
 * chat-command reply routing joins the /approve live-wiring batch.
 */

import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { canonicalJson, writeInfraEvent } from '@graph/shared';
import type { ApprovalPush } from './approval.js';

export const ASK_USER_TIMEOUT_MS = 10 * 60 * 1000;

export type QuestionStatus = 'pending' | 'answered' | 'timed_out';

async function audit(pool: Pool, scopeId: string, kind: string, fields: Record<string, unknown>): Promise<void> {
  await writeInfraEvent(
    pool,
    scopeId,
    'memory_updated',
    canonicalJson({ kind, ...fields, at: new Date().toISOString() }),
    'archived',
  ).catch(() => {
    /* audit best-effort — the row is authoritative */
  });
}

export class AskUserService {
  constructor(
    private readonly pool: Pool,
    private readonly push: ApprovalPush | null = null,
    private readonly homeTarget: string = 'origin',
  ) {}

  /** File a question, push it to the user's channel, return its id. */
  async ask(scopeId: string, principal: string, question: string): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO user_question (id, scope_id, principal, question) VALUES ($1, $2, $3, $4)`,
      [id, scopeId, principal, question],
    );
    await audit(this.pool, scopeId, 'memex::ask_user::asked', { question_id: id, principal, question });
    if (this.push !== null) {
      await this.push
        .deliver({
          deliver: this.homeTarget,
          text: `❓ ${principal} asks (${id.slice(0, 8)}):\n${question}\nReply: /answer ${id.slice(0, 8)} <text>`,
          expects_reply: true,
          scope_id: scopeId,
        })
        .catch(() => {
          /* push failure must not lose the pending row */
        });
    }
    return id;
  }

  /** Record the user's answer. False when the question was not pending. */
  async answer(questionId: string, answer: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ scope_id: string }>(
      `UPDATE user_question SET status = 'answered', answer = $2, answered_at = NOW()
       WHERE id = $1 AND status = 'pending' RETURNING scope_id`,
      [questionId, answer],
    );
    if (rows.length === 0) return false;
    await audit(this.pool, rows[0]!.scope_id, 'memex::ask_user::answered', {
      question_id: questionId,
      answer,
    });
    return true;
  }

  /** Status + answer (agent polls this from the ask_user tool). */
  async status(questionId: string): Promise<{ status: QuestionStatus; answer: string | null } | null> {
    const { rows } = await this.pool.query<{ status: QuestionStatus; answer: string | null }>(
      `SELECT status, answer FROM user_question WHERE id = $1`,
      [questionId],
    );
    return rows[0] ?? null;
  }

  /** Silence sweep — same discipline as approvals. */
  async sweepTimeouts(timeoutMs: number = ASK_USER_TIMEOUT_MS): Promise<number> {
    const { rows } = await this.pool.query<{ id: string; scope_id: string }>(
      `UPDATE user_question SET status = 'timed_out', answered_at = NOW()
       WHERE status = 'pending' AND asked_at < NOW() - ($1 || ' milliseconds')::interval
       RETURNING id, scope_id`,
      [String(timeoutMs)],
    );
    for (const row of rows) {
      await audit(this.pool, row.scope_id, 'memex::ask_user::timeout', { question_id: row.id });
    }
    return rows.length;
  }
}
