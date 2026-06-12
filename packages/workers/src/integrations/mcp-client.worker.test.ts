import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventWriter, MemexConfig } from '@graph/shared';
import { toolEntityId } from '@graph/shared';

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockListTools = vi.fn().mockResolvedValue({
  tools: [{ name: 'read_file' }, { name: 'write_file' }],
});
const mockCallTool = vi.fn().mockResolvedValue({
  content: [{ type: 'text', text: 'result' }],
});
const mockSetNotificationHandler = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    listTools: mockListTools,
    callTool: mockCallTool,
    setNotificationHandler: mockSetNotificationHandler,
  })),
}));

const httpTransportCtor = vi.fn().mockImplementation(() => ({}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: httpTransportCtor,
}));

const stdioTransportCtor = vi.fn().mockImplementation(() => ({}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: stdioTransportCtor,
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

const noConfig = () => null;

describe('McpClientWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListTools.mockResolvedValue({ tools: [{ name: 'read_file' }, { name: 'write_file' }] });
    delete process.env['MCP_SERVER_URLS'];
  });

  it('is a no-op when neither config nor MCP_SERVER_URLS provide servers', async () => {
    const { McpClientWorker } = await import('./mcp-client.worker.js');
    const worker = new McpClientWorker(makeWriter(), undefined, noConfig);
    const register = vi.fn();
    await worker.connect(register);
    expect(register).not.toHaveBeenCalled();
  });

  it('discovers tools and registers iii functions for each (env path, host namespace)', async () => {
    process.env['MCP_SERVER_URLS'] = 'http://localhost:3001';
    const { McpClientWorker } = await import('./mcp-client.worker.js');
    const worker = new McpClientWorker(makeWriter(), undefined, noConfig);
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

  it('calls the tool and writes result (with tool_entity_id) to calling scope', async () => {
    process.env['MCP_SERVER_URLS'] = 'http://localhost:3001';
    const { McpClientWorker } = await import('./mcp-client.worker.js');
    const writer = makeWriter();
    const worker = new McpClientWorker(writer, undefined, noConfig);
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
        tool_entity_id: toolEntityId('localhost:3001', 'read_file'),
        args: { path: '/tmp/test.txt' },
      }),
    });
    expect(result).toEqual({ version_hash: 'a'.repeat(64) });
  });

  it('registers config-driven http servers under their catalog name', async () => {
    const config = {
      mcp_servers: { github: { url: 'http://remote.example/mcp' } },
    } as unknown as MemexConfig;
    const { McpClientWorker } = await import('./mcp-client.worker.js');
    const worker = new McpClientWorker(makeWriter(), undefined, () => config);
    const register = vi.fn();
    await worker.connect(register);
    expect(register).toHaveBeenCalledWith('graph::mcp-ext::github::read_file', expect.any(Function));
  });

  it('uses stdio transport when entry has command', async () => {
    const config = {
      mcp_servers: { fs: { command: 'npx', args: ['-y', 'server-fs'] } },
    } as unknown as MemexConfig;
    const { McpClientWorker } = await import('./mcp-client.worker.js');
    const worker = new McpClientWorker(makeWriter(), undefined, () => config);
    await worker.connect(vi.fn());
    expect(stdioTransportCtor).toHaveBeenCalledWith({ command: 'npx', args: ['-y', 'server-fs'] });
    expect(httpTransportCtor).not.toHaveBeenCalled();
  });

  it('applies tools include/exclude filter before registration', async () => {
    const config = {
      mcp_servers: { fs: { command: 'npx', tools: { include: ['read_file'] } } },
    } as unknown as MemexConfig;
    const { McpClientWorker } = await import('./mcp-client.worker.js');
    const worker = new McpClientWorker(makeWriter(), undefined, () => config);
    const register = vi.fn();
    await worker.connect(register);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith('graph::mcp-ext::fs::read_file', expect.any(Function));
  });

  it('skips entries with enabled=false', async () => {
    const config = {
      mcp_servers: { fs: { command: 'npx', enabled: false } },
    } as unknown as MemexConfig;
    const { McpClientWorker } = await import('./mcp-client.worker.js');
    const worker = new McpClientWorker(makeWriter(), undefined, () => config);
    const register = vi.fn();
    await worker.connect(register);
    expect(register).not.toHaveBeenCalled();
  });

  it('subscribes to tools/list_changed for dynamic surfaces', async () => {
    process.env['MCP_SERVER_URLS'] = 'http://localhost:3001';
    const { McpClientWorker } = await import('./mcp-client.worker.js');
    const worker = new McpClientWorker(makeWriter(), undefined, noConfig);
    await worker.connect(vi.fn());
    expect(mockSetNotificationHandler).toHaveBeenCalledTimes(1);
  });
});

describe('resolveServers / filterTools', () => {
  beforeEach(() => {
    delete process.env['MCP_SERVER_URLS'];
  });

  it('merges config entries and env urls (env entries are anonymous)', async () => {
    const { resolveServers } = await import('./mcp-client.worker.js');
    const config = {
      mcp_servers: { a: { command: 'x' } },
    } as unknown as MemexConfig;
    const servers = resolveServers(config, 'http://h1:1, http://h2:2');
    expect(servers.map((s) => s.name)).toEqual(['a', null, null]);
  });

  it('exclude wins over include overlap', async () => {
    const { filterTools } = await import('./mcp-client.worker.js');
    const tools = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    expect(filterTools(tools, { include: ['a', 'b'], exclude: ['b'] })).toEqual([{ name: 'a' }]);
  });
});

describe('toolEntityId', () => {
  it('is deterministic and UUID-shaped', () => {
    const a = toolEntityId('github', 'create_issue');
    expect(a).toBe(toolEntityId('github', 'create_issue'));
    expect(a).not.toBe(toolEntityId('github', 'list_issues'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
