/**
 * Thinking-model signature round-trip (provider-agnostic) — ADR-57 follow-up.
 *
 * Some thinking models attach a per-tool-call vendor extra that the API REQUIRES
 * echoed back on the next turn, or it rejects the follow-up request with 400.
 * The canonical case is Gemini's OpenAI-compatible endpoint: a tool_call carries
 * `extra_content.google.thought_signature`, and the next request's assistant
 * tool_call must replay that exact `extra_content` ("Function call is missing a
 * thought_signature").
 *
 * pi-ai already models this concept (it round-trips OpenRouter's
 * `reasoning_details` as a tool-call thoughtSignature) but does NOT round-trip
 * the `extra_content` wire form, so direct Gemini tool use breaks. pi-ai exposes
 * no custom-fetch seam (createClient hardcodes `new OpenAI({apiKey,baseURL,…})`),
 * and its OpenAI SDK falls back to `globalThis.fetch`. So we install a scoped
 * fetch wrapper here, in our own code — surviving pi-ai upgrades, no fork.
 *
 * The mechanism mirrors Hermes' chat_completions transport: capture whatever
 * `extra_content` a streamed tool_call carries, keyed by tool_call id, and echo
 * it verbatim onto outgoing assistant tool_calls with that id. There is no
 * "if gemini" — any provider that uses `extra_content` round-trips for free, so
 * switching models mid-session (thinking or not) just works.
 *
 * @see D:/Repo/specimens/hermes-agent/agent/transports/chat_completions.py
 */

const SHIM_FLAG = Symbol.for('memex.signature-shim.installed');

/** A 4xx whose body is empty — the case pi-ai misreads as a context overflow. */
export function isBareBody(text: string): boolean {
  return text.trim() === '';
}

/**
 * A 4xx response carrying a descriptive body. pi-ai's isContextOverflow treats a
 * bare "400/413 (no body)" as a context overflow (a Cerebras quirk) and runs a
 * destructive compact-and-retry that fails with a misleading message. Giving the
 * error a body — deliberately free of any overflow phrase — makes pi surface the
 * real bad-request instead of looping on a phantom overflow.
 */
