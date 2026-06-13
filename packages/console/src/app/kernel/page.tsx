'use client';

/** Page 2 — kernel metrics, 2s poll, 300-point ring buffer (UI-SPEC). */

import { useEffect, useRef, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, type InfraMetrics } from '@/lib/api';
import { Badge, Meter, Panel, Readout } from '@/components/ds';

const BUFFER = 300;

const GLACIER = 'oklch(0.650 0.052 230)';
const RUST = 'oklch(0.595 0.135 40)';
const GRID = 'oklch(0.305 0.012 74)';
const AXIS = 'oklch(0.470 0.014 76)';

export default function KernelPage() {
  const bufferRef = useRef<InfraMetrics[]>([]);
  const [points, setPoints] = useState<InfraMetrics[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const m = await api.metrics();
        if (!alive) return;
        bufferRef.current = [...bufferRef.current.slice(-(BUFFER - 1)), m];
        setPoints(bufferRef.current);
        setError(null);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'poll failed');
      }
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const latest = points.at(-1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gutter)' }}>
      {error !== null ? <Badge tone="danger">{error}</Badge> : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 'var(--gutter)' }}>
        <Panel>
          <Readout label="Active slots" value={latest?.active_slots ?? '—'} unit={latest ? `/ ${latest.max_slots}` : undefined} tone="info" />
          {latest ? <div style={{ marginTop: 'var(--space-3)' }}><Meter value={latest.active_slots} max={latest.max_slots} tone="info" showValue={false} /></div> : null}
        </Panel>
        <Panel>
          <Readout label="Queue backlog" value={latest?.queue_backlog ?? '—'} tone={latest && latest.queue_backlog > 0 ? 'danger' : 'default'} />
        </Panel>
        <Panel>
          <Readout label="Sample rate" value="2000" unit="ms" footnote={`${points.length}/${BUFFER} points`} />
        </Panel>
      </div>

      <Panel eyebrow="Worker bus" title="Concurrency &amp; backlog">
        <div style={{ height: 256 }}>
          <ResponsiveContainer>
            <LineChart data={points}>
              <CartesianGrid stroke={GRID} />
              <XAxis dataKey="timestamp" tick={false} stroke={AXIS} />
              <YAxis stroke={AXIS} allowDecimals={false} tick={{ fontFamily: 'var(--font-mono)', fontSize: 11, fill: AXIS }} />
              <Tooltip
                contentStyle={{ background: 'oklch(0.250 0.011 73)', border: '1px solid oklch(0.305 0.012 74)', borderRadius: 5 }}
                labelStyle={{ color: 'var(--text-muted)' }}
                labelFormatter={(t) => new Date(Number(t) * 1000).toLocaleTimeString()}
              />
              <Line dataKey="active_slots" stroke={GLACIER} dot={false} isAnimationActive={false} />
              <Line dataKey="queue_backlog" stroke={RUST} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <p className="ds-label" style={{ marginTop: 'var(--space-3)' }}>
          <span style={{ color: GLACIER }}>■</span> active pool slots &nbsp;
          <span style={{ color: RUST }}>■</span> pending_scheduling / pending_dispatch backlog
        </p>
      </Panel>
    </div>
  );
}
