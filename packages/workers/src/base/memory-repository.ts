import type { Pool } from 'pg';

interface ProceduralTemplateParams {
  scopeId: string;
  content: string;
  intentDescription: string;
  templateGraph: unknown;
  /** pgvector bracketed literal: '[v1,v2,...]' */
  embeddingLiteral: string;
  /** pgvector bracketed literal or null when embedding provider failed */
  intentEmbeddingLiteral: string | null;
  /** When true, this row is a negative sample (anti-pattern). Default: false. */
  isAntiPattern?: boolean;
  /**
   * Independent-re-derivation count seeded on insert (prevention lever). A fresh
   * crystallization is 0 (unproven); a merge of a re-derived topology carries the
   * prior's corroboration_count + 1. Default 0.
   */
  corroborationCount?: number;
}

interface LessonRecord {
  fingerprintId: string;
  confidence: number;
  content: string;
}

/** Episodic memory tier — records what happened within a Scope. */
interface EpisodicRepository {
  appendEpisodicTrace(scopeId: string, entityId: string, content: string): Promise<void>;
  /**
   * Write an LLM-distilled episodic summary for a completed Scope (D-04).
   * embeddingLiteral null = late projection (ADR 55): row lands with NULL
   * embedding; the caller enqueues an embedding_backlog entry for backfill.
   * Returns the inserted row id so the backlog can target it.
   */
  appendEpisodicSummary(scopeId: string, entityId: string, intentSummary: string, outcomeSummary: string, embeddingLiteral: string | null): Promise<{ id: string }>;
}

/** Semantic memory tier — cross-Scope generalised facts. */
interface SemanticRepository {
  /**
   * embedding null = late projection (ADR 55): the fact is written with NULL
   * embedding (merge/contradiction checks need a vector and are skipped —
   * the backfill pass restores index participation, not retroactive dedup).
   */
  insertSemanticFact(scopeId: string, content: string, embedding: number[] | null): Promise<{ id: string; suggestedMerge: { id: string; content: string } | null }>;
  supersede(oldId: string, newId: string): Promise<void>;
  /**
   * Contradiction-candidate band (Phase 10): similarity 0.70–0.89 — close enough
   * to be about the same thing, not close enough to be a refinement. The caller
   * runs an LLM binary judgement; >0.89 is the suggestedMerge path, <0.70 is unrelated.
   */
  findContradictionCandidate(embedding: number[], excludeId: string): Promise<{ id: string; content: string } | null>;
}

/** Late-projection backlog (ADR 55 D-2, migration 020). */
interface BacklogRepository {
  /**
   * Enqueue a missing embedding for backfill. Idempotent — one pending
   * projection per target cell (ON CONFLICT DO NOTHING).
   */
  enqueueEmbeddingBackfill(
    targetTable: 'semantic_memory' | 'episodic_memory' | 'procedural_memory',
    targetId: string,
    targetColumn: 'embedding' | 'intent_embedding',
    content: string,
  ): Promise<void>;
}

