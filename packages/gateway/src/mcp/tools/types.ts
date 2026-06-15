/**
 * MCP tool registry — shared shape for the cognitive-translation tools.
 *
 * Each tool is a deep module: a named top-level handler (its own testable unit)
 * plus a factory that binds it to a Pool and declares its name/description/schema.
 * `buildMcpServer` is the thin adapter that registers the registry over MCP-over-
 * HTTP; the same factories can be adapted to other surfaces (in-process Pi,
 * ADR-57) without re-declaring the handler. One handler, N adapters.
 *
 * This decouples the tool definitions from server assembly — the pattern the
 * hermes specimen uses (a `tools/` registry the executor loops over, rather than
 * one god function that inlines every registration).
 */
import type { z } from 'zod';
import type { Pool } from 'pg';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Erased handler at the registry boundary. The arg is `any` because the registry
 * is heterogeneous (each tool has its own schema); the concrete handlers below
 * are fully typed against their own `z.infer` shape. The MCP SDK validates args
 * against `inputSchema` before dispatch, so `any` here is sound at runtime.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type McpToolHandler = (args: any) => CallToolResult | Promise<CallToolResult>;

/** A registrable tool: name + description + zod input schema + bound handler. */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler: McpToolHandler;
}

/**
 * Binds a tool to a Pool. Returns null when the tool is disabled for this
 * process (env-gated tools: execute_bash, browser) so the registry can skip it
 * while preserving order.
 */
export type McpToolFactory = (pool: Pool) => McpToolDef | null;

// ── Shared zod primitives ─────────────────────────────────────────────────────
// Re-used across tool schemas; kept in one place so the validation contract for
// a scope id / version hash is identical for every tool.
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const HASH_HEX64 = /^[0-9a-f]{64}$/;
