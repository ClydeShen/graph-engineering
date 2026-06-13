/**
 * Shared channel HTTP transport — proxy resolution + Telegram IP-fallback.
 *
 * Ported (DRY) from hermes-agent's proven approach rather than reinvented:
 *   - gateway/platforms/base.py        resolve_proxy_url()  → resolveProxyUrl()
 *   - gateway/platforms/telegram_network.py TelegramFallbackTransport → telegramFetch()
 *
 * Why this exists: behind restrictive networks (GFW, IPv6-broken hosts) Node's
 * global fetch (undici) fails to reach api.telegram.org where curl succeeds —
 * its Happy-Eyeballs gives each address family only 250ms, Telegram's IPv6 is
 * usually unroutable, and the IPv4 handshake can exceed 250ms, so undici
 * abandons the working IPv4 (ETIMEDOUT). hermes solves this with two layers,
 * which every channel adapter here now reuses:
 *
 *   1. Proxy resolution — platform env (TELEGRAM_PROXY/DISCORD_PROXY) →
 *      HTTPS/HTTP/ALL_PROXY → Windows system proxy; honours NO_PROXY.
 *   2. SNI-preserving IP fallback — when no proxy and the primary path fails,
 *      retry the TCP connection against known-reachable Telegram IPv4 IPs while
 *      keeping the logical host + TLS SNI = api.telegram.org (the programmatic
 *      equivalent of `curl --resolve api.telegram.org:443:<ip>`). IPs come from
 *      env, then DoH (Google/Cloudflare) + system DNS, then a hardcoded seed.
 */

import { Agent, ProxyAgent, type Dispatcher } from 'undici';
import { execFileSync } from 'node:child_process';
import { isIPv4 } from 'node:net';

const TELEGRAM_HOST = 'api.telegram.org';
// Stable Telegram Bot API endpoint in 149.154.160.0/20 (same seed hermes uses).
const SEED_FALLBACK_IPS = ['149.154.167.220'];
const DOH_TIMEOUT_MS = 4000;

// ── Proxy resolution (mirrors base.resolve_proxy_url) ────────────────────────

function envProxy(platformEnvVar?: string): string | undefined {
  const keys = [
    ...(platformEnvVar ? [platformEnvVar] : []),
    'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY',
    'https_proxy', 'http_proxy', 'all_proxy',
  ];
  for (const k of keys) {
    const v = process.env[k]?.trim();
    if (v) return v;
  }
  return undefined;
}

/** Best-effort Windows system proxy (the parallel to hermes's macOS scutil). */
let sysProxyCache: { url: string | undefined } | undefined;
function windowsSystemProxy(): string | undefined {
  if (sysProxyCache) return sysProxyCache.url; // resolve the reg subprocess once
  sysProxyCache = { url: windowsSystemProxyUncached() };
  return sysProxyCache.url;
}
function windowsSystemProxyUncached(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const enabled = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable'],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (!/0x1\b/.test(enabled)) return undefined; // ProxyEnable != 1
    const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    if (!m) return undefined;
    const server = m[1];
    // "host:port" or "http=host:port;https=host:port" — prefer https, else first.
    const https = server.match(/https=([^;]+)/i)?.[1];
    const hostPort = https ?? server.split(';')[0]!.replace(/^\w+=/, '');
    return hostPort.startsWith('http') ? hostPort : `http://${hostPort}`;
  } catch {
    return undefined;
  }
}

