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
}

interface LessonRecord {
  fingerprintId: string;
  confidence: number;
  content: string;
}

/** Episodic memory tier — records what happened within a Scope. */
interface EpisodicRepository {
  appendEpisodicTrace(scopeId: string, entityId: string, content: string): Promise<void>;
  /** Write an LLM-distilled episodic summary for a completed Scope (D-04). */
  appendEpisodicSummary(scopeId: string, entityId: string, intentSummary: string, outcomeSummary: string, embeddingLiteral: string): Promise<void>;
}

/** Semantic memory tier — cross-Scope generalised facts. */
interface SemanticRepository {
  insertSemanticFact(scopeId: string, content: string, embedding: number[]): Promise<{ id: string; suggestedMerge: { id: string; content: string } | null }>;
  supersede(oldId: string, newId: string): Promise<void>;
}

/** Procedural memory tier — positive/negative workflow templates and lessons. */
interface ProceduralRepository {
  insertProceduralTemplate(params: ProceduralTemplateParams): Promise<void>;
  reinforceTemplate(templateId: string): Promise<void>;
  /** Template ids injected into this scope by mem::reflect (migration 013). */
  getInjectedTemplateIds(scopeId: string): Promise<string[]>;
  lookupLesson(fingerprintId: string): Promise<LessonRecord | null>;
  reinforceLessonConfidence(fingerprintId: string): Promise<void>;
  insertLesson(fingerprintId: string, content: string): Promise<void>;
  markSupersededByEbbinghaus(): Promise<void>;
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
    WorkingRepository {}

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
    embeddingLiteral: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO episodic_memory
         (scope_id, entity_id, content, intent_summary, outcome_summary, embedding, source_scope_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $1, NOW())`,
      [scopeId, entityId, intentSummary + '\n' + outcomeSummary, intentSummary, outcomeSummary, embeddingLiteral],
    );
  }

  async insertSemanticFact(
    scopeId: string,
    content: string,
    embedding: number[],
  ): Promise<{ id: string; suggestedMerge: { id: string; content: string } | null }> {
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
       similar AS (
         SELECT sm.id, sm.content
         FROM semantic_memory sm
         WHERE sm.superseded_by IS NULL
           AND sm.embedding IS NOT NULL
           AND 1.0 - (sm.embedding <=> $3::vector) > 0.89
         ORDER BY sm.embedding <=> $3::vector ASC
         LIMIT 1
       )
       SELECT i.id AS inserted_id, s.id AS similar_id, s.content AS similar_content
       FROM inserted i LEFT JOIN similar s ON true`,
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

  async insertProceduralTemplate(params: ProceduralTemplateParams): Promise<void> {
    await this.pool.query(
      `INSERT INTO procedural_memory
         (scope_id, content, intent_description, template_graph, topology_embedding,
          intent_embedding, success_count, reinforcement_count, last_used_at,
          created_at, is_anti_pattern, source_scope_id)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 0, NOW(), NOW(), $7, $1)`,
      [
        params.scopeId,
        params.content,
        params.intentDescription,
        JSON.stringify(params.templateGraph),
        params.embeddingLiteral,
        params.intentEmbeddingLiteral,
        params.isAntiPattern ?? false,
      ],
    );
  }

  async reinforceTemplate(templateId: string): Promise<void> {
    await this.pool.query(
      `UPDATE procedural_memory
       SET success_count = success_count + 1,
           last_used_at = NOW()
       WHERE id = $1`,
      [templateId],
    );
  }

  async getInjectedTemplateIds(scopeId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ template_id: string }>(
      `SELECT template_id FROM template_injection WHERE scope_id = $1`,
      [scopeId],
    );
    return rows.map((r) => r.template_id);
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
      embeddingLiteral: string;
    }>,
    insertSemanticFact: [] as Array<{ scopeId: string; content: string; embedding: number[] }>,
    supersede: [] as Array<{ oldId: string; newId: string }>,
    insertProceduralTemplate: [] as ProceduralTemplateParams[],
    reinforceTemplate: [] as string[],
    getInjectedTemplateIds: [] as string[],
    lookupLesson: [] as string[],
    reinforceLessonConfidence: [] as string[],
    insertLesson: [] as Array<{ fingerprintId: string; content: string }>,
    markSupersededByEbbinghaus: 0,
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
    embeddingLiteral: string,
  ): Promise<void> {
    this.calls.appendEpisodicSummary.push({ scopeId, entityId, intentSummary, outcomeSummary, embeddingLiteral });
  }

  async insertSemanticFact(
    scopeId: string,
    content: string,
    embedding: number[],
  ): Promise<{ id: string; suggestedMerge: { id: string; content: string } | null }> {
    this.calls.insertSemanticFact.push({ scopeId, content, embedding });
    return { id: 'stub-id', suggestedMerge: this._suggestedMergeResult };
  }

  async supersede(oldId: string, newId: string): Promise<void> {
    this.calls.supersede.push({ oldId, newId });
  }

  async insertProceduralTemplate(params: ProceduralTemplateParams): Promise<void> {
    this.calls.insertProceduralTemplate.push(params);
  }

  async reinforceTemplate(templateId: string): Promise<void> {
    this.calls.reinforceTemplate.push(templateId);
  }

  private _injectedTemplateIds: string[] = [];

  setInjectedTemplateIds(ids: string[]): void {
    this._injectedTemplateIds = ids;
  }

  async getInjectedTemplateIds(scopeId: string): Promise<string[]> {
    this.maybeThrow('getInjectedTemplateIds');
    this.calls.getInjectedTemplateIds.push(scopeId);
    return this._injectedTemplateIds;
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

  async purgeTTLWorkingMemory(): Promise<void> {
    this.maybeThrow('purgeTTLWorkingMemory');
    this.calls.purgeTTLWorkingMemory++;
  }
}
