/**
 * Minimal type shim for @earendil-works/pi-coding-agent ExtensionAPI.
 * Based on Pi SDK docs: https://pi.dev/docs/latest/extensions
 *
 * This shim is spike-only — real code will import from the actual package.
 */

export interface ToolContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  details: Record<string, unknown>;
}

export interface ToolDefinition<P = Record<string, unknown>> {
  name: string;
  label: string;
  description: string;
  parameters: unknown; // typebox schema
  execute(
    toolCallId: string,
    params: P,
    signal: AbortSignal,
    onUpdate: (partial: ToolResult) => void,
    ctx: ExtensionContext,
  ): Promise<ToolResult>;
}

export interface ExtensionContext {
  ui: {
    notify(message: string, level: 'info' | 'warn' | 'error'): void;
    confirm(title: string, message: string): Promise<boolean>;
  };
  runtime: {
    fork(entryId: string, opts?: { position?: 'at' | 'after' }): Promise<void>;
  };
}

export interface SessionStartEvent {
  type: 'session_start';
  sessionId: string;
}

export interface ToolCallEvent {
  type: 'tool_call';
  toolName: string;
  input: Record<string, unknown>;
}

export type ExtensionEvent = SessionStartEvent | ToolCallEvent;

export type BlockResult = { block: true; reason: string } | void;

export interface ExtensionAPI {
  on(event: 'session_start', handler: (e: SessionStartEvent, ctx: ExtensionContext) => Promise<void>): void;
  on(event: 'tool_call', handler: (e: ToolCallEvent, ctx: ExtensionContext) => Promise<BlockResult>): void;
  registerTool<P>(def: ToolDefinition<P>): void;
  registerCommand(name: string, opts: {
    description: string;
    handler: (args: string, ctx: ExtensionContext) => Promise<void>;
  }): void;
}
