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

export interface ConversationMessage {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

export interface ActivityMetrics {
  by_type: Array<{ event_type: string; count: number }>;
  by_day: Array<{ day: string; count: number }>;
  scopes: Array<{ status: string; count: number }>;
  totals: { events: number; scopes: number };
}

export interface SysConfig {
  config_path: string;
  profile: string | null;
  config_present: boolean;
  gateway: { port: number | null; websocket: boolean; token_set: boolean };
  providers: Array<{
    name: string;
    display_name: string;
    model: string;
    priority: number;
    base_url: string | null;
    api: string;
    local: boolean;
    supports_embedding: boolean;
    api_key: string;
  }>;
  embedding: {
    configured: boolean;
    source: string | null;
    base_url: string | null;
    model: string | null;
  };
  channels: Array<{ platform: string; configured: boolean; home_channel: string | null }>;
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
  messages: (scopeId: string) =>
    getJson<{ messages: ConversationMessage[] }>(`/v1/scopes/${encodeURIComponent(scopeId)}/messages`),
  activity: () => getJson<ActivityMetrics>('/v1/metrics/activity'),
  sysConfig: () => getJson<SysConfig>('/v1/sys/config'),
};