/** Procedural memory tier — positive/negative workflow templates and lessons. */
interface ProceduralRepository {
  /** Returns the inserted row id (embedding backlog targeting, ADR 55). */
  insertProceduralTemplate(params: ProceduralTemplateParams): Promise<{ id: string }>;
  /**
   * Find the current canonical positive template with a near-identical TOPOLOGY
   * (WL cosine > 0.95) to this scope's converged graph, so a repeated run
   * consolidates INTO one canonical runbook instead of accumulating partial
   * duplicates (B1 consolidation, docs/benchmarks/emergence-loop-validation.md §5.5).
   *
   * Topology, not intent-prose embedding, is the merge key: it is computed
   * deterministically from the event DAG, so it does not drift run-to-run the way
   * an LLM-written intent summary does (the first consolidation attempt matched only
   * ~1/3 of repeats and the mixture re-formed). A run that STUMBLED has extra rework
   * events → a different graph → it structurally cannot match (and so cannot poison)
   * the clean canonical. Non-superseded, positive, a different source scope.
   */
  findMergeableTemplate(topologyEmbeddingLiteral: string, excludeScopeId: string): Promise<{ id: string; content: string; corroboration_count: number } | null>;
  /** Logically supersede a positive template by a newer canonical one (append-only: old row kept). */
  supersedeTemplate(oldId: string, newId: string): Promise<void>;
  /**
   * Credit a positive template's `success_count` on converged adoption. `credit`
   * (default 1) is the token-efficiency-graded harden amount (GH #31): a template
   * whose prescribed order let the SIMPLEST cooking win earns more. `recencyAlpha`
   * (N5) discounts recent_quality toward 1 (EWMA, outcome=1) for the late-drift
   * signal; 0 leaves recent_quality untouched (legacy callers).
   */
  reinforceTemplate(templateId: string, credit?: number, recencyAlpha?: number): Promise<void>;
  /** Template ids injected into this scope by mem::reflect (migration 013). */
  getInjectedTemplateIds(scopeId: string): Promise<string[]>;
  /**
   * Templates injected into this scope, WITH their readable lesson content, so the
   * crystallizer can conformance-gate the harden (GH #31 — credit only ingredients
   * the scope actually followed). Join of template_injection × procedural_memory.
   */
  getInjectedTemplates(scopeId: string): Promise<{ id: string; content: string | null }[]>;
  lookupLesson(fingerprintId: string): Promise<LessonRecord | null>;
  reinforceLessonConfidence(fingerprintId: string): Promise<void>;
  insertLesson(fingerprintId: string, content: string): Promise<void>;
  markSupersededByEbbinghaus(): Promise<void>;
  /**
   * Apoptosis (GH #32) — retire crystallizations with STRONG evidence of being
   * bad (Laplace quality_score ≤ qualityBad with evidence volume ≥ nMin), via
   * logical delete (`superseded_by=id`, reversible). Distinct from atrophy
   * (90d-unused time-decay): apoptosis is failure-evidence-driven. Returns the
   * retired rows so the sweep can log them — metabolism must be observable.
   */
  metabolizeByEvidence(bands: { nMin: number; qualityBad: number }): Promise<MetabolismRow[]>;
  /**
   * The ambiguous middle (GH #32) — non-superseded positive templates that are
   * NEITHER proven-good NOR proven-bad (thin evidence, or quality between the
   * bands). Surfaced to human triage with success-rate; never silently decided.
   */
  getMetabolismTriage(bands: { nMin: number; qualityBad: number; qualityGood: number }): Promise<TriageRow[]>;
  /**
   * Human override (GH #32/#34, highest authority) — reinstate a SELF-superseded
   * template (apoptosis/atrophy, `superseded_by=id`). Merge-supersedes
   * (`superseded_by=<other id>`) are left intact so a consolidated duplicate is
   * never resurrected. Returns true if a row was reinstated.
   */
  reinstateTemplate(id: string): Promise<boolean>;
  /**
   * Outcome-streak circuit-breaker (lever 2, GH #30-#35). For the templates a scope
   * recalled: on a CONVERGENT scope reset recall_fail_streak to 0; on a
   * non-convergent scope increment it, and when it reaches `retireAt` (>0) retire
   * the template (superseded_by=id, reversible) so the loop cold-starts. Conformance-
   * INDEPENDENT (covers cooking-caused collapse). retireAt=0 disables retirement
   * (streak still tracked). Returns the ids retired this call.
   */
  registerRecallOutcome(scopeId: string, converged: boolean, retireAt: number): Promise<string[]>;
}

/** A crystallization retired by apoptosis, with the evidence that condemned it. */
export interface MetabolismRow {
  id: string;
  success_count: number;
  failure_count: number;
  quality_score: number;
  /** N5 recency-weighted trust (EWMA) — the signal that actually condemned it. */
  recent_quality: number;
}

/** An ambiguous crystallization surfaced for human triage (GH #32/#34). */
export interface TriageRow {
  id: string;
  content: string | null;
  intent_description: string | null;
  success_count: number;
  failure_count: number;
  quality_score: number;
  injection_count: number;
}

/** Working memory tier — short-lived TTL entries. */
interface WorkingRepository {
  purgeTTLWorkingMemory(): Promise<void>;
}

/** Typed data-access seam for all memory tables. Pool is an implementation detail, not an interface. */
export interface MemoryRepository
  extends EpisodicRepository,
    SemanticRepository,
    ProceduralRepository,
    WorkingRepository,
    BacklogRepository {}

/** Production adapter — all memory-table SQL lives here. */
export class PoolMemoryRepository implements MemoryRepository {
  constructor(private readonly pool: Pool) {}

  async appendEpisodicTrace(scopeId: string, entityId: string, content: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO episodic_memory (scope_id, entity_id, content, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [scopeId, entityId, content],
    );
  }

