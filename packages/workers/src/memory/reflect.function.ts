/**
 * mem::reflect — Reflection Track hybrid retrieval (ADR-21, ADR-20 supplement).
 *
 * Pure function implementing the sequential greedy truncation across the three
 * memory tiers (Procedural -> Episodic -> Semantic) within a trigger-type budget.
 * Registered as an iii Function in packages/workers/src/index.ts (D-12).
 *
 * @see docs/adr/0022-adr21-reflection-track-trigger-spec.md — primary spec
 * @see docs/adr/0021-adr20-supplement-hybrid-retrieval-bm25-rrf.md — RRF formula
 */

import type { Pool } from 'pg';
import type { EmbeddingProvider } from '@graph/shared';
import { classifyProviderError } from '@graph/shared';
import { countTokens } from '@shared/tokenizer';
import { logger, LOG_EVENTS } from '@shared/logger';
import type { TemplateStat } from './escalation.js';

export interface MemReflectInput {
  query_text: string;
  trigger_type: 'cold_start' | 'conflict_detected' | 'macro_planning';
  w_max: number;
  scope_id: string;
  /**
   * Requesting principal (ADR-46 D-3). agent-private rows belonging to OTHER
   * principals are NEVER returned — visibility filtering is a security
   * semantic, applied on every retrieval route (HNSW + BM25, all three tiers).
   * Omitted → only shared/global rows are visible.
   */
  principal?: string;
  /**
   * Emergence-loop injection toggle (GH #24). When false, the procedural +
   * anti-pattern tiers are skipped entirely; episodic/semantic retrieval is
   * unchanged. Isolates the Phase 10 trail-discovery loop (template recall →
   * injection → reinforcement) so its causal effect on events-to-convergence
   * can be measured. Default true (production behaviour unchanged).
   */
  inject_procedural?: boolean;
}

/**
 * Visibility predicate fragment (ADR-46 D-3). Single definition — the
 * post-1.0 federated-mesh extension changes exactly this one function.
 * $N is the parameter index that carries the principal.
 */
export function visibilityFilter(paramIndex: number): string {
  return `(COALESCE(visibility, 'global') != 'agent-private' OR owner_principal = $${paramIndex})`;
}

export interface MemReflectOutput {
  content: string;
  tokens: number;
  sections: { procedural: string; antiPatterns: string; episodic: string; semantic: string };
  /**
   * Ids of positive procedural templates whose content made it into the formatted
   * output. The caller records these via recordTemplateInjection (migration 013)
   * so converged scope closure can reinforce them (Phase 10 reinforcement loop).
   */
  proceduralIds: string[];
  /**
   * Per-injected-template freshness, for the mid-flight escalation gate (GH #33):
   * the Laplace quality_score and the evidence volume (success+failure) of each
   * template that made it into the output. The gate reads the SAME evidence
   * signal as the P2 metabolism, at a second read-time (before-act) — a plan that
   * rests on shaky ingredients surfaces a sparse verification report.
   */
  proceduralStats: TemplateStat[];
  /**
   * True when retrieval ran lexical-only (BM25) because the embedding provider
   * was absent or unreachable (ADR 55 D-3). Trail deviation signal — the
   * conversation proceeds either way.
   */
  degraded: boolean;
}

/**
 * Compute the total Reflection Track token budget for a trigger type.
 *
 * - cold_start / macro_planning: min(2000, floor(w_max * 0.3))
 * - conflict_detected: min(1000, floor(w_max * 0.2))
 */
export function computeReflectBudget(triggerType: string, wMax: number): number {
  if (triggerType === 'conflict_detected') {
    return Math.min(1000, Math.floor(wMax * 0.2));
  }
  return Math.min(2000, Math.floor(wMax * 0.3));
}

/** Procedural Memory result LIMIT per trigger type (ADR-21 section 4). */
function procLimit(triggerType: string): number {
  return triggerType === 'conflict_detected' ? 1 : 3;
}

interface EpisodicRow {
  id: string;
  intent_summary: string | null;
  outcome_summary: string | null;
  rrf_score: number;
}

interface SemanticRow {
  id: string;
  content: string;
  rrf_score: number;
}

interface ProceduralRow {
  id: string;
  intent_description: string | null;
  template_graph: unknown;
  rrf_score: number;
  success_count: number;
  failure_count: number;
}

