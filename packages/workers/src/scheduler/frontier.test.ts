/**
 * frontier.test.ts — FrontierScheduler skill-matching extension tests
 *
 * GATE4-5: FrontierScheduler dispatches tasks by skill match (not arbitrary assignment).
 * Turned GREEN by: Plan 03-03 (FrontierScheduler skill-matching extension).
 *
 * These RED stubs define the expected behavior for the skill-based dispatch extension.
 * Existing dynamicScore / TokenBucket / SQL structure tests are in
 * src/__tests__/frontier.test.ts (Phase 1, unchanged).
 *
 * Per D-1 (locked): required_skills is declared in task payload; agent_registry
 * provides the skill→agent mapping; FrontierScheduler queries agent_registry via
 * GIN index (`skills && required_skills`) before SKIP LOCKED dispatch.
 * Tasks without required_skills pass through the existing dispatch path unchanged.
 */

import { describe, it, expect } from 'vitest';

// These tests reference the skill-matching logic that Plan 03-03 will implement
// inside FrontierSchedulerWorker.onFrontierChanged (or a new dispatch query).
// They are RED until Plan 03-03 wires the agent_registry JOIN.

describe('FrontierScheduler skill-matching (GATE4-5)', () => {
  // ── GATE4-5a: task with required_skills dispatches when GIN-matched agent exists ──

  it.todo(
    'GATE4-5a: task with required_skills dispatches when a GIN-matched active agent exists — RED: implemented by Plan 03-03',
    // Pseudocode for Plan 03-03 to implement:
    // 1. Insert agent_registry row: { skills: ['test-skill'], status: 'active',
    //    last_heartbeat: NOW() }
    // 2. Insert pending_scheduling event with payload.required_skills = ['test-skill']
    // 3. Call frontierScheduler.onFrontierChanged(scopeId)
    // 4. Assert: event status changed to 'pending_dispatch'
    // Implementation note: dispatch query must JOIN agent_registry WHERE
    //   status='active' AND last_heartbeat > NOW()-60s AND skills && required_skills
  );

  // ── GATE4-5b: task with required_skills excluded when no matching agent ────────

  it.todo(
    'GATE4-5b: task with required_skills is excluded from dispatch when no matching agent exists — RED: implemented by Plan 03-03',
    // Pseudocode:
    // 1. Ensure no agent_registry row matches ['missing-skill']
    // 2. Insert pending_scheduling event with payload.required_skills = ['missing-skill']
    // 3. Call frontierScheduler.onFrontierChanged(scopeId)
    // 4. Assert: event status remains 'pending_scheduling' (not dispatched)
    // This prevents tasks from being picked up by agents that lack required skills.
  );

  // ── GATE4-5c: task without required_skills passes through unchanged ────────────

  it.todo(
    'GATE4-5c: task without required_skills dispatches unchanged (existing dispatch path, no skill filter) — RED: implemented by Plan 03-03',
    // Pseudocode:
    // 1. Insert pending_scheduling event with no required_skills in payload
    // 2. Call frontierScheduler.onFrontierChanged(scopeId)
    // 3. Assert: event status changes to 'pending_dispatch' (existing dispatch path)
    // Per RESEARCH Pitfall 4: skill matching is opt-in — tasks without required_skills
    // use the pre-existing dispatch logic without querying agent_registry.
  );
});
