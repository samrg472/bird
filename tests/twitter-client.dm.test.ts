import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwitterClient } from '../src/lib/twitter-client.js';
import { validCookies } from './twitter-client-fixtures.js';

const originalFetch = global.fetch;
const DM_API_PATH_REGEX = /\/i\/api\/1\.1\/dm\//;
const DM_MUTATING_PATH_REGEX = /update_last_seen_event_id|mark_read|\/trust/;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('TwitterClient direct messages', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  it('parses inbox conversations with users join and epoch-ms timestamps', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        inbox_initial_state: {
          conversations: {
            '111-222': {
              conversation_id: '111-222',
              type: 'ONE_TO_ONE',
              sort_timestamp: '1700000000000',
              sort_event_id: '900',
              last_read_event_id: '800',
              participants: [{ user_id: '111' }, { user_id: '222' }],
            },
            '333-444': {
              conversation_id: '333-444',
              type: 'GROUP_DM',
              sort_timestamp: '1600000000000',
              sort_event_id: '700',
              last_read_event_id: '700',
              participants: [{ user_id: '333' }, { user_id: '444' }],
            },
          },
          users: {
            '111': { id_str: '111', screen_name: 'alice', name: 'Alice' },
            '222': { id_str: '222', screen_name: 'bob', name: 'Bob' },
            '333': { id_str: '333', screen_name: 'carol', name: 'Carol' },
            '444': { id_str: '444', screen_name: 'dave', name: 'Dave' },
          },
          entries: [
            {
              message: {
                id: '900',
                time: '1700000000000',
                conversation_id: '111-222',
                message_data: {
                  id: '900',
                  sender_id: '111',
                  text: 'Hello Bob',
                  time: '1700000000000',
                },
              },
            },
            {
              message: {
                id: '700',
                time: '1600000000000',
                conversation_id: '333-444',
                message_data: {
                  id: '700',
                  sender_id: '333',
                  text: 'Group hi',
                  time: '1600000000000',
                },
              },
            },
          ],
        },
      }),
    });

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getDmInbox();

    expect(result.success).toBe(true);
    expect(result.conversations).toHaveLength(2);
    expect(result.conversations?.[0]).toMatchObject({
      id: '111-222',
      type: 'ONE_TO_ONE',
      lastMessageText: 'Hello Bob',
      lastMessageAt: new Date(1700000000000).toISOString(),
      unread: true,
      participants: [
        { id: '111', username: 'alice', name: 'Alice' },
        { id: '222', username: 'bob', name: 'Bob' },
      ],
    });
    expect(result.conversations?.[1]).toMatchObject({
      id: '333-444',
      type: 'GROUP_DM',
      lastMessageText: 'Group hi',
      unread: false,
    });
  });

  it('parses conversation messages with media and entry ids', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        conversation_timeline: {
          status: 'AT_END',
          min_entry_id: '100',
          max_entry_id: '200',
          users: {
            '111': { screen_name: 'alice', name: 'Alice' },
            '222': { screen_name: 'bob', name: 'Bob' },
          },
          entries: [
            {
              message: {
                conversation_id: '111-222',
                message_data: {
                  id: '200',
                  sender_id: '222',
                  text: 'Latest',
                  time: '1700000002000',
                },
              },
            },
            {
              message: {
                conversation_id: '111-222',
                message_data: {
                  id: '100',
                  sender_id: '111',
                  text: 'With photo',
                  time: '1700000001000',
                  attachment: {
                    photo: { media_url_https: 'https://pbs.twimg.com/media/photo.jpg' },
                    video: { media_url_https: 'https://video.twimg.com/clip.mp4' },
                  },
                },
              },
            },
          ],
        },
      }),
    });

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getDmConversation('111-222');

    expect(result.success).toBe(true);
    expect(result.status).toBe('AT_END');
    expect(result.minEntryId).toBe('100');
    expect(result.maxEntryId).toBe('200');
    expect(result.messages).toHaveLength(2);
    expect(result.messages?.[0]).toMatchObject({
      id: '100',
      conversationId: '111-222',
      senderId: '111',
      senderUsername: 'alice',
      text: 'With photo',
      createdAt: new Date(1700000001000).toISOString(),
      mediaUrls: ['https://pbs.twimg.com/media/photo.jpg', 'https://video.twimg.com/clip.mp4'],
    });
    expect(result.messages?.[1]?.text).toBe('Latest');
  });

  it('returns an error for non-ok inbox responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    });

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getDmInbox();

    expect(result.success).toBe(false);
    expect(result.error).toContain('HTTP 403');
  });

  it('only issues GET requests for DM endpoints', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ inbox_initial_state: { conversations: {}, users: {}, entries: [] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          conversation_timeline: { status: 'AT_END', entries: [], users: {} },
        }),
      });

    const client = new TwitterClient({ cookies: validCookies });
    await client.getDmInbox();
    await client.getDmConversation('111-222', { maxId: '100' });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    for (const call of mockFetch.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.method).toBe('GET');
      const url = String(call[0]);
      expect(url).toMatch(DM_API_PATH_REGEX);
      expect(url).not.toMatch(DM_MUTATING_PATH_REGEX);
    }
  });
});
