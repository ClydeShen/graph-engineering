import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveProxyUrl,
  parseFallbackIpEnv,
  telegramAttemptOrder,
} from './channel-http.js';

const PROXY_ENVS = [
  'TELEGRAM_PROXY', 'DISCORD_PROXY',
  'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY',
  'https_proxy', 'http_proxy', 'all_proxy',
  'NO_PROXY', 'no_proxy',
];

describe('channel-http: proxy resolution (DRY port of hermes resolve_proxy_url)', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of PROXY_ENVS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of PROXY_ENVS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('platform env var wins over the generic proxy vars', () => {
    process.env['TELEGRAM_PROXY'] = 'http://platform:1';
    process.env['HTTPS_PROXY'] = 'http://generic:2';
    expect(resolveProxyUrl('TELEGRAM_PROXY')).toBe('http://platform:1');
  });

  it('falls back to HTTPS_PROXY / HTTP_PROXY / ALL_PROXY', () => {
    process.env['HTTP_PROXY'] = 'http://generic:8080';
    expect(resolveProxyUrl('TELEGRAM_PROXY')).toBe('http://generic:8080');
  });

  it('returns undefined when nothing is configured', () => {
    // (Windows system-proxy lookup is disabled here: ProxyEnable=0 on the box,
    // and on CI/non-Windows it is skipped — either way undefined.)
    expect(resolveProxyUrl('TELEGRAM_PROXY')).toBeUndefined();
  });

  it('NO_PROXY=* bypasses the proxy for any target host', () => {
    process.env['HTTPS_PROXY'] = 'http://p:1';
    process.env['NO_PROXY'] = '*';
    expect(resolveProxyUrl('TELEGRAM_PROXY', ['api.telegram.org'])).toBeUndefined();
  });

  it('NO_PROXY host match bypasses; non-match does not', () => {
    process.env['HTTPS_PROXY'] = 'http://p:1';
    process.env['NO_PROXY'] = 'telegram.org';
    expect(resolveProxyUrl('TELEGRAM_PROXY', ['api.telegram.org'])).toBeUndefined();
    expect(resolveProxyUrl('TELEGRAM_PROXY', ['discord.com'])).toBe('http://p:1');
  });
});

describe('channel-http: fallback IP helpers', () => {
  it('parseFallbackIpEnv keeps public IPv4, drops private/loopback/IPv6/junk', () => {
    expect(parseFallbackIpEnv('149.154.167.220, 10.0.0.1, ::1, not-an-ip, 91.108.4.5'))
      .toEqual(['149.154.167.220', '91.108.4.5']);
    expect(parseFallbackIpEnv(undefined)).toEqual([]);
  });

  it('telegramAttemptOrder: no sticky → primary first, then IPs', () => {
    expect(telegramAttemptOrder(['1.1.1.1', '2.2.2.2'], undefined))
      .toEqual([null, '1.1.1.1', '2.2.2.2']);
  });

  it('telegramAttemptOrder: sticky → sticky first, then primary, then the rest', () => {
    expect(telegramAttemptOrder(['1.1.1.1', '2.2.2.2'], '2.2.2.2'))
      .toEqual(['2.2.2.2', null, '1.1.1.1']);
  });
});
