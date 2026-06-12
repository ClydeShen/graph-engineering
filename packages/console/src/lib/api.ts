/**
 * Gateway API client (Console is a pure REST/SSE consumer — Shell owns no
 * state). All paths are same-origin /v1/* (next.config rewrites proxy to the
 * gateway in dev; production serves behind the same reverse proxy).
 */

export interface HealthResponse {
  engine_status: string;
  live_scopes?: number;
  suspended_count?: number;
  slots?: number;
  idle_slots?: number;
}

export interface TopologyNode {
  id: string;
  entity_id: string;
  event_type: string;
}

export interface TopologyEdge {
  source: string;
  target: string;
}

export interface TopologyResponse {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  truncated: boolean;
}

export interface InfraMetrics {
  timestamp: number;
  active_slots: number;
  max_slots: number;
  queue_backlog: number;
}

export interface SuspendedScope {
  scope_id: string;
  status: string;
  error_reason: string;
  frozen_at: string | null;
  unconverged_nodes_count: number;
}

export interface ScopeSummary {
  scope_id: string;
  intent: string | null;
  status: string;
  created_at: string;
}

export interface ArtifactMeta {
  content_hash: string;
  scope_id: string;
  entity_id: string;
  kind: string;
  media_type: string;
  byte_size: number;
  label: string;
  created_at: string;
  erased_at: string | null;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  health: () => getJson<HealthResponse>('/v1/sys/health'),
  scopes: (limit = 50) => getJson<{ scopes: ScopeSummary[] }>(`/v1/scopes?limit=${limit}`),
  topology: (scopeId: string) => getJson<TopologyResponse>(`/v1/scopes/${encodeURIComponent(scopeId)}/topology`),
  metrics: () => getJson<InfraMetrics>('/v1/metrics/infra'),
  suspended: () => getJson<SuspendedScope[]>('/v1/scopes/audit/suspended'),
  artifacts: (scopeId: string) => getJson<ArtifactMeta[]>(`/v1/scopes/${encodeURIComponent(scopeId)}/artifacts`),
  artifactUrl: (hash: string) => `/v1/artifacts/${hash}`,
};
