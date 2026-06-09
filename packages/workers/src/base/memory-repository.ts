import type { Pool } from 'pg';

export interface ProceduralTemplateParams {
  scopeId: string;
  content: string;
  intentDescription: string;
  templateGraph: unknown;
  /** pgvector bracketed literal: '[v1,v2,...]' */
  embeddingLiteral: string;
  /** pgvector bracketed literal or null when embedding provider failed */
  intentEmbeddingLiteral: string | null;
}

export interface LessonRecord {
  fingerprintId: string;
  confidence: number;
  content: string;
}

/** Typed data-access seam for all memory tables. Pool is an implementation detail, not an interface. */
export interface MemoryRepository {
  appendEpisodicTrace(scopeId: string, entityId: string, content: string): Promise<void>;
  insertSemanticFact(scopeId: string, content: string): Promise<void>;
  insertProceduralTemplate(params: ProceduralTemplateParams): Promise<void>;
  reinforceTemplate(templateId: string): Promise<void>;
  lookupLesson(fingerprintId: string): Promise<LessonRecord | null>;
  reinforceLessonConfidence(fingerprintId: string): Promise<void>;
  insertLesson(fingerprintId: string, content: string): Promise<void>;
  markSupersededByEbbinghaus(): Promise<void>;
  purgeTTLWorkingMemory(): Promise<void>;
}

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

  async insertSemanticFact(scopeId: string, content: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO semantic_memory (scope_id, content, valid_from, created_at)
       VALUES ($1, $2, NOW(), NOW())`,
      [scopeId, content],
    );
  }

  async insertProceduralTemplate(params: ProceduralTemplateParams): Promise<void> {
    await this.pool.query(
      `INSERT INTO procedural_memory
         (scope_id, content, intent_description, template_graph, topology_embedding,
          intent_embedding, success_count, reinforcement_count, last_used_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 0, NOW(), NOW())`,
      [
        params.scopeId,
        params.content,
        params.intentDescription,
        JSON.stringify(params.templateGraph),
        params.embeddingLiteral,
        params.intentEmbeddingLiteral,
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
    insertSemanticFact: [] as Array<{ scopeId: string; content: string }>,
    insertProceduralTemplate: [] as ProceduralTemplateParams[],
    reinforceTemplate: [] as string[],
    lookupLesson: [] as string[],
    reinforceLessonConfidence: [] as string[],
    insertLesson: [] as Array<{ fingerprintId: string; content: string }>,
    markSupersededByEbbinghaus: 0,
    purgeTTLWorkingMemory: 0,
  };

  private _lookupResult: LessonRecord | null = null;
  private _throwOn: string | null = null;

  setLookupLesson(result: LessonRecord | null): void {
    this._lookupResult = result;
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

  async insertSemanticFact(scopeId: string, content: string): Promise<void> {
    this.calls.insertSemanticFact.push({ scopeId, content });
  }

  async insertProceduralTemplate(params: ProceduralTemplateParams): Promise<void> {
    this.calls.insertProceduralTemplate.push(params);
  }

  async reinforceTemplate(templateId: string): Promise<void> {
    this.calls.reinforceTemplate.push(templateId);
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
