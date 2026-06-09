import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { EventWriter } from '@graph/shared';

export const MCP_CLIENT_TRIGGER_CONFIG = {
  type: 'scheduled' as const,
  function_id: 'graph::integration::mcp-client',
  config: { cron: '@startup' },
} as const;

type RegisterFn = (name: string, handler: (payload: unknown) => Promise<unknown>) => void;

export class McpClientWorker {
  constructor(private readonly writes: EventWriter) {}

  async connect(register: RegisterFn): Promise<void> {
    const raw = process.env['MCP_SERVER_URLS'];
    if (!raw) return;

    const urls = raw
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);

    for (const serverUrl of urls) {
      let client: Client;
      let tools: Array<{ name: string }>;

      try {
        const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
        client = new Client({ name: 'graph-workers', version: '1.0.0' });
        await client.connect(transport);
        const result = await client.listTools();
        tools = result.tools;
      } catch (err) {
        console.error(
          `[McpClientWorker] connect failed for ${serverUrl}:`,
          err instanceof Error ? err.message : String(err),
        );
        continue;
      }

      const host = new URL(serverUrl).host;

      for (const tool of tools) {
        const functionId = `graph::mcp-ext::${host}::${tool.name}`;
        const toolName = tool.name;
        const capturedClient = client;

        register(functionId, async (payload: unknown) => {
          const p = payload as {
            args: Record<string, unknown>;
            scope_id: string;
            predecessor_hash: string;
            entity_id: string;
          };

          const callResult = await capturedClient.callTool({
            name: toolName,
            arguments: p.args,
          });

          const writeResult = await this.writes.write({
            scopeId: p.scope_id,
            entityId: p.entity_id,
            predecessorHash: p.predecessor_hash,
            eventType: 'memory_updated',
            payload: {
              mcp_server: serverUrl,
              tool: toolName,
              args: p.args,
              result: callResult,
            },
          });

          return { version_hash: writeResult.version_hash };
        });
      }
    }
  }
}
