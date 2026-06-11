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
import { countTokens } from '@shared/tokenizer';

export interface MemReflectInput {
  query_text: string;
  trigger_type: 'cold_start' | 'conflict_detected' | 'macro_planning';
  w_max: number;
  scope_id: string;
}

export interface MemReflectOutput {
  content: string;
  tokens: number;
  sections: { procedural: string; episodic: string; semantic: string };
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
}

async function hybridSearchEpisodic(
  pool: Pool,
  queryEmbeddingLiteral: string,
  queryText: string,
  limit: number,
): Promise<EpisodicRow[]> {
  const { rows } = await pool.query<EpisodicRow>(
    `WITH
       vector_candidates AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS vector_rank
         FROM episodic_memory
         ORDER BY embedding <=> $1::vector
         LIMIT 20
       ),
       bm25_candidates AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ts_doc, query) DESC) AS bm25_rank
         FROM episodic_memory, plainto_tsquery('english', $2) AS query
         WHERE ts_doc @@ query
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
    [queryEmbeddingLiteral, queryText, limit],
  );
  return rows;
}

async function hybridSearchSemantic(
  pool: Pool,
  queryEmbeddingLiteral: string,
  queryText: string,
  limit: number,
): Promise<SemanticRow[]> {
  const { rows } = await pool.query<SemanticRow>(
    `WITH
       vector_candidates AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS vector_rank
         FROM semantic_memory
         WHERE superseded_by IS NULL
         ORDER BY embedding <=> $1::vector
         LIMIT 20
       ),
       bm25_candidates AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ts_doc, query) DESC) AS bm25_rank
         FROM semantic_memory, plainto_tsquery('english', $2) AS query
         WHERE ts_doc @@ query AND superseded_by IS NULL
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
    [queryEmbeddingLiteral, queryText, limit],
  );
  return rows;
}

async function hybridSearchProcedural(
  pool: Pool,
  queryEmbeddingLiteral: string,
  queryText: string,
  limit: number,
): Promise<ProceduralRow[]> {
  const { rows } = await pool.query<ProceduralRow>(
    `WITH
       vector_candidates AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY intent_embedding <=> $1::vector) AS vector_rank
         FROM procedural_memory
         WHERE is_anti_pattern = FALSE
         ORDER BY intent_embedding <=> $1::vector
         LIMIT 20
       ),
       bm25_candidates AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ts_doc, query) DESC) AS bm25_rank
         FROM procedural_memory, plainto_tsquery('english', $2) AS query
         WHERE ts_doc @@ query AND is_anti_pattern = FALSE
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
     SELECT p.id, p.intent_description, p.template_graph, r.rrf_score
     FROM rrf_scored r
     JOIN procedural_memory p ON r.id = p.id
     ORDER BY r.rrf_score DESC
     LIMIT $3`,
    [queryEmbeddingLiteral, queryText, limit],
  );
  return rows;
}

function formatProcedural(rows: ProceduralRow[], budgetTokens: number): string {
  let remaining = budgetTokens;
  const parts: string[] = [];
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
    parts.push(entry);
    remaining -= entryTokens;
  }
  return parts.join('');
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
 */
export async function memReflect(
  pool: Pool,
  embed: EmbeddingProvider,
  input: MemReflectInput,
): Promise<MemReflectOutput> {
  const budget = computeReflectBudget(input.trigger_type, input.w_max);
  const limit = procLimit(input.trigger_type);

  // LLM CALL — ADR 22 (embedding for query text; not counted against Worker token budget)
  const { vector } = await embed.embed(input.query_text);
  const queryEmbeddingLiteral = '[' + vector.join(',') + ']';

  // Step 1 — Procedural
  const procRows = await hybridSearchProcedural(pool, queryEmbeddingLiteral, input.query_text, limit);
  const procText = formatProcedural(procRows, budget);
  const pTokens = countTokens(procText);

  // Step 2 — Episodic
  const epiRows = await hybridSearchEpisodic(pool, queryEmbeddingLiteral, input.query_text, 5);
  const epiText = formatEpisodic(epiRows, Math.max(0, budget - pTokens));
  const eTokens = countTokens(epiText);

  // Step 3 — Semantic
  const semRows = await hybridSearchSemantic(pool, queryEmbeddingLiteral, input.query_text, 5);
  const semText = formatSemantic(semRows, Math.max(0, budget - pTokens - eTokens));
  const sTokens = countTokens(semText);

  const sections: string[] = [];
  if (procText !== '') sections.push(`## Procedural Memory\n${procText}`);
  if (epiText !== '') sections.push(`## Episodic Memory\n${epiText}`);
  if (semText !== '') sections.push(`## Semantic Memory\n${semText}`);
  const content = sections.join('\n\n');

  return {
    content,
    tokens: pTokens + eTokens + sTokens,
    sections: { procedural: procText, episodic: epiText, semantic: semText },
  };
}