async function hybridSearchEpisodic(
  pool: Pool,
  queryEmbeddingLiteral: string,
  queryText: string,
  limit: number,
  principal: string,
): Promise<EpisodicRow[]> {
  const { rows } = await pool.query<EpisodicRow>(
    `WITH
       vector_candidates AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS vector_rank
         FROM episodic_memory
         WHERE ${visibilityFilter(4)}
         ORDER BY embedding <=> $1::vector
         LIMIT 20
       ),
       bm25_candidates AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ts_doc, query) DESC) AS bm25_rank
         FROM episodic_memory, plainto_tsquery('english', $2) AS query
         WHERE ts_doc @@ query AND ${visibilityFilter(4)}
         LIMIT 20
       ),
       all_candidates AS (
         SELECT id FROM vector_candidates
         UNION
         SELECT id FROM bm25_candidates
       ),
       rrf_scored AS (
         SELECT
           ac.id,
           0.6 * (1.0 / (60 + COALESCE(vc.vector_rank, 21))) +
           0.4 * (1.0 / (60 + COALESCE(bc.bm25_rank,   21))) AS rrf_score
         FROM all_candidates ac
         LEFT JOIN vector_candidates vc ON ac.id = vc.id
         LEFT JOIN bm25_candidates   bc ON ac.id = bc.id
       )
     SELECT e.id, e.intent_summary, e.outcome_summary, r.rrf_score
     FROM rrf_scored r
     JOIN episodic_memory e ON r.id = e.id
     ORDER BY r.rrf_score DESC
     LIMIT $3`,
    [queryEmbeddingLiteral, queryText, limit, principal],
  );
  return rows;
}

async function hybridSearchSemantic(
  pool: Pool,
  queryEmbeddingLiteral: string,
  queryText: string,
  limit: number,
  principal: string,
): Promise<SemanticRow[]> {
  const { rows } = await pool.query<SemanticRow>(
    `WITH
       vector_candidates AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS vector_rank
         FROM semantic_memory
         WHERE superseded_by IS NULL AND ${visibilityFilter(4)}
         ORDER BY embedding <=> $1::vector
         LIMIT 20
       ),
       bm25_candidates AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ts_doc, query) DESC) AS bm25_rank
         FROM semantic_memory, plainto_tsquery('english', $2) AS query
         WHERE ts_doc @@ query AND superseded_by IS NULL AND ${visibilityFilter(4)}
         LIMIT 20
       ),
       all_candidates AS (
         SELECT id FROM vector_candidates
         UNION
         SELECT id FROM bm25_candidates
       ),
       rrf_scored AS (
         SELECT
           ac.id,
           0.6 * (1.0 / (60 + COALESCE(vc.vector_rank, 21))) +
           0.4 * (1.0 / (60 + COALESCE(bc.bm25_rank,   21))) AS rrf_score
         FROM all_candidates ac
         LEFT JOIN vector_candidates vc ON ac.id = vc.id
         LEFT JOIN bm25_candidates   bc ON ac.id = bc.id
       )
     SELECT s.id, s.content, r.rrf_score
     FROM rrf_scored r
     JOIN semantic_memory s ON r.id = s.id
     ORDER BY r.rrf_score DESC
     LIMIT $3`,
    [queryEmbeddingLiteral, queryText, limit, principal],
  );
  return rows;
}

