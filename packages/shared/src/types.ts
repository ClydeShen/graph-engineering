/**
 * Shared TypeScript type definitions for the Graph-Native Agent Runtime.
 *
 * EventLogNode, GraphWriteEvent, WriteResult, and CanonicalEventType have moved to
 * @graph/types/api. This file re-exports them to preserve existing import paths.
 *
 * @see packages/types/src/api.ts
 */
export type { CanonicalEventType, EventLogNode, GraphWriteEvent, WriteResult } from '@graph/types/api';
export { CANONICAL_EVENT_TYPES } from '@graph/types/api';
