'use client';

/**
 * UniverseCanvas — the Now hero's L0/L1 tier (CONSOLE-REDESIGN §6.1), now in 3D
 * (react-force-graph-3d / ThreeJS-WebGL; §7 翻案 2026-06-15). Reads /v1/forest
 * and renders each channel as a glowing galaxy with its root tasks orbiting;
 * clicking a task drills into its L2 tree.
 *
 * Visual depth (the reason 3D was chosen):
 *  - UnrealBloom post-processing → nodes read as light sources, not flat discs.
 *  - directional particles flow causality along the links.
 *  - galaxies = brass spheres + always-on SpriteText name; tasks = status-hued
 *    spheres; hover lifts the connected links + shows the name tooltip.
 *
 * Interaction stability (fixes the "nodes suddenly fly / zoom out of control"):
 *  - fit-once: the camera auto-frames the scene ONLY on the first settle; after
 *    that it is fully user-owned (no zoomToFit fighting your pan/zoom).
 *  - diff-before-reload: an SSE pulse only rebuilds graphData when the forest's
 *    visible signature actually changed, so idle pulses never reheat the layout.
 *  - reduced-motion: bloom + particles off, layout settles instantly.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { api } from '@/lib/api';
import { toUniverseGraph, type UniverseData } from '@/lib/forest-universe';
import { useTrailPulse } from '@/lib/use-trail-pulse';
import {
  STATUS_HEX,
  GALAXY_HEX,
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

export function UniverseCanvas({ onSelectTask }: { onSelectTask: (scopeId: string) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  const [data, setData] = useState<UniverseData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 800, h: 480 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const reduced = prefersReducedMotion();

  // Diff-before-reload: keep the last applied signature so an SSE pulse that
  // changed nothing is dropped (no setData → no reheat → no camera jump).
  const sigRef = useRef<string>('');
  const reload = useCallback(() => {
    api
      .forest()
      .then((r) => {
        const next = toUniverseGraph(r);
        const sig = graphSignature(next.nodes, next.links);
        if (sig === sigRef.current) return; // nothing visible changed
        sigRef.current = sig;
        setData(next);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'load failed'));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // Real-time: each trail pulse triggers a debounced REST reconcile (§6.3). On
  // (re)connect we reconcile immediately — the pulse is lossy, so anything that
  // landed while the stream was down (gateway restart / dropped LISTEN) is caught
  // up here instead of waiting for the next live pulse.
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useTrailPulse(
    () => {
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
      pulseTimer.current = setTimeout(reload, 800);
    },
    reload,
  );

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

  // Bloom: add exactly once after the instance exists (skip when reduced).
  const bloomRef = useRef(false);
  useEffect(() => {
    if (!ready || reduced || bloomRef.current) return;
    const fg = fgRef.current;
    if (!fg) return;
    bloomRef.current = true;
    void registerBloom(fg, { strength: 1.15, radius: 0.55, threshold: 0.1 });
  }, [ready, reduced]);

  // fit-once: frame the universe only on the first settle, then hands off to the
  // user — never refit on later reheats (that was the camera-grab bug).
  const fittedRef = useRef(false);
  const onEngineStop = useCallback(() => {
    if (fittedRef.current) return;
    fittedRef.current = true;
    fgRef.current?.zoomToFit(reduced ? 0 : 600, 80);
  }, [reduced]);

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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          nodeVal={(n: any) => (n.kind === 'galaxy' ? Math.min(3 + n.size * 1.5, 16) : Math.min(1 + n.size * 0.6, 6))}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          nodeColor={(n: any) => (n.kind === 'galaxy' ? GALAXY_HEX : STATUS_HEX[n.status as string] ?? TASK_FALLBACK)}
          nodeOpacity={0.92}
          nodeResolution={14}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          nodeLabel={(n: any) => n.label as string}
          nodeThreeObjectExtend
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          nodeThreeObject={(n: any) => {
            if (n.kind !== 'galaxy') return undefined; // tasks keep the default sphere
            // raise the name above the galaxy sphere so it never overlaps
            return makeLabelSprite(n.label as string, 4, Math.min(3 + n.size * 1.5, 16) + 7);
          }}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          linkColor={(l: any) => (linkHot(l) ? LINK_HOT : LINK_HEX)}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          linkWidth={(l: any) => (linkHot(l) ? 1.6 : 0.4)}
          linkOpacity={0.4}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          linkDirectionalParticles={(l: any) => (reduced ? 0 : linkHot(l) ? 4 : 1)}
          linkDirectionalParticleWidth={1.6}
          linkDirectionalParticleSpeed={0.006}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onNodeClick={(node: any) => {
            if (node.kind === 'task') onSelectTask(node.id as string);
          }}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onNodeHover={(node: any) => {
            setHoverId(node ? (node.id as string) : null);
            document.body.style.cursor = node && node.kind === 'task' ? 'pointer' : 'default';
          }}
        />
      ) : null}
    </div>
  );
}