function noProxyBypass(targetHosts: string[]): boolean {
  const entries = (process.env['NO_PROXY'] ?? process.env['no_proxy'] ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (entries.length === 0) return false;
  if (entries.includes('*')) return true;
  return targetHosts.some((h) => {
    const host = h.toLowerCase();
    return entries.some((e) => {
      const token = e.replace(/^\./, '');
      return host === token || host.endsWith(`.${token}`);
    });
  });
}

/**
 * Resolve a proxy URL: platform env var → standard proxy env → Windows system
 * proxy. Returns undefined when none is set or NO_PROXY matches a target host.
 */
export function resolveProxyUrl(platformEnvVar?: string, targetHosts: string[] = []): string | undefined {
  const url = envProxy(platformEnvVar) ?? windowsSystemProxy();
  if (!url) return undefined;
  if (noProxyBypass(targetHosts)) return undefined;
  return url;
}

// ── Dispatcher cache ─────────────────────────────────────────────────────────

const proxyAgents = new Map<string, ProxyAgent>();
function proxyAgent(url: string): ProxyAgent {
  let a = proxyAgents.get(url);
  if (!a) {
    a = new ProxyAgent(url);
    proxyAgents.set(url, a);
  }
  return a;
}

// Primary (no-proxy) dispatcher: keep dual-stack but lift the 250ms attempt cap
// so a slow-but-reachable IPv4 handshake isn't abandoned (the core undici bug).
let primaryAgent: Agent | undefined;
function getPrimaryAgent(): Agent {
  if (!primaryAgent) {
    // undici's BuildOptions type omits Node's net autoSelectFamily knobs, but
    // they are honoured at runtime — lifting the 250ms per-family attempt cap
    // so a slow-but-reachable IPv4 handshake isn't abandoned.
    primaryAgent = new Agent({
      connect: { autoSelectFamilyAttemptTimeout: 3000 } as { timeout?: number },
    });
  }
  return primaryAgent;
}

// Per-IP dispatcher: connect straight to the IPv4 literal but present SNI +
// validate the cert against api.telegram.org (curl --resolve equivalent).
const ipAgents = new Map<string, Agent>();
function ipAgent(ip: string): Agent {
  let a = ipAgents.get(ip);
  if (!a) {
    a = new Agent({ connect: { servername: TELEGRAM_HOST, family: 4 } });
    ipAgents.set(ip, a);
  }
  return a;
}

/** Generic per-channel dispatcher (proxy when configured, else primary). */
export function channelDispatcher(platformEnvVar?: string, targetHosts: string[] = []): Dispatcher {
  const proxy = resolveProxyUrl(platformEnvVar, targetHosts);
  return proxy ? proxyAgent(proxy) : getPrimaryAgent();
}

// ── Telegram fallback-IP discovery (mirrors discover_fallback_ips) ───────────

function normalizeIps(values: string[]): string[] {
  const out: string[] = [];
  for (const raw of values) {
    const ip = raw.trim();
    if (isIPv4(ip) && !ip.startsWith('127.') && !ip.startsWith('10.') && !ip.startsWith('192.168.')) {
      out.push(ip);
    }
  }
  return [...new Set(out)];
}

export function parseFallbackIpEnv(value: string | undefined): string[] {
  return value ? normalizeIps(value.split(',')) : [];
}

async function queryDoh(url: string, headers: Record<string, string>): Promise<string[]> {
  try {
    const res = await fetch(`${url}?name=${TELEGRAM_HOST}&type=A`, {
      headers,
      signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
    return (data.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
  } catch {
    return [];
  }
}

let cachedFallbackIps: string[] | undefined;
/** Env override → DoH (Google + Cloudflare) → hardcoded seed. Cached per process. */
export async function discoverTelegramFallbackIps(): Promise<string[]> {
  if (cachedFallbackIps) return cachedFallbackIps;
  const fromEnv = parseFallbackIpEnv(process.env['TELEGRAM_FALLBACK_IPS']);
  if (fromEnv.length > 0) {
    cachedFallbackIps = fromEnv;
    return fromEnv;
  }
  const [g, c] = await Promise.all([
    queryDoh('https://dns.google/resolve', {}),
    queryDoh('https://cloudflare-dns.com/dns-query', { Accept: 'application/dns-json' }),
  ]);
  const discovered = normalizeIps([...g, ...c]);
  cachedFallbackIps = discovered.length > 0 ? discovered : [...SEED_FALLBACK_IPS];
  return cachedFallbackIps;
}

// ── Telegram fetch with SNI-preserving IP fallback ───────────────────────────

let stickyIp: string | undefined;

/**
 * Compute the connection attempt order (pure, testable). `null` = primary DNS
 * path (normal host). Mirrors hermes: sticky first, then primary, then the rest.
 */
export function telegramAttemptOrder(ips: string[], sticky: string | undefined): Array<string | null> {
  const order: Array<string | null> = sticky ? [sticky, null] : [null];
  for (const ip of ips) if (ip !== sticky) order.push(ip);
  return order;
}

function isRetryableConnectError(err: unknown): boolean {
  const code = (err as { cause?: { code?: string }; code?: string })?.cause?.code
    ?? (err as { code?: string })?.code;
  return code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'ENETUNREACH'
    || code === 'ECONNRESET' || code === 'EAI_AGAIN' || code === 'UND_ERR_CONNECT_TIMEOUT'
    || /fetch failed|connect/i.test((err as Error)?.message ?? '');
}

/**
 * fetch() against api.telegram.org with hermes's resilience. Proxy wins when
 * set; otherwise try the primary path then each fallback IP (SNI preserved),
 * sticking to the first IP that works.
 */
export async function telegramFetch(url: string, init: RequestInit = {}): Promise<Response> {
  // Order matters: short-circuit proxy/disabled BEFORE DoH discovery so the
  // common and test paths never spawn DoH or system-proxy lookups needlessly.
  const proxy = resolveProxyUrl('TELEGRAM_PROXY', [TELEGRAM_HOST]);
  if (proxy) {
    return fetch(url, { ...init, dispatcher: proxyAgent(proxy) } as RequestInit);
  }
  const disabled = /^(1|true|yes|on)$/i.test(process.env['MEMEX_TELEGRAM_DISABLE_FALLBACK_IPS'] ?? '');
  if (disabled) {
    return fetch(url, { ...init, dispatcher: getPrimaryAgent() } as RequestInit);
  }
  const ips = await discoverTelegramFallbackIps();
  if (ips.length === 0) {
    return fetch(url, { ...init, dispatcher: getPrimaryAgent() } as RequestInit);
  }

  let lastErr: unknown;
  for (const ip of telegramAttemptOrder(ips, stickyIp)) {
    try {
      if (ip === null) {
        const res = await fetch(url, { ...init, dispatcher: getPrimaryAgent() } as RequestInit);
        return res;
      }
      // Rewrite host→IP, keep Host header + SNI = api.telegram.org.
      const rewritten = url.replace(`https://${TELEGRAM_HOST}`, `https://${ip}`);
      const headers = new Headers(init.headers);
      headers.set('host', TELEGRAM_HOST);
      const res = await fetch(rewritten, { ...init, headers, dispatcher: ipAgent(ip) } as RequestInit);
      stickyIp = ip;
      return res;
    } catch (err) {
      lastErr = err;
      if (!isRetryableConnectError(err)) throw err;
      if (ip === stickyIp) stickyIp = undefined; // sticky failed — reset
    }
  }
  throw lastErr ?? new Error('telegramFetch: all fallback IPs exhausted');
}
