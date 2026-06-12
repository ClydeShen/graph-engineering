'use client';

/**
 * Page 1 canvas — G6 v5 owns the canvas exclusively; React owns the shell
 * (UI-SPEC principle 3). Polling diff: only new nodes/edges get enter
 * animations; unchanged polls skip rendering.
 */

import { useEffect, useRef, useState } from 'react';
import { api, type TopologyNode, type TopologyResponse } from '@/lib/api';
import { diffTopology, nodeColor } from '@/lib/topology-diff';

interface G6GraphLike {
  addNodeData(nodes: unknown[]): void;
  addEdgeData(edges: unknown[]): void;
  setData(data: unknown): void;
  render(): Promise<void>;
  destroy(): void;
  on(event: string, cb: (e: { target?: { id?: string } }) => void): void;
}

export function TopologyCanvas({ scopeId }: { scopeId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<G6GraphLike | null>(null);
  const lastRef = useRef<TopologyResponse | null>(null);
  const [selected, setSelected] = useState<TopologyNode | null>(null);
  const [status, setStatus] = useState('connecting…');

  useEffect(() => {
    if (!containerRef.current || scopeId.length === 0) return;
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    void (async () => {
      const { Graph } = await import('@antv/g6');
      if (!alive || !containerRef.current) return;

      const graph = new Graph({
        container: containerRef.current,
        autoResize: true,
        layout: { type: 'force', preventOverlap: true },
        animation: true,
        node: {
          style: { labelText: (d: { id?: string }) => (d.id ?? '').slice(0, 8) },
          animation: { enter: 'fade' },
        },
        edge: { style: { endArrow: true, stroke: '#444444' }, animation: { enter: 'fade' } },
        behaviors: ['zoom-canvas', 'drag-canvas', 'drag-element'],
      }) as unknown as G6GraphLike;
      graphRef.current = graph;

      graph.on('node:click', (e) => {
        const id = e.target?.id;
        const found = lastRef.current?.nodes.find((n) => n.id === id) ?? null;
        setSelected(found);
      });

      const toG6Node = (n: TopologyNode) => ({
        id: n.id,
        data: { event_type: n.event_type, entity_id: n.entity_id },
        style: { fill: nodeColor(n.event_type) },
      });
      const toG6Edge = (e: { source: string; target: string }) => ({
        id: `${e.source}→${e.target}`,
        source: e.source,
        target: e.target,
      });

      const poll = async () => {
        try {
          const next = await api.topology(scopeId);
          if (!alive) return;
          const diff = diffTopology(lastRef.current, next);
          if (lastRef.current === null) {
            graph.setData({ nodes: next.nodes.map(toG6Node), edges: next.edges.map(toG6Edge) });
            await graph.render();
          } else if (!diff.unchanged) {
            graph.addNodeData(diff.addedNodes.map(toG6Node));
            graph.addEdgeData(diff.addedEdges.map(toG6Edge));
            await graph.render();
          }
          lastRef.current = next;
          setStatus(`${next.nodes.length} nodes${next.truncated ? ' (truncated at 500)' : ''}`);
        } catch (err) {
          if (alive) setStatus(err instanceof Error ? err.message : 'poll failed');
        }
      };

      await poll();
      timer = setInterval(poll, 2000);
    })();

    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      graphRef.current?.destroy();
      graphRef.current = null;
      lastRef.current = null;
    };
  }, [scopeId]);

  return (
    <div className="flex gap-4 h-[calc(100vh-7rem)]">
      <div className="flex-1 border border-line rounded bg-panel relative">
        <div ref={containerRef} className="absolute inset-0" />
        <span className="absolute bottom-2 left-2 text-xs text-gray-500">{status}</span>
      </div>
      <aside className="w-80 shrink-0 border border-line rounded bg-panel p-3 overflow-auto">
        <h2 className="text-gray-100 mb-2">Inspector</h2>
        {selected === null ? (
          <p className="text-gray-500">click a node</p>
        ) : (
          <dl className="space-y-1 break-all">
            <dt className="text-gray-500">version_hash</dt>
            <dd>{selected.id}</dd>
            <dt className="text-gray-500">entity_id</dt>
            <dd>{selected.entity_id}</dd>
            <dt className="text-gray-500">event_type</dt>
            <dd style={{ color: nodeColor(selected.event_type) }}>{selected.event_type}</dd>
          </dl>
        )}
      </aside>
    </div>
  );
}
