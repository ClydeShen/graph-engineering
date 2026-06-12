#!/usr/bin/env node
// memex bin launcher — registers the tsx loader so the TypeScript sources run
// directly from a repo checkout (`npm link --workspace packages/cli`).
// Plain `node src/index.ts` fails on the first relative '.js' import: Node's
// type stripping does not remap .js specifiers to .ts files; tsx does.
import { register } from 'tsx/esm/api';
register();
await import('../src/index.ts');
