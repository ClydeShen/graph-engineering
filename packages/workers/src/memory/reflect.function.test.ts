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
});
