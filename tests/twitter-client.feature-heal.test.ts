import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearFeatureOverridesCache } from '../src/lib/runtime-features.js';
import { TwitterClient } from '../src/lib/twitter-client.js';
import { validCookies } from './twitter-client-fixtures.js';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  delete process.env.BIRD_FEATURES_JSON;
  delete process.env.BIRD_FEATURES_CACHE;
  delete process.env.BIRD_FEATURES_PATH;
  clearFeatureOverridesCache();
});

describe('TwitterClient feature heal', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
    const cacheDir = path.join(os.tmpdir(), `bird-test-${randomUUID()}`);
    await mkdir(cacheDir, { recursive: true });
    process.env.BIRD_FEATURES_PATH = path.join(cacheDir, 'features.json');
    clearFeatureOverridesCache();
  });

  it('heals missing features on 400 and retries with overrides', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'The following features cannot be null: foo_enabled, bar_enabled',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            user: {
              result: {
                timeline: {
                  timeline: {
                    instructions: [
                      {
                        type: 'TimelineAddEntries',
                        entries: [
                          {
                            content: {
                              itemContent: {
                                user_results: {
                                  result: {
                                    __typename: 'User',
                                    rest_id: '1',
                                    legacy: { screen_name: 'alpha', name: 'Alpha' },
                                  },
                                },
                              },
                            },
                          },
                        ],
                      },
                    ],
                  },
                },
              },
            },
          },
        }),
      });

    const client = new TwitterClient({ cookies: validCookies });
    const clientPrivate = client as unknown as TwitterClient & { getFollowingQueryIds: () => Promise<string[]> };
    clientPrivate.getFollowingQueryIds = async () => ['test'];

    const result = await client.getFollowing('123', 2);

    expect(result.success).toBe(true);
    expect(result.users?.[0]?.username).toBe('alpha');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const secondUrl = String(mockFetch.mock.calls[1][0]);
    const features = JSON.parse(new URL(secondUrl).searchParams.get('features') as string) as Record<string, boolean>;
    expect(features.foo_enabled).toBe(true);
    expect(features.bar_enabled).toBe(true);
  });

  it('terminates after no-progress when the same missing flags repeat', async () => {
    const body = 'The following features cannot be null: foo_enabled, bar_enabled';
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => body,
    });

    const client = new TwitterClient({ cookies: validCookies });
    const clientPrivate = client as unknown as TwitterClient & { getFollowingQueryIds: () => Promise<string[]> };
    clientPrivate.getFollowingQueryIds = async () => ['test'];

    const result = await client.getFollowing('123', 2);

    expect(result.success).toBe(false);
    expect(result.error).toContain('features cannot be null');
    // Initial attempt + one heal retry, then no-progress stops further heals.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('passes through non-336 errors without retry', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    });

    const client = new TwitterClient({ cookies: validCookies });
    const clientPrivate = client as unknown as TwitterClient & { getFollowingQueryIds: () => Promise<string[]> };
    clientPrivate.getFollowingQueryIds = async () => ['test'];

    const result = await client.getFollowing('123', 2);

    expect(result.success).toBe(false);
    expect(result.error).toContain('HTTP 403');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
