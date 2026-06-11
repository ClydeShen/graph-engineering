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
});
