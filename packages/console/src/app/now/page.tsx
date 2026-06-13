'use client';

/**
 * Now — the hero page (CONSOLE-REDESIGN §6). Default view is the L0/L1 universe
 * (galaxies = channels); clicking a task drills into its L2 tree. A back control
 * returns to the universe. Real-time wiring (SSE) lands in batch 8.
 */

import { useState } from 'react';
import { UniverseCanvas } from '@/components/UniverseCanvas';
import { ForestCanvas } from '@/components/ForestCanvas';
import { Button } from '@/components/ds';

export default function NowPage() {
  const [taskId, setTaskId] = useState<string | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gutter)', height: '100%' }}>
      {taskId === null ? (
        <UniverseCanvas onSelectTask={setTaskId} />
      ) : (
        <>
          <div>
            <Button variant="ghost" onClick={() => setTaskId(null)}>
              ← back to the universe
            </Button>
          </div>
          <ForestCanvas key={taskId} scopeId={taskId} />
        </>
      )}
    </div>
  );
}
