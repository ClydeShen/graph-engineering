import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import type { EmbeddingProvider } from '@graph/shared';
import { memReflect, computeReflectBudget } from './reflect.function.js';

function makePool(queryImpl?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>): Pool {
  return {
    query: vi.fn(queryImpl ?? (() => Promise.resolve({ rows: [] }))),
  } as unknown as Pool;
}

function makeEmbed(): EmbeddingProvider & { embed: ReturnType<typeof vi.fn> } {
  return {
    embed: vi.fn().mockResolvedValue({ vector: Array(1536).fill(0.1), countedAgainstBudget: false as const }),
  };
}

describe('computeReflectBudget', () => {
  it('cold_start budget = min(2000, floor(wMax * 0.3))', () => {
    expect(computeReflectBudget('cold_start', 5000)).toBe(1500);
    expect(computeReflectBudget('cold_start', 3000)).toBe(900);
    expect(computeReflectBudget('cold_start', 10000)).toBe(2000); // capped
  });

  it('conflict_detected budget = min(1000, floor(wMax * 0.2))', () => {
    expect(computeReflectBudget('conflict_detected', 3000)).toBe(600);
    expect(computeReflectBudget('conflict_detected', 10000)).toBe(1000); // capped
  });
});

describe('memReflect', () => {
  it('returns empty sections when all three tiers return no rows', async () => {
    const pool = makePool();
    const embed = makeEmbed();

    const result = await memReflect(pool, embed, {
      query_text: 'test',
      trigger_type: 'cold_start',
      w_max: 5000,
      scope_id: 'scope-1',
    });

    expect(result.tokens).toBe(0);
    expect(result.sections.procedural).toBe('');
    expect(result.sections.episodic).toBe('');
    expect(result.sections.semantic).toBe('');
    expect(result.content).toBe('');
    expect(embed.embed).toHaveBeenCalledWith('test');
  });

  it('budget exhaustion: large procedural section consumes full budget, episodic/semantic get nothing', async () => {
    const pool = makePool((sql) => {
      if (sql.includes('is_anti_pattern = TRUE')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('procedural_memory')) {
        return Promise.resolve({
          rows: [
            {
              id: 'p1',
              intent_description: 'a'.repeat(3000),
              template_graph: null,
              rrf_score: 0.9,
            },
          ],
        });
      }
      if (sql.includes('episodic_memory')) {
        return Promise.resolve({
          rows: [
            { id: 'e1', intent_summary: 'did thing one', outcome_summary: 'succeeded', rrf_score: 0.8 },
            { id: 'e2', intent_summary: 'did thing two', outcome_summary: 'succeeded', rrf_score: 0.7 },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const embed = makeEmbed();

    // wMax = 1000 -> budget = min(2000, floor(1000*0.3)) = 300
    const result = await memReflect(pool, embed, {
      query_text: 'test',
      trigger_type: 'cold_start',
      w_max: 1000,
      scope_id: 'scope-1',
    });

    // Procedural section (3000 chars) exceeds the 300-token budget -> consumes it all.
    expect(result.sections.episodic).toBe('');
    expect(result.sections.semantic).toBe('');
  });

  it('calls embed.embed exactly once with query_text (not repeated per tier)', async () => {
    const pool = makePool();
    const embed = makeEmbed();

    await memReflect(pool, embed, {
      query_text: 'unique-query-text',
      trigger_type: 'cold_start',
      w_max: 5000,
      scope_id: 'scope-1',
    });

    expect(embed.embed).toHaveBeenCalledTimes(1);
    expect(embed.embed).toHaveBeenCalledWith('unique-query-text');
  });

  // ── Phase 10: anti-pattern injection + proceduralIds ───────────────────────

  it('includes an Anti-Patterns section and returns proceduralIds of injected templates', async () => {
    const pool = makePool((sql) => {
      if (sql.includes('is_anti_pattern = TRUE')) {
        return Promise.resolve({
          rows: [{ id: 'neg-1', intent_description: 'Orphan node — entity X dead-ended' }],
        });
      }
      if (sql.includes('procedural_memory')) {
        return Promise.resolve({
          rows: [{ id: 'pos-1', intent_description: 'golden path', template_graph: { version: 1 }, rrf_score: 0.9 }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const embed = makeEmbed();

    const result = await memReflect(pool, embed, {
      query_text: 'test',
      trigger_type: 'cold_start',
      w_max: 5000,
      scope_id: 'scope-1',
    });

    expect(result.proceduralIds).toEqual(['pos-1']);
    expect(result.sections.antiPatterns).toContain('dead-ended');
    expect(result.content).toContain('## Anti-Patterns (do not repeat)');
    expect(result.content).toContain('## Procedural Memory');
  });

  // ── GH #24: emergence-loop injection toggle ────────────────────────────────

  it('inject_procedural:false skips procedural + anti tiers but keeps episodic/semantic', async () => {
    const captured: string[] = [];
    const pool = makePool((sql) => {
      captured.push(sql);
      // These rows WOULD be injected if the procedural tier ran — assert it does not.
      if (sql.includes('is_anti_pattern = TRUE')) {
        return Promise.resolve({ rows: [{ id: 'neg-1', intent_description: 'should be skipped' }] });
      }
      if (sql.includes('procedural_memory')) {
        return Promise.resolve({
          rows: [{ id: 'pos-1', intent_description: 'should be skipped', template_graph: { version: 1 }, rrf_score: 0.9 }],
        });
      }
      if (sql.includes('episodic_memory')) {
        return Promise.resolve({
          rows: [{ id: 'e1', intent_summary: 'kept', outcome_summary: 'still here', rrf_score: 0.8 }],
        });
      }
      if (sql.includes('semantic_memory')) {
        return Promise.resolve({ rows: [{ id: 's1', content: 'semantic kept', rrf_score: 0.7 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const embed = makeEmbed();

    const result = await memReflect(pool, embed, {
      query_text: 'test',
      trigger_type: 'cold_start',
      w_max: 5000,
      scope_id: 'scope-1',
      inject_procedural: false,
    });

    // Procedural tier fully suppressed — no injection, no proceduralIds.
    expect(result.sections.procedural).toBe('');
    expect(result.sections.antiPatterns).toBe('');
    expect(result.proceduralIds).toEqual([]);
    expect(result.content).not.toContain('## Procedural Memory');
    expect(result.content).not.toContain('## Anti-Patterns');
    // Episodic/semantic retrieval unchanged.
    expect(result.content).toContain('kept');
    expect(result.content).toContain('semantic kept');
    // The procedural + anti SQL must never have been issued.
    expect(captured.some((s) => s.includes('procedural_memory'))).toBe(false);
    expect(captured.some((s) => s.includes('is_anti_pattern = TRUE'))).toBe(false);
  });

  it('inject_procedural defaults to true (procedural tier runs when omitted)', async () => {
    const captured: string[] = [];
    const pool = makePool((sql) => {
      captured.push(sql);
      return Promise.resolve({ rows: [] });
    });
    const embed = makeEmbed();

    await memReflect(pool, embed, {
      query_text: 'test',
      trigger_type: 'cold_start',
      w_max: 5000,
      scope_id: 'scope-1',
    });

    expect(captured.some((s) => s.includes('procedural_memory'))).toBe(true);
  });

  it('anti-pattern query filters correlation_confidence=low and uses BM25 only', async () => {
    const captured: string[] = [];
    const pool = makePool((sql) => {
      captured.push(sql);
      return Promise.resolve({ rows: [] });
    });
    const embed = makeEmbed();

    await memReflect(pool, embed, {
      query_text: 'test',
      trigger_type: 'cold_start',
      w_max: 5000,
      scope_id: 'scope-1',
    });

    const antiSql = captured.find((s) => s.includes('is_anti_pattern = TRUE'));
    expect(antiSql).toBeDefined();
    expect(antiSql).toContain(`correlation_confidence', 'high') <> 'low'`);
    expect(antiSql).not.toContain('intent_embedding'); // BM25-only route
  });

  it('positive procedural query applies the three-signal rerank (P0-B)', async () => {
    const captured: string[] = [];
    const pool = makePool((sql) => {
      captured.push(sql);
      return Promise.resolve({ rows: [] });
    });
    const embed = makeEmbed();

    await memReflect(pool, embed, {
      query_text: 'test',
      trigger_type: 'cold_start',
      w_max: 5000,
      scope_id: 'scope-1',
    });

    const posSql = captured.find((s) => s.includes('is_anti_pattern = FALSE') && s.includes('final_score'));
    expect(posSql).toBeDefined();
    expect(posSql).toContain('* 0.6');
    expect(posSql).toContain('quality_score * 0.3');
    expect(posSql).toContain('recency_score * 0.1');
  });

  it('empty result has empty proceduralIds and no anti-pattern section', async () => {
    const result = await memReflect(makePool(), makeEmbed(), {
      query_text: 'test',
      trigger_type: 'cold_start',
      w_max: 5000,
      scope_id: 'scope-1',
    });
    expect(result.proceduralIds).toEqual([]);
    expect(result.sections.antiPatterns).toBe('');
  });

  // ── Phase 13 (ADR-46 D-3): visibility enforcement — security red line ─────

  it('EVERY retrieval route (HNSW + BM25, all tiers + anti-patterns) carries the visibility filter', async () => {
    const captured: Array<{ sql: string; params: unknown[] }> = [];
    const pool = makePool((sql, params) => {
      captured.push({ sql, params: params ?? [] });
      return Promise.resolve({ rows: [] });
    });

    await memReflect(pool, makeEmbed(), {
      query_text: 'test',
      trigger_type: 'cold_start',
      w_max: 5000,
      scope_id: 'scope-1',
      principal: 'agent:alpha',
    });

    // every memory query must contain the agent-private guard and bind the principal
    const memoryQueries = captured.filter((c) => /episodic_memory|semantic_memory|procedural_memory/.test(c.sql));
    expect(memoryQueries.length).toBeGreaterThanOrEqual(4);
    for (const q of memoryQueries) {
      expect(q.sql).toContain(`!= 'agent-private' OR owner_principal =`);
      expect(q.params).toContain('agent:alpha');
    }
  });

  it('omitted principal binds the empty string — private rows of ANY owner are unreachable', async () => {
    const captured: Array<{ params: unknown[] }> = [];
    const pool = makePool((sql, params) => {
      captured.push({ params: params ?? [] });
      return Promise.resolve({ rows: [] });
    });

    await memReflect(pool, makeEmbed(), {
      query_text: 'test',
      trigger_type: 'cold_start',
      w_max: 5000,
      scope_id: 'scope-1',
    });

    for (const q of captured.filter((c) => c.params.length >= 3)) {
      expect(q.params).toContain('');
    }
  });
});

describe('memReflect degraded mode (ADR 55 D-3)', () => {
  it('null embed provider → lexical-only retrieval, degraded:true, turn succeeds', async () => {
    const seen: string[] = [];
    const pool = makePool((sql) => {
      seen.push(sql);
      return Promise.resolve({ rows: [] });
    });

    const result = await memReflect(pool, null, {
      query_text: 'test',
      trigger_type: 'cold_start',
      w_max: 5000,
      scope_id: 'scope-1',
    });

    expect(result.degraded).toBe(true);
    expect(result.content).toBe('');
    // No vector CTE in any issued SQL — pure BM25 path
    expect(seen.every((s) => !s.includes('<=>'))).toBe(true);
  });

  it('embed.embed() rejection degrades instead of failing the turn', async () => {
    const pool = makePool();
    const embed: EmbeddingProvider = {
      embed: vi.fn().mockRejectedValue(new Error('fetch failed')),
    };

    const result = await memReflect(pool, embed, {
      query_text: 'test',
      trigger_type: 'macro_planning',
      w_max: 5000,
      scope_id: 'scope-1',
    });

    expect(result.degraded).toBe(true);
  });

  it('healthy embed provider reports degraded:false', async () => {
    const result = await memReflect(makePool(), makeEmbed(), {
      query_text: 'test',
      trigger_type: 'cold_start',
      w_max: 5000,
      scope_id: 'scope-1',
    });
    expect(result.degraded).toBe(false);
  });
});
