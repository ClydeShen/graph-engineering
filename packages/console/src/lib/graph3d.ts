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
import * as THREE from 'three';
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

// Status → emissive intensity. The §9 "node art" vocabulary encodes work state on
// a NON-colour channel (glow), so the universe stays legible for colour-blind
// users and through bloom: active "thinks" (brightest), converged is a steady
// "done well", suspended is a warm-but-static "hit a wall", closed is a barely-lit
// "archived". (color-not-only / pattern-texture.)
export const STATUS_EMISSIVE: Record<string, number> = {
  active: 0.9,
  converged: 0.55,
  suspended: 0.5,
  closed: 0.18,
};
// Status → opacity: archived/closed work fades back; suspended dims slightly.
const STATUS_OPACITY: Record<string, number> = {
  active: 1,
  converged: 1,
  suspended: 0.75,
  closed: 0.5,
};

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

export interface UniverseNodeLike {
  kind: 'galaxy' | 'task';
  status?: string;
  size?: number;
  label?: string;
}

/**
 * Visual radius — mirrors the previous nodeVal mapping exactly so the force
 * layout and overall scale are unchanged by the art swap.
 */
function nodeRadius(n: UniverseNodeLike): number {
  return n.kind === 'galaxy'
    ? Math.min(3 + (n.size ?? 1) * 1.5, 16)
    : Math.min(1 + (n.size ?? 1) * 0.6, 6);
}

/**
 * Build a node's 3D object — the §9 "node art", implemented 3D-native rather
 * than as flat 2D sprite billboards (the 2.5D-era seam): kind is legible by
 * SHAPE (galaxy = smooth icosahedron "star" carrying the channel name; task =
 * faceted octahedron "shard"), status by EMISSIVE + OPACITY (not colour alone),
 * and aliveness by a gentle emissive pulse on ACTIVE work only (motion = cause:
 * "thinking"; never decorative; disabled under reduced motion). MeshLambert +
 * emissive matches the library's default lighting so UnrealBloom still reads the
 * nodes as light sources.
 */
export function makeNodeObject(n: UniverseNodeLike, reduced: boolean): THREE.Object3D {
  const r = nodeRadius(n);
  const isGalaxy = n.kind === 'galaxy';
  const hex = isGalaxy ? GALAXY_HEX : STATUS_HEX[n.status ?? ''] ?? TASK_FALLBACK;
  const color = new THREE.Color(hex);
  const baseEmissive = isGalaxy ? 0.7 : STATUS_EMISSIVE[n.status ?? ''] ?? 0.3;

  const geom = isGalaxy
    ? new THREE.IcosahedronGeometry(r, 1)
    : new THREE.OctahedronGeometry(r, 0);
  const mat = new THREE.MeshLambertMaterial({
    color,
    emissive: color,
    emissiveIntensity: baseEmissive,
    transparent: true,
    opacity: isGalaxy ? 0.95 : STATUS_OPACITY[n.status ?? ''] ?? 0.9,
  });
  const mesh = new THREE.Mesh(geom, mat);

  // Aliveness: only ACTIVE work breathes (emissive sine). The render loop already
  // runs for the link particles, so onBeforeRender ticks every frame with no
  // extra timer. reduced-motion → no pulse at all (steady glow).
  if (!reduced && n.status === 'active') {
    const t0 = performance.now();
    mesh.onBeforeRender = () => {
      const t = (performance.now() - t0) / 1000;
      mat.emissiveIntensity = baseEmissive + 0.35 * (0.5 + 0.5 * Math.sin(t * 2.2));
    };
  }

  if (isGalaxy && n.label) {
    const group = new THREE.Group();
    group.add(mesh);
    group.add(makeLabelSprite(n.label, 4, r + 7));
    return group;
  }
  return mesh;
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
