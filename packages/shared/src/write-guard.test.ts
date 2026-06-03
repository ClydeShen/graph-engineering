import { describe, it, expect } from 'vitest';
import { writeGuard } from './write-guard.js';

describe('writeGuard', () => {
  it('passes clean payload through unchanged', () => {
    const payload = '{"key":"value","count":42}';
    expect(writeGuard(payload)).toBe(payload);
  });

  it('redacts OpenAI API key', () => {
    const payload = '{"api_key":"sk-abcdefghijklmnopqrstuvwxyz12345678901234"}';
    expect(writeGuard(payload)).toBe('{"api_key":"[REDACTED:api_key]"}');
  });

  it('redacts AWS access key', () => {
    const payload = '{"key":"AKIAIOSFODNN7EXAMPLE"}';
    expect(writeGuard(payload)).toBe('{"key":"[REDACTED:aws_key]"}');
  });

  it('redacts PostgreSQL connection string', () => {
    const payload = '{"db":"postgres://user:pass@localhost:5432/mydb"}';
    expect(writeGuard(payload)).toBe('{"db":"[REDACTED:pg_conn]"}');
  });

  it('redacts <secret> tags', () => {
    const payload = 'token=<secret>mysupersecrettoken</secret>';
    expect(writeGuard(payload)).toBe('token=[REDACTED:secret_type]');
  });

  it('redacts multiple secrets in one payload', () => {
    const payload = 'key=sk-abcdefghijklmnopqrstuvwxyz12345678901234 db=postgres://u:p@host/db';
    expect(writeGuard(payload)).toBe('key=[REDACTED:api_key] db=[REDACTED:pg_conn]');
  });
});
