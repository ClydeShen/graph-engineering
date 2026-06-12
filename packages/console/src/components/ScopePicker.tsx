'use client';

/**
 * ScopePicker — recent-scope dropdown for pages that take a scope_id
 * (UX-audit U17: users can't be expected to know a uuid by heart).
 * Pure read: GET /v1/scopes, newest first. Picking an entry calls onPick.
 */

import { useEffect, useState } from 'react';
import { api, type ScopeSummary } from '@/lib/api';

export function ScopePicker({ onPick }: { onPick: (scopeId: string) => void }) {
  const [scopes, setScopes] = useState<ScopeSummary[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    api
      .scopes()
      .then((r) => setScopes(r.scopes))
      .catch(() => setError(true));
  }, []);

  if (error || scopes.length === 0) return null;

  return (
    <select
      value=""
      onChange={(e) => {
        if (e.target.value.length > 0) onPick(e.target.value);
      }}
      className="bg-panel border border-line rounded px-2 py-1.5 max-w-72 outline-none focus:border-accent text-gray-300"
    >
      <option value="">recent scopes…</option>
      {scopes.map((s) => (
        <option key={s.scope_id} value={s.scope_id}>
          {(s.intent ?? '').slice(0, 40) || s.scope_id.slice(0, 8)} · {s.scope_id.slice(0, 8)} ·{' '}
          {s.status}
        </option>
      ))}
    </select>
  );
}
