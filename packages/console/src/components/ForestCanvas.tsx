'use client';

/**
 * ForestCanvas — the Now universe's L2 tree (CONSOLE-REDESIGN §6), now in 3D
 * (react-force-graph-3d / ThreeJS-WebGL; §7 翻案 2026-06-15). Renders one task's
 * scope_lineage subtree (root intent → sub-tasks, depth ≤ 3) as a living
 * force-directed tree, sharing the universe's depth treatment: bloom glow,
 * directional particles, status-hued spheres, hover link highlight + tooltip.
 *
 * Interaction stability (same fixes as UniverseCanvas — see §6 / the "nodes
 * suddenly fly out of control" bug): fit-once camera, diff-before-reload so SSE
 * pulses don't reheat the layout, reduced-motion gating (bloom/particles off,
 * instant settle).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { api } from '@/lib/api';
import { toGraph, type GraphData } from '@/lib/forest-graph';
import { useTrailPulse } from '@/lib/use-trail-pulse';
import {
  STATUS_HEX,
  TASK_FALLBACK,
  LINK_HEX,
  LINK_HOT,
  SPACE_BG,
  nodeId,
  prefersReducedMotion,
  registerBloom,
  graphSignature,
  makeLabelSprite,
} from '@/lib/graph3d';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ForceGraph3D = dynamic(() => import('react-force-graph-3d'), { ssr: false }) as any;

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
        pointerEvents: 'none',
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
  const reduced = prefersReducedMotion();

  // diff-before-reload (drop idle pulses) — keyed to the current scope.
  const sigRef = useRef<string>('');
  // fit-once-per-scope latch (reset when the scope changes, below).
  const fittedRef = useRef(false);
  const reload = useCallback(() => {
    api
      .lineage(scopeId)
      .then((r) => {
        const next = toGraph(r);
        const sig = graphSignature(next.nodes, next.links);
        if (sig === sigRef.current) return;
        sigRef.current = sig;
        setData(next);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'load failed'));
  }, [scopeId]);

  // New scope → reset the dedup + camera-fit latches so the new tree reframes.
  useEffect(() => {
    sigRef.current = '';
    fittedRef.current = false;
    reload();
  }, [reload]);

  const pulseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useTrailPulse(() => {
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
    pulseTimer.current = setTimeout(reload, 800);
  });

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
  const linkHot = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (l: any) => highlight !== null && highlight.has(nodeId(l.source)) && highlight.has(nodeId(l.target)),
    [highlight],
  );

  const ready = error === null && data !== null && data.nodes.length > 0;

  const bloomRef = useRef(false);
  useEffect(() => {
    if (!ready || reduced || bloomRef.current) return;
    const fg = fgRef.current;
    if (!fg) return;
    bloomRef.current = true;
    void registerBloom(fg, { strength: 1.1, radius: 0.5, threshold: 0.12 });
  }, [ready, reduced]);

  // fit-once per scope (latch declared above; reset in the scope effect).
  const onEngineStop = useCallback(() => {
    if (fittedRef.current) return;
    fittedRef.current = true;
    fgRef.current?.zoomToFit(reduced ? 0 : 600, 70);
  }, [reduced]);

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
        <ForceGraph3D
          ref={fgRef}
          graphData={data}
          width={size.w}
          height={size.h}
          backgroundColor={SPACE_BG}
          showNavInfo={false}
          warmupTicks={reduced ? 100 : 0}
          cooldownTicks={reduced ? 0 : undefined}
          onEngineStop={onEngineStop}
          nodeRelSize={4}
          nodeVal={2}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          nodeColor={(n: any) => STATUS_HEX[n.status as string] ?? TASK_FALLBACK}
          nodeOpacity={0.92}
          nodeResolution={14}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          nodeLabel={(n: any) => n.label as string}
          nodeThreeObjectExtend
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          nodeThreeObject={(n: any) => {
            // Label the root only (depth 0) to keep the tree clean; the rest show
            // on hover via nodeLabel.
            if (n.depth !== 0) return undefined;
            return makeLabelSprite(n.label as string, 3.5, 9);
          }}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          linkColor={(l: any) => (linkHot(l) ? LINK_HOT : LINK_HEX)}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          linkWidth={(l: any) => (linkHot(l) ? 2 : 0.6)}
          linkOpacity={0.45}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          linkDirectionalParticles={(l: any) => (reduced ? 0 : linkHot(l) ? 4 : 2)}
          linkDirectionalParticleWidth={1.8}
          linkDirectionalParticleSpeed={0.006}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onNodeHover={(node: any) => {
            setHoverId(node ? (node.id as string) : null);
            document.body.style.cursor = node ? 'pointer' : 'default';
          }}
        />
      ) : null}
    </div>
  );
}
