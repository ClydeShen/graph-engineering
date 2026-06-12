import { defineConfig } from 'vitest/config';
import path from 'path';
import { readFileSync } from 'fs';

function loadDotenv(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(path.resolve(__dirname, '.env'), 'utf8')
        .split('\n')
        .filter(l => l.trim() && !l.startsWith('#'))
        .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
        .filter(([k]) => k),
    );
  } catch {
    return {};
  }
}

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'packages/shared/src'),
      '@graph/shared': path.resolve(__dirname, 'packages/shared/src'),
      '@graph/workers': path.resolve(__dirname, 'packages/workers/src'),
      '@graph/control-plane': path.resolve(__dirname, 'packages/control-plane/src'),
      '@graph/gateway': path.resolve(__dirname, 'packages/gateway/src'),
      '@graph/types/core': path.resolve(__dirname, 'packages/types/src/core.ts'),
      '@graph/types/api': path.resolve(__dirname, 'packages/types/src/api.ts'),
      '@graph/types/shell': path.resolve(__dirname, 'packages/types/src/shell.ts'),
      '@graph/types': path.resolve(__dirname, 'packages/types/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'src/**/*.test.ts', 'tests/**/*.test.ts'],
    env: loadDotenv(),
  },
});
