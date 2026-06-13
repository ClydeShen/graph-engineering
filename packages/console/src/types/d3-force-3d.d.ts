/**
 * Minimal ambient types for d3-force-3d (bundled by react-force-graph-2d, ships
 * no .d.ts). We only use forceCollide to spread overlapping graph nodes.
 */
declare module 'd3-force-3d' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function forceCollide(radius?: number | ((node: any) => number)): any;
}
