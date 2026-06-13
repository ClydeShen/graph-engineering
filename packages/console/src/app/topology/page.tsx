'use client';

import { useState } from 'react';
import { TopologyCanvas } from '@/components/TopologyCanvas';
import { ScopePicker } from '@/components/ScopePicker';
import { Button, Icon, Input } from '@/components/ds';

export default function TopologyPage() {
  const [input, setInput] = useState('');
  const [scopeId, setScopeId] = useState('');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gutter)', height: '100%' }}>
      <form
        style={{ display: 'flex', gap: 'var(--space-2)' }}
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
      {scopeId.length > 0 ? (
        <TopologyCanvas key={scopeId} scopeId={scopeId} />
      ) : (
        <p className="ds-label">enter a scope id to render its causal topology</p>
      )}
    </div>
  );
}
