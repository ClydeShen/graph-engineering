'use client';

import { useState } from 'react';
import { TopologyCanvas } from '@/components/TopologyCanvas';
import { ScopePicker } from '@/components/ScopePicker';

export default function TopologyPage() {
  const [input, setInput] = useState('');
  const [scopeId, setScopeId] = useState('');

  return (
    <div className="space-y-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setScopeId(input.trim());
        }}
      >
        <ScopePicker
          onPick={(id) => {
            setInput(id);
            setScopeId(id);
          }}
        />
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
      {scopeId.length > 0 ? (
        <TopologyCanvas key={scopeId} scopeId={scopeId} />
      ) : (
        <p className="text-gray-500">enter a scope id to render its causal topology</p>
      )}
    </div>
  );
}