async function hybridSearchProcedural(
  pool: Pool,
  queryEmbeddingLiteral: string,
  queryText: string,
  limit: number,
  principal: string,
): Promise<ProceduralRow[]> {
  // Three-signal rerank per P0-B decision: rrf_norm×0.6 + quality×0.3 + recency×0.1.
  // rrf_score is normalized against the pool max — raw RRF (~0.01 scale) would be
  // drowned by quality/recency (0..1 scale). See ADR-25 supplement 2 D-5.
  const { rows } = await pool.query<ProceduralRow>(
    `WITH
       vector_candidates AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY intent_embedding <=> $1::vector) AS vector_rank
         FROM procedural_memory
         WHERE is_anti_pattern = FALSE AND superseded_by IS NULL AND ${visibilityFilter(4)}
         ORDER BY intent_embedding <=> $1::vector
         LIMIT 20
       ),
       bm25_candidates AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ts_doc, query) DESC) AS bm25_rank
         FROM procedural_memory, plainto_tsquery('english', $2) AS query
         WHERE ts_doc @@ query AND is_anti_pattern = FALSE AND superseded_by IS NULL AND ${visibilityFilter(4)}
         LIMIT 20
       ),
       all_candidates AS (
         SELECT id FROM vector_candidates
         UNION
         SELECT id FROM bm25_candidates
       ),
       rrf_scored AS (
         SELECT
           ac.id,
           0.6 * (1.0 / (60 + COALESCE(vc.vector_rank, 21))) +
           0.4 * (1.0 / (60 + COALESCE(bc.bm25_rank,   21))) AS rrf_score
         FROM all_candidates ac
         LEFT JOIN vector_candidates vc ON ac.id = vc.id
         LEFT JOIN bm25_candidates   bc ON ac.id = bc.id
       ),
       scored AS (
         SELECT
           p.id, p.intent_description, p.template_graph, r.rrf_score,
           p.success_count, p.failure_count,
           r.rrf_score / NULLIF(MAX(r.rrf_score) OVER (), 0)              AS rrf_norm,
           ((p.success_count::FLOAT + 1.0) /
            (p.success_count + p.failure_count + 1.0))                    AS quality_score,
           GREATEST(0.0, 1.0 - (
             EXTRACT(EPOCH FROM (NOW() - COALESCE(p.last_used_at, NOW()))) / (86400.0 * 30)
           ))                                                             AS recency_score
         FROM rrf_scored r
         JOIN procedural_memory p ON r.id = p.id
       )
     SELECT id, intent_description, template_graph, rrf_score, success_count, failure_count,
            (COALESCE(rrf_norm, 0) * 0.6 + quality_score * 0.3 + recency_score * 0.1) AS final_score
     FROM scored
     ORDER BY final_score DESC
     LIMIT $3`,
    [queryEmbeddingLiteral, queryText, limit, principal],
  );
  return rows;
}

// ── Lexical-only degraded retrieval (ADR 55 D-3) ─────────────────────────────
// When the embedding provider is absent/unreachable, the vector CTE drops out
// and the hybrid RRF degenerates to its BM25 component: 0.4 * 1/(60 + rank).
// Same shape as the hybrid result rows, so formatting/truncation is unchanged.

async function bm25SearchEpisodic(
  pool: Pool,
  queryText: string,
  limit: number,
  principal: string,
): Promise<EpisodicRow[]> {
  const { rows } = await pool.query<EpisodicRow>(
    `SELECT id, intent_summary, outcome_summary,
            0.4 * (1.0 / (60 + ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ts_doc, query) DESC))) AS rrf_score
     FROM episodic_memory, plainto_tsquery('english', $1) AS query
     WHERE ts_doc @@ query AND ${visibilityFilter(3)}
     ORDER BY ts_rank_cd(ts_doc, query) DESC
     LIMIT $2`,
    [queryText, limit, principal],
  );
  return rows;
}

async function bm25SearchSemantic(
  pool: Pool,
  queryText: string,
  limit: number,
  principal: string,
): Promise<SemanticRow[]> {
  const { rows } = await pool.query<SemanticRow>(
    `SELECT id, content,
            0.4 * (1.0 / (60 + ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ts_doc, query) DESC))) AS rrf_score
     FROM semantic_memory, plainto_tsquery('english', $1) AS query
     WHERE ts_doc @@ query AND superseded_by IS NULL AND ${visibilityFilter(3)}
     ORDER BY ts_rank_cd(ts_doc, query) DESC
     LIMIT $2`,
    [queryText, limit, principal],
  );
  return rows;
}

async function bm25SearchProcedural(
  pool: Pool,
  queryText: string,
  limit: number,
  principal: string,
): Promise<ProceduralRow[]> {
  // Three-signal rerank preserved (quality 0.3 + recency 0.1); the rrf_norm
  // component degenerates to BM25-rank normalization.
  const { rows } = await pool.query<ProceduralRow>(
    `WITH bm25_scored AS (
       SELECT p.id, p.intent_description, p.template_graph,
              p.success_count, p.failure_count, p.last_used_at,
              0.4 * (1.0 / (60 + ROW_NUMBER() OVER (ORDER BY ts_rank_cd(p.ts_doc, query) DESC))) AS rrf_score
       FROM procedural_memory p, plainto_tsquery('english', $1) AS query
       WHERE p.ts_doc @@ query AND p.is_anti_pattern = FALSE AND p.superseded_by IS NULL AND ${visibilityFilter(3)}
       LIMIT 20
     ),
     scored AS (
       SELECT id, intent_description, template_graph, rrf_score, success_count, failure_count,
              rrf_score / NULLIF(MAX(rrf_score) OVER (), 0)         AS rrf_norm,
              ((success_count::FLOAT + 1.0) /
               (success_count + failure_count + 1.0))               AS quality_score,
              GREATEST(0.0, 1.0 - (
                EXTRACT(EPOCH FROM (NOW() - COALESCE(last_used_at, NOW()))) / (86400.0 * 30)
              ))                                                    AS recency_score
       FROM bm25_scored
     )
     SELECT id, intent_description, template_graph, rrf_score, success_count, failure_count
     FROM scored
     ORDER BY (COALESCE(rrf_norm, 0) * 0.6 + quality_score * 0.3 + recency_score * 0.1) DESC
     LIMIT $2`,
    [queryText, limit, principal],
  );
  return rows;
}

