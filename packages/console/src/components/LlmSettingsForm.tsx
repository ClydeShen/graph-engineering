'use client';

/**
 * LLM settings write form (CONSOLE-REDESIGN Appendix A) — the console's ONE
 * write exception. Edits the standalone llm-overrides.json (chat + embedding
 * slots) through the token-guarded POST /v1/sys/llm-overrides. Fail-closed: an
 * invalid body is rejected server-side (§6.5) and the error is surfaced here.
 * Honest effect: persisted now, active on next restart (no hot-reload infra).
 */

import { useState } from 'react';
import { api, type LlmOverrideSlotInput, type LlmOverrideSlotView } from '@/lib/api';
import { Badge, Button, Icon, Input, Panel } from '@/components/ds';

interface SlotDraft {
  type: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

const emptySlot: SlotDraft = { type: '', model: '', baseUrl: '', apiKey: '' };

function fromView(v: LlmOverrideSlotView | null): SlotDraft {
  return {
    type: v?.type ?? '',
    model: v?.model ?? '',
    baseUrl: v?.base_url ?? '',
    apiKey: '', // never round-trip a secret into the form
  };
}

/** Build the POST payload — only non-empty fields; null slot when fully blank. */
function toInput(d: SlotDraft): LlmOverrideSlotInput | undefined {
  const out: LlmOverrideSlotInput = {};
  if (d.type.trim()) out.type = d.type.trim();
  if (d.model.trim()) out.model = d.model.trim();
  if (d.baseUrl.trim()) out.baseUrl = d.baseUrl.trim();
  if (d.apiKey) out.apiKey = d.apiKey;
  return Object.keys(out).length > 0 ? out : undefined;
}

function SlotFields({
  draft,
  onChange,
  showKey,
  onToggleKey,
  keySetHint,
  disabled,
}: {
  draft: SlotDraft;
  onChange: (d: SlotDraft) => void;
  showKey: boolean;
  onToggleKey: () => void;
  keySetHint: boolean;
  disabled: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', textAlign: 'left' }}>
      <Input
        label="Provider type"
        placeholder="openai · anthropic · ollama · openai-compatible"
        value={draft.type}
        disabled={disabled}
        onChange={(e) => onChange({ ...draft, type: e.target.value })}
      />
      <Input
        label="Model"
        placeholder="e.g. gpt-4o-mini · qwen3 · claude-opus-4"
        value={draft.model}
        disabled={disabled}
        onChange={(e) => onChange({ ...draft, model: e.target.value })}
      />
      <Input
        label="Base URL"
        placeholder="optional — defaults to the provider profile"
        value={draft.baseUrl}
        disabled={disabled}
        onChange={(e) => onChange({ ...draft, baseUrl: e.target.value })}
      />
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}>
          <Input
            label="API key"
            type={showKey ? 'text' : 'password'}
            autoComplete="off"
            placeholder={keySetHint ? '•••••••• (a key is already stored — leave blank to keep it)' : 'optional'}
            hint={keySetHint ? 'A key is stored. Type a new value only to replace it.' : 'Stored in llm-overrides.json, never in the graph.'}
            value={draft.apiKey}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, apiKey: e.target.value })}
          />
        </div>
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onToggleKey} iconLeft={<Icon name="eye" size={14} />}>
          {showKey ? 'Hide' : 'Show'}
        </Button>
      </div>
    </div>
  );
}

export function LlmSettingsForm({
  initialChat,
  initialEmbedding,
  present,
  path,
  onSaved,
}: {
  initialChat: LlmOverrideSlotView | null;
  initialEmbedding: LlmOverrideSlotView | null;
  present: boolean;
  path: string;
  onSaved: () => void;
}) {
  const [chat, setChat] = useState<SlotDraft>(fromView(initialChat));
  const [embedding, setEmbedding] = useState<SlotDraft>(fromView(initialEmbedding));
  const [showChatKey, setShowChatKey] = useState(false);
  const [showEmbKey, setShowEmbKey] = useState(false);
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    setOk(null);
    const body = { chat: toInput(chat), embedding: toInput(embedding) };
    if (!body.chat && !body.embedding) {
      setError('Set at least one of chat or embedding before saving.');
      return;
    }
    setBusy('save');
    try {
      const res = await api.saveLlmOverrides(body);
      setOk(`Saved — ${res.applied === 'on-restart' ? 'takes effect on the next restart.' : 'applied.'}`);
      setChat((c) => ({ ...c, apiKey: '' }));
      setEmbedding((c) => ({ ...c, apiKey: '' }));
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save failed');
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    setError(null);
    setOk(null);
    setBusy('reset');
    try {
      await api.clearLlmOverrides();
      setChat(emptySlot);
      setEmbedding(emptySlot);
      setOk('Cleared — the base config provider applies on the next restart.');
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'clear failed');
    } finally {
      setBusy(null);
    }
  };

  const disabled = busy !== null;

  return (
    <Panel
      eyebrow="Inference override"
      title="LLM settings"
      actions={present ? <Badge tone="ok" dot>override active</Badge> : <Badge tone="neutral">using base config</Badge>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gutter)', textAlign: 'left' }}>
        <p className="ds-label" style={{ margin: 0 }}>
          Overrides the chat and embedding model for the whole stack. Persisted to{' '}
          <code style={{ color: 'var(--brass-300)' }}>{path}</code>, never to the graph. Changes take effect on the next restart.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--gutter)' }}>
          <fieldset style={{ border: 'var(--border-width) solid var(--border-hairline)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)', margin: 0 }}>
            <legend className="ds-label" style={{ padding: '0 var(--space-2)' }}>Chat</legend>
            <SlotFields draft={chat} onChange={setChat} showKey={showChatKey} onToggleKey={() => setShowChatKey((s) => !s)} keySetHint={initialChat?.api_key_set ?? false} disabled={disabled} />
          </fieldset>
          <fieldset style={{ border: 'var(--border-width) solid var(--border-hairline)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)', margin: 0 }}>
            <legend className="ds-label" style={{ padding: '0 var(--space-2)' }}>Embedding</legend>
            <SlotFields draft={embedding} onChange={setEmbedding} showKey={showEmbKey} onToggleKey={() => setShowEmbKey((s) => !s)} keySetHint={initialEmbedding?.api_key_set ?? false} disabled={disabled} />
          </fieldset>
        </div>

        {error !== null ? <Badge tone="danger" dot>{error}</Badge> : null}
        {ok !== null ? <Badge tone="ok" dot>{ok}</Badge> : null}

        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
          <Button variant="primary" disabled={disabled} onClick={() => void save()} iconLeft={<Icon name={busy === 'save' ? 'clock' : 'check'} size={15} />}>
            {busy === 'save' ? 'Saving…' : 'Save override'}
          </Button>
          <div style={{ flex: 1 }} />
          <Button variant="danger" disabled={disabled || !present} onClick={() => void reset()} iconLeft={<Icon name="x" size={15} />}>
            {busy === 'reset' ? 'Clearing…' : 'Clear override'}
          </Button>
        </div>
      </div>
    </Panel>
  );
}
