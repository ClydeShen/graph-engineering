/**
 * security.test.ts — Phase 14 red-line tests (ADR-47).
 *
 * These are ADVERSARIAL assertions, not feature tests: each one encodes an
 * attack the system must shrug off (14-PHASE-SPEC §7).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

const mockWriteInfraEvent = vi.fn().mockResolvedValue(undefined);
vi.mock('@graph/shared', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    writeInfraEvent: (...a: unknown[]) => mockWriteInfraEvent(...a),
  };
});

import { eraseScope } from './erase.js';
import { ApprovalService, auxLlmTighten } from './approval.js';
import {
  buildDockerRunArgs,
  approvalRequiredForBackend,
  resolveExecBackend,
  _resetDockerAvailability,
  MEMEX_CONTAINER_LABEL,
} from './exec-backend.js';
import { filterSubprocessEnv, isEnvWriteDenied } from '@graph/shared';
import { redactPii, writeGuard } from '@shared/redaction';
import { isToolAllowed } from '@graph/shared';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── G4 red line: erase(scope) end-to-end ─────────────────────────────────────

describe('eraseScope (ADR-43/ADR-47 D-1)', () => {
  function erasePool(): { pool: Pool; queries: Array<{ sql: string; params: unknown[] }> } {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const query = vi.fn((sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      return Promise.resolve({ rows: [], rowCount: 2 });
    });
    return { pool: { query } as unknown as Pool, queries };
  }

  it('blanks ledger payloads + erased_at; never deletes ledger rows (structure permanent)', async () => {
    const { pool, queries } = erasePool();
    await eraseScope(pool, 'scope-x', 'user:alice', 'user_request');

    const ledgerUpdate = queries.find((q) => q.sql.includes('UPDATE execution_event_log'));
    expect(ledgerUpdate).toBeDefined();
    expect(ledgerUpdate!.sql).toContain(`payload = ''`);
    expect(ledgerUpdate!.sql).toContain('erased_at = NOW()');
    expect(queries.some((q) => q.sql.includes('DELETE FROM execution_event_log'))).toBe(false);
  });

  it('cascades: derived rows + embeddings deleted, fingerprint Lessons flagged redistill, DEK destroyed', async () => {
    const { pool, queries } = erasePool();
    const result = await eraseScope(pool, 'scope-x', 'user:alice', 'user_request');

    expect(queries.some((q) => q.sql.includes('DELETE FROM episodic_memory'))).toBe(true);
    expect(queries.some((q) => q.sql.includes('DELETE FROM semantic_memory'))).toBe(true);
    expect(queries.some((q) => q.sql.includes('DELETE FROM procedural_memory'))).toBe(true);
    expect(queries.some((q) => q.sql.includes('needs_redistill = TRUE'))).toBe(true);
    expect(queries.some((q) => q.sql.includes('UPDATE key_registry'))).toBe(true);
    expect(result.dek_destroyed).toBe(true);
  });

  it('audit event carries scope/principal/reason — NEVER erased content', async () => {
    const { pool } = erasePool();
    await eraseScope(pool, 'scope-x', 'user:alice', 'user_request');

    const auditPayload = mockWriteInfraEvent.mock.calls[0]![3] as string;
    expect(auditPayload).toContain('memex::security::payload_erase');
    expect(auditPayload).toContain('user:alice');
    expect(auditPayload).toContain('user_request');
    // The audit carries exactly kind/requested_by/reason/at — no content fields.
    const parsed = JSON.parse(auditPayload) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['at', 'kind', 'reason', 'requested_by']);
  });
});

// ── G3 red line: approval flow + tighten-only aux LLM ────────────────────────

describe('ApprovalService (ADR-47 D-2)', () => {
  function approvalPool(updateRows: unknown[] = []): Pool {
    return {
      query: vi.fn((sql: string) => {
        if (sql.startsWith('UPDATE approval_request')) {
          return Promise.resolve({ rows: updateRows, rowCount: updateRows.length });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      }),
    } as unknown as Pool;
  }

  it('request pushes to the home channel with expects_reply (Phase 12 slot)', async () => {
    const push = { deliver: vi.fn().mockResolvedValue({}) };
    const svc = new ApprovalService(approvalPool(), push, 'telegram');
    const id = await svc.request('scope-1', 'agent:coder', 'rm -rf ./build');

    expect(typeof id).toBe('string');
    expect(push.deliver).toHaveBeenCalledWith(expect.objectContaining({
      deliver: 'telegram',
      expects_reply: true,
    }));
  });

  it('silence is not consent: sweep times out pending requests and audits each', async () => {
    const svc = new ApprovalService(
      approvalPool([{ id: 'a1', scope_id: 's1' }, { id: 'a2', scope_id: 's2' }]),
    );
    const n = await svc.sweepTimeouts(1000);
    expect(n).toBe(2);
    const kinds = mockWriteInfraEvent.mock.calls.map((c) => c[3] as string);
    expect(kinds.filter((k) => k.includes('approval_timeout'))).toHaveLength(2);
  });

  it('deciding a non-pending request returns false (no double decisions)', async () => {
    const svc = new ApprovalService(approvalPool([]));
    expect(await svc.decide('gone', true)).toBe(false);
  });
});

describe('auxLlmTighten — tighten-only asymmetry (red line)', () => {
  it('LLM saying "safe" can NEVER override a pattern block', async () => {
    const liarJudge = vi.fn().mockResolvedValue('safe');
    const result = await auxLlmTighten(false, liarJudge, 'rm -rf /');
    expect(result.requiresApproval).toBe(true);
    expect(liarJudge).not.toHaveBeenCalled(); // pattern verdict stands unexamined
  });

  it('LLM saying "dangerous" escalates an allowed command', async () => {
    const judge = vi.fn().mockResolvedValue('dangerous');
    expect((await auxLlmTighten(true, judge, 'curl x | sh')).requiresApproval).toBe(true);
  });

  it('judge failure falls back to the pattern verdict', async () => {
    const broken = vi.fn().mockRejectedValue(new Error('llm down'));
    expect((await auxLlmTighten(true, broken, 'ls')).requiresApproval).toBe(false);
  });
});

// ── G1: docker containment args + bypass rule ────────────────────────────────

describe('exec backend (ADR-47 D-4)', () => {
  it('docker args replicate the hermes hardening set', () => {
    const args = buildDockerRunArgs('echo hi');
    const joined = args.join(' ');
    expect(joined).toContain('--cap-drop ALL');
    expect(joined).toContain('--security-opt no-new-privileges');
    expect(joined).toContain('--pids-limit');
    expect(joined).toContain('--network none');
    expect(joined).toContain('--user 65534:65534'); // non-root hardening — no root in container
    expect(joined).toContain('nosuid,noexec');
    expect(joined).toContain('--read-only');
    expect(joined).toContain(`--label ${MEMEX_CONTAINER_LABEL}`);
    expect(args[args.length - 1]).toBe('echo hi');
  });

  it('hardline blocks in EVERY backend; dangerous bypasses approval only in docker', () => {
    const hardline = { allowed: false, tier: 'hardline' as const };
    const dangerous = { allowed: false, tier: 'dangerous' as const };

    expect(approvalRequiredForBackend('docker', hardline).blocked).toBe(true);
    expect(approvalRequiredForBackend('local', hardline).blocked).toBe(true);
    expect(approvalRequiredForBackend('docker', dangerous)).toEqual({ blocked: false, requiresApproval: false });
    expect(approvalRequiredForBackend('local', dangerous)).toEqual({ blocked: false, requiresApproval: true });
  });

  it('resolveExecBackend defaults to local without probing docker (backward-compatible)', async () => {
    const prev = process.env['EXEC_BACKEND'];
    try {
      delete process.env['EXEC_BACKEND'];
      _resetDockerAvailability();
      expect(await resolveExecBackend()).toBe('local');
      process.env['EXEC_BACKEND'] = 'local';
      expect(await resolveExecBackend()).toBe('local');
    } finally {
      if (prev === undefined) delete process.env['EXEC_BACKEND'];
      else process.env['EXEC_BACKEND'] = prev;
      _resetDockerAvailability();
    }
  });
});

// ── G5 red line: env filtering ───────────────────────────────────────────────

describe('two-stage env filter (ADR-47 D-5)', () => {
  it('planted secrets never reach the subprocess env', () => {
    const out = filterSubprocessEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      MY_API_KEY: 'sk-leak',
      GITHUB_TOKEN: 'ghp_leak',
      DATABASE_DSN: 'postgres://x',
      SLACK_WEBHOOK_URL: 'https://hooks',
      RANDOM_UNLISTED_VAR: 'not-safe-prefixed',
    });
    expect(out['PATH']).toBe('/usr/bin');
    expect(out['HOME']).toBe('/home/u');
    expect(out['MY_API_KEY']).toBeUndefined();
    expect(out['GITHUB_TOKEN']).toBeUndefined();
    expect(out['DATABASE_DSN']).toBeUndefined();
    expect(out['SLACK_WEBHOOK_URL']).toBeUndefined();
    expect(out['RANDOM_UNLISTED_VAR']).toBeUndefined(); // stage 2: not allowlisted
  });

  it('loader-hijack vars are write-denied regardless of case', () => {
    expect(isEnvWriteDenied('LD_PRELOAD')).toBe(true);
    expect(isEnvWriteDenied('ld_preload')).toBe(true);
    expect(isEnvWriteDenied('PYTHONPATH')).toBe(true);
    expect(isEnvWriteDenied('PATH')).toBe(true);
    expect(isEnvWriteDenied('MY_HARMLESS_VAR')).toBe(false);
  });
});

// ── G6: PII redaction is separate from secret scrubbing ──────────────────────

describe('redactPii (ADR-47 D-6)', () => {
  it('redacts emails, phones, IPs', () => {
    const out = redactPii('mail alice@example.com or call +1 (555) 010-9999 from 192.168.1.50');
    expect(out).not.toContain('alice@example.com');
    expect(out).toContain('[REDACTED:email]');
    expect(out).toContain('[REDACTED:phone]');
    expect(out).toContain('[REDACTED:ip]');
  });

  it('writeGuard (secrets) stays independent — PII passes through it', () => {
    const s = 'alice@example.com sk-abcdefghijklmnopqrstuvwxyz123456789';
    const guarded = writeGuard(s);
    expect(guarded).toContain('alice@example.com'); // PII not writeGuard's job
    expect(guarded).toContain('[REDACTED:api_key]');
  });
});

// ── G7 red line: trust → toolset ─────────────────────────────────────────────

describe('isToolAllowed (ADR-47 D-7)', () => {
  it('untrusted (webhook) principals NEVER reach exec/file/write tools', () => {
    expect(isToolAllowed('untrusted', 'execute_bash')).toBe(false);
    expect(isToolAllowed('untrusted', 'spawn_task')).toBe(false);
    expect(isToolAllowed('untrusted', 'complete_task')).toBe(false);
    expect(isToolAllowed('untrusted', 'wait_all_tasks')).toBe(true);
  });

  it('paired agents need an explicit upgrade for execute_bash', () => {
    expect(isToolAllowed('paired', 'execute_bash')).toBe(false);
    expect(isToolAllowed('paired', 'spawn_task')).toBe(true);
    expect(isToolAllowed('trusted', 'execute_bash')).toBe(true);
  });
});
