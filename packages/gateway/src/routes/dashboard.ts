/**
 * GET /dashboard — read-only live view v0 (Phase 11).
 *
 * Self-contained HTML (no build step, no framework): SSE live trail feed via
 * /v1/stream + scope topology lookup via /v1/scopes/:id/topology. This is the
 * deliberately-cut-down increment per 11-PHASE-SPEC §7 ("砍 Dashboard 可视化的
 * 丰富度") — the full Console (Next.js per docs/CONSOLE-REDESIGN.md) remains a
 * planned frontend project; this page proves the realtime data path end to end
 * and gives operators a zero-install live window.
 *
 * Read-only by design (UI-SPEC 原则 2): no write operations exist on this page.
 */

import { Hono } from 'hono';

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>MemexOS — live view</title>
<style>
  :root { color-scheme: dark; }
  body { font: 13px/1.5 ui-monospace, Consolas, monospace; background: #0d1117; color: #c9d1d9; margin: 0; }
  header { padding: 10px 16px; background: #161b22; border-bottom: 1px solid #30363d; display: flex; gap: 16px; align-items: baseline; }
  header h1 { font-size: 14px; margin: 0; color: #58a6ff; }
  #status { font-size: 12px; }
  #status.ok { color: #3fb950; } #status.err { color: #f85149; }
  main { display: grid; grid-template-columns: 1fr 1fr; gap: 0; height: calc(100vh - 41px); }
  section { overflow-y: auto; padding: 12px 16px; border-right: 1px solid #30363d; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #8b949e; }
  .evt { padding: 4px 8px; border-left: 2px solid #30363d; margin-bottom: 4px; }
  .evt .t { color: #8b949e; font-size: 11px; }
  .evt.scope_closed { border-color: #3fb950; }
  .evt.conflict_detected { border-color: #f85149; }
  .evt.task_spawned { border-color: #58a6ff; }
  .evt.memory_updated { border-color: #d29922; }
  input { background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; padding: 4px 8px; width: 320px; }
  button { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 4px 12px; cursor: pointer; }
  pre { background: #161b22; padding: 8px; overflow-x: auto; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>MemexOS live view</h1>
  <span id="status">connecting…</span>
</header>
<main>
  <section>
    <h2>Live trail</h2>
    <div id="feed"></div>
  </section>
  <section>
    <h2>Scope topology</h2>
    <p><input id="scopeId" placeholder="scope UUID"> <button id="load">load</button></p>
    <pre id="topology">—</pre>
  </section>
</main>
<script>
  const token = new URLSearchParams(location.search).get('token');
  const qs = token ? '?token=' + encodeURIComponent(token) : '';
  const statusEl = document.getElementById('status');
  const feed = document.getElementById('feed');

  const es = new EventSource('/v1/stream' + qs);
  es.onopen = () => { statusEl.textContent = 'live'; statusEl.className = 'ok'; };
  es.onerror = () => { statusEl.textContent = 'reconnecting…'; statusEl.className = 'err'; };
  es.addEventListener('trail_event', (e) => {
    let evt; try { evt = JSON.parse(e.data); } catch { return; }
    const div = document.createElement('div');
    div.className = 'evt ' + (evt.event_type || '');
    div.innerHTML = '<span class="t">' + (evt.timestamp || '') + '</span> '
      + '<b>' + (evt.event_type || '?') + '</b> '
      + '<span class="t">scope ' + (evt.scope_id || '').slice(0, 8) + '</span>';
    div.title = JSON.stringify(evt.payload);
    feed.prepend(div);
    while (feed.childElementCount > 200) feed.lastChild.remove();
  });

  document.getElementById('load').onclick = async () => {
    const id = document.getElementById('scopeId').value.trim();
    if (!id) return;
    const out = document.getElementById('topology');
    out.textContent = 'loading…';
    try {
      const res = await fetch('/v1/scopes/' + encodeURIComponent(id) + '/topology');
      out.textContent = JSON.stringify(await res.json(), null, 2);
    } catch (err) { out.textContent = String(err); }
  };
</script>
</body>
</html>
`;

export function buildDashboardRoute(): Hono {
  const app = new Hono();
  app.get('/dashboard', (c) => c.html(PAGE));
  return app;
}
