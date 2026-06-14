/**
 * Shared 3D force-graph helpers (CONSOLE-REDESIGN §6/§7 — 2D→3D 翻案 2026-06-15).
 *
 * The Now universe moved from react-force-graph-2d (flat canvas) to
 * react-force-graph-3d (ThreeJS/WebGL) for the depth the design always wanted.
 * These helpers are the bits both the universe (L0/L1) and the tree (L2) share:
 * a hex status palette (ThreeJS materials want hex, not the oklch tokens), an
 * UnrealBloom registrar (the "glow"), a graph signature for diff-before-reload
 * (so SSE pulses don't reheat the simulation when nothing actually changed —
 * the root cause of the "nodes suddenly fly/zoom out of control" bug), and the
 * reduced-motion gate.
 */

// Hex mirror of the observatory status palette (ForestCanvas/UniverseCanvas
// oklch tokens). ThreeJS Color does not parse oklch reliably, so the WebGL
// surface uses the nearest hex; bloom makes them read as the same glow family.
import SpriteText from 'three-spritetext';

export const STATUS_HEX: Record<string, string> = {
  active: '#6aa7c4', // glacier — "thinking"
  converged: '#84b06a', // moss — "done well"
  closed: '#8a8578', // ink — "archived"
  suspended: '#c2683f', // rust — "hit a wall"
};
export const GALAXY_HEX = '#cda24a'; // brass — the channel signal
export const TASK_FALLBACK = '#6f6a5e';
export const LINK_HEX = '#4f7d80'; // patina
export const LINK_HOT = '#d8a23e'; // highlighted branch
/** Dark space background — bloom needs a dark field to read as glow. */
export const SPACE_BG = '#05060a';

/**
 * Build a node label as a ThreeJS text sprite, raised `y` units above the node
 * so it never overlaps the sphere. Returned to react-force-graph as an extended
 * nodeThreeObject. (position is cast because three's Object3D types don't always
 * resolve through the three-spritetext re-export under moduleResolution=bundler.)
 */
export function makeLabelSprite(text: string, textHeight: number, y: number): SpriteText {
  const s = new SpriteText(text);
  s.color = '#f4ecd8';
  s.textHeight = textHeight;
  s.fontFace = 'ui-sans-serif, system-ui';
  (s as unknown as { position: { set: (x: number, y: number, z: number) => void } }).position.set(0, y, 0);
  return s;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const nodeId = (x: any): string =>
  typeof x === 'object' && x !== null ? (x.id as string) : (x as string);

/**
 * Add an UnrealBloom post-processing pass to a ForceGraph3D instance exactly
 * once (the caller guards re-entry with a ref). No-op under reduced motion or
 * before the composer exists. Dynamic import keeps the heavy ThreeJS addon off
 * the initial bundle.
 */
export async function registerBloom(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fg: any,
  opts: { strength?: number; radius?: number; threshold?: number } = {},
): Promise<void> {
  if (!fg || typeof fg.postProcessingComposer !== 'function') return;
  const { UnrealBloomPass } = await import(
    'three/examples/jsm/postprocessing/UnrealBloomPass.js'
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pass: any = new UnrealBloomPass(undefined as never, 1.0, 0.6, 0.1);
  pass.strength = opts.strength ?? 1.1;
  pass.radius = opts.radius ?? 0.55;
  pass.threshold = opts.threshold ?? 0.12;
  fg.postProcessingComposer().addPass(pass);
}

/**
 * Stable signature of a graph's *visible* state (node ids + status + size, and
 * link endpoints). Used to skip setData() on an SSE pulse that changed nothing —
 * which prevents a needless d3 reheat (and therefore the position jitter +
 * camera-refit that read as "the graph going out of control").
 */
export function graphSignature(
  nodes: Array<{ id: string; status?: string; size?: number }>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  links: Array<{ source: any; target: any }>,
): string {
  const n = nodes
    .map((x) => `${x.id}:${x.status ?? ''}:${x.size ?? ''}`)
    .sort()
    .join(',');
  const l = links
    .map((x) => `${nodeId(x.source)}>${nodeId(x.target)}`)
    .sort()
    .join(',');
  return `${n}|${l}`;
}
