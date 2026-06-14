import { describe, it, expect } from 'vitest';
import { toUniverseGraph, galaxyId } from './forest-universe.js';
import type { ForestResponse } from './api.js';

const forest: ForestResponse = {
  total_roots: 3,
  projects: [],
  galaxies: [
    {
      channel: 'telegram',
      status_counts: { active: 2 },
      tasks: [
        { scope_id: 't1', intent: 'session:telegram::1', status: 'active', created_at: 'x', descendants: 2, project: null },
        { scope_id: 't2', intent: 'session:telegram::2', status: 'active', created_at: 'x', descendants: 0, project: null },
      ],
    },
    {
      channel: 'direct',
      status_counts: { closed: 1 },
      tasks: [{ scope_id: 'd1', intent: null, status: 'closed', created_at: 'x', descendants: 0, project: null }],
    },
  ],
};

describe('toUniverseGraph', () => {
  it('builds galaxy + task nodes with channel links', () => {
    const u = toUniverseGraph(forest);
    expect(u.nodes).toHaveLength(5); // 2 galaxies + 3 tasks

    const tg = u.nodes.find((n) => n.id === galaxyId('telegram'));
    expect(tg?.kind).toBe('galaxy');
    expect(tg?.size).toBe(2); // 2 tasks in the galaxy

    expect(u.links).toContainEqual({ source: galaxyId('telegram'), target: 't1' });

    const t1 = u.nodes.find((n) => n.id === 't1');
    expect(t1?.kind).toBe('task');
    expect(t1?.size).toBe(3); // descendants 2 + 1
    expect(t1?.status).toBe('active');
  });

  it('returns an empty graph for an empty forest', () => {
    expect(toUniverseGraph({ galaxies: [], projects: [], total_roots: 0 })).toEqual({ nodes: [], links: [] });
  });
});
