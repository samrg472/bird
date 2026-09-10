import { describe, expect, it } from 'vitest';
import { extractOperation, parseRateLimitHeaders, resolveCredentials, TwitterClient } from '../src/index.js';

describe('library exports', () => {
  it('exposes primary library surface', () => {
    expect(typeof TwitterClient).toBe('function');
    expect(typeof resolveCredentials).toBe('function');
  });

  it('exposes rate limit observation helpers', () => {
    expect(typeof extractOperation).toBe('function');
    expect(typeof parseRateLimitHeaders).toBe('function');
  });
});