  async appendEpisodicSummary(
    scopeId: string,
    entityId: string,
    intentSummary: string,
    outcomeSummary: string,
    embeddingLiteral: string | null,
  ): Promise<{ id: string }> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO episodic_memory
         (scope_id, entity_id, content, intent_summary, outcome_summary, embedding, source_scope_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $1, NOW())
       RETURNING id`,
      [scopeId, entityId, intentSummary + '\n' + outcomeSummary, intentSummary, outcomeSummary, embeddingLiteral],
    );
    return { id: rows[0]!.id };
  }

  async insertSemanticFact(
    scopeId: string,
    content: string,
    embedding: number[] | null,
  ): Promise<{ id: string; suggestedMerge: { id: string; content: string } | null }> {
    if (embedding === null) {
      // Late projection (ADR 55): NULL embedding — partial HNSW index skips the
      // row until backfill; merge detection needs a vector, so none is suggested.
      const { rows } = await this.pool.query<{ id: string }>(
        `INSERT INTO semantic_memory (scope_id, content, embedding, source_scope_id, valid_from, created_at)
         VALUES ($1, $2, NULL, $1, NOW(), NOW())
         RETURNING id`,
        [scopeId, content],
      );
      return { id: rows[0]!.id, suggestedMerge: null };
    }
    const embeddingLiteral = '[' + embedding.join(',') + ']';
    const { rows } = await this.pool.query<{
      inserted_id: string;
      similar_id: string | null;
      similar_content: string | null;
    }>(
      `WITH inserted AS (
         INSERT INTO semantic_memory (scope_id, content, embedding, source_scope_id, valid_from, created_at)
         VALUES ($1, $2, $3::vector, $1, NOW(), NOW())
         RETURNING id
       ),
       nearby AS (
         SELECT sm.id, sm.content
         FROM semantic_memory sm
         WHERE sm.superseded_by IS NULL
           AND sm.embedding IS NOT NULL
           AND 1.0 - (sm.embedding <=> $3::vector) > 0.89
         ORDER BY sm.embedding <=> $3::vector ASC
         LIMIT 1
       )
       SELECT i.id AS inserted_id, s.id AS similar_id, s.content AS similar_content
       FROM inserted i LEFT JOIN nearby s ON true`,
      [scopeId, content, embeddingLiteral],
    );
    return {
      id: rows[0].inserted_id,
      suggestedMerge: rows[0].similar_id
        ? { id: rows[0].similar_id, content: rows[0].similar_content! }
        : null,
    };
  }

  async supersede(oldId: string, newId: string): Promise<void> {
    await this.pool.query(
      `UPDATE semantic_memory SET superseded_by = $2 WHERE id = $1`,
      [oldId, newId],
    );
  }

  async findContradictionCandidate(
    embedding: number[],
    excludeId: string,
  ): Promise<{ id: string; content: string } | null> {
    const embeddingLiteral = '[' + embedding.join(',') + ']';
    const { rows } = await this.pool.query<{ id: string; content: string }>(
      `SELECT id, content
       FROM semantic_memory
       WHERE superseded_by IS NULL
         AND id != $2
         AND embedding IS NOT NULL
         AND 1.0 - (embedding <=> $1::vector) BETWEEN 0.70 AND 0.89
       ORDER BY embedding <=> $1::vector ASC
       LIMIT 1`,
      [embeddingLiteral, excludeId],
    );
    return rows.length > 0 ? { id: rows[0]!.id, content: rows[0]!.content } : null;
  }

  async insertProceduralTemplate(params: ProceduralTemplateParams): Promise<{ id: string }> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO procedural_memory
         (scope_id, content, intent_description, template_graph, topology_embedding,
          intent_embedding, success_count, reinforcement_count, last_used_at,
          created_at, is_anti_pattern, source_scope_id, corroboration_count)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 0, NOW(), NOW(), $7, $1, $8)
       RETURNING id`,
      [
        params.scopeId,
        params.content,
        params.intentDescription,
        JSON.stringify(params.templateGraph),
        params.embeddingLiteral,
        params.intentEmbeddingLiteral,
        params.isAntiPattern ?? false,
        params.corroborationCount ?? 0,
      ],
    );
    return { id: rows[0]!.id };
  }

  async enqueueEmbeddingBackfill(
    targetTable: 'semantic_memory' | 'episodic_memory' | 'procedural_memory',
    targetId: string,
    targetColumn: 'embedding' | 'intent_embedding',
    content: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO embedding_backlog (target_table, target_id, target_column, content)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (target_table, target_id, target_column) DO NOTHING`,
      [targetTable, targetId, targetColumn, content],
    );
  }

  async findMergeableTemplate(
    topologyEmbeddingLiteral: string,
    excludeScopeId: string,
  ): Promise<{ id: string; content: string; corroboration_count: number } | null> {
    const { rows } = await this.pool.query<{ id: string; content: string; corroboration_count: number }>(
      `SELECT id, content, corroboration_count
       FROM procedural_memory
       WHERE is_anti_pattern = FALSE
         AND superseded_by IS NULL
         AND topology_embedding IS NOT NULL
         AND source_scope_id IS DISTINCT FROM $2
         AND 1.0 - (topology_embedding <=> $1::vector) > 0.95
       ORDER BY topology_embedding <=> $1::vector ASC
       LIMIT 1`,
      [topologyEmbeddingLiteral, excludeScopeId],
    );
    return rows.length > 0
      ? { id: rows[0]!.id, content: rows[0]!.content, corroboration_count: rows[0]!.corroboration_count }
      : null;
  }

  async supersedeTemplate(oldId: string, newId: string): Promise<void> {
    await this.pool.query(
      `UPDATE procedural_memory SET superseded_by = $2 WHERE id = $1`,
      [oldId, newId],
    );
  }

  async reinforceTemplate(templateId: string, credit = 1, recencyAlpha = 0): Promise<void> {
    // N5: discount recent_quality toward 1 (EWMA, outcome=1). recencyAlpha=0 is a
    // no-op on recent_quality, preserving legacy callers that don't pass it.
    await this.pool.query(
      `UPDATE procedural_memory
       SET success_count = success_count + $2,
           recent_quality = (1.0 - $3) * recent_quality + $3 * 1.0,
           last_used_at = NOW()
       WHERE id = $1`,
      [templateId, Math.max(1, Math.round(credit)), recencyAlpha],
    );
  }

  async getInjectedTemplateIds(scopeId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ template_id: string }>(
      `SELECT template_id FROM template_injection WHERE scope_id = $1`,
      [scopeId],
    );
    return rows.map((r) => r.template_id);
  }

  async getInjectedTemplates(scopeId: string): Promise<{ id: string; content: string | null }[]> {
    const { rows } = await this.pool.query<{ id: string; content: string | null }>(
      `SELECT pm.id, pm.content
       FROM template_injection ti
       JOIN procedural_memory pm ON pm.id = ti.template_id
       WHERE ti.scope_id = $1`,
      [scopeId],
    );
    return rows;
  }

  async lookupLesson(fingerprintId: string): Promise<LessonRecord | null> {
    const { rows } = await this.pool.query<{
      fingerprint_id: string;
      confidence: number;
      content: string;
    }>(
      `SELECT fingerprint_id, confidence, content
       FROM procedural_memory
       WHERE fingerprint_id = $1
       LIMIT 1`,
      [fingerprintId],
    );
    if (rows.length === 0) return null;
    return {
      fingerprintId: rows[0].fingerprint_id,
      confidence: rows[0].confidence,
      content: rows[0].content,
    };
  }

  async reinforceLessonConfidence(fingerprintId: string): Promise<void> {
    await this.pool.query(
      `UPDATE procedural_memory
       SET confidence = LEAST(1.0, confidence + 0.1 * (1 - confidence)),
           reinforcement_count = reinforcement_count + 1
       WHERE fingerprint_id = $1`,
      [fingerprintId],
    );
  }

  async insertLesson(fingerprintId: string, content: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO procedural_memory
         (fingerprint_id, content, confidence, quality_score, reinforcement_count, last_used_at, superseded_by)
       VALUES ($1, $2, 0.5, 0.5, 0, NOW(), NULL)`,
      [fingerprintId, content],
    );
  }

  async markSupersededByEbbinghaus(): Promise<void> {
    await this.pool.query(`
      UPDATE procedural_memory
      SET superseded_by = id
      WHERE reinforcement_count = 0
        AND last_used_at < NOW() - INTERVAL '90 days'
        AND superseded_by IS NULL
    `);
  }

  async metabolizeByEvidence(bands: { nMin: number; qualityBad: number }): Promise<MetabolismRow[]> {
    // N5: the bad-band test is on recent_quality (EWMA), NOT cumulative Laplace, so a
    // once-good template that DRIFTS bad is retired even though its lifetime quality is
    // still high (the late-drift mode N4 exposed). The evidence floor stays on
    // cumulative volume (success+failure ≥ nMin) so a brand-new neutral template
    // (recent_quality=0.5) is never retired before it has a track record. Logical
    // delete (superseded_by=id) → reversible.
    const { rows } = await this.pool.query<MetabolismRow>(
      `UPDATE procedural_memory
       SET superseded_by = id
       WHERE is_anti_pattern = FALSE
         AND superseded_by IS NULL
         AND (success_count + failure_count) >= $1
         AND recent_quality <= $2
       RETURNING id, success_count, failure_count, recent_quality,
                 (((success_count + 1.0) / (success_count + failure_count + 1.0)))::float8 AS quality_score`,
      [bands.nMin, bands.qualityBad],
    );
    return rows;
  }

  async getMetabolismTriage(bands: {
    nMin: number;
    qualityBad: number;
    qualityGood: number;
  }): Promise<TriageRow[]> {
    // Ambiguous = live positive template that is NOT proven-good and NOT
    // proven-bad: thin evidence (volume < nMin) OR quality strictly between the
    // bands. Only templates that were actually used (injection_count > 0) carry a
    // meaningful success-rate, so they alone warrant a human decision.
    const { rows } = await this.pool.query<TriageRow>(
      `SELECT id, content, intent_description, success_count, failure_count,
              (((success_count + 1.0) / (success_count + failure_count + 1.0)))::float8 AS quality_score,
              injection_count
       FROM procedural_memory
       WHERE is_anti_pattern = FALSE
         AND superseded_by IS NULL
         AND injection_count > 0
         AND NOT (
           (success_count + failure_count) >= $1
           AND ((success_count + 1.0) / (success_count + failure_count + 1.0)) <= $2
         )
         AND NOT (
           (success_count + failure_count) >= $1
           AND ((success_count + 1.0) / (success_count + failure_count + 1.0)) >= $3
         )
       ORDER BY ((success_count + 1.0) / (success_count + failure_count + 1.0)) ASC, injection_count DESC`,
      [bands.nMin, bands.qualityBad, bands.qualityGood],
    );
    return rows;
  }

  async reinstateTemplate(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE procedural_memory
       SET superseded_by = NULL, last_used_at = NOW()
       WHERE id = $1 AND superseded_by = id`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  async registerRecallOutcome(scopeId: string, converged: boolean, retireAt: number): Promise<string[]> {
    if (converged) {
      // a convergent recall clears the streak — the ingredient is working
      await this.pool.query(
        `UPDATE procedural_memory SET recall_fail_streak = 0
         WHERE id IN (SELECT template_id FROM template_injection WHERE scope_id = $1)`,
        [scopeId],
      );
      return [];
    }
    // non-convergent: bump the streak for the recalled templates
    await this.pool.query(
      `UPDATE procedural_memory SET recall_fail_streak = recall_fail_streak + 1
       WHERE id IN (SELECT template_id FROM template_injection WHERE scope_id = $1)`,
      [scopeId],
    );
    if (retireAt <= 0) return [];
    // retire (reversible) any whose streak reached the threshold — cold-start escape
    const { rows } = await this.pool.query<{ id: string }>(
      `UPDATE procedural_memory SET superseded_by = id
       WHERE id IN (SELECT template_id FROM template_injection WHERE scope_id = $1)
         AND is_anti_pattern = FALSE AND superseded_by IS NULL
         AND recall_fail_streak >= $2
       RETURNING id`,
      [scopeId, retireAt],
    );
    return rows.map((r) => r.id);
  }

  async purgeTTLWorkingMemory(): Promise<void> {
    await this.pool.query(
      `DELETE FROM working_memory WHERE created_at < NOW() - INTERVAL '24 hours'`,
    );
  }
}

/** In-memory stub for unit tests. Tracks calls; returns configurable results. */
export class StubMemoryRepository implements MemoryRepository {
  readonly calls = {
    appendEpisodicTrace: [] as Array<{ scopeId: string; entityId: string; content: string }>,
    appendEpisodicSummary: [] as Array<{
      scopeId: string;
      entityId: string;
      intentSummary: string;
      outcomeSummary: string;
      embeddingLiteral: string | null;
    }>,
    insertSemanticFact: [] as Array<{ scopeId: string; content: string; embedding: number[] | null }>,
    enqueueEmbeddingBackfill: [] as Array<{
      targetTable: string;
      targetId: string;
      targetColumn: string;
      content: string;
    }>,
    supersede: [] as Array<{ oldId: string; newId: string }>,
    findContradictionCandidate: [] as string[],
    insertProceduralTemplate: [] as ProceduralTemplateParams[],
    findMergeableTemplate: [] as Array<{ topologyEmbeddingLiteral: string; excludeScopeId: string }>,
    supersedeTemplate: [] as Array<{ oldId: string; newId: string }>,
    reinforceTemplate: [] as string[],
    reinforceTemplateGraded: [] as Array<{ templateId: string; credit: number; recencyAlpha: number }>,
    getInjectedTemplateIds: [] as string[],
    getInjectedTemplates: [] as string[],
    lookupLesson: [] as string[],
    reinforceLessonConfidence: [] as string[],
    insertLesson: [] as Array<{ fingerprintId: string; content: string }>,
    markSupersededByEbbinghaus: 0,
    metabolizeByEvidence: [] as Array<{ nMin: number; qualityBad: number }>,
    getMetabolismTriage: [] as Array<{ nMin: number; qualityBad: number; qualityGood: number }>,
    reinstateTemplate: [] as string[],
    registerRecallOutcome: [] as Array<{ scopeId: string; converged: boolean; retireAt: number }>,
    purgeTTLWorkingMemory: 0,
  };

  private _lookupResult: LessonRecord | null = null;
  private _suggestedMergeResult: { id: string; content: string } | null = null;
  private _throwOn: string | null = null;

  setLookupLesson(result: LessonRecord | null): void {
    this._lookupResult = result;
  }

  setSuggestedMergeResult(result: { id: string; content: string } | null): void {
    this._suggestedMergeResult = result;
  }

  throwOn(method: string): void {
    this._throwOn = method;
  }

  private maybeThrow(method: string): void {
    if (this._throwOn === method) {
      this._throwOn = null;
      throw new Error('db error');
    }
  }

  async appendEpisodicTrace(scopeId: string, entityId: string, content: string): Promise<void> {
    this.maybeThrow('appendEpisodicTrace');
    this.calls.appendEpisodicTrace.push({ scopeId, entityId, content });
  }

  async appendEpisodicSummary(
    scopeId: string,
    entityId: string,
    intentSummary: string,
    outcomeSummary: string,
    embeddingLiteral: string | null,
  ): Promise<{ id: string }> {
    this.calls.appendEpisodicSummary.push({ scopeId, entityId, intentSummary, outcomeSummary, embeddingLiteral });
    return { id: 'stub-episodic-id' };
  }

  async insertSemanticFact(
    scopeId: string,
    content: string,
    embedding: number[] | null,
  ): Promise<{ id: string; suggestedMerge: { id: string; content: string } | null }> {
    this.calls.insertSemanticFact.push({ scopeId, content, embedding });
    return { id: 'stub-id', suggestedMerge: embedding === null ? null : this._suggestedMergeResult };
  }

  async enqueueEmbeddingBackfill(
    targetTable: 'semantic_memory' | 'episodic_memory' | 'procedural_memory',
    targetId: string,
    targetColumn: 'embedding' | 'intent_embedding',
    content: string,
  ): Promise<void> {
    this.calls.enqueueEmbeddingBackfill.push({ targetTable, targetId, targetColumn, content });
  }

  async supersede(oldId: string, newId: string): Promise<void> {
    this.calls.supersede.push({ oldId, newId });
  }

  private _contradictionCandidate: { id: string; content: string } | null = null;

  setContradictionCandidate(result: { id: string; content: string } | null): void {
    this._contradictionCandidate = result;
  }

  async findContradictionCandidate(
    _embedding: number[],
    excludeId: string,
  ): Promise<{ id: string; content: string } | null> {
    this.maybeThrow('findContradictionCandidate');
    this.calls.findContradictionCandidate.push(excludeId);
    return this._contradictionCandidate;
  }

  async insertProceduralTemplate(params: ProceduralTemplateParams): Promise<{ id: string }> {
    this.calls.insertProceduralTemplate.push(params);
    return { id: 'stub-procedural-id' };
  }

  private _mergeableTemplate: { id: string; content: string; corroboration_count?: number } | null = null;

  setMergeableTemplate(result: { id: string; content: string; corroboration_count?: number } | null): void {
    this._mergeableTemplate = result;
  }

  async findMergeableTemplate(
    topologyEmbeddingLiteral: string,
    excludeScopeId: string,
  ): Promise<{ id: string; content: string; corroboration_count: number } | null> {
    this.maybeThrow('findMergeableTemplate');
    this.calls.findMergeableTemplate.push({ topologyEmbeddingLiteral, excludeScopeId });
    return this._mergeableTemplate === null
      ? null
      : { ...this._mergeableTemplate, corroboration_count: this._mergeableTemplate.corroboration_count ?? 0 };
  }

  async supersedeTemplate(oldId: string, newId: string): Promise<void> {
    this.calls.supersedeTemplate.push({ oldId, newId });
  }

  async reinforceTemplate(templateId: string, credit = 1, recencyAlpha = 0): Promise<void> {
    this.calls.reinforceTemplate.push(templateId);
    this.calls.reinforceTemplateGraded.push({ templateId, credit, recencyAlpha });
  }

  private _injectedTemplateIds: string[] = [];
  private _injectedTemplates: { id: string; content: string | null }[] = [];

  setInjectedTemplateIds(ids: string[]): void {
    this._injectedTemplateIds = ids;
  }

  /** Set the content-bearing injection set the conformance-gated harden reads (GH #31). */
  setInjectedTemplates(rows: { id: string; content: string | null }[]): void {
    this._injectedTemplates = rows;
  }

  async getInjectedTemplateIds(scopeId: string): Promise<string[]> {
    this.maybeThrow('getInjectedTemplateIds');
    this.calls.getInjectedTemplateIds.push(scopeId);
    return this._injectedTemplateIds;
  }

  async getInjectedTemplates(scopeId: string): Promise<{ id: string; content: string | null }[]> {
    this.maybeThrow('getInjectedTemplates');
    this.calls.getInjectedTemplates.push(scopeId);
    return this._injectedTemplates;
  }

  async lookupLesson(fingerprintId: string): Promise<LessonRecord | null> {
    this.calls.lookupLesson.push(fingerprintId);
    return this._lookupResult;
  }

  async reinforceLessonConfidence(fingerprintId: string): Promise<void> {
    this.calls.reinforceLessonConfidence.push(fingerprintId);
  }

  async insertLesson(fingerprintId: string, content: string): Promise<void> {
    this.calls.insertLesson.push({ fingerprintId, content });
  }

  async markSupersededByEbbinghaus(): Promise<void> {
    this.maybeThrow('markSupersededByEbbinghaus');
    this.calls.markSupersededByEbbinghaus++;
  }

  private _metabolismRows: MetabolismRow[] = [];
  private _triageRows: TriageRow[] = [];

  setMetabolismRows(rows: MetabolismRow[]): void {
    this._metabolismRows = rows;
  }
  setTriageRows(rows: TriageRow[]): void {
    this._triageRows = rows;
  }

  async metabolizeByEvidence(bands: { nMin: number; qualityBad: number }): Promise<MetabolismRow[]> {
    this.maybeThrow('metabolizeByEvidence');
    this.calls.metabolizeByEvidence.push(bands);
    return this._metabolismRows;
  }

  async getMetabolismTriage(bands: {
    nMin: number;
    qualityBad: number;
    qualityGood: number;
  }): Promise<TriageRow[]> {
    this.calls.getMetabolismTriage.push(bands);
    return this._triageRows;
  }

  async reinstateTemplate(id: string): Promise<boolean> {
    this.calls.reinstateTemplate.push(id);
    return true;
  }

  private _recallRetireIds: string[] = [];
  setRecallRetireIds(ids: string[]): void {
    this._recallRetireIds = ids;
  }

  async registerRecallOutcome(scopeId: string, converged: boolean, retireAt: number): Promise<string[]> {
    this.calls.registerRecallOutcome.push({ scopeId, converged, retireAt });
    return converged ? [] : this._recallRetireIds;
  }

  async purgeTTLWorkingMemory(): Promise<void> {
    this.maybeThrow('purgeTTLWorkingMemory');
    this.calls.purgeTTLWorkingMemory++;
  }
}
