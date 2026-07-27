import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearFeatureOverridesCache } from '../src/lib/runtime-features.js';
import { TwitterClient } from '../src/lib/twitter-client.js';
import { validCookies } from './twitter-client-fixtures.js';

const FEATURE_FLAG_NAME_REGEX = /^[a-z][a-z0-9_]*$/i;
const JUNK_KEY_CHARS_REGEX = /[":]/;
const TRUNCATION_JUNK_CHARS_REGEX = /["{}:]/;

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

  it('heals 336 errors delivered inside an X JSON envelope without persisting junk keys', async () => {
    const envelope = JSON.stringify({
      errors: [
        {
          message: 'The following features cannot be null: foo_enabled, bar_enabled',
          name: 'BadRequest',
          code: 336,
        },
      ],
    });
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => envelope,
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
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const cachePath = process.env.BIRD_FEATURES_PATH as string;
    const persisted = JSON.parse(await readFile(cachePath, 'utf8')) as {
      sets?: Record<string, Record<string, boolean>>;
    };
    const following = persisted.sets?.following ?? {};
    expect(following.foo_enabled).toBe(true);
    expect(following.bar_enabled).toBe(true);
    for (const key of Object.keys(following)) {
      expect(key).not.toMatch(JUNK_KEY_CHARS_REGEX);
    }
  });

  it('drops truncated mid-token flag fragments from a long 336 body', async () => {
    // Build a body long enough that slice(0, 400) cuts the last flag mid-token.
    const flags = Array.from({ length: 30 }, (_, i) => `flag_${String(i).padStart(2, '0')}_enabled`);
    const message = `The following features cannot be null: ${flags.join(', ')}`;
    const envelope = JSON.stringify({
      errors: [{ message, name: 'BadRequest', code: 336 }],
    });
    expect(envelope.length).toBeGreaterThan(400);

    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => envelope,
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

    const cachePath = process.env.BIRD_FEATURES_PATH as string;
    const persisted = JSON.parse(await readFile(cachePath, 'utf8')) as {
      sets?: Record<string, Record<string, boolean>>;
    };
    const following = persisted.sets?.following ?? {};
    for (const key of Object.keys(following)) {
      expect(key).toMatch(FEATURE_FLAG_NAME_REGEX);
      expect(key).not.toMatch(TRUNCATION_JUNK_CHARS_REGEX);
    }
    expect(Object.keys(following).length).toBeGreaterThan(0);
  });

  it('skips heal when the 336 body yields no valid flag names', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'features cannot be null: ",{}',
    });

    const client = new TwitterClient({ cookies: validCookies });
    const clientPrivate = client as unknown as TwitterClient & { getFollowingQueryIds: () => Promise<string[]> };
    clientPrivate.getFollowingQueryIds = async () => ['test'];

    const result = await client.getFollowing('123', 2);

    expect(result.success).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const cachePath = process.env.BIRD_FEATURES_PATH as string;
    await expect(access(cachePath)).rejects.toThrow('ENOENT');
  });
});
