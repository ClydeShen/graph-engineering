/**
 * MemexTerminalClient — pure protocol client for the Gateway realtime API.
 *
 * Zero state ownership: every field of TerminalSession derives from the graph
 * (scope_id from POST /v1/scopes, tip_hash from turn results). The client owns
 * only transport concerns: WS lifecycle, request/response correlation,
 * trail-event fan-in.
 *
 * Transport is injectable (wsFactory / fetchFn) so the protocol logic is fully
 * unit-testable without sockets. Defaults use the global WebSocket/fetch
 * (Node ≥ 22 and Bun both provide them).
 *
 * @see docs/adr/0053-adr44-realtime-ws-sse-api.md — protocol contract
 * @see @graph/types/shell — message shapes
 */

import type {
  WsClientMessage,
  WsServerMessage,
  WsTurnResultMessage,
  TrailSseEvent,
  TerminalSession,
} from '@graph/types/shell';

/** Minimal WebSocket surface the client needs (subset of the WHATWG interface). */
export interface WsLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    cb: (evt: { data?: unknown }) => void,
  ): void;
}

export interface TerminalClientOptions {
  gatewayUrl: string;
  token?: string;
  /** Injectable for tests. Default: global WebSocket. */
  wsFactory?: (url: string) => WsLike;
  /** Injectable for tests. Default: global fetch. */
  fetchFn?: typeof fetch;
  /** Per-request turn timeout. */
  turnTimeoutMs?: number;
}

export class MemexTerminalClient {
  private ws: WsLike | null = null;
  private pending = new Map<string, { resolve: (m: WsTurnResultMessage) => void; timer: ReturnType<typeof setTimeout> }>();
  private trailHandlers = new Set<(evt: TrailSseEvent) => void>();
  private requestSeq = 0;
  readonly session: TerminalSession = { scope_id: '', tip_hash: '', connected: false };

  constructor(private readonly opts: TerminalClientOptions) {}

  private get fetchFn(): typeof fetch {
    return this.opts.fetchFn ?? fetch;
  }

  private httpUrl(path: string): string {
    return this.opts.gatewayUrl.replace(/\/$/, '') + path;
  }

  private wsUrl(): string {
    const base = this.opts.gatewayUrl.replace(/\/$/, '').replace(/^http/, 'ws') + '/ws';
    return this.opts.token !== undefined ? `${base}?token=${encodeURIComponent(this.opts.token)}` : base;
  }

  /** POST /v1/scopes — create the session scope. */
  async createScope(intent: string): Promise<TerminalSession> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.token !== undefined) headers['Authorization'] = `Bearer ${this.opts.token}`;
    const res = await this.fetchFn(this.httpUrl('/v1/scopes'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ intent }),
    });
    if (!res.ok) throw new Error(`createScope failed: ${res.status}`);
    const body = (await res.json()) as { scope_id: string; plan_hash: string };
    this.session.scope_id = body.scope_id;
    this.session.tip_hash = body.plan_hash;
    return { ...this.session };
  }

  /** Open the WS connection and wire message dispatch. Resolves on open. */
  connect(): Promise<void> {
    const factory = this.opts.wsFactory ?? ((url: string) => new WebSocket(url) as unknown as WsLike);
    const ws = factory(this.wsUrl());
    this.ws = ws;

    return new Promise((resolve, reject) => {
      ws.addEventListener('open', () => {
        this.session.connected = true;
        resolve();
      });
      ws.addEventListener('error', () => {
        if (!this.session.connected) reject(new Error('WS connection failed'));
      });
      ws.addEventListener('close', () => {
        this.session.connected = false;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
        }
        this.pending.clear();
      });
      ws.addEventListener('message', (evt) => {
        this.dispatch(String(evt.data));
      });
    });
  }

  /** Handle one server message (exposed for tests). */
  dispatch(raw: string): void {
    let msg: WsServerMessage;
    try {
      msg = JSON.parse(raw) as WsServerMessage;
    } catch {
      return;
    }
    if (msg.type === 'turn_result' || msg.type === 'error') {
      const requestId = 'request_id' in msg ? msg.request_id : undefined;
      if (requestId !== undefined && this.pending.has(requestId)) {
        const entry = this.pending.get(requestId)!;
        clearTimeout(entry.timer);
        this.pending.delete(requestId);
        if (msg.type === 'turn_result') {
          if (msg.version_hash !== undefined) this.session.tip_hash = msg.version_hash;
          entry.resolve(msg);
        } else {
          entry.resolve({ type: 'turn_result', request_id: requestId, error: msg.message, context: null });
        }
      }
      return;
    }
    if (msg.type === 'trail_event') {
      for (const handler of this.trailHandlers) handler(msg);
    }
  }

  private send(msg: WsClientMessage): void {
    if (this.ws === null) throw new Error('not connected');
    this.ws.send(JSON.stringify(msg));
  }

  /** Subscribe to live trail events for the session scope (or all with '*'). */
  subscribe(scopeId?: string): void {
    this.send({ type: 'subscribe', ...(scopeId !== undefined ? { scope_id: scopeId } : {}) });
  }

  onTrailEvent(handler: (evt: TrailSseEvent) => void): () => void {
    this.trailHandlers.add(handler);
    return () => this.trailHandlers.delete(handler);
  }

  /**
   * Submit one conversation turn (ADR 54): the gateway runs the conversation
   * core (graph write → projection → LLM → graph write) and streams reply
   * deltas as trail_event text_delta frames before the turn_result.
   */
  sendUserMessage(text: string): Promise<WsTurnResultMessage> {
    const requestId = `t${++this.requestSeq}`;
    return this.sendWithCorrelation(requestId, {
      type: 'user_message',
      scope_id: this.session.scope_id,
      request_id: requestId,
      text,
    });
  }

  /**
   * Record an arbitrary agent event into the session scope (agent mode mirrors
   * Pi session turns into the graph through this — Phase 18 #6).
   */
  recordEvent(
    eventType: 'task_spawned' | 'memory_updated',
    payload: Record<string, unknown>,
  ): Promise<WsTurnResultMessage> {
    const requestId = `t${++this.requestSeq}`;
    return this.sendWithCorrelation(requestId, {
      type: 'agent_event',
      scope_id: this.session.scope_id,
      request_id: requestId,
      event: {
        entity_id: crypto.randomUUID(),
        event_type: eventType,
        predecessor_hash: this.session.tip_hash,
        payload,
      },
    });
  }

  /** Send a correlated request and await its turn_result (shared plumbing). */
  private sendWithCorrelation(
    requestId: string,
    message: WsClientMessage,
  ): Promise<WsTurnResultMessage> {
    return new Promise<WsTurnResultMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('turn timed out'));
      }, this.opts.turnTimeoutMs ?? 30_000);
      this.pending.set(requestId, { resolve, timer });
      try {
        this.send(message);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
    this.session.connected = false;
  }
}
