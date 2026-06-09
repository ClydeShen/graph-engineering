/**
 * @graph/types — canonical type definitions for the Graph-Native Agent Runtime.
 *
 * This is a LEAF package: it has zero @graph/* dependencies.
 * Any package can import from here without risk of circular dependencies.
 *
 * Sub-path exports:
 *   @graph/types/core  — graph engine entity types (Entity, Snapshot, HyperEdge, Scope, Trail)
 *   @graph/types/api   — HTTP/MCP wire types (EventLogNode, GraphWriteEvent, WriteResult)
 *   @graph/types/shell — MemexTerminal SSE types (TrailSseEvent)
 */
export * from './core.js';
export * from './api.js';
export * from './shell.js';
