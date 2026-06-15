/**
 * Graph snapshot — the data behind "the graph is the terminal's working memory".
 *
 * Cheap, read-only projections of the scope's trail for the persistent widget and
 * the /graph, /memory overlays. EVERY query is wrapped: a missing migration or
 * empty system yields a safe default, never an exception — the widget must never
 * crash the terminal it lives in. The widget render is synchronous, so callers
 * cache these results and refresh on a timer / turn boundary (never await in
 * render).
 *
 * Sources (all existing): scope_lineage, execution_event_log, approval_request,
 * procedural_memory (crystallized Lessons — same table /v1/emergence reads).
 */

import type { Pool } from 'pg';

export interface GraphSnapshot {
  scopeId: string;
  intent: string | null;
  status: string;
  /** assistant turns (conversation.assistant events, non-erased) */
  turns: number;
  /** total trail depth (all events in the scope) */
  events: number;
  pendingApprovals: number;
  lastLesson: { content: string; confidence: number } | null;
}

export interface LessonRow {
  content: string;
  confidence: number;
  reinforcementCount: number;
}

export interface RecentEvent {
  kind: 'conversation' | 'tool' | 'memory' | 'other';
  label: string;
  text: string;
  at: string;
}

export interface GraphDetail {
  scopeId: string;
  intent: string | null;
  status: string;
  events: number;
  breakdown: { conversation: number; tool: number; memory: number; other: number };
  recent: RecentEvent[];
}

/** Classify an event into a human bucket for the breakdown / recent feed. */
export function classifyEvent(eventType: string, payloadKind: string | null): RecentEvent['kind'] {
  if (payloadKind === 'conversation.user' || payloadKind === 'conversation.assistant') return 'conversation';
  if (eventType === 'memory_updated') return 'memory';
  if (eventType.includes('tool') || eventType.includes('bash') || eventType.includes('task')) return 'tool';
  return 'other';
}

/** First non-empty line of text, collapsed and clamped — for one-line previews. */
export function firstLine(text: string, max = 80): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

/** Compact relative age ("just now", "3m", "2h", "5d"). */
export function relativeAge(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const ms = Math.max(0, now - t);
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

async function safe<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/** Widget-sized snapshot: a few cheap counts + the latest lesson. */
export async function readGraphSnapshot(pool: Pool, scopeId: string): Promise<GraphSnapshot> {
  const lineage = await safe<{ intent: string | null; status: string }>(
    { intent: null, status: 'active' },
    async () => {
      const { rows } = await pool.query<{ intent: string | null; status: string }>(
        'SELECT intent, status FROM scope_lineage WHERE scope_id = $1 LIMIT 1',
        [scopeId],
      );
      return rows[0] ?? { intent: null, status: 'active' };
    },
  );

  const counts = await safe<{ turns: number; events: number }>(
    { turns: 0, events: 0 },
    async () => {
      const { rows } = await pool.query<{ turns: string; events: string }>(
        `SELECT
           count(*) FILTER (
             WHERE event_type = 'memory_updated'
               AND erased_at IS NULL
               AND payload::jsonb->>'kind' = 'conversation.assistant'
           ) AS turns,
           count(*) AS events
         FROM execution_event_log WHERE scope_id = $1`,
        [scopeId],
      );
      return { turns: Number(rows[0]?.turns ?? 0), events: Number(rows[0]?.events ?? 0) };
    },
  );

  const pendingApprovals = await safe<number>(0, async () => {
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM approval_request WHERE scope_id = $1 AND status = 'pending'",
      [scopeId],
    );
    return Number(rows[0]?.n ?? 0);
  });

  const lastLesson = await safe<{ content: string; confidence: number } | null>(null, async () => {
    const { rows } = await pool.query<{ content: string; confidence: number }>(
      `SELECT content, confidence FROM procedural_memory
       WHERE superseded_by IS NULL AND COALESCE(is_anti_pattern, FALSE) = FALSE AND content IS NOT NULL
       ORDER BY last_used_at DESC LIMIT 1`,
    );
    return rows[0] ?? null;
  });

  return { scopeId, intent: lineage.intent, status: lineage.status, ...counts, pendingApprovals, lastLesson };
}

/** /memory overlay: lessons ordered by confidence (mirrors /v1/emergence). */
export async function readLessons(pool: Pool, limit = 50): Promise<LessonRow[]> {
  return safe<LessonRow[]>([], async () => {
    const { rows } = await pool.query<{ content: string; confidence: number; reinforcement_count: number }>(
      `SELECT content, confidence, reinforcement_count FROM procedural_memory
       WHERE superseded_by IS NULL AND COALESCE(is_anti_pattern, FALSE) = FALSE AND content IS NOT NULL
       ORDER BY confidence DESC, last_used_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      content: r.content,
      confidence: r.confidence,
      reinforcementCount: Number(r.reinforcement_count ?? 0),
    }));
  });
}

/** /graph overlay: scope + event breakdown + recent feed (oldest→newest). */
export async function readGraphDetail(pool: Pool, scopeId: string, recentLimit = 30): Promise<GraphDetail> {
  const lineage = await safe<{ intent: string | null; status: string }>(
    { intent: null, status: 'active' },
    async () => {
      const { rows } = await pool.query<{ intent: string | null; status: string }>(
        'SELECT intent, status FROM scope_lineage WHERE scope_id = $1 LIMIT 1',
        [scopeId],
      );
      return rows[0] ?? { intent: null, status: 'active' };
    },
  );

  const rows = await safe<Array<{ event_type: string; payload: string; created_at: string }>>([], async () => {
    const res = await pool.query<{ event_type: string; payload: string; created_at: string }>(
      `SELECT event_type, payload, created_at::text AS created_at
       FROM execution_event_log WHERE scope_id = $1 ORDER BY id DESC LIMIT $2`,
      [scopeId, recentLimit],
    );
    return res.rows;
  });

  const totalEvents = await safe<number>(rows.length, async () => {
    const { rows: r } = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM execution_event_log WHERE scope_id = $1',
      [scopeId],
    );
    return Number(r[0]?.n ?? rows.length);
  });

  const breakdown = { conversation: 0, tool: 0, memory: 0, other: 0 };
  const recent: RecentEvent[] = [];
  for (const row of rows) {
    let kind: string | null = null;
    let text = '';
    try {
      const p = JSON.parse(row.payload) as { kind?: string; text?: string; command?: string };
      kind = p.kind ?? null;
      text = p.text ?? p.command ?? '';
    } catch {
      /* non-JSON payload */
    }
    const bucket = classifyEvent(row.event_type, kind);
    breakdown[bucket]++;
    const label =
      kind === 'conversation.user' ? 'user'
        : kind === 'conversation.assistant' ? 'assistant'
          : bucket;
    recent.push({ kind: bucket, label, text: firstLine(text, 120), at: row.created_at });
  }
  recent.reverse(); // oldest → newest for reading order

  return { scopeId, intent: lineage.intent, status: lineage.status, events: totalEvents, breakdown, recent };
}
