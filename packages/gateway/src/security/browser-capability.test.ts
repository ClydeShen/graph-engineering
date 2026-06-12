import { describe, expect, it } from 'vitest';
import {
  buildBrowserRunArgs,
  mapBrowserCall,
  shellQuote,
  UnknownBrowserImplError,
} from './browser-capability.js';

describe('shellQuote', () => {
  it('single-quotes and escapes embedded quotes', () => {
    expect(shellQuote('plain')).toBe(`'plain'`);
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
  });
});

describe('mapBrowserCall (agent-browser)', () => {
  it('maps all five ops', () => {
    expect(mapBrowserCall('agent-browser', { op: 'navigate', url: 'https://courts.example' })).toBe(
      `agent-browser open 'https://courts.example'`,
    );
    expect(mapBrowserCall('agent-browser', { op: 'read' })).toBe('agent-browser snapshot');
    expect(mapBrowserCall('agent-browser', { op: 'fill', selector: '#pw', text: 'x' })).toBe(
      `agent-browser fill '#pw' 'x'`,
    );
    expect(mapBrowserCall('agent-browser', { op: 'click', selector: '#book' })).toBe(
      `agent-browser click '#book'`,
    );
    expect(mapBrowserCall('agent-browser', { op: 'screenshot' })).toContain('screenshot');
  });

  it('rejects missing arguments and unknown implementations', () => {
    expect(() => mapBrowserCall('agent-browser', { op: 'navigate' })).toThrow(/missing required/);
    expect(() => mapBrowserCall('playwright', { op: 'read' })).toThrow(UnknownBrowserImplError);
  });
});

describe('buildBrowserRunArgs', () => {
  it('keeps the security args, switches network to bridge, uses the browser image', () => {
    const args = buildBrowserRunArgs('agent-browser', { op: 'read' }, { image: 'memex-browser:test' });
    const s = args.join(' ');
    expect(s).toContain('--cap-drop ALL');
    expect(s).toContain('no-new-privileges');
    expect(s).toContain('--network bridge'); // browsers need egress; everything else stays locked
    expect(s).toContain('memex-browser:test');
    expect(args.at(-1)).toBe('agent-browser snapshot');
  });
});
