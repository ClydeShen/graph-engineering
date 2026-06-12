'use client';

/** Global Status Ribbon — 1s /v1/sys/health poll (UI-SPEC 常驻组件). */

import { useEffect, useState } from 'react';
import { api, type HealthResponse } from '@/lib/api';

export function StatusRibbon() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const h = await api.health();
        if (alive) {
          setHealth(h);
          setError(false);
        }
      } catch {
        if (alive) setError(true);
      }
    };
    void tick();
    const id = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const ok = !error && health?.engine_status === 'ok';
  return (
    <header className="flex items-center gap-4 px-4 py-2 bg-panel border-b border-line sticky top-0 z-10">
      <span className="font-bold text-gray-100">MemexOS</span>
      <span className={ok ? 'text-ok' : 'text-danger'}>
        Engine: {error ? 'UNREACHABLE' : (health?.engine_status ?? '…').toUpperCase()}
      </span>
      <span>Live Scopes: {health?.live_scopes ?? '—'}</span>
      <span className={health?.suspended_count ? 'text-danger' : 'text-ok'}>
        Suspended: {health?.suspended_count ?? '—'}
      </span>
      <span>
        Slots: {health?.slots !== undefined ? `${(health.slots ?? 0) - (health.idle_slots ?? 0)}/${health.slots}` : '—'}
      </span>
    </header>
  );
}
