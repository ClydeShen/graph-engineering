'use client';

/**
 * UniverseCanvas — the Now hero's L0/L1 tier (CONSOLE-REDESIGN §6.1). Reads
 * /v1/forest and renders each channel as a glowing galaxy with its root tasks
 * orbiting; clicking a task drills into its L2 tree (ForestCanvas). Same engine
 * + reduced-motion discipline as ForestCanvas.
 */

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { api } from '@/lib/api';
import { toUniverseGraph, type UniverseData } from '@/lib/forest-universe';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false }) as any;

// Status palette mirrors ForestCanvas (CONSOLE-REDESIGN §6 — single source is
// the design doc; kept inline to avoid coupling the pure data module to colors).
const STATUS_COLOR: Record<string, string> = {
  active: 'oklch(0.650 0.052 230)',
  converged: 'oklch(0.640 0.072 136)',
  closed: 'oklch(0.640 0.015 78)',
  suspended: 'oklch(0.595 0.135 40)',
};
const GALAXY_COLOR = 'oklch(0.730 0.110 77)'; // brass — the channel signal
const FALLBACK = 'oklch(0.470 0.014 76)';
const EDGE = 'oklch(0.500 0.045 178)';

export function UniverseCanvas({ onSelectTask }: { onSelectTask: (scopeId: string) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<UniverseData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 800, h: 480 });
  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    let alive = true;
    api
      .forest()
      .then((r) => {
        if (alive) {
          setData(toUniverseGraph(r));
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : 'load failed');
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (error !== null)
    return <p className="ds-label" style={{ color: 'var(--status-danger)' }}>{error}</p>;
  if (data === null) return <p className="ds-label">loading the universe…</p>;
  if (data.nodes.length === 0)
    return (
      <p className="ds-label">
        no tasks yet — dispatch one from a channel and watch the universe grow
      </p>
    );

  return (
    <div ref={wrapRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
      <ForceGraph2D
        graphData={data}
        width={size.w}
        height={size.h}
        backgroundColor="transparent"
        linkColor={() => EDGE}
        linkDirectionalParticles={reduced ? 0 : 1}
        linkDirectionalParticleSpeed={0.005}
        cooldownTicks={reduced ? 0 : 120}
        warmupTicks={reduced ? 80 : 0}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onNodeClick={(node: any) => {
          if (node.kind === 'task') onSelectTask(node.id as string);
        }}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onNodeHover={(node: any) => {
          document.body.style.cursor = node && node.kind === 'task' ? 'pointer' : 'default';
        }}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
          if (node.kind === 'galaxy') {
            const r = Math.min(6 + node.size * 2, 22);
            if (!reduced) {
              const grad = ctx.createRadialGradient(node.x, node.y, r * 0.3, node.x, node.y, r * 1.8);
              grad.addColorStop(0, 'oklch(0.730 0.110 77 / 0.5)');
              grad.addColorStop(1, 'oklch(0.730 0.110 77 / 0)');
              ctx.fillStyle = grad;
              ctx.beginPath();
              ctx.arc(node.x, node.y, r * 1.8, 0, 2 * Math.PI);
              ctx.fill();
            }
            ctx.beginPath();
            ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
            ctx.fillStyle = GALAXY_COLOR;
            ctx.fill();
            const fs = Math.max(11 / globalScale, 3);
            ctx.font = `600 ${fs}px ui-sans-serif, system-ui`;
            ctx.fillStyle = 'oklch(0.965 0.012 88)';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(node.label as string, node.x, node.y);
            return;
          }
          // task node
          const color = STATUS_COLOR[node.status as string] ?? FALLBACK;
          const r = Math.min(3 + node.size, 9);
          ctx.beginPath();
          ctx.arc(node.x, node.y + 1.5, r, 0, 2 * Math.PI);
          ctx.fillStyle = 'rgba(10,8,4,0.4)';
          ctx.fill();
          ctx.beginPath();
          ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
          if (node.status === 'active' && !reduced) {
            ctx.beginPath();
            ctx.arc(node.x, node.y, r + 3, 0, 2 * Math.PI);
            ctx.strokeStyle = color;
            ctx.globalAlpha = 0.35;
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
          if (node.status === 'suspended') {
            ctx.beginPath();
            ctx.arc(node.x, node.y, r + 2, 0, 2 * Math.PI);
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
          if (globalScale > 1.6) {
            const fs = 10 / globalScale;
            ctx.font = `${fs}px ui-monospace, monospace`;
            ctx.fillStyle = 'oklch(0.875 0.021 84)';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(node.label as string, node.x, node.y + r + 2);
          }
        }}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
          const r =
            node.kind === 'galaxy' ? Math.min(6 + node.size * 2, 22) : Math.min(3 + node.size, 9) + 2;
          ctx.beginPath();
          ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
        }}
      />
    </div>
  );
}
