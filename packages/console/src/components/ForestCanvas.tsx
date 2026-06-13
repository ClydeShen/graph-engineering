'use client';

/**
 * ForestCanvas — the Now universe's tree renderer (CONSOLE-REDESIGN §6, batch 6).
 * Replaces the G6 TopologyCanvas: instead of one scope's entity graph, it renders
 * a task's scope_lineage subtree (root intent → sub-tasks, depth ≤ 3) as a living
 * force-directed tree via react-force-graph-2d + d3-force.
 *
 * ui-ux-pro-max rules applied:
 *  - state→HUD color + shape (not color alone): status drives fill; active gets a
 *    halo. (CONSOLE-REDESIGN §6 palette, observatory oklch tokens.)
 *  - semantic-zoom LOD: labels only paint past a globalScale threshold.
 *  - causality-as-motion: linkDirectionalParticles flow along the branches.
 *  - reduced-motion guard (Appendix B.3④): the canvas rAF loop is NOT reachable by
 *    the CSS media query, so we read matchMedia in JS and drop particles + freeze
 *    the layout (cooldownTicks 0, one-shot warmup) when the user asked for less.
 *  - loading + empty states (no blank canvas).
 *
 * react-force-graph-2d touches window/canvas, so it is dynamically imported with
 * ssr:false (Next.js requirement). Its props/canvas callbacks are loosely typed
 * here (the lib's own types are lost through next/dynamic) — intentional `any` at
 * that single boundary, documented.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { forceCollide } from 'd3-force-3d';
import { api } from '@/lib/api';
import { toGraph, type GraphData } from '@/lib/forest-graph';
import { useTrailPulse } from '@/lib/use-trail-pulse';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false }) as any;

/** Status → fill (CONSOLE-REDESIGN §6 state palette). Shape/halo adds a second,
 *  non-color channel so the encoding survives color-blindness (rule color-not-only). */
const STATUS_COLOR: Record<string, string> = {
  active: 'oklch(0.650 0.052 230)', // glacier — "thinking"
  converged: 'oklch(0.640 0.072 136)', // moss — "done well"
  closed: 'oklch(0.640 0.015 78)', // ink-400 — "archived"
  suspended: 'oklch(0.595 0.135 40)', // rust — "hit a wall"
};
const FALLBACK_COLOR = 'oklch(0.470 0.014 76)';
const EDGE_COLOR = 'oklch(0.500 0.045 178)'; // patina
const EDGE_HOT = 'oklch(0.760 0.110 80)'; // highlighted branch
const DIM_ALPHA = 0.12;

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

export function ForestCanvas({ scopeId }: { scopeId: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 800, h: 480 });
  const [hoverId, setHoverId] = useState<string | null>(null);

  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const reload = useCallback(() => {
    api
      .lineage(scopeId)
      .then((r) => {
        setData(toGraph(r));
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'load failed'));
  }, [scopeId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Real-time: trail pulses trigger a debounced reconcile of this subtree (§6.3).
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useTrailPulse(() => {
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
    pulseTimer.current = setTimeout(reload, 800);
  });

  // Always-mounted ref'd container (overlays inside) — fixes the size-stuck-at-
  // default bug where the observer attached before the canvas div existed.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

  // Spread overlapping task nodes (all radius 6 → collide at 12).
  useEffect(() => {
    if (!ready) return;
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3Force('collide', forceCollide(12));
    fg.d3ReheatSimulation?.();
  }, [ready, data]);

  return (
    <div ref={wrapRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
      {error !== null ? (
        <Overlay danger>{error}</Overlay>
      ) : data === null ? (
        <Overlay>loading the task tree…</Overlay>
      ) : data.nodes.length === 0 ? (
        <Overlay>no sub-tasks yet — this task is a single node</Overlay>
      ) : null}

      {ready ? (
        <ForceGraph2D
          ref={fgRef}
          graphData={data}
          width={size.w}
          height={size.h}
          backgroundColor="transparent"
          autoPauseRedraw={false}
          onEngineStop={() => fgRef.current?.zoomToFit(reduced ? 0 : 500, 48)}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          linkColor={(l: any) =>
            highlight && highlight.has(nodeId(l.source)) && highlight.has(nodeId(l.target))
              ? EDGE_HOT
              : EDGE_COLOR
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          linkWidth={(l: any) =>
            highlight && highlight.has(nodeId(l.source)) && highlight.has(nodeId(l.target)) ? 2.5 : 1
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          linkDirectionalParticles={(l: any) =>
            reduced ? 0 : highlight && highlight.has(nodeId(l.source)) && highlight.has(nodeId(l.target)) ? 4 : 2
          }
          linkDirectionalParticleSpeed={0.006}
          linkDirectionalParticleWidth={2}
          cooldownTicks={reduced ? 0 : 120}
          warmupTicks={reduced ? 80 : 0}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onNodeHover={(node: any) => {
            setHoverId(node ? (node.id as string) : null);
            document.body.style.cursor = node ? 'pointer' : 'default';
          }}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
            const focused = highlight === null || highlight.has(node.id as string);
            ctx.globalAlpha = focused ? 1 : DIM_ALPHA;
            const color = STATUS_COLOR[node.status as string] ?? FALLBACK_COLOR;
            const r = 6;
            // 2.5D drop shadow — depth cue
            ctx.beginPath();
            ctx.arc(node.x, node.y + 2.5, r, 0, 2 * Math.PI);
            ctx.fillStyle = 'rgba(10,8,4,0.4)';
            ctx.fill();
            // node body
            ctx.beginPath();
            ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
            ctx.fillStyle = color;
            ctx.fill();
            // active → soft halo ("thinking"); second visual channel beyond color
            if (node.status === 'active' && !reduced && focused) {
              ctx.beginPath();
              ctx.arc(node.x, node.y, r + 3, 0, 2 * Math.PI);
              ctx.strokeStyle = color;
              ctx.globalAlpha = 0.35;
              ctx.stroke();
              ctx.globalAlpha = focused ? 1 : DIM_ALPHA;
            }
            // suspended → exclamation ring (shape channel, always shown)
            if (node.status === 'suspended') {
              ctx.beginPath();
              ctx.arc(node.x, node.y, r + 2, 0, 2 * Math.PI);
              ctx.strokeStyle = color;
              ctx.lineWidth = 1.5;
              ctx.stroke();
            }
            // focus ring on the hovered node itself
            if (node.id === hoverId) {
              ctx.beginPath();
              ctx.arc(node.x, node.y, r + 4, 0, 2 * Math.PI);
              ctx.strokeStyle = 'oklch(0.965 0.012 88)';
              ctx.lineWidth = 1.5;
              ctx.stroke();
            }
            // label: on focus or when zoomed in (semantic-zoom LOD)
            const isHot = highlight !== null && highlight.has(node.id as string);
            if (isHot || globalScale > 1.4) {
              const fontSize = Math.max(11 / globalScale, 3.5);
              ctx.font = `${fontSize}px ui-monospace, monospace`;
              ctx.fillStyle = 'oklch(0.935 0.020 86)'; // bone
              ctx.textAlign = 'center';
              ctx.textBaseline = 'top';
              ctx.fillText(node.label as string, node.x, node.y + r + 2);
            }
            ctx.globalAlpha = 1;
          }}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
            ctx.beginPath();
            ctx.arc(node.x, node.y, 9, 0, 2 * Math.PI);
            ctx.fillStyle = color;
            ctx.fill();
          }}
        />
      ) : null}
    </div>
  );
}
