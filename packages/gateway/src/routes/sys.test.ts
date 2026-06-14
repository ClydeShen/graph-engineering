import { describe, it, expect } from 'vitest';
import { buildSysConfigRoute } from './sys.js';

// These cases exercise the SECURITY-CRITICAL fail-closed paths of the Appendix-A
// write endpoint (CONSOLE-REDESIGN §6.5): every one returns BEFORE touching the
// filesystem, so no test writes to the real profile dir.
describe('POST /v1/sys/llm-overrides — fail closed (§6.5)', () => {
  const app = buildSysConfigRoute();
  const post = (body: string) =>
    app.request('/sys/llm-overrides', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

  it('rejects malformed JSON with 400 (never persists)', async () => {
    const res = await post('{ not json');
    expect(res.status).toBe(400);
  });

  it('rejects an empty override (clearing is DELETE, not POST {})', async () => {
    const res = await post('{}');
    expect(res.status).toBe(400);
  });

  it('rejects an override whose slot has the wrong type', async () => {
    const res = await post(JSON.stringify({ chat: { model: 123 } }));
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/sys/config — llm_overrides projection (§11.2 + Appendix A)', () => {
  it('always includes a redacted llm_overrides section', async () => {
    const app = buildSysConfigRoute();
    const res = await app.request('/sys/config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { llm_overrides?: { present: boolean; path: string } };
    expect(body.llm_overrides).toBeDefined();
    expect(typeof body.llm_overrides?.present).toBe('boolean');
    expect(typeof body.llm_overrides?.path).toBe('string');
  });
});
