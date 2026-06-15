import { describe, it, expect } from 'vitest';
import { classifyEvent, firstLine, relativeAge } from './graph-snapshot.js';

describe('classifyEvent', () => {
  it('buckets conversation events by payload kind', () => {
    expect(classifyEvent('memory_updated', 'conversation.user')).toBe('conversation');
    expect(classifyEvent('memory_updated', 'conversation.assistant')).toBe('conversation');
  });
  it('buckets non-conversation memory_updated as memory', () => {
    expect(classifyEvent('memory_updated', 'lesson.saved')).toBe('memory');
    expect(classifyEvent('memory_updated', null)).toBe('memory');
  });
  it('buckets tool/bash/task events as tool', () => {
    expect(classifyEvent('tool_call', null)).toBe('tool');
    expect(classifyEvent('memex::exec::bash', null)).toBe('tool');
    expect(classifyEvent('task_spawned', null)).toBe('tool');
  });
  it('falls back to other', () => {
    expect(classifyEvent('scope_initialized', null)).toBe('other');
  });
});

describe('firstLine', () => {
  it('collapses whitespace and takes the first line', () => {
    expect(firstLine('hello\n  world  again')).toBe('hello world again');
  });
  it('clamps to max with ellipsis', () => {
    expect(firstLine('abcdefghij', 5)).toBe('abcd…');
  });
  it('handles empty/undefined safely', () => {
    expect(firstLine('')).toBe('');
    expect(firstLine(undefined as unknown as string)).toBe('');
  });
});

describe('relativeAge', () => {
  const now = Date.parse('2026-06-15T12:00:00Z');
  it('formats sub-minute as just now', () => {
    expect(relativeAge('2026-06-15T11:59:30Z', now)).toBe('just now');
  });
  it('formats minutes/hours/days', () => {
    expect(relativeAge('2026-06-15T11:30:00Z', now)).toBe('30m');
    expect(relativeAge('2026-06-15T09:00:00Z', now)).toBe('3h');
    expect(relativeAge('2026-06-13T12:00:00Z', now)).toBe('2d');
  });
  it('returns empty for invalid dates', () => {
    expect(relativeAge('not-a-date', now)).toBe('');
  });
});
