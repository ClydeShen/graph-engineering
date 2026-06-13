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

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { api } from '@/lib/api';
import { toGraph, type GraphData } from '@/lib/forest-graph';

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

export function ForestCanvas({ scopeId }: { scopeId: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 800, h: 480 });

  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    let alive = true;
    api
      .lineage(scopeId)
      .then((r) => {
        if (alive) {
          setData(toGraph(r));
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : 'load failed');
      });
    return () => {
      alive = false;
    };
  }, [scopeId]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (error !== null)
    return <p className="ds-label" style={{ color: 'var(--status-danger)' }}>{error}</p>;
  if (data === null) return <p className="ds-label">loading the task tree…</p>;
  if (data.nodes.length === 0)
    return <p className="ds-label">no sub-tasks yet — this task is a single node</p>;

  return (
    <div ref={wrapRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
      <ForceGraph2D
        graphData={data}
        width={size.w}
        height={size.h}
        backgroundColor="transparent"
        linkColor={() => EDGE_COLOR}
        linkWidth={1}
        linkDirectionalParticles={reduced ? 0 : 2}
        linkDirectionalParticleSpeed={0.006}
        linkDirectionalParticleWidth={2}
        cooldownTicks={reduced ? 0 : 120}
        warmupTicks={reduced ? 80 : 0}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
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
          if (node.status === 'active' && !reduced) {
            ctx.beginPath();
            ctx.arc(node.x, node.y, r + 3, 0, 2 * Math.PI);
            ctx.strokeStyle = color;
            ctx.globalAlpha = 0.35;
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
          // suspended → exclamation ring (shape channel, always shown)
          if (node.status === 'suspended') {
            ctx.beginPath();
            ctx.arc(node.x, node.y, r + 2, 0, 2 * Math.PI);
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
          // label only when zoomed in (semantic-zoom LOD)
          if (globalScale > 1.4) {
            const fontSize = 11 / globalScale;
            ctx.font = `${fontSize}px ui-monospace, monospace`;
            ctx.fillStyle = 'oklch(0.935 0.020 86)'; // bone
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(node.label as string, node.x, node.y + r + 2);
          }
        }}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
          ctx.beginPath();
          ctx.arc(node.x, node.y, 9, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
        }}
      />
    </div>
  );
}
