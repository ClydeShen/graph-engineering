'use client';

/**
 * Artifact preview (Phase 19 #2 — consumer of the ADR-52 convention):
 * list a scope's artifacts, preview markdown/code/html inline, link binaries.
 */

import { useState } from 'react';
import { api, type ArtifactMeta } from '@/lib/api';

export default function ArtifactsPage() {
  const [input, setInput] = useState('');
  const [items, setItems] = useState<ArtifactMeta[]>([]);
  const [preview, setPreview] = useState<{ meta: ArtifactMeta; text: string | null } | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = async (scopeId: string) => {
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
    <div className="space-y-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void load(input.trim());
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="scope_id (uuid)"
          className="flex-1 bg-panel border border-line rounded px-3 py-1.5 outline-none focus:border-accent"
        />
        <button type="submit" className="px-4 py-1.5 bg-line rounded hover:bg-accent hover:text-black">
          Load
        </button>
      </form>
      {status !== null && <p className="text-gray-500">{status}</p>}
      <div className="flex gap-4">
        <ul className="w-96 shrink-0 space-y-2">
          {items.map((a) => (
            <li key={`${a.content_hash}-${a.scope_id}`}>
              <button
                onClick={() => void open(a)}
                className={`w-full text-left border border-line rounded bg-panel p-2 hover:border-accent ${
                  a.erased_at !== null ? 'opacity-50' : ''
                }`}
              >
                <span className="text-gray-100">{a.label || a.content_hash.slice(0, 12)}</span>
                <span className="block text-xs text-gray-500">
                  {a.kind} · {a.byte_size} B · {a.created_at.slice(0, 19)}
                  {a.erased_at !== null ? ' · ERASED' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex-1 border border-line rounded bg-panel p-3 overflow-auto min-h-64">
          {preview === null ? (
            <p className="text-gray-500">select an artifact</p>
          ) : preview.text !== null ? (
            <pre className="whitespace-pre-wrap break-all text-xs">{preview.text}</pre>
          ) : (
            <a
              href={api.artifactUrl(preview.meta.content_hash)}
              target="_blank"
              rel="noreferrer"
              className="text-accent underline"
            >
              open {preview.meta.media_type} ({preview.meta.byte_size} bytes)
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
