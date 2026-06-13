import { useEffect, useRef } from 'react';
import type { TrailSseEvent } from './api';

/**
 * Subscribe to the gateway trail pulse (CONSOLE-REDESIGN §6.3). Opens an
 * EventSource on /v1/stream; each 'trail_event' fires onPulse. The pulse is thin
 * and lossy by design (ADR 32) — callers use it to TRIGGER a REST reconcile, not
 * as a source of truth. A ref keeps the SSE connection stable across onPulse
 * identity changes (no reconnect storm on every render).
 */
export function useTrailPulse(onPulse: (evt: TrailSseEvent) => void): void {
  const ref = useRef(onPulse);
  ref.current = onPulse;

  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    const es = new EventSource('/v1/stream');
    const handler = (e: MessageEvent) => {
      try {
        ref.current(JSON.parse(e.data) as TrailSseEvent);
      } catch {
        /* malformed pulse — ignore (REST reconcile is the safety net) */
      }
    };
    es.addEventListener('trail_event', handler);
    return () => {
      es.removeEventListener('trail_event', handler);
      es.close();
    };
  }, []);
}
