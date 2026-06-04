import { createHash } from 'crypto';

export function computeWLEmbedding(
  nodes: { id: string; event_type: string }[],
  edges: { source: string; target: string }[],
): Float32Array {
  const histogram = new Map<string, number>();
  const N_DIMS = 128;
  const DEPTH = 3;

  let labels = new Map(nodes.map((n) => [n.id, n.event_type]));

  for (let iter = 0; iter < DEPTH; iter++) {
    const newLabels = new Map<string, string>();
    for (const node of nodes) {
      const neighborLabels = edges
        .filter((e) => e.target === node.id)
        .map((e) => labels.get(e.source)!)
        .sort();
      const hash = createHash('sha256')
        .update(`${labels.get(node.id)}|${neighborLabels.join(',')}`)
        .digest('hex');
      newLabels.set(node.id, hash);
      histogram.set(hash, (histogram.get(hash) ?? 0) + 1);
    }
    labels = newLabels;
  }

  const vec = new Float32Array(N_DIMS);
  for (const [hash, count] of histogram) {
    for (let i = 0; i < 32; i++) {
      const byte = parseInt(hash.slice(i * 2, i * 2 + 2), 16);
      vec[byte % N_DIMS] += count;
    }
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / (norm || 1));
}
