import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwitterClient } from '../src/lib/twitter-client.js';
import {
  extractOperation,
  parseRateLimitHeaders,
  type ResponseObservation,
} from '../src/lib/twitter-client-rate-limit.js';
import { validCookies } from './twitter-client-fixtures.js';

const originalFetch = global.fetch;

function collectObservations(): { observations: ResponseObservation[]; onResponse: (o: ResponseObservation) => void } {
  const observations: ResponseObservation[] = [];
  return { observations, onResponse: (observation) => observations.push(observation) };
}

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('rate limit response observations', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  it('emits one observation with parsed rate-limit headers on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'application/json; charset=utf-8',
        'x-rate-limit-limit': '50',
        'x-rate-limit-remaining': '49',
        'x-rate-limit-reset': '1700000000',
      }),
      json: async () => ({ user_id: '12345', screen_name: 'tester', name: 'Test User' }),
    });

    const { observations, onResponse } = collectObservations();
    const client = new TwitterClient({ cookies: validCookies, onResponse });
    const result = await client.getCurrentUser();

    expect(result.success).toBe(true);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.operation).toBe('account/settings.json');
    expect(observations[0]?.method).toBe('GET');
    expect(observations[0]?.status).toBe(200);
    expect(observations[0]?.ok).toBe(true);
    expect(typeof observations[0]?.atMs).toBe('number');
    expect(observations[0]?.contentType).toBe('application/json; charset=utf-8');
    expect(observations[0]?.cfMitigated).toBeNull();
    expect(observations[0]?.rateLimit).toEqual({
      limit: 50,
      remaining: 49,
      resetEpochSeconds: 1700000000,
      retryAfterSeconds: null,
    });
  });

  it('reports content-type and cf-mitigated on edge interstitials', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers({
        'content-type': 'text/html; charset=utf-8',
        'cf-mitigated': 'challenge',
      }),
      text: async () => '<!doctype html><title>Just a moment...</title>',
    });

    const { observations, onResponse } = collectObservations();
    const client = new TwitterClient({ cookies: validCookies, onResponse });
    const result = await client.getCurrentUser();

    expect(result.success).toBe(false);
    expect(observations[0]?.status).toBe(403);
    expect(observations[0]?.contentType).toBe('text/html; charset=utf-8');
    expect(observations[0]?.cfMitigated).toBe('challenge');
  });

  it('reports rateLimit null for headerless responses (legacy mock shapes)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ user_id: '12345', screen_name: 'tester', name: 'Test User' }),
    });

    const { observations, onResponse } = collectObservations();
    const client = new TwitterClient({ cookies: validCookies, onResponse });
    const result = await client.getCurrentUser();

    expect(result.success).toBe(true);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.rateLimit).toBeNull();
    expect(observations[0]?.contentType).toBeNull();
    expect(observations[0]?.cfMitigated).toBeNull();
  });

  it('observes 429s with the x-rate-limit-retryafter cooldown', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({
        'x-rate-limit-limit': '50',
        'x-rate-limit-remaining': '0',
        'x-rate-limit-reset': '1700000000',
        'x-rate-limit-retryafter': '600',
      }),
      text: async () => 'Rate limit exceeded',
    });

    const { observations, onResponse } = collectObservations();
    const client = new TwitterClient({ cookies: validCookies, onResponse });
    const result = await client.getCurrentUser();

    expect(result.success).toBe(false);
    expect(observations[0]?.status).toBe(429);
    expect(observations[0]?.ok).toBe(false);
    expect(observations[0]?.rateLimit?.remaining).toBe(0);
    expect(observations[0]?.rateLimit?.retryAfterSeconds).toBe(600);
  });

  it('falls back to the standard retry-after header', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '30' }),
      text: async () => 'Too Many Requests',
    });

    const { observations, onResponse } = collectObservations();
    const client = new TwitterClient({ cookies: validCookies, onResponse });
    await client.getCurrentUser();

    expect(observations[0]?.rateLimit).toEqual({
      limit: null,
      remaining: null,
      resetEpochSeconds: null,
      retryAfterSeconds: 30,
    });
  });

  it('does not let a throwing observer break the request', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'x-rate-limit-remaining': '10' }),
      json: async () => ({ user_id: '12345', screen_name: 'tester', name: 'Test User' }),
    });

    const client = new TwitterClient({
      cookies: validCookies,
      onResponse: () => {
        throw new Error('observer exploded');
      },
    });

    const result = await client.getCurrentUser();

    expect(result.success).toBe(true);
  });

  it('emits one observation per underlying response across internal retries', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'Not found' })
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'Not found' })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            user: {
              result: {
                __typename: 'User',
                rest_id: '99999',
                legacy: {
                  screen_name: 'founduser',
                  name: 'Found User',
                },
              },
            },
          },
        }),
      });

    const { observations, onResponse } = collectObservations();
    const client = new TwitterClient({ cookies: validCookies, onResponse });
    const result = await client.getUserIdByUsername('founduser');

    expect(result.success).toBe(true);
    expect(observations).toHaveLength(3);
    expect(observations.map((o) => o.status)).toEqual([404, 404, 200]);
    expect(observations.every((o) => o.operation === 'UserByScreenName')).toBe(true);
  });

  it('works without onResponse (no observer wired, no behavior change)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ user_id: '12345', screen_name: 'tester', name: 'Test User' }),
    });

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getCurrentUser();

    expect(result.success).toBe(true);
  });
});

describe('parseRateLimitHeaders', () => {
  it('returns null for undefined or empty headers', () => {
    expect(parseRateLimitHeaders(undefined)).toBeNull();
    expect(parseRateLimitHeaders(new Headers())).toBeNull();
  });

  it('parses the header set case-insensitively', () => {
    expect(
      parseRateLimitHeaders(
        new Headers({
          'X-Rate-Limit-Limit': '500',
          'X-Rate-Limit-Remaining': '499',
          'X-Rate-Limit-Reset': '1700000000',
        }),
      ),
    ).toEqual({ limit: 500, remaining: 499, resetEpochSeconds: 1700000000, retryAfterSeconds: null });
  });

  it('rejects HTTP-date and negative retry-after values', () => {
    expect(parseRateLimitHeaders(new Headers({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }))).toBeNull();
    expect(parseRateLimitHeaders(new Headers({ 'retry-after': '-5' }))).toBeNull();
  });
});

describe('extractOperation', () => {
  it('extracts GraphQL operation names without the rotating query ID', () => {
    expect(extractOperation('https://x.com/i/api/graphql/97JF30KziU00483E_8elBA/SearchTimeline?variables=%7B%7D')).toBe(
      'SearchTimeline',
    );
    expect(extractOperation('/i/api/graphql/abc123/TweetDetail')).toBe('TweetDetail');
  });

  it('falls back to the last two path segments for REST endpoints', () => {
    expect(extractOperation('https://x.com/i/api/1.1/guest/activate.json')).toBe('guest/activate.json');
    expect(extractOperation('https://upload.twitter.com/i/media/upload.json')).toBe('media/upload.json');
    expect(extractOperation('https://x.com/settings/account')).toBe('settings/account');
  });

  it('degrades on the bare GraphQL POST fallback URL', () => {
    expect(extractOperation('https://x.com/i/api/graphql')).toBe('api/graphql');
  });
});
