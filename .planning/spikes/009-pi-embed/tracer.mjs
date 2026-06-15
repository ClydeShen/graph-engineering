// Tracer bullet — ADR-57 R-A embed of @earendil-works/pi-coding-agent.
// Goal: confirm the embed wiring against the REAL API and observe the
// AgentSessionEvent stream granularity (kill-criterion: before_agent_start /
// turn boundaries). No real LLM key — prompt() is guarded; a model requirement
// is itself a useful finding (pinpoints the one build-out seam = Core provider).
import {
  createAgentSession,
  defineTool,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const log = (...a) => console.log('[tracer]', ...a);

// 1. A custom tool standing in for an in-process MemexCore function (e.g. a
//    graph write / query_context). Build-out replaces execute() with the real
//    Core handler; the registration shape is what we verify here.
const graphWriteTool = defineTool({
  name: 'graph_write',
  label: 'Graph Write',
  description: 'Stand-in for an in-process MemexCore graph write.',
  parameters: Type.Object({ note: Type.String() }),
  async execute(_toolCallId, params) {
    log('TOOL graph_write executed with', JSON.stringify(params));
    return { content: [{ type: 'text', text: 'ok (stub Core write)' }] };
  },
});

async function main() {
  log('creating session: noTools=builtin (suppress pi bash/edit/write), customTools=[graph_write]');
  let session;
  try {
    const result = await createAgentSession({
      noTools: 'builtin', // safety: pi's raw bash off; only Core tools surface
      customTools: [graphWriteTool],
      sessionManager: SessionManager.inMemory?.() ?? undefined,
    });
    session = result.session;
    log('session created. modelFallbackMessage=', result.modelFallbackMessage ?? '(none)');
  } catch (err) {
    log('createAgentSession threw (likely model/auth seam):', err?.message ?? err);
    log('FINDING: build-out must supply a Model (Core onboarded provider) — that is the remaining seam.');
    return;
  }

  // 2. Confirm the custom tool registered and pi builtins are suppressed.
  log('graph_write registered?', !!session.getToolDefinition?.('graph_write'));
  log('bash (pi builtin) suppressed?', !session.getToolDefinition?.('bash'));

  // 3. Observe the event stream granularity. This is where C3 maps:
  //    before_agent_start (per user prompt) = inject Core projection;
  //    agent_end (per user prompt) = flush turn to ledger;
  //    turn_start/turn_end (per internal turn) = fine-grained trail.
  const seen = [];
  const unsub = session.subscribe?.((event) => {
    const idx = event.turnIndex !== undefined ? ` turnIndex=${event.turnIndex}` : '';
    seen.push(event.type);
    log('EVENT', event.type + idx);
  });

  // 4. Drive one user prompt. Without a model this will surface the seam;
  //    with one it exercises the full loop and prints the event granularity.
  try {
    log('prompt("ping")...');
    await session.prompt('ping');
    log('prompt resolved. event sequence:', seen.join(' -> '));
  } catch (err) {
    log('prompt threw (model/auth seam):', err?.message ?? err);
    log('event sequence before throw:', seen.join(' -> '));
  } finally {
    unsub?.();
  }
}

main().catch((e) => {
  console.error('[tracer] fatal', e);
  process.exit(1);
});
