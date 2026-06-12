'use client';

/**
 * Skills panel — two-phase loading (Phase 11 loader contract): the list is
 * name+description only; SKILL.md bodies load on demand via /v1/skills/:id.
 */

import { useEffect, useState } from 'react';

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
    setBody({ name: s.name, text: res.ok ? await res.text() : `fetch failed: ${res.status}` });
  };

  return (
    <div className="space-y-3">
      <h1 className="text-gray-100">Skills</h1>
      {status !== null && <p className="text-gray-500">{status}</p>}
      <div className="flex gap-4">
        <ul className="w-96 shrink-0 space-y-2">
          {skills.map((s) => (
            <li key={s.fingerprintId}>
              <button
                onClick={() => void open(s)}
                className="w-full text-left border border-line rounded bg-panel p-2 hover:border-accent"
              >
                <span className="text-gray-100">{s.name}</span>
                <span className="block text-xs text-gray-500">{s.description}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex-1 border border-line rounded bg-panel p-3 overflow-auto min-h-64">
          {body === null ? (
            <p className="text-gray-500">select a skill to load its SKILL.md (two-phase loading)</p>
          ) : (
            <pre className="whitespace-pre-wrap break-all text-xs">{body.text}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
