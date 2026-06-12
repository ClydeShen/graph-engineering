import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Pool } from 'pg';
import type { EventWriter, MemexConfig, McpServerEntry } from '@graph/shared';
import {
  findCapabilityScope,
  loadMemexConfig,
  MemexOAuthProvider,
  recordActivation,
  recordCapabilityEvent,
  toolEntityId,
} from '@graph/shared';

// N2 fix: no trigger registration — '@startup' is not a cron expression and
// iii has no 'scheduled' type. Boot calls connect() directly (workers/index.ts);
// this const only names the manually-invokable function.
export const MCP_CLIENT_TRIGGER_CONFIG = {
  function_id: 'graph::integration::mcp-client',
} as const;

type RegisterFn = (name: string, handler: (payload: unknown) => Promise<unknown>) => void;

/** A resolved server to connect: named entries come from config/catalog, anonymous from MCP_SERVER_URLS. */
interface ResolvedServer {
  /** Catalog/config name; null for env-var entries (namespace falls back to host). */
  name: string | null;
  entry: McpServerEntry;
}

/**
 * Read connection targets: config `mcp_servers` (Phase 17) plus the
 * MCP_SERVER_URLS env var (Phase 6, kept as anonymous http entries).
 */
export function resolveServers(
  config: MemexConfig | null,
  envUrls = process.env['MCP_SERVER_URLS'],
): ResolvedServer[] {
  const servers: ResolvedServer[] = [];
  for (const [name, entry] of Object.entries(config?.mcp_servers ?? {})) {
    if (entry.enabled === false) continue;
    servers.push({ name, entry });
  }
  if (envUrls) {
    for (const url of envUrls.split(',').map((u) => u.trim()).filter(Boolean)) {
      servers.push({ name: null, entry: { url } });
    }
  }
  return servers;
}

/** Apply the desired-state tool filter (Hermes tools.include semantics, ADR-50). */
export function filterTools<T extends { name: string }>(
  tools: T[],
  filter?: { include?: string[]; exclude?: string[] },
): T[] {
  let result = tools;
  if (filter?.include) result = result.filter((t) => filter.include!.includes(t.name));
  if (filter?.exclude) result = result.filter((t) => !filter.exclude!.includes(t.name));
  return result;
}

export class McpClientWorker {
  constructor(
    private readonly writes: EventWriter,
    /** Optional: enables capability-graph observation (ADR-51). Worker never CREATES the scope. */
    private readonly pool?: Pool,
    /** Injectable for tests; defaults to the real ~/.memex config. */
    private readonly loadConfig: () => MemexConfig | null = loadMemexConfig,
  ) {}

  async connect(register: RegisterFn): Promise<void> {
    for (const server of resolveServers(this.loadConfig())) {
      await this.connectOne(server, register);
    }
  }

  private async connectOne(server: ResolvedServer, register: RegisterFn): Promise<void> {
    const { name, entry } = server;
    const label = name ?? entry.url ?? entry.command ?? 'unknown';

    let client: Client;
    let tools: Array<{ name: string }>;
    try {
      client = new Client({ name: 'graph-workers', version: '1.0.0' });
      await client.connect(this.makeTransport(server));
      tools = filterTools((await client.listTools()).tools, entry.tools);
    } catch (err) {
      console.error(
        `[McpClientWorker] connect failed for ${label}:`,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    // Tool namespace: catalog/config name when present (ADR-50), host for
    // anonymous env entries (grandfathered Phase 6 naming).
    const namespace = name ?? new URL(entry.url!).host;
    const serverRef = entry.url ?? entry.command!;

    this.registerTools(client, namespace, serverRef, tools, register);

    // ADR-51: effective tool surface is an observation into the graph.
    await this.recordSurface(namespace, tools.map((t) => t.name));

    // MCP tool surfaces are dynamic (notifications/tools/list_changed):
    // re-list, re-filter, re-register, re-observe.
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      void (async () => {
        try {
          const updated = filterTools((await client.listTools()).tools, entry.tools);
          this.registerTools(client, namespace, serverRef, updated, register);
          await this.recordSurface(namespace, updated.map((t) => t.name));
        } catch (err) {
          console.error(
            `[McpClientWorker] list_changed re-sync failed for ${label}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      })();
    });
  }

  private makeTransport(server: ResolvedServer) {
    const { name, entry } = server;
    if (entry.command !== undefined) {
      return new StdioClientTransport({
        command: entry.command,
        ...(entry.args ? { args: entry.args } : {}),
        ...(entry.env ? { env: entry.env } : {}),
      });
    }
    const url = new URL(entry.url!);
    if (entry.auth === 'oauth' && name) {
      // Token cache written by `memex mcp login`; SDK handles refresh.
      return new StreamableHTTPClientTransport(url, {
        authProvider: new MemexOAuthProvider(name),
      });
    }
    return new StreamableHTTPClientTransport(
      url,
      entry.headers ? { requestInit: { headers: entry.headers } } : undefined,
    );
  }

  private registerTools(
    client: Client,
    namespace: string,
    serverRef: string,
    tools: Array<{ name: string }>,
    register: RegisterFn,
  ): void {
    for (const tool of tools) {
      const functionId = `graph::mcp-ext::${namespace}::${tool.name}`;
      const toolName = tool.name;
      const entityRef = toolEntityId(namespace, toolName);

      register(functionId, async (payload: unknown) => {
        const p = payload as {
          args: Record<string, unknown>;
          scope_id: string;
          predecessor_hash: string;
          entity_id: string;
        };

        const callResult = await client.callTool({ name: toolName, arguments: p.args });

        // Co-occurrence sampling (ADR-51 D-6): this implementation was active
        // in this scope. Idempotent; outcome attribution joins scope_lineage.
        if (this.pool) {
          await recordActivation(this.pool, p.scope_id, namespace).catch(() => {
            /* stats are best-effort — never fail the tool call */
          });
        }

        const writeResult = await this.writes.write({
          scopeId: p.scope_id,
          entityId: p.entity_id,
          predecessorHash: p.predecessor_hash,
          eventType: 'memory_updated',
          payload: {
            mcp_server: serverRef,
            tool: toolName,
            // ADR-51 D-2: reference to the Tool Entity so per-tool statistics
            // accumulate via projection over call events.
            tool_entity_id: entityRef,
            args: p.args,
            result: callResult,
          },
        });

        return { version_hash: writeResult.version_hash };
      });
    }
  }

  private async recordSurface(namespace: string, toolNames: string[]): Promise<void> {
    if (!this.pool) return;
    try {
      const scopeId = await findCapabilityScope(this.pool);
      if (!scopeId) return; // registry scope not yet created (memex mcp install does that)
      await recordCapabilityEvent(this.pool, scopeId, 'surfaceChanged', {
        server: namespace,
        tools: toolNames.map((t) => ({ name: t, entity_id: toolEntityId(namespace, t) })),
      });
    } catch (err) {
      console.error(
        `[McpClientWorker] capability surface record failed for ${namespace}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
