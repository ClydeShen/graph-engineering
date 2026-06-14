import { useEffect, useRef } from 'react';
import type { TrailSseEvent } from './api';

/**
 * Subscribe to the gateway trail pulse (CONSOLE-REDESIGN §6.3). Opens an
 * EventSource on /v1/stream; each 'trail_event' fires onPulse. The pulse is thin
 * and lossy by design (ADR 32) — callers use it to TRIGGER a REST reconcile, not
 * as a source of truth. A ref keeps the SSE connection stable across onPulse
 * identity changes (no reconnect storm on every render).
 *
 * onOpen fires on every (re)connection. Because the pulse is lossy, anything that
 * happened while the EventSource was disconnected (e.g. the gateway restarted or
 * the LISTEN connection dropped) is missed — so callers reconcile on open to
 * catch up. This is the "clients that reconnect simply point-query for anything
 * missed" contract from the stream route, finally honoured on the client.
 */
export function useTrailPulse(onPulse: (evt: TrailSseEvent) => void, onOpen?: () => void): void {
  const ref = useRef(onPulse);
  ref.current = onPulse;
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

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
    const onopen = () => openRef.current?.();
    es.addEventListener('trail_event', handler);
    es.addEventListener('open', onopen);
    return () => {
      es.removeEventListener('trail_event', handler);
      es.removeEventListener('open', onopen);
      es.close();
    };
  }, []);
}
