'use client';

/**
 * Skills panel — two-phase loading (Phase 11 loader contract): the list is
 * name+description only; SKILL.md bodies load on demand via /v1/skills/:id.
 */

import { useEffect, useState } from 'react';
import { Panel } from '@/components/ds';

interface SkillRow {
  fingerprintId: string;
  name: string;
  description: string;
}

export default function SkillsPage() {
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [body, setBody] = useState<{ name: string; text: string } | null>(null);
  const [status, setStatus] = useState<string | null>('loading…');

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/v1/skills', { cache: 'no-store' });
        if (!res.ok) throw new Error(`/v1/skills → ${res.status}`);
        const data = (await res.json()) as { skills: SkillRow[] } | SkillRow[];
        const list = Array.isArray(data) ? data : (data as { skills: SkillRow[] }).skills ?? [];
        setSkills(list);
        setStatus(list.length === 0 ? 'no exported skills' : null);
      } catch (err) {
        setStatus(err instanceof Error ? err.message : 'load failed');
      }
    })();
  }, []);

  const open = async (s: SkillRow) => {
    const res = await fetch(`/v1/skills/${s.fingerprintId}`, { cache: 'no-store' });
    // The endpoint wraps the SKILL.md body as {"content": "..."} — render the
    // body, not the raw JSON envelope (UX-audit U19).
    let text: string;
    if (res.ok) {
      const data = (await res.json()) as { content?: string };
      text = data.content ?? '';
    } else {
      text = `fetch failed: ${res.status}`;
    }
    setBody({ name: s.name, text });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gutter)', height: '100%' }}>
      {status !== null ? <p className="ds-label">{status}</p> : null}
      <div style={{ display: 'flex', gap: 'var(--gutter)', flex: 1, minHeight: 0 }}>
        <Panel noBody style={{ width: 360, flexShrink: 0, overflow: 'auto' }}>
          <ul style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', padding: 'var(--panel-pad)', margin: 0, listStyle: 'none' }}>
            {skills.map((s) => (
              <li key={s.fingerprintId}>
                <button
                  onClick={() => void open(s)}
                  className="mx-btn"
                  style={{ width: '100%', justifyContent: 'flex-start', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}
                >
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{s.name}</span>
                  <span className="ds-label" style={{ textTransform: 'none', letterSpacing: 'var(--tracking-normal)' }}>{s.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel eyebrow="Crystallized lesson" title={body?.name ?? 'SKILL.md'} style={{ flex: 1, overflow: 'auto' }}>
          {body === null ? (
            <p className="ds-label">select a skill to load its SKILL.md (two-phase loading)</p>
          ) : (
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', margin: 0 }}>{body.text}</pre>
          )}
        </Panel>
      </div>
    </div>
  );
}
