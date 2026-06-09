/**
 * Re-exports Pi SDK types where available; defines locally only what Pi SDK doesn't export.
 *
 * ExtensionAPI is kept local — Pi SDK's version requires TypeBox TSchema (nested dep not
 * available in this package's resolution) and has complex generics incompatible with
 * our plain JSON schema parameters in registerTool().
 */

// Real Pi SDK types — no longer hand-written
export type {
  ExtensionContext,
  ExtensionCommandContext,
  SessionStartEvent,
  SessionBeforeForkEvent,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent';

import type {
  ExtensionContext,
  ExtensionCommandContext,
  SessionStartEvent,
  SessionBeforeForkEvent,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent';

// ---------------------------------------------------------------------------
// Types not exported by Pi SDK
// ---------------------------------------------------------------------------

export type BlockResult = { block: true; reason: string } | void;
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
// ExtensionAPI — simplified facade; Pi SDK's version requires TypeBox TSchema
// ---------------------------------------------------------------------------

export interface ExtensionAPI {
  on(event: 'session_start', handler: (e: SessionStartEvent, ctx: ExtensionContext) => Promise<void>): void;
  on(event: 'session_before_fork', handler: (e: SessionBeforeForkEvent, ctx: ExtensionContext) => Promise<void>): void;
  on(event: 'tool_call', handler: (e: ToolCallEvent, ctx: ExtensionContext) => Promise<BlockResult>): void;
  registerTool<P>(def: ToolDefinition<P>): void;
  registerCommand(name: string, opts: {
    description: string;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  }): void;
  exec(command: string, args: string[], options?: unknown): Promise<unknown>;
  sendMessage(message: unknown, options?: unknown): Promise<void>;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}
