#!/usr/bin/env node
// memex-terminal bin launcher — registers the tsx loader so the TypeScript
// sources run directly from a repo checkout (same rationale as cli/bin).
import { register } from 'tsx/esm/api';
register();
await import('../src/index.ts');
