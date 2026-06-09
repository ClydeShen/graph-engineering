import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventWriter } from '@graph/shared';

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockListTools = vi.fn().mockResolvedValue({
  tools: [{ name: 'read_file' }, { name: 'write_file' }],
});
const mockCallTool = vi.fn().mockResolvedValue({
  content: [{ type: 'text', text: 'result' }],
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    listTools: mockListTools,
    callTool: mockCallTool,
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({})),
}));

function makeWriter(): EventWriter & { write: ReturnType<typeof vi.fn> } {
  return {
    write: vi.fn().mockResolvedValue({
      version_hash: 'a'.repeat(64),
      occ_result: 'won',
      event_type: 'memory_updated',
    }),
  };
}

describe('McpClientWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['MCP_SERVER_URLS'];
  });

  it('is a no-op when MCP_SERVER_URLS is not set', async () => {
    const { McpClientWorker } = await import('./mcp-client.worker.js');
    const worker = new McpClientWorker(makeWriter());
    const register = vi.fn();
    await worker.connect(register);
    expect(register).not.toHaveBeenCalled();
  });

  it('discovers tools and registers iii functions for each', async () => {
    process.env['MCP_SERVER_URLS'] = 'http://localhost:3001';
    const { McpClientWorker } = await import('./mcp-client.worker.js');
    const worker = new McpClientWorker(makeWriter());
    const register = vi.fn();
    await worker.connect(register);
    expect(register).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenCalledWith(
      'graph::mcp-ext::localhost:3001::read_file',
      expect.any(Function),
    );
    expect(register).toHaveBeenCalledWith(
      'graph::mcp-ext::localhost:3001::write_file',
      expect.any(Function),
    );
  });

  it('calls the tool and writes result to calling scope via writes.write', async () => {
    process.env['MCP_SERVER_URLS'] = 'http://localhost:3001';
    const { McpClientWorker } = await import('./mcp-client.worker.js');
    const writer = makeWriter();
    const worker = new McpClientWorker(writer);
    const handlers = new Map<string, (p: unknown) => Promise<unknown>>();
    await worker.connect((name, fn) => handlers.set(name, fn));

    const handler = handlers.get('graph::mcp-ext::localhost:3001::read_file')!;
    const scope_id = '11111111-1111-4111-8111-111111111111';
    const predecessor_hash = '0'.repeat(64);
    const entity_id = '22222222-2222-4222-8222-222222222222';

    const result = await handler({
      args: { path: '/tmp/test.txt' },
      scope_id,
      predecessor_hash,
      entity_id,
    });

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'read_file',
      arguments: { path: '/tmp/test.txt' },
    });
    expect(writer.write).toHaveBeenCalledWith({
      scopeId: scope_id,
      entityId: entity_id,
      predecessorHash: predecessor_hash,
      eventType: 'memory_updated',
      payload: expect.objectContaining({
        mcp_server: 'http://localhost:3001',
        tool: 'read_file',
        args: { path: '/tmp/test.txt' },
      }),
    });
    expect(result).toEqual({ version_hash: 'a'.repeat(64) });
  });
});
