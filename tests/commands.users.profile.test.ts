import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliContext } from '../src/cli/shared.js';
import { registerUserCommands } from '../src/commands/users.js';
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

describe('users profile command', () => {
  it('prints the full profile as JSON with --json', async () => {
    const program = new Command();
    registerUserCommands(program, baseCtx);
    vi.spyOn(TwitterClient.prototype, 'getUserProfile').mockResolvedValue({
      success: true,
      user: {
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
      },
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await program.parseAsync(['node', 'bird', 'profile', '@testuser', '--json']);

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(payload.username).toBe('testuser');
    expect(payload.followersCount).toBe(1234);
    expect(payload.websiteUrl).toBe('https://example.com');
  });

  it('prints formatted profile lines without --json', async () => {
    const program = new Command();
    registerUserCommands(program, baseCtx);
    vi.spyOn(TwitterClient.prototype, 'getUserProfile').mockResolvedValue({
      success: true,
      user: {
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
        createdAt: 'Tue Mar 21 20:50:14 +0000 2006',
      },
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await program.parseAsync(['node', 'bird', 'profile', 'testuser']);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('@testuser (Test User) ✓');
    expect(output).toContain('Building things.');
    expect(output).toContain('📍 Vienna, Austria');
    expect(output).toContain('🌐 https://example.com');
    expect(output).toContain('1,234 followers · 567 following · 8,901 tweets');
    expect(output).toContain('https://x.com/testuser');
  });

  it('exits on profile lookup failure', async () => {
    const program = new Command();
    registerUserCommands(program, baseCtx);
    vi.spyOn(TwitterClient.prototype, 'getUserProfile').mockResolvedValue({
      success: false,
      error: 'HTTP 500',
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    await expect(program.parseAsync(['node', 'bird', 'profile', 'testuser'])).rejects.toThrow('process.exit');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch profile'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
