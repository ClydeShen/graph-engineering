import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventWriter, LLMProvider, EmbeddingProvider } from '@graph/shared';
import { StubTrailReader } from '../base/trail-reader.js';
import { StubMemoryRepository } from '../base/memory-repository.js';
import type { EventLogNode } from '@graph/shared';

vi.mock('@graph/shared', () => ({
  writeGuard: vi.fn((s: string) => `[guarded]:${s}`),
  contentFingerprint: vi.fn((s: string) => `fp:${s}`),
}));

import { TemplateProposalWorker, TEMPLATE_PROPOSAL_TRIGGER_CONFIG } from './template-proposal.worker.js';

function makeWriter(): EventWriter & { write: ReturnType<typeof vi.fn> } {
  return {
    write: vi.fn().mockResolvedValue({
      version_hash: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
      event_type: 'memory_updated',
      occ_result: 'won',
    }),
  };
}

/**
 * Shared fixture: two events where first.version_hash === second.predecessor_hash
 * (first entity IS consumed — not an orphan) and second.version_hash is NOT referenced
 * by any predecessor (second entity IS an orphan).
 */
function makeScopeEvents(): EventLogNode[] {
  return [
    {
      id: 'ev-1',
      scope_id: 'scope-1',
      entity_id: 'entity-1',
      event_type: 'task_spawned',
      predecessor_hash: '0'.repeat(64),
      version_hash: 'hash-of-ev1',
      payload: '{}',
      status: 'terminated',
      base_priority: 0,
      unlocks_count: 0,
      spawned_by: null,
      last_active_at: null,
      created_at: new Date(),
    },
    {
      id: 'ev-2',
      scope_id: 'scope-1',
      entity_id: 'entity-2',
      event_type: 'scope_closed',
      predecessor_hash: 'hash-of-ev1', // consumes ev-1 → entity-1 NOT orphan
      version_hash: 'hash-of-ev2',     // nothing consumes this → entity-2 IS orphan
      payload: '{}',
      status: 'terminated',
      base_priority: 0,
      unlocks_count: 0,
      spawned_by: null,
      last_active_at: null,
      created_at: new Date(),
    },
  ];
}

