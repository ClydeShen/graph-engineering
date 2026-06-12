import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemexOAuthProvider, safeServerFileName } from './oauth-provider.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-tokens-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const tokens: OAuthTokens = { access_token: 'at-1', token_type: 'bearer', refresh_token: 'rt-1' };

function makeProvider(name = 'github'): MemexOAuthProvider {
  return new MemexOAuthProvider(name, 'http://localhost:7777/callback', () => {}, dir);
}

describe('MemexOAuthProvider', () => {
  it('rejects unsafe server names', () => {
    expect(() => makeProvider('../evil')).toThrow(/unsafe/);
    expect(safeServerFileName('..')).toBeNull();
    expect(safeServerFileName('ok-name_1.x')).toBe('ok-name_1.x');
  });

  it('round-trips tokens, client info, and PKCE verifier in one file', () => {
    const p = makeProvider();
    expect(p.tokens()).toBeUndefined();
    p.saveTokens(tokens);
    p.saveClientInformation({ client_id: 'cid-1' });
    p.saveCodeVerifier('ver-1');
    expect(p.tokens()).toEqual(tokens);
    expect(p.clientInformation()).toEqual({ client_id: 'cid-1' });
    expect(p.codeVerifier()).toBe('ver-1');
    // single file per server
    expect(existsSync(join(dir, 'github.json'))).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(dir, 'github.json'), 'utf8'));
    expect(onDisk.tokens.access_token).toBe('at-1');
  });

  it('codeVerifier throws when nothing is cached (login not run)', () => {
    expect(() => makeProvider().codeVerifier()).toThrow(/memex mcp login/);
  });

  it('invalidateCredentials scopes: tokens only, then all', () => {
    const p = makeProvider();
    p.saveTokens(tokens);
    p.saveClientInformation({ client_id: 'cid-1' });
    p.invalidateCredentials('tokens');
    expect(p.tokens()).toBeUndefined();
    expect(p.clientInformation()).toEqual({ client_id: 'cid-1' });
    p.invalidateCredentials('all');
    expect(existsSync(join(dir, 'github.json'))).toBe(false);
  });

  it('treats a corrupt cache file as empty (re-authorize path)', () => {
    const p = makeProvider();
    p.saveTokens(tokens);
    writeFileSync(join(dir, 'github.json'), '{not json', 'utf8');
    expect(p.tokens()).toBeUndefined();
  });

  it('deleteCache removes the file for uninstall', () => {
    const p = makeProvider();
    p.saveTokens(tokens);
    MemexOAuthProvider.deleteCache('github', dir);
    expect(existsSync(join(dir, 'github.json'))).toBe(false);
  });

  it('clientMetadata declares a public PKCE client with the callback redirect', () => {
    const p = makeProvider();
    expect(p.clientMetadata.token_endpoint_auth_method).toBe('none');
    expect(p.clientMetadata.redirect_uris).toEqual(['http://localhost:7777/callback']);
    expect(p.redirectUrl).toBe('http://localhost:7777/callback');
  });
});
