'use client';

/** Page 3 — suspended scopes, 5s poll (UI-SPEC). */

import { useEffect, useState } from 'react';
import { api, type SuspendedScope } from '@/lib/api';
import { Badge, Panel, StatusDot } from '@/components/ds';

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<SuspendedScope[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const a = await api.suspended();
        if (alive) {
          setAlerts(a);
          setError(null);
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'poll failed');
      }
    };
    void tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gutter)' }}>
      {error !== null ? <Badge tone="danger">{error}</Badge> : null}
      {alerts.length === 0 ? (
        <StatusDot tone="ok" live>none — all scopes healthy</StatusDot>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 'var(--gutter)' }}>
          {alerts.map((a) => (
            <Panel
              key={a.scope_id}
              variant="raised"
              corners
              eyebrow="Suspended scope"
              actions={<Badge tone="danger" dot>frozen</Badge>}
              title={a.scope_id.slice(0, 8)}
              style={{ borderColor: 'var(--rust-600)' }}
            >
              <dl style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}>
                <dt className="ds-label">scope_id</dt>
                <dd style={{ wordBreak: 'break-all', color: 'var(--text-primary)' }}>{a.scope_id}</dd>
                <dt className="ds-label">reason</dt>
                <dd style={{ color: 'var(--rust-400)' }}>{a.error_reason}</dd>
                <dt className="ds-label">frozen at</dt>
                <dd>{a.frozen_at ?? '—'}</dd>
                <dt className="ds-label">unconverged nodes</dt>
                <dd>{a.unconverged_nodes_count}</dd>
              </dl>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
