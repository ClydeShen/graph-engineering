import { describe, it, expect } from 'vitest';
import { channelFromIntent, groupIntoGalaxies } from './forest.js';

describe('channelFromIntent', () => {
  it('parses the platform from a session intent', () => {
    expect(channelFromIntent('session:telegram::123')).toBe('telegram');
    expect(channelFromIntent('session:slack::C0XYZ')).toBe('slack');
    expect(channelFromIntent('session:Discord::g1')).toBe('discord'); // lowercased
  });

  it('falls back to "direct" for null / empty / unparseable intent', () => {
    expect(channelFromIntent(null)).toBe('direct');
    expect(channelFromIntent('')).toBe('direct');
    expect(channelFromIntent('some freeform task description')).toBe('direct');
    expect(channelFromIntent('session:bad-format')).toBe('direct'); // no '::'
  });
});

describe('groupIntoGalaxies', () => {
  it('groups root scopes by channel with per-status counts', () => {
    const galaxies = groupIntoGalaxies([
      { scope_id: 'a', intent: 'session:telegram::1', status: 'active', created_at: 't1', descendants: 3 },
      { scope_id: 'b', intent: 'session:telegram::2', status: 'closed', created_at: 't2', descendants: 0 },
      { scope_id: 'c', intent: 'session:slack::3', status: 'active', created_at: 't3', descendants: 1 },
      { scope_id: 'd', intent: null, status: 'active', created_at: 't4', descendants: 0 },
    ]);

    const tg = galaxies.find((g) => g.channel === 'telegram');
    expect(tg?.tasks).toHaveLength(2);
    expect(tg?.status_counts).toEqual({ active: 1, closed: 1 });

    expect(galaxies.find((g) => g.channel === 'slack')?.tasks).toHaveLength(1);
    expect(galaxies.find((g) => g.channel === 'direct')?.tasks).toHaveLength(1);
  });

  it('returns no galaxies for empty input', () => {
    expect(groupIntoGalaxies([])).toEqual([]);
  });
});
