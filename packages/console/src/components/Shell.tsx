'use client';

/**
 * ConsoleShell — observatory chrome: status ribbon + instrument rail around
 * the routed page body. Ported from the Memex Design System ui_kit Shell.jsx.
 * Owns the live /v1/sys/health poll (1s) and the recent-scopes list (5s) —
 * StatusRibbon/Nav are retired in favor of this single chrome component.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { api, type HealthResponse, type ScopeSummary } from '@/lib/api';
import { Logo } from '@/components/Logo';
import { Badge, Icon, IconButton, Input, StatusDot, type IconName } from '@/components/ds';

const NAV: Array<{ href: string; label: string; icon: IconName }> = [
  { href: '/chat', label: 'Chat', icon: 'terminal' },
  { href: '/topology', label: 'Topology', icon: 'git-branch' },
  { href: '/kernel', label: 'Kernel', icon: 'gauge' },
  { href: '/alerts', label: 'Alerts', icon: 'triangle-alert' },
  { href: '/artifacts', label: 'Artifacts', icon: 'box' },
  { href: '/skills', label: 'Skills', icon: 'layers' },
];

const TITLES: Record<string, [string, string]> = {
  '/chat': ['Conversation', 'memex terminal · every turn written to the trail'],
  '/topology': ['Causal topology', 'one scope · live projection of the trail'],
  '/kernel': ['Kernel telemetry', 'worker bus · concurrency & backlog'],
  '/alerts': ['Suspended scopes', 'frozen trails awaiting reconciliation'],
  '/artifacts': ['Artifacts', 'content-addressed blobs · scope projection'],
  '/skills': ['Crystallized lessons', 'exported portable skill definitions'],
};

const POLL: Record<string, string> = {
  '/topology': '2000ms',
  '/kernel': '2000ms',
  '/alerts': '5000ms',
};

function Ribbon({ health, error }: { health: HealthResponse | null; error: boolean }) {
  const ok = !error && health?.engine_status === 'ok';
  const maxSlots = health?.slots ?? 0;
  const activeSlots = maxSlots - (health?.idle_slots ?? 0);
  return (
    <header
      style={{
        height: 'var(--ribbon-h)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-5)',
        padding: '0 var(--space-5)',
        background: 'var(--surface-panel)',
        backgroundImage: 'var(--sheen-panel)',
        borderBottom: 'var(--hairline)',
        boxShadow: 'var(--shadow-engrave)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, color: 'var(--brass-500)' }}>
        <Logo size={22} />
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 600,
            fontSize: 'var(--text-md)',
            color: 'var(--text-heading)',
            letterSpacing: '0.01em',
          }}
        >
          Memex
        </span>
        <span className="ds-label" style={{ fontSize: 9 }}>Console</span>
      </div>
      <span style={{ width: 1, height: 18, background: 'var(--border-hairline)' }} />
      <StatusDot tone={ok ? 'ok' : 'danger'} live={ok}>
        Engine {error ? 'UNREACHABLE' : (health?.engine_status ?? '…').toUpperCase()}
      </StatusDot>
      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 'var(--space-5)' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          <span style={{ color: 'var(--text-muted)' }}>live scopes </span>{health?.live_scopes ?? '—'}
        </span>
        <Badge tone={health?.suspended_count ? 'danger' : 'ok'} dot>
          {health?.suspended_count ?? 0} suspended
        </Badge>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          <span style={{ color: 'var(--text-muted)' }}>slots </span>
          {health?.slots !== undefined ? `${activeSlots}/${maxSlots}` : '—'}
        </span>
        <IconButton variant="ghost" aria-label="Settings">
          <Icon name="settings" />
        </IconButton>
      </span>
    </header>
  );
}

function Rail({ pathname, suspendedCount, scopes }: { pathname: string; suspendedCount: number; scopes: ScopeSummary[] }) {
  const [filter, setFilter] = useState('');
  const filtered = filter.trim().length === 0
    ? scopes
    : scopes.filter((s) => s.scope_id.includes(filter) || (s.intent ?? '').toLowerCase().includes(filter.toLowerCase()));

  return (
    <nav
      style={{
        width: 'var(--rail-w)',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-5)',
        padding: 'var(--space-5) var(--space-4)',
        borderRight: 'var(--hairline)',
        background: 'var(--surface)',
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {NAV.map((n) => {
          const on = pathname.startsWith(n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 11,
                padding: '9px 11px',
                borderRadius: 'var(--radius-md)',
                border: '1px solid ' + (on ? 'var(--border-hairline)' : 'transparent'),
                background: on ? 'var(--surface-raised)' : 'transparent',
                backgroundImage: on ? 'var(--sheen-panel)' : 'none',
                boxShadow: on ? 'var(--shadow-engrave)' : 'none',
                color: on ? 'var(--text-heading)' : 'var(--text-secondary)',
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--text-base)',
                fontWeight: on ? 600 : 400,
                textDecoration: 'none',
              }}
            >
              <Icon name={n.icon} size={17} style={{ color: on ? 'var(--signal)' : 'var(--text-muted)' }} />
              <span>{n.label}</span>
              {n.href === '/alerts' && suspendedCount > 0 ? (
                <span style={{ marginLeft: 'auto' }}>
                  <Badge tone="danger">{suspendedCount}</Badge>
                </span>
              ) : null}
            </Link>
          );
        })}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', minHeight: 0 }}>
        <span className="ds-label">Scopes</span>
        <Input
          icon={<Icon name="search" size={14} />}
          placeholder="filter scopes…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, overflow: 'auto' }}>
          {filtered.map((s) => (
            <div
              key={s.scope_id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                padding: '8px 9px',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              <StatusDot
                tone={s.status === 'suspended' ? 'danger' : s.status === 'crystallized' ? 'idle' : 'ok'}
                live={s.status === 'live'}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--text-sm)',
                    color: 'var(--text-primary)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {(s.intent ?? '').slice(0, 28) || s.scope_id.slice(0, 8)}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
                  {s.scope_id.slice(0, 8)} · {s.status}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div
        style={{
          marginTop: 'auto',
          paddingTop: 'var(--space-4)',
          borderTop: 'var(--hairline)',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <span className="ds-label" style={{ fontSize: 9 }}>Trail Mesh · PostgreSQL</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
          append-only · pgvector HNSW
        </span>
      </div>
    </nav>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [scopes, setScopes] = useState<ScopeSummary[]>([]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const h = await api.health();
        if (alive) {
          setHealth(h);
          setHealthError(false);
        }
      } catch {
        if (alive) setHealthError(true);
      }
    };
    void tick();
    const id = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api.scopes();
        if (alive) setScopes(r.scopes);
      } catch {
        // recent-scopes list is best-effort
      }
    };
    void tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const [title, subtitle] = TITLES[pathname] ?? ['MemexOS Console', 'Trail Mesh console — read-only projection of the graph'];
  const poll = POLL[pathname];

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Ribbon health={health} error={healthError} />
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <Rail pathname={pathname} suspendedCount={health?.suspended_count ?? 0} scopes={scopes} />
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div
            style={{
              padding: 'var(--space-5) var(--space-6) var(--space-4)',
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'space-between',
              gap: 16,
            }}
          >
            <div>
              <h1 style={{ margin: 0, font: 'var(--type-display)', fontSize: 'var(--text-2xl)', color: 'var(--text-heading)', letterSpacing: '-0.01em' }}>
                {title}
              </h1>
              <p style={{ margin: '6px 0 0', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--text-muted)', letterSpacing: '0.02em' }}>
                {subtitle}
              </p>
            </div>
            {poll ? <span className="ds-label">poll · {poll}</span> : null}
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 var(--space-6) var(--space-6)' }}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
