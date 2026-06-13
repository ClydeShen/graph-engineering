'use client';

/**
 * UniverseCanvas — the Now hero's L0/L1 tier (CONSOLE-REDESIGN §6.1). Reads
 * /v1/forest and renders each channel as a glowing galaxy with its root tasks
 * orbiting; clicking a task drills into its L2 tree (ForestCanvas). Same engine
 * + reduced-motion discipline as ForestCanvas.
 *
 * react-force-graph leverage (the four reference behaviours):
 *  - large-graph: custom nodeCanvasObject + pointer-area paint keep dense graphs
 *    cheap; labels are gated so a 400-node hairball stays legible.
 *  - highlight: hovering a node lifts it + its neighbours + their links, and dims
 *    the rest (globalAlpha) — the canonical focus interaction.
 *  - text-nodes: galaxy names always paint; task names paint on focus or zoom.
 *  - dynamic: SSE trail pulses debounce-reconcile against REST (§6.3).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { api } from '@/lib/api';
import { toUniverseGraph, type UniverseData } from '@/lib/forest-universe';
import { useTrailPulse } from '@/lib/use-trail-pulse';

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
const EDGE_HOT = 'oklch(0.760 0.110 80)'; // highlighted link
const DIM_ALPHA = 0.12; // non-focused nodes when something is hovered

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeId = (x: any): string => (typeof x === 'object' && x !== null ? (x.id as string) : (x as string));

function Overlay({ children, danger }: { children: React.ReactNode; danger?: boolean }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: 'var(--space-6)',
      }}
    >
      <p className="ds-label" style={danger ? { color: 'var(--status-danger)' } : undefined}>
        {children}
      </p>
    </div>
  );
}

export function UniverseCanvas({ onSelectTask }: { onSelectTask: (scopeId: string) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<UniverseData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 800, h: 480 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const reload = useCallback(() => {
    api
      .forest()
      .then((r) => {
        setData(toUniverseGraph(r));
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'load failed'));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // Real-time: each trail pulse triggers a debounced REST reconcile (§6.3 —
  // the pulse is lossy by design, REST is the truth).
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useTrailPulse(() => {
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
    pulseTimer.current = setTimeout(reload, 800);
  });

  // The ref'd container is ALWAYS mounted (loading/empty are overlays inside it),
  // so the observer attaches on first paint and never misses the real size —
  // the previous early-return left it stuck at the 800×480 default (not fullscreen).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Adjacency from the raw links (built before the engine mutates source/target
  // into node refs; norm handles either form). Drives hover highlight.
  const adjacency = useMemo(() => {
    const m = new Map<string, Set<string>>();
    if (!data) return m;
    for (const l of data.links) {
      const s = nodeId(l.source);
      const t = nodeId(l.target);
      (m.get(s) ?? m.set(s, new Set()).get(s)!).add(t);
      (m.get(t) ?? m.set(t, new Set()).get(t)!).add(s);
    }
    return m;
  }, [data]);

  const highlight = useMemo(() => {
    if (hoverId === null) return null;
    const s = new Set<string>([hoverId]);
    for (const n of adjacency.get(hoverId) ?? []) s.add(n);
    return s;
  }, [hoverId, adjacency]);

  const ready = error === null && data !== null && data.nodes.length > 0;

  return (
    <div ref={wrapRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
      {error !== null ? (
        <Overlay danger>{error}</Overlay>
      ) : data === null ? (
        <Overlay>loading the universe…</Overlay>
      ) : data.nodes.length === 0 ? (
        <Overlay>no tasks yet — dispatch one from a channel and watch the universe grow</Overlay>
      ) : null}

      {ready ? (
        <ForceGraph2D
          graphData={data}
          width={size.w}
          height={size.h}
          backgroundColor="transparent"
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          linkColor={(l: any) =>
            highlight && highlight.has(nodeId(l.source)) && highlight.has(nodeId(l.target))
              ? EDGE_HOT
              : EDGE
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          linkWidth={(l: any) =>
            highlight && highlight.has(nodeId(l.source)) && highlight.has(nodeId(l.target)) ? 2 : 0.5
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          linkDirectionalParticles={(l: any) =>
            reduced ? 0 : highlight && highlight.has(nodeId(l.source)) && highlight.has(nodeId(l.target)) ? 3 : 1
          }
          linkDirectionalParticleSpeed={0.005}
          cooldownTicks={reduced ? 0 : 120}
          warmupTicks={reduced ? 80 : 0}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onNodeClick={(node: any) => {
            if (node.kind === 'task') onSelectTask(node.id as string);
          }}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onNodeHover={(node: any) => {
            setHoverId(node ? (node.id as string) : null);
            document.body.style.cursor = node && node.kind === 'task' ? 'pointer' : 'default';
          }}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
            const focused = highlight === null || highlight.has(node.id as string);
            ctx.globalAlpha = focused ? 1 : DIM_ALPHA;

            if (node.kind === 'galaxy') {
              const r = Math.min(6 + node.size * 2, 22);
              if (!reduced && focused) {
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
              ctx.globalAlpha = 1;
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
            if (node.status === 'active' && !reduced && focused) {
              ctx.beginPath();
              ctx.arc(node.x, node.y, r + 3, 0, 2 * Math.PI);
              ctx.strokeStyle = color;
              ctx.globalAlpha = 0.35;
              ctx.stroke();
              ctx.globalAlpha = focused ? 1 : DIM_ALPHA;
            }
            if (node.status === 'suspended') {
              ctx.beginPath();
              ctx.arc(node.x, node.y, r + 2, 0, 2 * Math.PI);
              ctx.strokeStyle = color;
              ctx.lineWidth = 1.5;
              ctx.stroke();
            }
            // focus ring on the hovered node itself (shape channel, not color)
            if (node.id === hoverId) {
              ctx.beginPath();
              ctx.arc(node.x, node.y, r + 4, 0, 2 * Math.PI);
              ctx.strokeStyle = 'oklch(0.965 0.012 88)';
              ctx.lineWidth = 1.5;
              ctx.stroke();
            }
            // label: on focus (highlighted) or when zoomed in — keeps dense
            // graphs legible instead of painting every name at once.
            const isHot = highlight !== null && highlight.has(node.id as string);
            if (isHot || globalScale > 1.6) {
              const fs = Math.max(10 / globalScale, 3.5);
              ctx.font = `${fs}px ui-monospace, monospace`;
              ctx.fillStyle = 'oklch(0.875 0.021 84)';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'top';
              ctx.fillText(node.label as string, node.x, node.y + r + 2);
            }
            ctx.globalAlpha = 1;
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
      ) : null}
    </div>
  );
}
