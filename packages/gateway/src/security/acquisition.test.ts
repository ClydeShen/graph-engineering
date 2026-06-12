import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { executeInstall, requestInstall, searchCapabilities } from './acquisition.js';
import type { ApprovalService } from './approval.js';

describe('searchCapabilities', () => {
  it('matches presets by category/name/description and merges registry hits', async () => {
    const out = await searchCapabilities('browser', {
      searchRegistries: async () => [
        { registry: 'agentskills.io', id: 'web-nav', name: 'web-nav', description: 'navigate sites' },
      ],
    });
    expect(out.some((c) => c.install_ref === 'preset:agent-browser')).toBe(true);
    expect(out.some((c) => c.install_ref === 'skill:agentskills.io:web-nav')).toBe(true);
  });

  it('a down registry hides nothing else', async () => {
    const out = await searchCapabilities('search', {
      searchRegistries: async () => {
        throw new Error('registry down');
      },
    });
    expect(out.some((c) => c.install_ref === 'preset:tavily')).toBe(true);
  });
});

describe('requestInstall', () => {
  it('embeds the guard report in the approval command body', async () => {
    const request = vi.fn(async () => 'approval-1');
    const approvals = { request } as unknown as ApprovalService;
    const out = await requestInstall(
      approvals,
      { scanCandidate: async () => ({ findings: 2, report: 'HIGH curl|sh at line 3' }) },
      'scope-1',
      'agent-a',
      'skill:agentskills.io:web-nav',
    );
    expect(out).toEqual({ approval_id: 'approval-1', findings: 2 });
    const command = (request.mock.calls[0] as unknown[])[2] as string;
    expect(command).toContain('guard scan: 2 finding(s)');
    expect(command).toContain('HIGH curl|sh at line 3');
  });
});

describe('executeInstall', () => {
  const pool = { query: vi.fn(async () => ({ rows: [] })) } as unknown as Pool;
  const deps = { performInstall: vi.fn(async () => ({ location: '/skills/web-nav' })) };

  it('refuses anything not approved (pending/denied/timed_out/unknown)', async () => {
    for (const status of ['pending', 'denied', 'timed_out', null] as const) {
      const approvals = { status: vi.fn(async () => status) } as unknown as ApprovalService;
      const out = await executeInstall(pool, approvals, deps, 'a-1', 'skill:x:y', 'agent-a');
      expect(out.status).toBe(status ?? 'unknown_approval');
      expect(deps.performInstall).not.toHaveBeenCalled();
    }
  });

  it('approved → installs and reports the location', async () => {
    const approvals = { status: vi.fn(async () => 'approved') } as unknown as ApprovalService;
    const out = await executeInstall(pool, approvals, deps, 'a-1', 'skill:x:y', 'agent-a');
    expect(out).toEqual({ status: 'installed', location: '/skills/web-nav' });
  });
});
