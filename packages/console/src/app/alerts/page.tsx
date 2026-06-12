'use client';

/** Page 3 — suspended scopes, 5s poll (UI-SPEC). */

import { useEffect, useState } from 'react';
import { api, type SuspendedScope } from '@/lib/api';

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
    <div className="space-y-4">
      <h1 className="text-gray-100">Suspended scopes</h1>
      {error !== null && <p className="text-danger">{error}</p>}
      {alerts.length === 0 ? (
        <p className="text-ok">none — all scopes healthy</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {alerts.map((a) => (
            <div key={a.scope_id} className="border border-danger rounded bg-panel p-3 space-y-1">
              <p className="text-danger break-all">{a.scope_id}</p>
              <p>reason: {a.error_reason}</p>
              <p>frozen: {a.frozen_at ?? '—'}</p>
              <p>unconverged nodes: {a.unconverged_nodes_count}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
