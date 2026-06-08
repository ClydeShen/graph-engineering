// ---------------------------------------------------------------------------
// Shadow adapter types — mirrors the pg.Pool surface we actually use
// ---------------------------------------------------------------------------

export interface QueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number | null;
}

export interface PoolLike {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
}

export interface ShadowEntry {
  table: string;
  scopeId: string;
  entityId: string;
  predecessorHash: string;
  canonicalText: string;
  eventType: string;
  capturedAt: Date;
}

/**
 * Wraps a Pool-compatible object. All OCC write calls (SQL starting with
 * "WITH new_version AS") are captured into entries[]. All reads pass through.
 *
 * Usage:
 *   const shadow = new InMemoryShadowAdapter(realPool);
 *   await occWrite(shadow.proxy, args);
 *   const entries = shadow.getEntries();
 *   shadow.clear(); // 阅后即焚
 */
export class InMemoryShadowAdapter {
  private readonly real: PoolLike;
  private entries: ShadowEntry[] = [];

  constructor(real: PoolLike) {
    this.real = real;
  }

  get proxy(): PoolLike {
    const self = this;
    return {
      query(sql: string, params?: unknown[]) {
        return self.routeQuery(sql, params);
      },
    };
  }

  private async routeQuery(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (sql.trimStart().startsWith('WITH new_version AS')) {
      return this.captureWrite(sql, params as string[]);
    }
    return this.real.query(sql, params);
  }

  private captureWrite(sql: string, params: string[]): QueryResult {
    // params order per occ-writable-cte.sql.ts:
    //   $1 scopeId, $2 entityId, $3 predecessorHash, $4 canonicalText, $5 eventType
    const [scopeId, entityId, predecessorHash, canonicalText, eventType] = params;
    const tableMatch = sql.match(/INSERT INTO\s+(\S+)/i);
    const table = tableMatch?.[1] ?? 'execution_event_log_shadow';
    this.entries.push({
      table,
      scopeId,
      entityId,
      predecessorHash,
      canonicalText,
      eventType: eventType ?? 'memory_updated',
      capturedAt: new Date(),
    });
    const fakeHash = `shadow::${scopeId}::${entityId}::${Date.now()}`;
    return {
      rows: [{ version_hash: fakeHash, event_type: eventType ?? 'memory_updated', occ_result: 'won' }],
      rowCount: 1,
    };
  }

  getEntries(): readonly ShadowEntry[] {
    return this.entries;
  }

  /** 阅后即焚 — destroy all captured shadow entries. */
  clear(): void {
    this.entries = [];
  }
}

// ---------------------------------------------------------------------------
// writeGuard — scrubs secrets from strings before LLM input
// ---------------------------------------------------------------------------

const REDACTIONS: Array<[RegExp, string]> = [
  // OpenAI (sk-...) and Anthropic (sk-ant-...) API keys
  [/sk-(?:ant-)?[A-Za-z0-9\-_]{32,}/g, '[REDACTED:api_key]'],
  // AWS access key IDs
  [/AKIA[0-9A-Z]{16}/g, '[REDACTED:aws_key]'],
  // PostgreSQL / MySQL connection strings
  [/(?:postgres(?:ql)?|mysql):\/\/[^\s"']+/g, '[REDACTED:pg_conn]'],
  // Explicit <secret> tags
  [/<secret>[^<]*<\/secret>/g, '[REDACTED:secret_type]'],
];

export function writeGuard(payload: string): string {
  let result = payload;
  for (const [pattern, replacement] of REDACTIONS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
