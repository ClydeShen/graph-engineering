'use client';

/**
 * Emergence — "what the system has learned" (CONSOLE-REDESIGN §9). Reads
 * /v1/emergence (procedural_memory lessons). The content is already LLM-distilled
 * prose, so there is no machine→human translation — only presentation: render the
 * prose, translate confidence into a human badge, hide ids/hashes.
 */

import { useEffect, useState } from 'react';
import { api, type EmergenceLesson } from '@/lib/api';
import { Badge, Panel, Tag } from '@/components/ds';

function confidenceLabel(c: number): { text: string; tone: 'ok' | 'info' | 'neutral' } {
  if (c >= 0.8) return { text: 'well-reinforced', tone: 'ok' };
  if (c >= 0.5) return { text: 'taking hold', tone: 'info' };
  return { text: 'early', tone: 'neutral' };
}

export default function EmergencePage() {
  const [lessons, setLessons] = useState<EmergenceLesson[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .emergence()
      .then((r) => setLessons(r.lessons))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'load failed'));
  }, []);

  if (error !== null) return <Badge tone="danger">{error}</Badge>;
  if (lessons === null) return <p className="ds-label">loading what the system has learned…</p>;
  if (lessons.length === 0)
    return (
      <Panel variant="sunken">
        <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          Nothing learned yet. As tasks finish, the system distills what worked into
          lessons — they will show up here, and grow more confident the more they help.
        </p>
      </Panel>
    );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gutter)', maxWidth: 820 }}>
      {lessons.map((l) => {
        const cl = confidenceLabel(l.confidence);
        return (
          <Panel
            key={l.id}
            eyebrow="Lesson"
            title={l.intent ?? 'A pattern the system noticed'}
            actions={
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Badge tone={cl.tone} dot>{cl.text}</Badge>
                {l.reinforcement_count > 0 ? <Tag>reinforced ×{l.reinforcement_count}</Tag> : null}
              </span>
            }
          >
            <p style={{ margin: 0, whiteSpace: 'pre-wrap', color: 'var(--text-primary)', lineHeight: 1.6 }}>
              {l.content}
            </p>
          </Panel>
        );
      })}
    </div>
  );
}
