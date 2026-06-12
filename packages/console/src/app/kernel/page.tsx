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

const BUFFER = 300;

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

  return (
    <div className="space-y-4">
      <h1 className="text-gray-100">Kernel metrics</h1>
      {error !== null && <p className="text-danger">{error}</p>}
      <div className="h-64 border border-line rounded bg-panel p-2">
        <ResponsiveContainer>
          <LineChart data={points}>
            <CartesianGrid stroke="#30363d" />
            <XAxis dataKey="timestamp" tick={false} stroke="#555" />
            <YAxis stroke="#555" allowDecimals={false} />
            <Tooltip
              contentStyle={{ background: '#161b22', border: '1px solid #30363d' }}
              labelFormatter={(t) => new Date(Number(t) * 1000).toLocaleTimeString()}
            />
            <Line dataKey="active_slots" stroke="#4A9EFF" dot={false} isAnimationActive={false} />
            <Line dataKey="queue_backlog" stroke="#FF4D4F" dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="text-gray-500">
        blue: active pool slots · red: pending_scheduling/pending_dispatch backlog · {points.length}/{BUFFER} points
      </p>
    </div>
  );
}
