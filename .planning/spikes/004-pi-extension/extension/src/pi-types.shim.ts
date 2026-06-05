/**
 * Minimal type shim for @earendil-works/pi-coding-agent ExtensionAPI.
 * Based on: https://pi.dev/docs/latest/extensions (verified via WebFetch)
 *
 * CRITICAL CORRECTIONS vs initial assumption:
 * - ctx in event handlers is ExtensionContext — NO fork(), NO runtime property
 * - ctx in registerCommand handlers is ExtensionCommandContext — HAS fork() directly
 * - There is NO ctx.runtime.fork() — fork() is a top-level method on ExtensionCommandContext
 * - session_before_fork event exists — hook into Pi's own /fork command
 */

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface SessionStartEvent { type: 'session_start'; sessionId: string }
export interface SessionBeforeForkEvent { type: 'session_before_fork'; entryId: string }
export interface ToolCallEvent {
  type: 'tool_call';
  toolName: string;
  input: Record<string, unknown>;
}
export type BlockResult = { block: true; reason: string } | void;

// ---------------------------------------------------------------------------
// ExtensionContext — ctx in event handlers (pi.on())
// ---------------------------------------------------------------------------

export interface ExtensionContext {
  ui: {
    notify(message: string, level: 'info' | 'warn' | 'error'): void;
    confirm(title: string, message: string): Promise<boolean>;
  };
  mode: 'tui' | 'rpc' | 'json' | 'print';
  hasUI: boolean;
  cwd: string;
  sessionManager: unknown; // read-only
  signal: AbortSignal;
  // NO runtime property. NO fork() here.
}

// ---------------------------------------------------------------------------
// ExtensionCommandContext — ctx in registerCommand handlers
// Extends ExtensionContext with session-mutation methods
// ---------------------------------------------------------------------------

export interface ExtensionCommandContext extends ExtensionContext {
  fork(entryId: string, options?: { position?: 'at' }): Promise<void>; // ← direct, not ctx.runtime.fork()
  newSession(options?: unknown): Promise<void>;
  switchSession(sessionPath: string, options?: unknown): Promise<void>;
  navigateTree(targetId: string, options?: unknown): Promise<void>;
  waitForIdle(): Promise<void>;
  reload(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export interface ToolContent { type: 'text'; text: string }
export interface ToolResult { content: ToolContent[]; details: Record<string, unknown> }

export interface ToolDefinition<P = Record<string, unknown>> {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: P,
    signal: AbortSignal,
    onUpdate: (partial: ToolResult) => void,
    ctx: ExtensionContext,
  ): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// ExtensionAPI — the pi object passed to the extension factory
// ---------------------------------------------------------------------------

export interface ExtensionAPI {
  // Event subscription
  on(event: 'session_start', handler: (e: SessionStartEvent, ctx: ExtensionContext) => Promise<void>): void;
  on(event: 'session_before_fork', handler: (e: SessionBeforeForkEvent, ctx: ExtensionContext) => Promise<void>): void;
  on(event: 'tool_call', handler: (e: ToolCallEvent, ctx: ExtensionContext) => Promise<BlockResult>): void;

  // Tool and command registration
  registerTool<P>(def: ToolDefinition<P>): void;
  registerCommand(name: string, opts: {
    description: string;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>; // ← ExtensionCommandContext
  }): void;

  // Other ExtensionAPI methods (documented, not yet used in spike)
  exec(command: string, args: string[], options?: unknown): Promise<unknown>;
  sendMessage(message: unknown, options?: unknown): Promise<void>;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}
