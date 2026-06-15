import { describe, it, expect } from 'vitest';
import { injectExtraContent, harvestSseChunk } from './signature-shim.js';

/**
 * The signature round-trip is provider-agnostic: harvest whatever extra_content a
 * streamed tool_call carries (keyed by id), then echo it verbatim onto the next
 * request's assistant tool_call with that id. Gemini's thought_signature is the
 * driving case but nothing here knows about Gemini.
 */
describe('harvestSseChunk', () => {
  const gemSig = { google: { thought_signature: 'sig-abc' } };

  it('captures extra_content when id and extra arrive in the same delta', () => {
    const byIndex = new Map();
    const sigById = new Map();
    harvestSseChunk(
      `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'x' }, extra_content: gemSig }] } }],
      })}\n\n`,
      byIndex,
      sigById,
    );
    expect(sigById.get('call_1')).toEqual(gemSig);
  });

  it('joins id and extra_content that arrive in separate deltas', () => {
    const byIndex = new Map();
    const sigById = new Map();
    // delta 1: id, no extra
    harvestSseChunk(
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_2' }] } }] })}\n`,
      byIndex,
      sigById,
    );
    expect(sigById.has('call_2')).toBe(false);
    // delta 2: extra, same index, no id
    harvestSseChunk(
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, extra_content: gemSig }] } }] })}\n`,
      byIndex,
      sigById,
    );
    expect(sigById.get('call_2')).toEqual(gemSig);
  });

  it('ignores [DONE], blank lines, and non-data lines', () => {
    const byIndex = new Map();
    const sigById = new Map();
    harvestSseChunk(': comment\n\ndata: [DONE]\n', byIndex, sigById);
    expect(sigById.size).toBe(0);
  });

  it('tolerates a partial/non-JSON data line without throwing', () => {
    const byIndex = new Map();
    const sigById = new Map();
    expect(() => harvestSseChunk('data: {"choices":[{"delta', byIndex, sigById)).not.toThrow();
    expect(sigById.size).toBe(0);
  });

  it('handles a tool_call delta with no extra_content (non-thinking model)', () => {
    const byIndex = new Map();
    const sigById = new Map();
    harvestSseChunk(
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_3', function: { name: 'y' } }] } }] })}\n`,
      byIndex,
      sigById,
    );
    expect(sigById.size).toBe(0);
  });
});

describe('injectExtraContent', () => {
  const gemSig = { google: { thought_signature: 'sig-abc' } };

  it('echoes stored extra_content onto a matching assistant tool_call', () => {
    const sigById = new Map<string, unknown>([['call_1', gemSig]]);
    const body = JSON.stringify({
      model: 'gemini',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      ],
    });
    const out = JSON.parse(injectExtraContent(body, sigById));
    expect(out.messages[1].tool_calls[0].extra_content).toEqual(gemSig);
  });

  it('is a no-op when there is nothing stored', () => {
    const body = JSON.stringify({ messages: [{ role: 'assistant', tool_calls: [{ id: 'call_1' }] }] });
    expect(injectExtraContent(body, new Map())).toBe(body);
  });

  it('does not overwrite an extra_content already present', () => {
    const sigById = new Map<string, unknown>([['call_1', gemSig]]);
    const existing = { google: { thought_signature: 'keep-me' } };
    const body = JSON.stringify({
      messages: [{ role: 'assistant', tool_calls: [{ id: 'call_1', extra_content: existing }] }],
    });
    const out = JSON.parse(injectExtraContent(body, sigById));
    expect(out.messages[0].tool_calls[0].extra_content).toEqual(existing);
  });

  it('leaves tool_calls without a stored signature untouched (model switch)', () => {
    const sigById = new Map<string, unknown>([['call_1', gemSig]]);
    const body = JSON.stringify({
      messages: [{ role: 'assistant', tool_calls: [{ id: 'call_other', function: { name: 'z' } }] }],
    });
    const out = JSON.parse(injectExtraContent(body, sigById));
    expect(out.messages[0].tool_calls[0].extra_content).toBeUndefined();
  });

  it('returns the body unchanged on non-JSON input', () => {
    const sigById = new Map<string, unknown>([['call_1', gemSig]]);
    expect(injectExtraContent('not json', sigById)).toBe('not json');
  });
});
