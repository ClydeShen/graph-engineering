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
import { api, type HealthResponse } from '@/lib/api';
import { Logo } from '@/components/Logo';
import { Badge, Icon, IconButton, StatusDot, type IconName } from '@/components/ds';

// Human-legible IA (CONSOLE-REDESIGN §5). Engine jargon (Topology/Kernel/Alerts/
// Crystallized-lessons) is gone: Now = the living universe, Workspace = what was
// made, Emergence = what was learned, Plugins = installable skills. Kernel +
// Alerts pages are removed (Occam — §5 note).
const NAV: Array<{ href: string; label: string; icon: IconName }> = [
  { href: '/', label: 'Overview', icon: 'activity' },
  { href: '/now', label: 'Now', icon: 'git-branch' },
  { href: '/chat', label: 'Chat', icon: 'terminal' },
  { href: '/sessions', label: 'History', icon: 'clock' },
  { href: '/artifacts', label: 'Workspace', icon: 'box' },
  { href: '/emergence', label: 'Emergence', icon: 'zap' },
  { href: '/review', label: 'Review', icon: 'check' },
  { href: '/skills', label: 'Plugins', icon: 'layers' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
];

const TITLES: Record<string, [string, string]> = {
  '/': ['Overview', 'what your system is up to right now'],
  '/now': ['Now', 'the living universe — channels, tasks, growth'],
  '/chat': ['Chat', 'talk to the system · every turn joins the trail'],
  '/sessions': ['History', 'past tasks · replay any conversation'],
  '/topology': ['Task tree', 'one task · its sub-tasks as they grow'],
  '/artifacts': ['Workspace', 'what the system has made for you'],
  '/emergence': ['Emergence', 'what the system has learned'],
  '/review': ['Review', 'procedures the system is unsure about · your call teaches it'],
  '/skills': ['Plugins', 'installable skills · add or remove capabilities'],
  '/settings': ['Settings', 'active configuration'],
};

// No polling labels: Now/tree are SSE-driven (batch 8), the rest load once.
const POLL: Record<string, string> = {};

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
        <Link href="/settings" aria-label="Settings" style={{ display: 'inline-flex' }}>
          <IconButton variant="ghost" aria-label="Settings">
            <Icon name="settings" />
          </IconButton>
        </Link>
      </span>
    </header>
  );
}

function Rail({ pathname }: { pathname: string }) {
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
          // '/' must match exactly, else Overview lights up on every route.
          const on = n.href === '/' ? pathname === '/' : pathname.startsWith(n.href);
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
            </Link>
          );
        })}
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
        <span className="ds-label" style={{ fontSize: 9 }}>Memex</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
          graph-native runtime
        </span>
      </div>
    </nav>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState(false);

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

  const [title, subtitle] = TITLES[pathname] ?? ['Memex', 'a window into what your system is doing'];
  const poll = POLL[pathname];

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Ribbon health={health} error={healthError} />
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <Rail pathname={pathname} />
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
