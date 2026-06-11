/**
 * Tool interface — restricted execution context for graph Tools.
 *
 * A Tool receives ReadOnlyGraphHandle (no write() in type signature).
 * Any attempt to call ctx.graph.write() from a Tool is a TypeScript compile error.
 *
 * @see ADR 35 — Worker/Tool capability boundary
 * @see ADR 29 — Worker/Tool/Knowledge/Connector 4-element boundary
 */

import type { z } from 'zod';
import type { ReadOnlyGraphHandle } from './graph-handle.js';

/**
 * Execution context passed to a Tool's execute() method.
 * graph is ReadOnlyGraphHandle — write() is absent from the interface.
 */
export interface ToolExecutionContext {
  scopeId: string;
  /** ReadOnly graph access — Tools CANNOT write to the graph. */
  graph: ReadOnlyGraphHandle;
}

/**
 * Tool interface — parameterized by input and output Zod schemas.
 *
 * Implement this interface to register a tool with the Workers framework.
 * Tools receive ReadOnlyGraphHandle; they cannot call graph.write().
 */
export interface Tool<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  /** Zod schema for validating tool inputs. */
  inputSchema: TInput;
  /** Zod schema for validating tool outputs. */
  outputSchema: TOutput;
  /**
   * Execute the tool with validated input and restricted graph context.
   * ctx.graph is ReadOnlyGraphHandle — no write() access.
   */
  execute(
    input: z.infer<TInput>,
    ctx: ToolExecutionContext,
  ): Promise<z.infer<TOutput>>;
}
