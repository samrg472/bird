import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwitterClient } from '../src/lib/twitter-client.js';
import { validCookies } from './twitter-client-fixtures.js';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('TwitterClient getUserProfile', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  it('returns a fully mapped profile for a valid user', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          user: {
            result: {
              __typename: 'User',
              rest_id: '12345',
              is_blue_verified: true,
              legacy: {
                screen_name: 'testuser',
                name: 'Test User',
                description: 'Building things.',
                followers_count: 1234,
                friends_count: 567,
                statuses_count: 8901,
                created_at: 'Tue Mar 21 20:50:14 +0000 2006',
                location: 'Vienna, Austria',
                url: 'https://t.co/abc',
                profile_image_url_https: 'https://pbs.twimg.com/profile_images/x.jpg',
                entities: {
                  url: {
                    urls: [{ url: 'https://t.co/abc', expanded_url: 'https://example.com' }],
                  },
                },
              },
            },
          },
        },
      }),
    });

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getUserProfile('@testuser');

    expect(result.success).toBe(true);
    expect(result.user).toEqual({
      id: '12345',
      username: 'testuser',
      name: 'Test User',
      description: 'Building things.',
      followersCount: 1234,
      followingCount: 567,
      tweetsCount: 8901,
      location: 'Vienna, Austria',
      websiteUrl: 'https://example.com',
      isBlueVerified: true,
      profileImageUrl: 'https://pbs.twimg.com/profile_images/x.jpg',
      createdAt: 'Tue Mar 21 20:50:14 +0000 2006',
    });
  });

  it('falls back to core fields when legacy name/screen_name are missing', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          user: {
            result: {
              __typename: 'User',
              rest_id: '67890',
              core: {
                screen_name: 'coreuser',
                name: 'Core User',
                created_at: 'Wed Jan 01 00:00:00 +0000 2020',
              },
              location: { location: 'Berlin' },
              avatar: { image_url: 'https://pbs.twimg.com/profile_images/core.jpg' },
            },
          },
        },
      }),
    });

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getUserProfile('coreuser');

    expect(result.success).toBe(true);
    expect(result.user?.id).toBe('67890');
    expect(result.user?.username).toBe('coreuser');
    expect(result.user?.name).toBe('Core User');
    expect(result.user?.location).toBe('Berlin');
    expect(result.user?.profileImageUrl).toBe('https://pbs.twimg.com/profile_images/core.jpg');
    expect(result.user?.createdAt).toBe('Wed Jan 01 00:00:00 +0000 2020');
  });

  it('returns an error for an unavailable user', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          user: {
            result: {
              __typename: 'UserUnavailable',
            },
          },
        },
      }),
    });

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getUserProfile('suspended_user');

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found or unavailable');
  });

  it('returns an error for non-ok responses', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getUserProfile('testuser');

    expect(result.success).toBe(false);
    expect(result.error).toContain('HTTP 500');
  });

  it('rejects an invalid username without fetching', async () => {
    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getUserProfile('!!!');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid username');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