interface AntiPatternRow {
  id: string;
  intent_description: string | null;
}

/**
 * Anti-pattern retrieval for negative injection ("禁止重蹈的坑").
 * BM25-only: anti-pattern rows have no intent_embedding (TPW writes them
 * embedding-less on the intent axis), so the text route is the relevance signal.
 * Rows with correlation_confidence='low' are excluded — weak failure→fix
 * pairings must not steer the agent (ADR-25 supplement 2 D-1).
 */
async function searchAntiPatterns(
  pool: Pool,
  queryText: string,
  limit: number,
  principal: string,
): Promise<AntiPatternRow[]> {
  const { rows } = await pool.query<AntiPatternRow>(
    `SELECT id, intent_description
     FROM procedural_memory, plainto_tsquery('english', $1) AS query
     WHERE is_anti_pattern = TRUE
       AND ts_doc @@ query
       AND COALESCE(template_graph->>'correlation_confidence', 'high') <> 'low'
       AND ${visibilityFilter(3)}
     ORDER BY ts_rank_cd(ts_doc, query) DESC
     LIMIT $2`,
    [queryText, limit, principal],
  );
  return rows;
}

function formatProcedural(
  rows: ProceduralRow[],
  budgetTokens: number,
): { text: string; ids: string[] } {
  let remaining = budgetTokens;
  const parts: string[] = [];
  const ids: string[] = [];
  for (const row of rows) {
    if (remaining <= 0) break;
    const fullEntry = `## Procedural Pattern\nIntent: ${row.intent_description ?? ''}\n${JSON.stringify(row.template_graph)}`;
    const fullTokens = countTokens(fullEntry);
    let entry: string;
    let entryTokens: number;
    if (fullTokens > budgetTokens * 0.6) {
      entry = `## Procedural Pattern\nIntent: ${row.intent_description ?? ''}\n`;
      entryTokens = countTokens(entry);
    } else {
      entry = fullEntry;
      entryTokens = fullTokens;
    }
    if (entryTokens > remaining && parts.length > 0) break;
    parts.push(entry);
    ids.push(row.id);
    remaining -= entryTokens;
  }
  return { text: parts.join(''), ids };
}

function formatAntiPatterns(rows: AntiPatternRow[], budgetTokens: number): string {
  let remaining = budgetTokens;
  const parts: string[] = [];
  for (const row of rows) {
    const line = `- ${row.intent_description ?? ''}`;
    const lineTokens = countTokens(line);
    if (lineTokens > remaining) break;
    parts.push(line);
    remaining -= lineTokens;
  }
  return parts.join('\n');
}

function formatEpisodic(rows: EpisodicRow[], budgetTokens: number): string {
  let remaining = budgetTokens;
  const parts: string[] = [];
  for (const row of rows) {
    const line = `- ${row.intent_summary ?? ''}: ${row.outcome_summary ?? ''}`;
    const lineTokens = countTokens(line);
    if (lineTokens > remaining) break;
    parts.push(line);
    remaining -= lineTokens;
  }
  return parts.join('\n');
}

function formatSemantic(rows: SemanticRow[], budgetTokens: number): string {
  let remaining = budgetTokens;
  const parts: string[] = [];
  for (const row of rows) {
    const line = `- ${row.content}`;
    const lineTokens = countTokens(line);
    if (lineTokens > remaining) break;
    parts.push(line);
    remaining -= lineTokens;
  }
  return parts.join('\n');
}

/**
 * Hybrid-retrieve and sequentially truncate across the three memory tiers
 * (Procedural -> Episodic -> Semantic) within the trigger-type token budget.
 *
 * ADR 55: `embed` is nullable, and embedding failures NEVER propagate — both
 * cases degrade to lexical-only retrieval (degraded:true in the output).
 * 降级 = 替补顶上，而非弃守: the retrieval line is held by BM25; the index
 * self-heals later via the embedding backlog.
 */
