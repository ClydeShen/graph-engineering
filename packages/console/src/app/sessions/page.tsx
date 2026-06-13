'use client';

/**
 * Sessions — full scope browser (Hermes SessionsPage, Memex-native). Lists
 * every scope from GET /v1/scopes; selecting one shows its conversation replay
 * (GET /v1/scopes/:id/messages) plus quick links to its topology and artifacts.
 * Read-only projection of the trail mesh — no new write surface.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api, type ScopeSummary, type ConversationMessage } from '@/lib/api';
import { Badge, Icon, Input, Panel, StatusDot, Tag } from '@/components/ds';

function statusTone(status: string): 'ok' | 'danger' | 'idle' {
  if (status === 'suspended') return 'danger';
  if (status === 'closed' || status === 'crystallized') return 'idle';
  return 'ok';
}

export default function SessionsPage() {
  const [scopes, setScopes] = useState<ScopeSummary[]>([]);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<ScopeSummary | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api.scopes(200);
        if (alive) setScopes(r.scopes);
      } catch {
        /* list is best-effort */
      }
    };
    void tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (q === '') return scopes;
    return scopes.filter(
      (s) => s.scope_id.includes(q) || (s.intent ?? '').toLowerCase().includes(q),
    );
  }, [scopes, filter]);

  const select = async (s: ScopeSummary) => {
    setSelected(s);
    setMessages(null);
    setError(null);
    setLoading(true);
    try {
      const r = await api.messages(s.scope_id);
      setMessages(r.messages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load conversation');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: 'var(--gutter)', height: '100%', minHeight: 0 }}>
      <Panel noBody style={{ width: 380, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: 'var(--space-3)', borderBottom: 'var(--hairline)' }}>
          <Input
            icon={<Icon name="search" size={14} />}
            placeholder="filter by intent or id…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <p className="ds-label" style={{ marginTop: 'var(--space-2)' }}>
            {filtered.length} of {scopes.length} scopes
          </p>
        </div>
        <ul style={{ flex: 1, overflow: 'auto', listStyle: 'none', margin: 0, padding: 'var(--space-2)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {filtered.map((s) => {
            const on = selected?.scope_id === s.scope_id;
            return (
              <li key={s.scope_id}>
                <button
                  onClick={() => void select(s)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '9px 11px',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid ' + (on ? 'var(--border-hairline)' : 'transparent'),
                    background: on ? 'var(--surface-raised)' : 'transparent',
                    backgroundImage: on ? 'var(--sheen-panel)' : 'none',
                    boxShadow: on ? 'var(--shadow-engrave)' : 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <StatusDot tone={statusTone(s.status)} live={s.status === 'active'} />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: 'block', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {(s.intent ?? '').slice(0, 44) || s.scope_id.slice(0, 8)}
                    </span>
                    <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
                      {s.scope_id.slice(0, 8)} · {s.status} · {s.created_at.slice(0, 10)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Panel>

      <Panel
        eyebrow={selected ? 'Session' : undefined}
        title={selected ? (selected.intent ?? '').slice(0, 64) || selected.scope_id.slice(0, 8) : 'Session detail'}
        actions={
          selected ? (
            <span style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <Link href={`/topology?scope=${selected.scope_id}`}><Tag>topology</Tag></Link>
              <Link href={`/artifacts?scope=${selected.scope_id}`}><Tag>artifacts</Tag></Link>
            </span>
          ) : null
        }
        style={{ flex: 1, minWidth: 0, overflow: 'auto' }}
      >
        {selected === null ? (
          <p className="ds-label">select a session to replay its conversation</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
              <Badge tone={statusTone(selected.status) === 'danger' ? 'danger' : 'ok'} dot>{selected.status}</Badge>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{selected.scope_id}</span>
            </div>
            {error !== null ? (
              <div className="mx-chat__error">{error}</div>
            ) : loading ? (
              <p className="ds-label">loading conversation…</p>
            ) : messages !== null && messages.length === 0 ? (
              <p className="ds-label">no conversation turns in this scope (non-chat trail)</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                {(messages ?? []).map((m, i) => (
                  <div key={i} className={`mx-chat__msg mx-chat__msg--${m.role === 'user' ? 'user' : 'assistant'}`} style={{ maxWidth: 720 }}>
                    {m.role === 'assistant' ? (
                      <>
                        <div className="mx-chat__avatar" aria-hidden style={{ fontSize: 11 }}>M</div>
                        <div className="mx-chat__assistant-body">
                          <span style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--text-base)', lineHeight: 1.6 }}>{m.text}</span>
                        </div>
                      </>
                    ) : (
                      <div className="mx-chat__bubble-user">{m.text}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
