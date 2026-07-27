import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliContext } from '../src/cli/shared.js';
import { registerDmCommands } from '../src/commands/dms.js';
import { TwitterClient } from '../src/lib/twitter-client.js';

const baseCtx = {
  resolveTimeoutFromOptions: () => undefined,
  resolveCredentialsFromOptions: async () => ({
    cookies: { authToken: 'auth', ct0: 'ct0', cookieHeader: 'auth=auth; ct0=ct0' },
    warnings: [],
  }),
  p: () => '',
  l: () => '',
  printTweets: () => undefined,
} as unknown as CliContext;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dms commands', () => {
  it('prints inbox conversations as JSON with dms --json', async () => {
    const program = new Command();
    registerDmCommands(program, baseCtx);
    vi.spyOn(TwitterClient.prototype, 'getDmInbox').mockResolvedValue({
      success: true,
      conversations: [
        {
          id: '111-222',
          type: 'ONE_TO_ONE',
          participants: [
            { id: '111', username: 'alice', name: 'Alice' },
            { id: '222', username: 'bob', name: 'Bob' },
          ],
          lastMessageText: 'Hello',
          lastMessageAt: '2023-11-14T22:13:20.000Z',
        },
      ],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await program.parseAsync(['node', 'bird', 'dms', '--json']);

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(payload).toHaveLength(1);
    expect(payload[0].id).toBe('111-222');
    expect(payload[0].participants[0].username).toBe('alice');
  });

  it('prints conversation messages as JSON with dm <id> --json', async () => {
    const program = new Command();
    registerDmCommands(program, baseCtx);
    vi.spyOn(TwitterClient.prototype, 'getDmConversation').mockResolvedValue({
      success: true,
      status: 'AT_END',
      messages: [
        {
          id: '100',
          conversationId: '111-222',
          senderId: '111',
          senderUsername: 'alice',
          text: 'Hi',
          createdAt: '2023-11-14T22:13:20.000Z',
        },
      ],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await program.parseAsync(['node', 'bird', 'dm', '111-222', '--json']);

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(payload).toHaveLength(1);
    expect(payload[0].text).toBe('Hi');
    expect(payload[0].senderUsername).toBe('alice');
  });

  it('resolves @handle via inbox ONE_TO_ONE match', async () => {
    const program = new Command();
    registerDmCommands(program, baseCtx);
    vi.spyOn(TwitterClient.prototype, 'getCurrentUser').mockResolvedValue({
      success: true,
      user: { id: '111', username: 'alice', name: 'Alice' },
    });
    const inboxSpy = vi.spyOn(TwitterClient.prototype, 'getDmInbox').mockResolvedValue({
      success: true,
      conversations: [
        {
          id: '111-333',
          type: 'ONE_TO_ONE',
          participants: [
            { id: '111', username: 'alice', name: 'Alice' },
            { id: '333', username: 'carol', name: 'Carol' },
          ],
        },
        {
          id: '111-222',
          type: 'ONE_TO_ONE',
          participants: [
            { id: '111', username: 'alice', name: 'Alice' },
            { id: '222', username: 'bob', name: 'Bob' },
          ],
        },
      ],
    });
    const conversationSpy = vi.spyOn(TwitterClient.prototype, 'getDmConversation').mockResolvedValue({
      success: true,
      status: 'AT_END',
      messages: [
        {
          id: '100',
          conversationId: '111-222',
          senderId: '222',
          senderUsername: 'bob',
          text: 'Hey',
        },
      ],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await program.parseAsync(['node', 'bird', 'dm', '@bob', '--json']);

    expect(inboxSpy).toHaveBeenCalled();
    expect(conversationSpy).toHaveBeenCalledWith('111-222', { maxId: undefined });
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(payload[0].text).toBe('Hey');
  });

  it('resolves self-handle to self-notes conversation id', async () => {
    const program = new Command();
    registerDmCommands(program, baseCtx);
    vi.spyOn(TwitterClient.prototype, 'getCurrentUser').mockResolvedValue({
      success: true,
      user: { id: '111', username: 'alice', name: 'Alice' },
    });
    vi.spyOn(TwitterClient.prototype, 'getDmInbox').mockResolvedValue({
      success: true,
      conversations: [
        {
          id: '111-222',
          type: 'ONE_TO_ONE',
          participants: [
            { id: '111', username: 'alice', name: 'Alice' },
            { id: '222', username: 'bob', name: 'Bob' },
          ],
        },
      ],
    });
    vi.spyOn(TwitterClient.prototype, 'getUserIdByUsername').mockResolvedValue({
      success: true,
      userId: '111',
    });
    const conversationSpy = vi.spyOn(TwitterClient.prototype, 'getDmConversation').mockResolvedValue({
      success: true,
      status: 'AT_END',
      messages: [
        {
          id: '200',
          conversationId: '111-111',
          senderId: '111',
          senderUsername: 'alice',
          text: 'Note to self',
        },
      ],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await program.parseAsync(['node', 'bird', 'dm', '@alice', '--json']);

    expect(conversationSpy).toHaveBeenCalledWith('111-111', { maxId: undefined });
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(payload[0].text).toBe('Note to self');
  });

  it('exits on DM inbox failure', async () => {
    const program = new Command();
    registerDmCommands(program, baseCtx);
    vi.spyOn(TwitterClient.prototype, 'getDmInbox').mockResolvedValue({
      success: false,
      error: 'HTTP 500',
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    await expect(program.parseAsync(['node', 'bird', 'dms'])).rejects.toThrow('process.exit');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch DM inbox'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
