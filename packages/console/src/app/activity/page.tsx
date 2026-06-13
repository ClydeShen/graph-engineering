'use client';

/**
 * Activity — trail-mesh analytics (Hermes AnalyticsPage, Memex-native). All
 * numbers are aggregations over execution_event_log + scope_lineage served by
 * GET /v1/metrics/activity — a projection of the graph, not a separate usage
 * ledger. Daily bar chart + event-type breakdown + scope status mix.
 */

import { useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, type ActivityMetrics } from '@/lib/api';
import { Badge, Meter, Panel, Readout } from '@/components/ds';

const BRASS = 'oklch(0.730 0.110 77)';
const GRID = 'oklch(0.305 0.012 74)';
const AXIS = 'oklch(0.470 0.014 76)';

const TYPE_TONE: Record<string, string> = {
  task_spawned: 'oklch(0.650 0.052 230)',
  memory_updated: 'oklch(0.640 0.072 136)',
  plan_created: 'oklch(0.730 0.110 77)',
  scope_closed: 'oklch(0.640 0.015 78)',
  conflict_detected: 'oklch(0.595 0.135 40)',
  sub_scope_resolved: 'oklch(0.585 0.062 332)',
};

function tone(t: string): string {
  return TYPE_TONE[t] ?? 'oklch(0.600 0.050 176)';
}

export default function ActivityPage() {
  const [data, setData] = useState<ActivityMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const a = await api.activity();
        if (alive) {
          setData(a);
          setError(null);
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'load failed');
      }
    };
    void tick();
    const id = setInterval(tick, 10000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const live = data?.scopes.find((s) => s.status === 'active')?.count ?? 0;
  const suspended = data?.scopes.find((s) => s.status === 'suspended')?.count ?? 0;
  const maxType = Math.max(1, ...(data?.by_type.map((t) => t.count) ?? [1]));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gutter)' }}>
      {error !== null ? <Badge tone="danger">{error}</Badge> : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 'var(--gutter)' }}>
        <Panel><Readout label="Total events" value={data?.totals.events.toLocaleString() ?? '—'} /></Panel>
        <Panel><Readout label="Total scopes" value={data?.totals.scopes.toLocaleString() ?? '—'} /></Panel>
        <Panel><Readout label="Live scopes" value={live} tone="ok" /></Panel>
        <Panel><Readout label="Suspended" value={suspended} tone={suspended > 0 ? 'danger' : 'default'} /></Panel>
      </div>

      <Panel eyebrow="Trail mesh" title="Events per day · last 14 days">
        <div style={{ height: 240 }}>
          <ResponsiveContainer>
            <BarChart data={data?.by_day ?? []}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="day" stroke={AXIS} tick={{ fontFamily: 'var(--font-mono)', fontSize: 10, fill: AXIS }} tickFormatter={(d: string) => d.slice(5)} />
              <YAxis stroke={AXIS} allowDecimals={false} tick={{ fontFamily: 'var(--font-mono)', fontSize: 11, fill: AXIS }} />
              <Tooltip
                cursor={{ fill: 'oklch(0.250 0.011 73 / 0.5)' }}
                contentStyle={{ background: 'oklch(0.250 0.011 73)', border: '1px solid oklch(0.305 0.012 74)', borderRadius: 5 }}
                labelStyle={{ color: 'var(--text-muted)' }}
              />
              <Bar dataKey="count" fill={BRASS} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 'var(--gutter)' }}>
        <Panel eyebrow="Composition" title="Events by type">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            {(data?.by_type ?? []).map((t) => (
              <div key={t.event_type} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                    <span style={{ width: 9, height: 9, borderRadius: 2, background: tone(t.event_type) }} />
                    {t.event_type}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>{t.count.toLocaleString()}</span>
                </div>
                <div style={{ height: 5, borderRadius: 3, background: 'var(--surface-sunken)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${(t.count / maxType) * 100}%`, background: tone(t.event_type) }} />
                </div>
              </div>
            ))}
            {data !== null && data.by_type.length === 0 ? <p className="ds-label">no events yet</p> : null}
          </div>
        </Panel>

        <Panel eyebrow="Scopes" title="Status mix">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            {(data?.scopes ?? []).map((s) => (
              <Meter
                key={s.status}
                label={s.status}
                value={s.count}
                max={data?.totals.scopes ?? 1}
                tone={s.status === 'suspended' ? 'danger' : s.status === 'active' ? 'ok' : 'info'}
              />
            ))}
            {data !== null && data.scopes.length === 0 ? <p className="ds-label">no scopes yet</p> : null}
          </div>
        </Panel>
      </div>
    </div>
  );
}
