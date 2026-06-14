'use client';

/**
 * Settings — read-only projection of the active configuration (Hermes
 * Config/Models/Profiles condensed). Served by GET /v1/sys/config, which
 * redacts every secret (gateway.token → boolean, apiKey → ref|set|none).
 * Editing stays a CLI concern (memex onboard) until the CONSOLE-REDESIGN
 * writable LLM-settings exception lands (Appendix A) — the Dashboard is a
 * projection, not a writer.
 */

import { useEffect, useState } from 'react';
import { api, type SysConfig } from '@/lib/api';
import { Badge, Panel, StatusDot, Tag } from '@/components/ds';
import { LlmSettingsForm } from '@/components/LlmSettingsForm';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-4)', padding: '7px 0', borderBottom: 'var(--hairline)' }}>
      <span className="ds-label">{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--text-primary)', textAlign: 'right', overflowWrap: 'anywhere' }}>{children}</span>
    </div>
  );
}

export default function SettingsPage() {
  const [cfg, setCfg] = useState<SysConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => {
    api
      .sysConfig()
      .then(setCfg)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'load failed'));
  };

  useEffect(reload, []);

  if (error !== null) return <Badge tone="danger">{error}</Badge>;
  if (cfg === null) return <p className="ds-label">loading configuration…</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gutter)', maxWidth: 920, textAlign: 'left' }}>
      {!cfg.config_present ? (
        <Panel variant="sunken">
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
            No config file at <code style={{ color: 'var(--brass-300)' }}>{cfg.config_path}</code> — the
            stack is booting from environment variables. Run <code style={{ color: 'var(--brass-300)' }}>memex onboard</code> to write one.
          </p>
        </Panel>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--gutter)' }}>
        <Panel eyebrow="Runtime" title="Gateway">
          <Row label="Profile">{cfg.profile ?? 'default'}</Row>
          <Row label="Port">{cfg.gateway.port ?? '—'}</Row>
          <Row label="WebSocket">
            <StatusDot tone={cfg.gateway.websocket ? 'ok' : 'idle'}>{cfg.gateway.websocket ? 'on' : 'off'}</StatusDot>
          </Row>
          <Row label="Realtime token">
            <Badge tone={cfg.gateway.token_set ? 'ok' : 'neutral'}>{cfg.gateway.token_set ? 'configured' : 'none (localhost only)'}</Badge>
          </Row>
          <Row label="Config path">{cfg.config_path}</Row>
        </Panel>

        <Panel eyebrow="Semantic index" title="Embedding">
          {cfg.embedding.configured ? (
            <>
              <Row label="Status"><Badge tone="ok" dot>active</Badge></Row>
              <Row label="Source">{cfg.embedding.source}</Row>
              <Row label="Model">{cfg.embedding.model}</Row>
              <Row label="Endpoint">{cfg.embedding.base_url}</Row>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
              <Badge tone="warn" dot>degraded — lexical retrieval (ADR-55)</Badge>
              <p className="ds-label">no embedding endpoint configured; the semantic index runs on BM25 until one is added</p>
            </div>
          )}
        </Panel>
      </div>

      <Panel eyebrow="Inference" title="Providers" actions={<Tag>{cfg.providers.length} configured</Tag>}>
        {cfg.providers.length === 0 ? (
          <p className="ds-label">no providers configured</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {cfg.providers
              .slice()
              .sort((a, b) => a.priority - b.priority)
              .map((p) => (
                <div
                  key={`${p.name}-${p.priority}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-3)',
                    padding: '11px 13px',
                    borderRadius: 'var(--radius-md)',
                    border: 'var(--border-width) solid var(--border-hairline)',
                    background: 'var(--surface-raised)',
                    backgroundImage: 'var(--sheen-panel)',
                  }}
                >
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--text-muted)', width: 28 }}>#{p.priority}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                      <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, color: 'var(--text-heading)' }}>{p.display_name}</span>
                      {p.local ? <Tag>local</Tag> : null}
                      {p.supports_embedding ? <Tag>embeds</Tag> : null}
                    </div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                      {p.model}{p.base_url ? ` · ${p.base_url}` : ''}
                    </div>
                  </div>
                  <Badge tone={p.api_key === 'set' ? 'ok' : p.api_key === 'none' ? 'neutral' : 'info'}>
                    {p.api_key === 'set' ? 'key set' : p.api_key === 'none' ? 'no key' : p.api_key}
                  </Badge>
                </div>
              ))}
          </div>
        )}
      </Panel>

      <LlmSettingsForm
        initialChat={cfg.llm_overrides.chat}
        initialEmbedding={cfg.llm_overrides.embedding}
        present={cfg.llm_overrides.present}
        path={cfg.llm_overrides.path}
        onSaved={reload}
      />

      {cfg.channels.length > 0 ? (
        <Panel eyebrow="Delivery" title="Channels">
          {cfg.channels.map((ch) => (
            <Row key={ch.platform} label={ch.platform}>
              <span style={{ display: 'inline-flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                {ch.llm ? <Tag>agent: {ch.llm}</Tag> : null}
                <Badge tone={ch.configured ? 'ok' : 'neutral'}>{ch.configured ? 'configured' : 'not set'}</Badge>
              </span>
            </Row>
          ))}
        </Panel>
      ) : null}
    </div>
  );
}
