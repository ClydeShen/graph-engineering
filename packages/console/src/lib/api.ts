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
  /** Working folder the producing scope ran in (Workspace grouping, §11.1). */
  project?: string | null;
  /** §11.3 lazy tombstone — project folder gone on disk (global feed only). */
  project_archived?: boolean;
}

export interface ForestTask {
  scope_id: string;
  intent: string | null;
  status: string;
  created_at: string;
  descendants: number;
  project: string | null;
}

export interface ForestGalaxy {
  channel: string;
  tasks: ForestTask[];
  status_counts: Record<string, number>;
}

export interface ForestProject {
  project: string;
  name: string;
  roots: number;
  archived: boolean;
}

export interface ForestResponse {
  galaxies: ForestGalaxy[];
  projects: ForestProject[];
  total_roots: number;
}

export interface LineageNode {
  scope_id: string;
  parent_scope_id: string | null;
  depth: number;
  intent: string | null;
  status: string;
  created_at: string;
}

export interface LineageResponse {
  root: string;
  nodes: LineageNode[];
}

export interface EmergenceLesson {
  id: string;
  content: string | null;
  intent: string | null;
  confidence: number;
  reinforcement_count: number;
  last_used_at: string;
  created_at: string;
}

export interface EmergenceResponse {
  lessons: EmergenceLesson[];
}

export interface TrailSseEvent {
  event_type: string;
  scope_id: string;
  event_id?: number;
  timestamp?: string;
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
  channels: Array<{ platform: string; configured: boolean; home_channel: string | null; llm: string | null }>;
  llm_overrides: {
    path: string;
    present: boolean;
    chat: LlmOverrideSlotView | null;
    embedding: LlmOverrideSlotView | null;
  };
}

export interface LlmOverrideSlotView {
  type: string | null;
  model: string | null;
  base_url: string | null;
  api_key_set: boolean;
}

/** Write shape for POST /v1/sys/llm-overrides (Appendix A). */
export interface LlmOverrideSlotInput {
  type?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}
export interface LlmOverridesInput {
  chat?: LlmOverrideSlotInput;
  embedding?: LlmOverrideSlotInput;
}

/** An ambiguous crystallization surfaced for human triage (GH #32/#34). */
export interface TriageCandidate {
  id: string;
  content: string | null;
  intent_description: string | null;
  success_count: number;
  failure_count: number;
  quality_score: number;
  injection_count: number;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `${path} → ${res.status}`);
  }
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
  forest: () => getJson<ForestResponse>('/v1/forest'),
  lineage: (scopeId: string) =>
    getJson<LineageResponse>(`/v1/scopes/${encodeURIComponent(scopeId)}/lineage`),
  emergence: (limit = 100) => getJson<EmergenceResponse>(`/v1/emergence?limit=${limit}`),
  triage: () => getJson<{ triage: TriageCandidate[] }>('/v1/memory/triage'),
  triageFeedback: (id: string, outcome: 'success' | 'failure') =>
    postJson<{ ok: boolean }>(`/v1/memory/templates/${encodeURIComponent(id)}/feedback`, { outcome }),
  triageRetire: (id: string) => postJson<{ retired: boolean }>(`/v1/memory/templates/${encodeURIComponent(id)}/retire`),
  triageReinstate: (id: string) =>
    postJson<{ reinstated: boolean }>(`/v1/memory/templates/${encodeURIComponent(id)}/reinstate`),
  allArtifacts: (limit = 200) => getJson<ArtifactMeta[]>(`/v1/artifacts?limit=${limit}`),
  sysConfig: () => getJson<SysConfig>('/v1/sys/config'),
  saveLlmOverrides: async (body: LlmOverridesInput): Promise<{ ok: boolean; applied: string }> => {
    const res = await fetch('/v1/sys/llm-overrides', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `save failed (${res.status})`);
    }
    return (await res.json()) as { ok: boolean; applied: string };
  },
  clearLlmOverrides: async (): Promise<void> => {
    const res = await fetch('/v1/sys/llm-overrides', { method: 'DELETE' });
    if (!res.ok) throw new Error(`clear failed (${res.status})`);
  },
};
