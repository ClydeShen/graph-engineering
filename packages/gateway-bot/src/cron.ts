/**
 * Graph-native cron (ADR-45): jobs are Entity Snapshots in the cron registry
 * scope; every due tick opens a fresh scope (an ordinary Trail); results are
 * delivered via the DeliveryRouter after the run scope closes.
 *
 * Job identity = payload.name (latest Snapshot wins — append-only config
 * history). Registry writes use writeInfraEvent with 'archived' status so the
 * registry scope never enters the convergence lifecycle (ADR-45 D-1/后果).
 *
 * Missed ticks are never caught up (ADR-45 D-3); duplicate fires within the
 * same minute are prevented by the run-scope intent (cron:<name>:<minute>)
 * existence check (ADR-45 D-4).
 */

import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { canonicalJson, occWrite, writeInfraEvent } from '@graph/shared';
import { nestScope } from '@graph/control-plane/nesting';
import type { DeliveryRouter } from './delivery-router.js';

export const CRON_REGISTRY_INTENT = 'cron:registry';

/** Find or create the cron registry scope. Standalone so non-bot processes
 * (e.g. MemexTerminal's schedule_task tool, ADR-57 D-6) can register jobs the
 * running gateway-bot's CronService.tick() will fire — one shared write path. */
export async function ensureCronRegistryScope(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ scope_id: string }>(
    `SELECT scope_id FROM scope_lineage WHERE intent = $1 LIMIT 1`,
    [CRON_REGISTRY_INTENT],
  );
  if (rows.length > 0) return rows[0]!.scope_id;
  const { scopeId } = await nestScope(pool, CRON_REGISTRY_INTENT);
  return scopeId;
}

/** Append a job definition Snapshot (append-only config history, ADR-45 D-1). */
export async function upsertCronJob(pool: Pool, def: Omit<CronJobDef, 'kind'>): Promise<void> {
  const registryScopeId = await ensureCronRegistryScope(pool);
  await writeInfraEvent(
    pool,
    registryScopeId,
    'memory_updated',
    canonicalJson({ kind: 'cron_job', ...def }),
    'archived',
  );
}

export interface CronJobDef {
  kind: 'cron_job';
  name: string;
  /** 5-field cron: minute hour dom month dow. */
  schedule: string;
  prompt: string;
  deliver: string;
  origin?: string;
  enabled: boolean;
}

// ── 5-field cron matcher (minute precision, ADR-45 D-4) ─────────────────────
// Supported per field: '*', '*/n', 'a', 'a,b,c', 'a-b'. No seconds, no names.

function fieldMatches(field: string, value: number): boolean {
  for (const part of field.split(',')) {
    if (part === '*') return true;
    const step = part.match(/^\*\/(\d+)$/);
    if (step) {
      if (value % Number(step[1]) === 0) return true;
      continue;
    }
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      if (value >= Number(range[1]) && value <= Number(range[2])) return true;
      continue;
    }
    if (Number(part) === value) return true;
  }
  return false;
}

export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  return (
    fieldMatches(minute, date.getMinutes()) &&
    fieldMatches(hour, date.getHours()) &&
    fieldMatches(dom, date.getDate()) &&
    fieldMatches(month, date.getMonth() + 1) &&
    fieldMatches(dow, date.getDay())
  );
}

/** Run-scope intent for a given job + minute — the dedup anchor (D-4). */
export function runScopeIntent(jobName: string, date: Date): string {
  const minute = date.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  return `cron:${jobName}:${minute}`;
}

// ── Cron service ─────────────────────────────────────────────────────────────

export class CronService {
  constructor(
    private readonly pool: Pool,
    private readonly router: DeliveryRouter,
  ) {}

  /** Find or create the cron registry scope. */
  async ensureRegistryScope(): Promise<string> {
    return ensureCronRegistryScope(this.pool);
  }

  /** Append a job definition Snapshot (append-only config history, D-1). */
  async upsertCronJob(def: Omit<CronJobDef, 'kind'>): Promise<void> {
    await upsertCronJob(this.pool, def);
  }

