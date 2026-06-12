/**
 * MemexOAuthProvider — file-backed OAuthClientProvider for remote MCP servers
 * (Phase 17 Block 2, ADR-50).
 *
 * Persists tokens / client registration / PKCE verifier to
 * `<profileDir>/mcp-tokens/<server>.json` (0600) so a `memex mcp login` done
 * once in the CLI is reusable by McpClientWorker across restarts — mirrors
 * hermes `~/.hermes/mcp-tokens/<server>.json`.
 *
 * Lives in @graph/shared because both the CLI (login flow) and workers
 * (transport authProvider) consume it; SDK types are imported type-only so
 * this module adds zero runtime dependency.
 *
 * Token refresh is the SDK's job: StreamableHTTPClientTransport calls
 * tokens()/saveTokens() through this provider per its documented behavior.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { profileDir } from '../config/loader.js';

/** On-disk shape: one JSON file per server holding all OAuth state. */
interface TokenFileState {
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
}

/** Directory holding cached MCP OAuth state for the active profile. */
export function mcpTokensDir(): string {
  return join(profileDir(), 'mcp-tokens');
}

/** Reject server names that could escape the tokens directory. */
export function safeServerFileName(server: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(server) && !server.includes('..') ? server : null;
}

export class MemexOAuthProvider implements OAuthClientProvider {
  private readonly file: string;

  constructor(
    private readonly serverName: string,
    /** Local callback target for the PKCE redirect (memex mcp login owns the port). */
    private readonly callbackUrl: string = 'http://localhost:7777/callback',
    /** Invoked to send the user to the authorization URL; CLI opens a browser, worker contexts print. */
    private readonly onRedirect: (url: URL) => void | Promise<void> = (url) => {
      console.log(`[mcp:${serverName}] authorize in your browser:\n  ${url.toString()}`);
    },
    /** Token directory override (tests); defaults to the active profile's mcp-tokens dir. */
    private readonly dir: string = mcpTokensDir(),
  ) {
    const name = safeServerFileName(serverName);
    if (!name) throw new Error(`unsafe MCP server name: ${serverName}`);
    this.file = join(this.dir, `${name}.json`);
  }

  get redirectUrl(): string {
    return this.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'MemexOS',
      redirect_uris: [this.callbackUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // public client + PKCE
    };
  }

  private read(): TokenFileState {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as TokenFileState;
    } catch {
      return {}; // corrupt cache = no cache; the flow re-authorizes
    }
  }

  private write(state: TokenFileState): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file, JSON.stringify(state, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.file, 0o600); // mode in writeFileSync is umask-filtered; enforce
    } catch {
      /* Windows: chmod is best-effort; ACLs follow the profile dir */
    }
  }

  tokens(): OAuthTokens | undefined {
    return this.read().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.write({ ...this.read(), tokens });
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.read().clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.write({ ...this.read(), clientInformation });
  }

  codeVerifier(): string {
    const v = this.read().codeVerifier;
    if (!v) throw new Error(`no PKCE verifier cached for ${this.serverName} — run memex mcp login`);
    return v;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.write({ ...this.read(), codeVerifier });
  }

  redirectToAuthorization(authorizationUrl: URL): void | Promise<void> {
    return this.onRedirect(authorizationUrl);
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all') {
      if (existsSync(this.file)) unlinkSync(this.file);
      return;
    }
    const state = this.read();
    if (scope === 'tokens') delete state.tokens;
    if (scope === 'client') delete state.clientInformation;
    if (scope === 'verifier') delete state.codeVerifier;
    this.write(state);
  }

  /** Remove the cache file (memex mcp uninstall). */
  static deleteCache(serverName: string, dir: string = mcpTokensDir()): void {
    const name = safeServerFileName(serverName);
    if (!name) return;
    const file = join(dir, `${name}.json`);
    if (existsSync(file)) unlinkSync(file);
  }
}
