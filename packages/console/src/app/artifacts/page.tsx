'use client';

/**
 * Artifact preview (Phase 19 #2 — consumer of the ADR-52 convention):
 * list a scope's artifacts, preview markdown/code/html inline, link binaries.
 */

import { useEffect, useState } from 'react';
import { api, type ArtifactMeta } from '@/lib/api';
import { ScopePicker } from '@/components/ScopePicker';
import { Badge, Button, Icon, Input, Panel, Tag } from '@/components/ds';

export default function ArtifactsPage() {
  const [input, setInput] = useState('');
  const [items, setItems] = useState<ArtifactMeta[]>([]);
  const [preview, setPreview] = useState<{ meta: ArtifactMeta; text: string | null } | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = async (scopeId: string) => {
    void loadImpl(scopeId);
  };

  // Deep link from Sessions: /artifacts?scope=<id> pre-loads the scope.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('scope');
    if (q !== null && q.length > 0) {
      setInput(q);
      void loadImpl(q);
    }
  }, []);

  const loadImpl = async (scopeId: string) => {
    try {
      const list = await api.artifacts(scopeId);
      setItems(list);
      setPreview(null);
      setStatus(list.length === 0 ? 'no artifacts in this scope' : null);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'load failed');
    }
  };

  const open = async (meta: ArtifactMeta) => {
    if (meta.erased_at !== null) {
      setPreview({ meta, text: '(erased — ADR-43)' });
      return;
    }
    if (meta.kind === 'markdown' || meta.kind === 'code' || meta.kind === 'html') {
      const res = await fetch(api.artifactUrl(meta.content_hash));
      setPreview({ meta, text: res.ok ? await res.text() : `fetch failed: ${res.status}` });
    } else {
      setPreview({ meta, text: null }); // binary/image — link only
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gutter)', height: '100%' }}>
      <form
        style={{ display: 'flex', gap: 'var(--space-2)' }}
        onSubmit={(e) => {
          e.preventDefault();
          void load(input.trim());
        }}
      >
        <ScopePicker
          onPick={(id) => {
            setInput(id);
            void load(id);
          }}
        />
        <div style={{ flex: 1 }}>
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="scope_id (uuid)"
          />
        </div>
        <Button type="submit" variant="primary" iconRight={<Icon name="arrow-right" size={15} />}>
          Load
        </Button>
      </form>
      {status !== null ? <p className="ds-label">{status}</p> : null}
      <div style={{ display: 'flex', gap: 'var(--gutter)', flex: 1, minHeight: 0 }}>
        <Panel noBody style={{ width: 360, flexShrink: 0, overflow: 'auto' }}>
          <ul style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', padding: 'var(--panel-pad)', margin: 0, listStyle: 'none' }}>
            {items.map((a) => (
              <li key={`${a.content_hash}-${a.scope_id}`}>
                <button
                  onClick={() => void open(a)}
                  className="mx-btn"
                  style={{
                    width: '100%',
                    justifyContent: 'flex-start',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: 6,
                    opacity: a.erased_at !== null ? 0.55 : 1,
                  }}
                >
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{a.label || a.content_hash.slice(0, 12)}</span>
                  <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <Tag>{a.kind}</Tag>
                    <span className="ds-label">{a.byte_size} B · {a.created_at.slice(0, 19)}</span>
                    {a.erased_at !== null ? <Badge tone="danger">erased</Badge> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel eyebrow="Preview" title={preview?.meta.label || preview?.meta.content_hash.slice(0, 12) || 'Artifact'} style={{ flex: 1, overflow: 'auto' }}>
          {preview === null ? (
            <p className="ds-label">select an artifact</p>
          ) : preview.text !== null ? (
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', margin: 0 }}>{preview.text}</pre>
          ) : (
            <a
              href={api.artifactUrl(preview.meta.content_hash)}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--signal)' }}
            >
              open {preview.meta.media_type} ({preview.meta.byte_size} bytes)
            </a>
          )}
        </Panel>
      </div>
    </div>
  );
}
