'use client';

/**
 * Chat — embedded MemexTerminal conversation surface (ADR 54).
 *
 * The page is a thin shell: assistant-ui's LocalRuntime owns the message
 * state; every turn round-trips through /api/chat (server-side token bridge)
 * into the gateway conversation core, so the trail mesh remains the single
 * source of truth. Resuming a scope replays GET /v1/scopes/:id/messages.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { PencilSquareIcon } from '@heroicons/react/24/outline';
import { Button, Select, Tag } from '@/components/ds';
import { api, type ScopeSummary } from '@/lib/api';
import { Thread } from '@/components/assistant-ui/thread';

interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

/** One SSE frame from /api/chat. */
interface ChatStreamFrame {
  type: 'delta' | 'done' | 'error';
  text?: string;
  reply?: string;
  message?: string;
}

async function createScope(intent: string): Promise<string> {
  const res = await fetch('/v1/scopes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ intent }),
  });
  if (!res.ok) throw new Error(`scope creation failed (${res.status})`);
  const body = (await res.json()) as { scope_id: string };
  return body.scope_id;
}

/** Parse an SSE byte stream into ChatStreamFrame objects. */
async function* sseFrames(res: Response): AsyncGenerator<ChatStreamFrame> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('no response body');
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split('\n\n');
    buf = events.pop() ?? '';
    for (const evt of events) {
      const data = evt
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('');
      if (data === '') continue;
      try {
        yield JSON.parse(data) as ChatStreamFrame;
      } catch {
        /* skip malformed frame */
      }
    }
  }
}

function ChatSession({
  scopeId,
  initialMessages,
  onScopeCreated,
}: {
  scopeId: string | null;
  initialMessages: ThreadMessageLike[];
  onScopeCreated: (id: string) => void;
}) {
  // The adapter closes over a ref so a lazily-created scope survives renders.
  const scopeRef = useRef<string | null>(scopeId);

  const adapter = useMemo<ChatModelAdapter>(
    () => ({
      async *run({ messages, abortSignal }) {
        const last = messages[messages.length - 1];
        const text =
          last?.content
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map((p) => p.text)
            .join('\n') ?? '';
        if (text === '') throw new Error('empty message');

        if (scopeRef.current === null) {
          scopeRef.current = await createScope(`chat: ${text.slice(0, 120)}`);
          onScopeCreated(scopeRef.current);
        }

        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scope_id: scopeRef.current, text }),
          signal: abortSignal,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `chat request failed (${res.status})`);
        }

        let full = '';
        for await (const frame of sseFrames(res)) {
          if (frame.type === 'delta' && typeof frame.text === 'string') {
            full += frame.text;
            yield { content: [{ type: 'text', text: full }] };
          } else if (frame.type === 'done') {
            const reply = frame.reply ?? full;
            yield { content: [{ type: 'text', text: reply }] };
            return;
          } else if (frame.type === 'error') {
            throw new Error(frame.message ?? 'conversation turn failed');
          }
        }
      },
    }),
    [onScopeCreated],
  );

  const runtime = useLocalRuntime(adapter, { initialMessages });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  );
}

export default function ChatPage() {
  const [scopeId, setScopeId] = useState<string | null>(null);
  // sessionEpoch remounts ChatSession (fresh runtime) on session switches.
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [initialMessages, setInitialMessages] = useState<ThreadMessageLike[]>([]);
  const [scopes, setScopes] = useState<ScopeSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    api
      .scopes(100)
      .then((r) => setScopes(r.scopes.filter((s) => s.intent?.startsWith('chat:'))))
      .catch(() => {
        /* picker is best-effort */
      });
  }, [sessionEpoch]);

  const newSession = useCallback(() => {
    setScopeId(null);
    setInitialMessages([]);
    setLoadError(null);
    setSessionEpoch((n) => n + 1);
  }, []);

  const resumeSession = useCallback(async (id: string) => {
    if (id === '') return;
    setLoadError(null);
    try {
      const res = await fetch(`/v1/scopes/${encodeURIComponent(id)}/messages`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`history load failed (${res.status})`);
      const body = (await res.json()) as { messages: ChatHistoryMessage[] };
      setInitialMessages(
        body.messages.map((m) => ({
          role: m.role,
          content: [{ type: 'text' as const, text: m.text }],
        })),
      );
      setScopeId(id);
      setSessionEpoch((n) => n + 1);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexShrink: 0 }}>
        <Select
          aria-label="Resume a chat session"
          value={scopeId ?? ''}
          onChange={(e) => void resumeSession(e.target.value)}
          style={{ minWidth: 260 }}
        >
          <option value="">resume a session…</option>
          {scopes.map((s) => (
            <option key={s.scope_id} value={s.scope_id}>
              {(s.intent ?? '').replace(/^chat:\s*/, '').slice(0, 48)} · {s.scope_id.slice(0, 8)}
            </option>
          ))}
        </Select>
        <Button variant="secondary" size="sm" iconLeft={<PencilSquareIcon />} onClick={newSession}>
          New session
        </Button>
        <span style={{ marginLeft: 'auto' }}>
          {scopeId !== null ? (
            <Tag>scope · {scopeId.slice(0, 8)}</Tag>
          ) : (
            <Tag>new trail — scope created on first message</Tag>
          )}
        </span>
      </div>
      {loadError !== null ? (
        <div className="mx-chat__error" role="alert">
          {loadError}
        </div>
      ) : null}
      <div style={{ flex: 1, minHeight: 0 }}>
        <ChatSession
          key={sessionEpoch}
          scopeId={scopeId}
          initialMessages={initialMessages}
          onScopeCreated={setScopeId}
        />
      </div>
    </div>
  );
}
