import { describe, it, expect } from 'vitest';
import type { EventLogNode, CanonicalEventType } from '@shared/types';
import { ZERO_HASH } from '@shared/constants';
import {
  MEMEX_RETRIEVE_TOOL_NAME,
  buildCcrSentinel,
  createCcrStore,
  createMemexRetrieveTool,
  createMemexRetrieveInstructions,
  createMemexRetrieveExecute,
} from './ccr.js';

let counter = 0;

function makeEvent(
  overrides: Partial<EventLogNode> & { event_type: CanonicalEventType }
): EventLogNode {
  counter++;
  const hash = overrides.version_hash ?? `hash-${counter}`.padEnd(64, '0');
  return {
    id: `id-${counter}`,
    scope_id: 'scope-1',
    entity_id: 'entity-1',
    event_type: overrides.event_type,
    predecessor_hash: overrides.predecessor_hash ?? ZERO_HASH,
    version_hash: hash,
    payload: overrides.payload ?? 'x'.repeat(40),
    status: overrides.status ?? 'archived',
    base_priority: overrides.base_priority ?? 0,
    unlocks_count: overrides.unlocks_count ?? 0,
    spawned_by: overrides.spawned_by ?? null,
    last_active_at: overrides.last_active_at ?? null,
    created_at: overrides.created_at ?? new Date(),
  };
}

describe('buildCcrSentinel', () => {
  it('Test 1: returns sentinel with CCR format and 64-char SHA-256 hash for non-empty dropped array', () => {
    const dropped = [
      makeEvent({ event_type: 'task_spawned', version_hash: 'a'.repeat(64) }),
      makeEvent({ event_type: 'plan_created', version_hash: 'b'.repeat(64) }),
    ];

    const result = buildCcrSentinel(dropped);

    expect(result).not.toBeNull();
    expect(result!.hash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(result!.hash)).toBe(true);
    expect(result!.sentinel._ccr_dropped).toBe(
      `<<ccr:${result!.hash} ${dropped.length}_dropped>>`
    );
  });

  it('Test 2: returns null for empty dropped array', () => {
    expect(buildCcrSentinel([])).toBeNull();
  });
});

describe('createCcrStore', () => {
  it('Test 3: stores and retrieves events; two separate stores are independent (D-05 invocation-scoping)', () => {
    const store1 = createCcrStore();
    const store2 = createCcrStore();
    const eventA = makeEvent({ event_type: 'task_spawned' });
    const eventB = makeEvent({ event_type: 'plan_created' });

    store1.set('abc', [eventA, eventB]);

    expect(store1.get('abc')).toEqual([eventA, eventB]);
    expect(store1.get('missing')).toBeUndefined();

    // store2 is independent — does not see store1's data
    expect(store2.get('abc')).toBeUndefined();
  });
});

describe('createMemexRetrieveTool', () => {
  it('Test 4: returns Anthropic tool definition with name memex_retrieve, required hash, and hash+query properties', () => {
    const tool = createMemexRetrieveTool();

    expect(tool.name).toBe(MEMEX_RETRIEVE_TOOL_NAME);
    expect(tool.name).toBe('memex_retrieve');
    expect(tool.input_schema.required).toEqual(['hash']);
    expect(tool.input_schema.properties).toHaveProperty('hash');
    expect(tool.input_schema.properties).toHaveProperty('query');
    expect(tool.input_schema.properties['hash']!.type).toBe('string');
    expect(tool.input_schema.properties['hash']!.description).toBeTruthy();
    expect(tool.input_schema.properties['query']!.type).toBe('string');
    expect(tool.input_schema.properties['query']!.description).toBeTruthy();
  });
});

describe('createMemexRetrieveInstructions', () => {
  it('Test 5: returns string containing memex_retrieve and both hashes; empty array returns empty string', () => {
    const instructions = createMemexRetrieveInstructions(['hash1', 'hash2']);

    expect(instructions).toContain('memex_retrieve');
    expect(instructions).toContain('hash1');
    expect(instructions).toContain('hash2');

    expect(createMemexRetrieveInstructions([])).toBe('');
  });
});

describe('createMemexRetrieveExecute', () => {
  it('Test 6: retrieves items by hash, returns empty for unknown hash, filters by query substring', async () => {
    const store = createCcrStore();
    const eventA = makeEvent({ event_type: 'task_spawned', payload: 'hello world payload' });
    const eventB = makeEvent({ event_type: 'plan_created', payload: 'foo bar payload' });
    store.set('abc', [eventA, eventB]);

    const execute = createMemexRetrieveExecute(store);

    // Found by hash — returns all items
    const found = await execute({ hash: 'abc' });
    expect(found.items).toEqual([eventA, eventB]);

    // Unknown hash returns empty items
    const notFound = await execute({ hash: 'unknown' });
    expect(notFound.items).toEqual([]);

    // Query filter — only items whose payload contains the query substring
    const filtered = await execute({ hash: 'abc', query: 'hello' });
    expect(filtered.items).toEqual([eventA]);
  });
});
