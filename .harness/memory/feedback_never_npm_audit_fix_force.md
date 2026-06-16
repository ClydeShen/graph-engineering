---
name: feedback_never_npm_audit_fix_force
description: "Never run `npm audit fix --force` on this repo — it downgrades next 16→9 and breaks the console"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1c613c0c-86d9-43b0-8f65-ecf83d6bc83b
---

`npm audit fix --force` is **destructive** on this repo. Running it downgrades `packages/console` from `next@^16.2.9` (clean, app-router, turbopack, React 19) to `next@9.3.3` (2020-era, React 16) to "fix" a bundled-postcss advisory — which re-introduces ~91 transitive vulnerabilities and breaks the console entirely. It also bumps vitest 2→4, nodemailer 7→8, and sprays spurious deps into console.

**Why:** npm's audit resolver treats next's *internally bundled* postcss as fixable by changing the `next` range, and picks the oldest "non-vulnerable" version (9.3.3). The advisory is really patched by Next upstream, not by downgrading.

**How to apply:** When the install is corrupted this way, don't chase the audit number — revert: `git checkout HEAD -- package.json packages/console/package.json packages/gateway-bot/package.json package-lock.json && npm install`. Verify with `npm run typecheck` + `npm run test:unit`, not `npm audit`. The ~8 baseline advisories (esbuild via vitest@2 = dev-server-only; nodemailer ≤8.0.4; next's bundled postcss) are pre-existing, low-risk, and accepted — do not force-fix them. See [[feedback_live_verification_policy]].