export function overflowSafeBadRequest(status: number): Response {
  const body = JSON.stringify({
    error: {
      message:
        `The model endpoint returned HTTP ${status} with no error body. This is a ` +
        `bad request (often a transient endpoint hiccup, or an invalid message ` +
        `sequence after history compaction) — not an oversized prompt. Retry, or ` +
        `switch models if it persists.`,
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

/** Debug: print the outgoing message structure (roles, tool_calls, signatures). */
function dumpRequest(body: string, sigById: Map<string, unknown>): void {
  try {
    const p = JSON.parse(body) as { messages?: Array<Record<string, unknown>> };
    const rows = (p.messages ?? []).map((m, i) => {
      const role = m['role'];
      const tcs = Array.isArray(m['tool_calls']) ? (m['tool_calls'] as Array<Record<string, unknown>>) : [];
      const tcInfo = tcs.map((tc) => {
        const id = String(tc['id'] ?? '?');
        return `${id.slice(0, 8)}${tc['extra_content'] ? '+sig' : sigById.has(id) ? '~have' : '!nosig'}`;
      });
      const tcid = m['tool_call_id'] ? `→${String(m['tool_call_id']).slice(0, 8)}` : '';
      return `${i}:${role}${tcInfo.length ? `[${tcInfo.join(',')}]` : ''}${tcid}`;
    });
    process.stderr.write(`\n[shim] req msgs: ${rows.join(' ')}\n`);
  } catch {
    /* ignore */
  }
}

/** A request whose path is the OpenAI-compatible chat endpoint (any provider). */
function isChatCompletions(url: string): boolean {
  return url.includes('/chat/completions');
}

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof (input as { url?: unknown }).url === 'string') return (input as { url: string }).url;
  return '';
}

/**
 * Echo stored extra_content onto outgoing assistant tool_calls by id. pi-ai
 * serializes tool_calls without it (it only knows the reasoning_details form),
 * so we re-attach what the model gave us. Pure + exported for tests.
 */
export function injectExtraContent(body: string, sigById: Map<string, unknown>): string {
  if (sigById.size === 0) return body;
  let parsed: { messages?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  const messages = parsed.messages;
  if (!Array.isArray(messages)) return body;
  let touched = false;
  for (const m of messages) {
    const msg = m as { role?: string; tool_calls?: unknown };
    if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue;
    for (const tc of msg.tool_calls) {
      const call = tc as { id?: string; extra_content?: unknown };
      if (call.id && call.extra_content === undefined && sigById.has(call.id)) {
        call.extra_content = sigById.get(call.id);
        touched = true;
      }
    }
  }
  return touched ? JSON.stringify(parsed) : body;
}

type Slot = { id?: string; extra?: unknown };

/**
 * Feed SSE text (one or more chunks) into a per-index accumulator and commit
 * `id -> extra_content` once both are known for a tool_call. OpenAI streams a
 * tool_call's id and its extra_content possibly in different deltas, so we
 * accumulate by `index` and commit eagerly. Pure + exported for tests.
 */
export function harvestSseChunk(
  text: string,
  byIndex: Map<number, Slot>,
  sigById: Map<string, unknown>,
): void {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let chunk: { choices?: Array<{ delta?: { tool_calls?: unknown } }> };
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    const toolCalls = chunk.choices?.[0]?.delta?.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      const call = tc as { index?: number; id?: string; extra_content?: unknown };
      const idx = call.index ?? 0;
      const slot = byIndex.get(idx) ?? {};
      if (call.id) slot.id = call.id;
      if (call.extra_content !== undefined) slot.extra = call.extra_content;
      byIndex.set(idx, slot);
      if (slot.id && slot.extra !== undefined) sigById.set(slot.id, slot.extra);
    }
  }
}

/**
 * Wrap a streaming chat response so its bytes pass through verbatim while we
 * harvest extra_content out of the SSE. We re-emit each chunk before parsing it,
 * so pi-ai sees an identical stream.
 */
function harvestResponse(res: Response, sigById: Map<string, unknown>): Response {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const byIndex = new Map<number, Slot>();
  let buf = '';
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value); // pass through, byte-identical
      buf += decoder.decode(value, { stream: true });
      // Only parse whole lines; keep any partial trailing line buffered.
      const lastNl = buf.lastIndexOf('\n');
      if (lastNl < 0) return;
      const ready = buf.slice(0, lastNl);
      buf = buf.slice(lastNl + 1);
      harvestSseChunk(ready, byIndex, sigById);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * Install the provider-agnostic signature round-trip once per process. Idempotent
 * (guarded by a global symbol) and scoped to chat/completions requests — every
 * other fetch passes straight through. Call before the Pi runtime issues any
 * model call; buildCoreModelRegistry() is the shared chokepoint.
 */
export function installSignatureShim(): void {
  const g = globalThis as unknown as Record<symbol, unknown> & { fetch?: typeof fetch };
  if (g[SHIM_FLAG]) return;
  const initialFetch = g.fetch;
  if (typeof initialFetch !== 'function') return;
  // `let` because the setter below re-points this at any fetch a later
  // globalThis.fetch reassignment installs (pi's configureHttpDispatcher runs
  // undici.install(), i.e. `globalThis.fetch = undici.fetch`, AFTER us).
  let realFetch: typeof fetch = initialFetch;
  const sigById = new Map<string, unknown>();

  const debug = !!process.env['MEMEX_SHIM_DEBUG'];
  const wrapped: typeof fetch = async (input, init) => {
    const url = urlOf(input);
    const isChat = isChatCompletions(url);
    if (isChat && init && typeof init.body === 'string') {
      if (debug) dumpRequest(init.body, sigById);
      init = { ...init, body: injectExtraContent(init.body, sigById) };
    }
    let res = await realFetch(input as Parameters<typeof fetch>[0], init);

    // Bare-4xx normalization: a 400/413 with an empty body is not a context
    // overflow (pi-ai misclassifies it as one). The model request is idempotent
    // (same messages), so retry once — recovers transient hiccups the OpenAI SDK
    // won't retry for a 400 — then, if still bare, hand pi an honest error body.
    if (isChat && (res.status === 400 || res.status === 413)) {
      const text = await res.clone().text().catch(() => '');
      if (isBareBody(text)) {
        if (debug) process.stderr.write(`\n[shim] bare ${res.status} — retry once\n`);
        res = await realFetch(input as Parameters<typeof fetch>[0], init);
        if (res.status === 400 || res.status === 413) {
          const retryText = await res.clone().text().catch(() => '');
          if (isBareBody(retryText)) return overflowSafeBadRequest(res.status);
        }
      }
    }

    if (isChat && debug && !res.ok) {
      const body = await res.clone().text().catch(() => '<unreadable>');
      process.stderr.write(`\n[shim] ${res.status} body: ${body.slice(0, 800)}\n`);
    }
    // Only tee the SSE stream; non-streaming responses (errors, key-tier probes)
    // pass through untouched.
    const isStream = res.headers.get('content-type')?.includes('text/event-stream') ?? false;
    if (isChat && res.ok && res.body && isStream) return harvestResponse(res, sigById);
    return res;
  };

  // Resilient install: define globalThis.fetch as a getter that ALWAYS returns
  // our wrapper, plus a setter that captures any later reassignment as the new
  // inner fetch. Plain assignment (the old approach) was silently clobbered when
  // pi's configureHttpDispatcher() later ran undici.install() — that overwrote
  // globalThis.fetch, so pi's model requests bypassed us entirely (observed: the
  // wrap installed but was never invoked in the real InteractiveMode session).
  // undici.install() uses assignment, so our setter intercepts it: we adopt
  // pi's undici fetch as realFetch (preserving its dispatcher) while keeping our
  // wrapper as the public globalThis.fetch.
  Object.defineProperty(g, 'fetch', {
    configurable: true,
    enumerable: true,
    get() {
      return wrapped;
    },
    set(next: unknown) {
      if (typeof next === 'function' && next !== wrapped) realFetch = next as typeof fetch;
    },
  });
  g[SHIM_FLAG] = true;
}