export async function memReflect(
  pool: Pool,
  embed: EmbeddingProvider | null,
  input: MemReflectInput,
): Promise<MemReflectOutput> {
  const budget = computeReflectBudget(input.trigger_type, input.w_max);
  const limit = procLimit(input.trigger_type);

  let queryEmbeddingLiteral: string | null = null;
  if (embed !== null) {
    try {
      // LLM CALL — ADR 22 (embedding for query text; not counted against Worker token budget)
      const { vector } = await embed.embed(input.query_text);
      queryEmbeddingLiteral = '[' + vector.join(',') + ']';
    } catch (err) {
      // Environment fault taxonomy (ADR 55 D-1): an unreachable embedding
      // endpoint is never a reason to fail the turn.
      logger.child({ component: 'mem-reflect', scope_id: input.scope_id }).warn(
        { reason: classifyProviderError(err).reason },
        LOG_EVENTS.REFLECT_DEGRADED,
      );
    }
  }
  const degraded = queryEmbeddingLiteral === null;

  // Visibility principal (ADR-46 D-3): '' matches no owner_principal, so an
  // anonymous request sees only shared/global rows.
  const principal = input.principal ?? '';

  // Steps 1 + 1b — Procedural tier (positive templates + anti-patterns). This
  // is the emergence-loop injection surface; the GH #24 toggle gates exactly
  // these two steps, leaving episodic/semantic (steps 2–3) untouched.
  const injectProcedural = input.inject_procedural ?? true;

  // Step 1 — Procedural (positive templates, three-signal rerank)
  let procText = '';
  let proceduralIds: string[] = [];
  let proceduralStats: TemplateStat[] = [];
  if (injectProcedural) {
    const procRows = degraded
      ? await bm25SearchProcedural(pool, input.query_text, limit, principal)
      : await hybridSearchProcedural(pool, queryEmbeddingLiteral!, input.query_text, limit, principal);
    ({ text: procText, ids: proceduralIds } = formatProcedural(procRows, budget));
    // Per-template freshness for the mid-flight gate (GH #33): only the templates
    // that actually made it into the output (proceduralIds), in that order.
    const byId = new Map(procRows.map((r) => [r.id, r]));
    proceduralStats = proceduralIds.map((id) => {
      const r = byId.get(id)!;
      const evidence = r.success_count + r.failure_count;
      return {
        id,
        quality_score: (r.success_count + 1) / (evidence + 1), // Laplace
        evidence,
        intent_description: r.intent_description,
      };
    });
  }
  const pTokens = countTokens(procText);

  // Step 1b — Anti-patterns (negative injection, Phase 10): slotted directly after
  // positive procedural in the truncation order — both are procedural-tier content.
  // (Already BM25-only by design — anti-pattern rows carry no intent_embedding.)
  let antiText = '';
  if (injectProcedural) {
    const antiRows = await searchAntiPatterns(pool, input.query_text, 2, principal);
    antiText = formatAntiPatterns(antiRows, Math.max(0, budget - pTokens));
  }
  const aTokens = countTokens(antiText);

  // Step 2 — Episodic
  const epiRows = degraded
    ? await bm25SearchEpisodic(pool, input.query_text, 5, principal)
    : await hybridSearchEpisodic(pool, queryEmbeddingLiteral!, input.query_text, 5, principal);
  const epiText = formatEpisodic(epiRows, Math.max(0, budget - pTokens - aTokens));
  const eTokens = countTokens(epiText);

  // Step 3 — Semantic
  const semRows = degraded
    ? await bm25SearchSemantic(pool, input.query_text, 5, principal)
    : await hybridSearchSemantic(pool, queryEmbeddingLiteral!, input.query_text, 5, principal);
  const semText = formatSemantic(semRows, Math.max(0, budget - pTokens - aTokens - eTokens));
  const sTokens = countTokens(semText);

  const sections: string[] = [];
  if (procText !== '') sections.push(`## Procedural Memory\n${procText}`);
  if (antiText !== '') sections.push(`## Anti-Patterns (do not repeat)\n${antiText}`);
  if (epiText !== '') sections.push(`## Episodic Memory\n${epiText}`);
  if (semText !== '') sections.push(`## Semantic Memory\n${semText}`);
  const content = sections.join('\n\n');

  return {
    content,
    tokens: pTokens + aTokens + eTokens + sTokens,
    sections: { procedural: procText, antiPatterns: antiText, episodic: epiText, semantic: semText },
    proceduralIds,
    proceduralStats,
    degraded,
  };
}