describe('TemplateProposalWorker', () => {
  let reader: StubTrailReader;
  let memory: StubMemoryRepository;
  let writer: ReturnType<typeof makeWriter>;
  let mockChat: ReturnType<typeof vi.fn>;
  let mockEmbed: ReturnType<typeof vi.fn>;
  let llm: LLMProvider;
  let embed: EmbeddingProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChat = vi
      .fn()
      .mockResolvedValue('{"intent_summary":"test intent","outcome_summary":"test outcome"}');
    mockEmbed = vi.fn().mockResolvedValue({
      vector: Array(1536).fill(0.1),
      countedAgainstBudget: false,
    });
    reader = new StubTrailReader();
    memory = new StubMemoryRepository();
    writer = makeWriter();
    llm = { chat: mockChat };
    embed = { embed: mockEmbed };
  });

  it('returns early without any writes when getScopeEvents returns empty array', async () => {
    vi.spyOn(reader, 'getScopeEvents').mockResolvedValue([]);
    const worker = new TemplateProposalWorker(reader, memory, writer, llm, embed);
    await worker.onScopeClosed('scope-empty', 'entity-1', '0'.repeat(64));

    expect(mockChat).not.toHaveBeenCalled();
    expect(memory.calls.appendEpisodicSummary).toHaveLength(0);
    expect(writer.write).not.toHaveBeenCalled();
  });

  it('calls appendEpisodicSummary with writeGuard(intentSummary), writeGuard(outcomeSummary), and an embeddingLiteral', async () => {
    vi.spyOn(reader, 'getScopeEvents').mockResolvedValue(makeScopeEvents());
    const worker = new TemplateProposalWorker(reader, memory, writer, llm, embed);
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    expect(memory.calls.appendEpisodicSummary).toHaveLength(1);
    const call = memory.calls.appendEpisodicSummary[0];
    expect(call).toMatchObject({
      scopeId: 'scope-1',
      entityId: 'entity-1',
      intentSummary: '[guarded]:test intent',
      outcomeSummary: '[guarded]:test outcome',
    });
    expect(call.embeddingLiteral).toMatch(/^\[/);
  });

  it('writes memory_updated event after episodic write (C1 constraint)', async () => {
    vi.spyOn(reader, 'getScopeEvents').mockResolvedValue(makeScopeEvents());
    const worker = new TemplateProposalWorker(reader, memory, writer, llm, embed);
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    const episodicWrite = (writer.write as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => {
        const args = call[0] as { eventType: string; payload: { memory_type: string } };
        return args.eventType === 'memory_updated' && args.payload.memory_type === 'episodic';
      },
    );
    expect(episodicWrite).toBeDefined();
    expect(episodicWrite![0]).toMatchObject({
      eventType: 'memory_updated',
      payload: expect.objectContaining({ memory_type: 'episodic' }),
    });
  });

  it('detects orphan entity_ids and writes them to procedural_memory with isAntiPattern: true', async () => {
    vi.spyOn(reader, 'getScopeEvents').mockResolvedValue(makeScopeEvents());
    const worker = new TemplateProposalWorker(reader, memory, writer, llm, embed);
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    const orphanWrite = memory.calls.insertProceduralTemplate.find(
      (p) => p.isAntiPattern === true,
    );
    expect(orphanWrite).toBeDefined();
    expect(orphanWrite!.isAntiPattern).toBe(true);
    expect(orphanWrite!.intentDescription).toContain('Orphan');
  });

  it('does NOT mark the first entity as orphan when its version_hash is consumed as predecessor', async () => {
    vi.spyOn(reader, 'getScopeEvents').mockResolvedValue(makeScopeEvents());
    const worker = new TemplateProposalWorker(reader, memory, writer, llm, embed);
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    // entity-1's version_hash ('hash-of-ev1') is consumed by ev-2's predecessor_hash
    const entity1Writes = memory.calls.insertProceduralTemplate.filter((p) =>
      p.intentDescription.includes('entity-1'),
    );
    expect(entity1Writes).toHaveLength(0);
  });

  it('TEMPLATE_PROPOSAL_TRIGGER_CONFIG has durable:subscriber type, correct function_id, and topic', () => {
    expect(TEMPLATE_PROPOSAL_TRIGGER_CONFIG.type).toBe('durable:subscriber');
    expect(TEMPLATE_PROPOSAL_TRIGGER_CONFIG.function_id).toBe('graph::memory::template-proposal');
    expect(TEMPLATE_PROPOSAL_TRIGGER_CONFIG.config.topic).toBe('graph::scope::closed');
  });

  // ── Phase 10: positive skeleton extraction ─────────────────────────────────

  it('writes a positive skeleton (isAntiPattern=false) with canonical template_graph on low-conflict scope', async () => {
    vi.spyOn(reader, 'getScopeEvents').mockResolvedValue(makeScopeEvents());
    const worker = new TemplateProposalWorker(reader, memory, writer, llm, embed);
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    const positive = memory.calls.insertProceduralTemplate.find((p) => p.isAntiPattern === false);
    expect(positive).toBeDefined();
    const graph = positive!.templateGraph as {
      version: number;
      abstraction: string;
      nodes: { id: string; label: string }[];
      edges: { from: string; to: string }[];
    };
    expect(graph.version).toBe(1);
    expect(graph.abstraction).toBe('interface-edge');
    expect(graph.nodes.every((n) => /^n\d+$/.test(n.id))).toBe(true);
    // WL topology literal is a 128-dim non-zero vector
    expect(positive!.embeddingLiteral).toMatch(/^\[/);
    expect(positive!.embeddingLiteral).not.toBe('[' + Array(128).fill(0).join(',') + ']');
    // intent embedding reused from the episodic embed call (one embed call, two writes)
    expect(positive!.intentEmbeddingLiteral).toMatch(/^\[/);
    expect(mockEmbed).toHaveBeenCalledTimes(1);
  });

  it('L2: embeds the crystallized lesson into the positive template content (actionable structure)', async () => {
    mockChat.mockResolvedValue(
      '{"intent_summary":"build a service","outcome_summary":"done","lesson":"containerize must be done before run_tests"}',
    );
    vi.spyOn(reader, 'getScopeEvents').mockResolvedValue(makeScopeEvents());
    const worker = new TemplateProposalWorker(reader, memory, writer, llm, embed);
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    const positive = memory.calls.insertProceduralTemplate.find((p) => p.isAntiPattern === false);
    expect(positive).toBeDefined();
    expect(positive!.intentDescription).toContain('Lesson:');
    expect(positive!.intentDescription).toContain('containerize must be done before run_tests');
    expect(positive!.content).toContain('Lesson:');
  });

  it('L2: positive template carries no Lesson line when the LLM omits one', async () => {
    // default mockChat returns no lesson field
    vi.spyOn(reader, 'getScopeEvents').mockResolvedValue(makeScopeEvents());
    const worker = new TemplateProposalWorker(reader, memory, writer, llm, embed);
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    const positive = memory.calls.insertProceduralTemplate.find((p) => p.isAntiPattern === false);
    expect(positive!.intentDescription).not.toContain('Lesson:');
  });

  it('skips positive skeleton when conflicts exceed 10% of scope events', async () => {
    const events = makeScopeEvents();
    // 1 conflict out of 2 events = 50% > 10%
    events[0] = { ...events[0]!, event_type: 'conflict_detected' };
    vi.spyOn(reader, 'getScopeEvents').mockResolvedValue(events);
    const worker = new TemplateProposalWorker(reader, memory, writer, llm, embed);
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    const positive = memory.calls.insertProceduralTemplate.find((p) => p.isAntiPattern === false);
    expect(positive).toBeUndefined();
  });

  // ── B1: template consolidation (crystallization-time merge + supersede) ─────

  it('B1: folds this run into the prior canonical template and supersedes it', async () => {
    mockChat
      .mockResolvedValueOnce('{"intent_summary":"set up service","outcome_summary":"done","lesson":"A before B"}')
      .mockResolvedValueOnce('A must be done before B. C must be done before D.');
    memory.setMergeableTemplate({ id: 'prior-tpl', content: 'C before D' });
    vi.spyOn(reader, 'getScopeEvents').mockResolvedValue(makeScopeEvents());
    const worker = new TemplateProposalWorker(reader, memory, writer, llm, embed);
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    // looked up by deterministic WL topology, excluding this scope's own rows
    expect(memory.calls.findMergeableTemplate).toHaveLength(1);
    expect(memory.calls.findMergeableTemplate[0]!.excludeScopeId).toBe('scope-1');
    expect(memory.calls.findMergeableTemplate[0]!.topologyEmbeddingLiteral).toMatch(/^\[/);
    // the canonical (positive) template carries the MERGED superset runbook
    const positive = memory.calls.insertProceduralTemplate.find((p) => p.isAntiPattern === false);
    expect(positive!.content).toContain('A must be done before B. C must be done before D.');
    // and the prior row is superseded by the freshly written canonical row
    expect(memory.calls.supersedeTemplate).toEqual([{ oldId: 'prior-tpl', newId: 'stub-procedural-id' }]);
  });

  it('B1: no prior canonical template → appends this run unchanged, no supersede', async () => {
    mockChat.mockResolvedValue(
      '{"intent_summary":"set up service","outcome_summary":"done","lesson":"A before B"}',
    );
    // setMergeableTemplate not called → stub returns null
    vi.spyOn(reader, 'getScopeEvents').mockResolvedValue(makeScopeEvents());
    const worker = new TemplateProposalWorker(reader, memory, writer, llm, embed);
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    expect(memory.calls.findMergeableTemplate).toHaveLength(1); // topology lookup always runs
    expect(memory.calls.supersedeTemplate).toHaveLength(0);
    const positive = memory.calls.insertProceduralTemplate.find((p) => p.isAntiPattern === false);
    expect(positive!.content).toContain('A before B'); // this run's own lesson, not a merge
  });

  it('B1: consolidation works without an embedding provider (topology is deterministic)', async () => {
    mockChat
      .mockResolvedValueOnce('{"intent_summary":"x","outcome_summary":"y","lesson":"A before B"}')
      .mockResolvedValueOnce('A must be done before B. C must be done before D.');
    memory.setMergeableTemplate({ id: 'prior-tpl', content: 'C before D' });
    vi.spyOn(reader, 'getScopeEvents').mockResolvedValue(makeScopeEvents());
    const worker = new TemplateProposalWorker(reader, memory, writer, llm, null);
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    // topology embedding needs no LLM/embed call → merge + supersede still happen
    expect(memory.calls.findMergeableTemplate).toHaveLength(1);
    expect(memory.calls.findMergeableTemplate[0]!.topologyEmbeddingLiteral).toMatch(/^\[/);
    expect(memory.calls.supersedeTemplate).toEqual([{ oldId: 'prior-tpl', newId: 'stub-procedural-id' }]);
  });

  // ── Phase 10: reinforcement closure (P1-D call path) ───────────────────────

  /** Scope events whose task_spawned payloads carry steps in the given order. */
  function makeStepEvents(steps: string[]): EventLogNode[] {
    const base = makeScopeEvents()[0]!;
    return steps.map((step, i) => ({
      ...base,
      id: `step-${i}`,
      entity_id: `e-${i}`,
      event_type: 'task_spawned' as const,
      version_hash: `vh-${i}`,
      payload: JSON.stringify({ step }),
    }));
  }

  it('credits only the templates whose prescribed order the converged scope FOLLOWED (GH #31)', async () => {
    vi.spyOn(reader, 'getScopeEvents').mockResolvedValue(makeStepEvents(['write_api', 'db_schema']));
    memory.setInjectedTemplates([
      { id: 'tpl-conform', content: 'write_api before db_schema.' },
      { id: 'tpl-violate', content: 'db_schema before write_api.' },
    ]);
    const worker = new TemplateProposalWorker(reader, memory, writer, llm, embed);
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    expect(memory.calls.getInjectedTemplates).toEqual(['scope-1']);
    expect(memory.calls.reinforceTemplate).toEqual(['tpl-conform']); // violating ingredient gets no credit
    expect(memory.calls.reinforceTemplateGraded[0]!.credit).toBeGreaterThanOrEqual(1);
  });

  it('credits nothing when conformance cannot be judged against the scope (fail-closed)', async () => {
    vi.spyOn(reader, 'getScopeEvents').mockResolvedValue(makeStepEvents(['scaffold', 'add_deps']));
    memory.setInjectedTemplates([{ id: 'tpl-na', content: 'write_api before db_schema.' }]);
    const worker = new TemplateProposalWorker(reader, memory, writer, llm, embed);
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));
    expect(memory.calls.reinforceTemplate).toEqual([]);
  });

  it('reinforcement failure does not break the scope_closed pass', async () => {
    vi.spyOn(reader, 'getScopeEvents').mockResolvedValue(makeScopeEvents());
    memory.throwOn('getInjectedTemplates');
    const worker = new TemplateProposalWorker(reader, memory, writer, llm, embed);
    await expect(
      worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64)),
    ).resolves.toBeUndefined();
    // orphan negative still written after the reinforcement failure
    expect(memory.calls.insertProceduralTemplate.some((p) => p.isAntiPattern === true)).toBe(true);
  });

  // ── Phase 10: success-correlation negatives ────────────────────────────────

  it('anti-pattern rows carry correlation_confidence and a real WL embedding (not zero vector)', async () => {
    vi.spyOn(reader, 'getScopeEvents').mockResolvedValue(makeScopeEvents());
    const worker = new TemplateProposalWorker(reader, memory, writer, llm, embed);
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    const negative = memory.calls.insertProceduralTemplate.find((p) => p.isAntiPattern === true);
    expect(negative).toBeDefined();
    const graph = negative!.templateGraph as { correlation_confidence?: string };
    // ev-2 is the last event — no corrective path follows → low confidence
    expect(graph.correlation_confidence).toBe('low');
    expect(negative!.embeddingLiteral).not.toBe('[' + Array(128).fill(0).join(',') + ']');
  });

  it('orphan followed by corrective events gets correlation_confidence=high', async () => {
    const events = makeScopeEvents();
    // make ev-1 the orphan (nothing consumes hash-of-ev1) and ev-2 the corrective tail
    events[1] = { ...events[1]!, predecessor_hash: 'unrelated-hash' };
    // now both are orphans; ev-1 has ev-2 as corrective path → high
    vi.spyOn(reader, 'getScopeEvents').mockResolvedValue(events);
    const worker = new TemplateProposalWorker(reader, memory, writer, llm, embed);
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    const negatives = memory.calls.insertProceduralTemplate.filter((p) => p.isAntiPattern === true);
    const confidences = negatives.map(
      (n) => (n.templateGraph as { correlation_confidence?: string }).correlation_confidence,
    );
    expect(confidences).toContain('high'); // ev-1: corrective path exists
    expect(confidences).toContain('low');  // ev-2: terminal, no corrective path
  });
});