  /** Latest Snapshot per job name (later event wins). */
  async readJobTips(): Promise<CronJobDef[]> {
    const registryScopeId = await this.ensureRegistryScope();
    const { rows } = await this.pool.query<{ payload: string }>(
      `SELECT payload FROM execution_event_log
       WHERE scope_id = $1 AND payload LIKE '%"kind":"cron_job"%'
       ORDER BY id ASC`,
      [registryScopeId],
    );
    const byName = new Map<string, CronJobDef>();
    for (const row of rows) {
      try {
        const def = JSON.parse(row.payload) as CronJobDef;
        if (def.kind === 'cron_job' && typeof def.name === 'string') {
          byName.set(def.name, def);
        }
      } catch {
        /* non-JSON payload — skip */
      }
    }
    return [...byName.values()];
  }

  /**
   * One tick: fire every enabled job whose schedule matches `now`.
   * A run = fresh scope + task_spawned (ordinary Trail, ADR-45 D-2).
   * Returns the names fired.
   */
  async tick(now: Date = new Date()): Promise<string[]> {
    const fired: string[] = [];
    for (const job of await this.readJobTips()) {
      if (!job.enabled) continue;
      if (!cronMatches(job.schedule, now)) continue;

      const intent = runScopeIntent(job.name, now);
      const { rows } = await this.pool.query<{ scope_id: string }>(
        `SELECT scope_id FROM scope_lineage WHERE intent = $1 LIMIT 1`,
        [intent],
      );
      if (rows.length > 0) continue; // already fired this minute (D-4)

      const { scopeId, planHash } = await nestScope(this.pool, intent);
      await occWrite(this.pool, {
        scopeId,
        entityId: randomUUID(),
        predecessorHash: planHash,
        eventType: 'task_spawned',
        payload: {
          task_id: randomUUID(),
          source: 'cron',
          text: job.prompt,
          required_skills: ['message-handler'],
          cron_job: job.name,
          deliver: job.deliver,
          ...(job.origin !== undefined ? { origin: job.origin } : {}),
        },
      });
      fired.push(job.name);
    }
    return fired;
  }

  /**
   * Deliver results of closed cron runs that lack a delivered marker (D-5).
   * Result text = the last completed task payload's output/text field, else a
   * generic completion notice. Marker is an 'archived' infra event.
   */
  async deliverClosedRuns(): Promise<number> {
    const { rows: closedRuns } = await this.pool.query<{ scope_id: string; intent: string }>(
      `SELECT sl.scope_id, sl.intent
       FROM scope_lineage sl
       WHERE sl.intent LIKE 'cron:%' AND sl.intent != $1 AND sl.status = 'closed'
         AND NOT EXISTS (
           SELECT 1 FROM execution_event_log e
           WHERE e.scope_id = sl.scope_id AND e.payload LIKE '%"kind":"cron::delivered"%'
         )`,
      [CRON_REGISTRY_INTENT],
    );

    let delivered = 0;
    for (const run of closedRuns) {
      const { rows: events } = await this.pool.query<{ payload: string }>(
        `SELECT payload FROM execution_event_log
         WHERE scope_id = $1 AND event_type IN ('task_spawned', 'memory_updated')
         ORDER BY id ASC`,
        [run.scope_id],
      );

      let deliver = 'origin';
      let origin: string | undefined;
      let resultText = '[cron] run completed';
      for (const evt of events) {
        try {
          const payload = JSON.parse(evt.payload) as Record<string, unknown>;
          if (typeof payload['deliver'] === 'string') deliver = payload['deliver'];
          if (typeof payload['origin'] === 'string') origin = payload['origin'];
          const out = payload['output'] ?? payload['text'];
          if (payload['status'] === 'completed' && typeof out === 'string') resultText = out;
        } catch {
          /* skip non-JSON */
        }
      }

      await this.router.deliver({
        deliver,
        text: resultText,
        scope_id: run.scope_id,
        ...(origin !== undefined ? { origin } : {}),
      });
      await writeInfraEvent(
        this.pool,
        run.scope_id,
        'memory_updated',
        canonicalJson({ kind: 'cron::delivered', at: new Date().toISOString() }),
        'archived',
      );
      delivered++;
    }
    return delivered;
  }

  /** Minute loop: tick + deliver. */
  async start(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      try {
        await this.tick();
        await this.deliverClosedRuns();
      } catch {
        /* cron loop must survive transient failures */
      }
      await new Promise((r) => setTimeout(r, 60_000));
    }
  }
}
