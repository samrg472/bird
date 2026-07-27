import type { Command } from 'commander';
import type { CliContext } from '../cli/shared.js';
import { normalizeHandle } from '../lib/normalize-handle.js';
import { TwitterClient } from '../lib/twitter-client.js';
import type { DmConversationSummary, DmMessage } from '../lib/twitter-client-types.js';

const NUMERIC_ID_REGEX = /^\d+$/;

function formatParticipant(participant: { username?: string; name?: string; id: string }): string {
  if (participant.username) {
    const namePart = participant.name ? ` (${participant.name})` : '';
    return `@${participant.username}${namePart}`;
  }
  if (participant.name) {
    return participant.name;
  }
  return participant.id;
}

function printConversations(conversations: DmConversationSummary[]): void {
  for (const conversation of conversations) {
    const participantsLine = conversation.participants.map(formatParticipant).join(', ');
    console.log(participantsLine || conversation.id);

    if (conversation.lastMessageText) {
      const text = conversation.lastMessageText;
      console.log(`  ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`);
    }
    if (conversation.lastMessageAt) {
      console.log(`  ${conversation.lastMessageAt}`);
    }
    console.log(`  ${conversation.id}`);
    console.log('──────────────────────────────────────────────────');
  }
}

function printMessages(messages: DmMessage[]): void {
  for (const message of messages) {
    const sender = message.senderUsername ? `@${message.senderUsername}` : message.senderId;
    const time = message.createdAt ?? '';
    console.log(`${sender} · ${time}`);
    console.log(message.text);
    if (message.mediaUrls) {
      for (const url of message.mediaUrls) {
        console.log(url);
      }
    }
    console.log('');
  }
}

function looksLikeHandle(argument: string): boolean {
  if (argument.startsWith('@')) {
    return true;
  }
  // Conversation ids are numeric, optionally with dashes (userId-userId).
  // Bare handles are non-numeric with no dash.
  return !argument.includes('-') && !NUMERIC_ID_REGEX.test(argument);
}

async function resolveConversationId(
  client: TwitterClient,
  argument: string,
  ctx: CliContext,
): Promise<{ id: string; alternateId?: string }> {
  if (!looksLikeHandle(argument)) {
    return { id: argument };
  }

  const handle = normalizeHandle(argument);
  if (!handle) {
    console.error(`${ctx.p('err')}Invalid username: ${argument}`);
    process.exit(1);
  }

  // Best-effort: self-filtering (and the id-form fallback below) need the self
  // id, but an inbox match shouldn't be blocked by a transient whoami failure.
  const self = await client.getCurrentUser();
  const selfId = self.success ? self.user?.id : undefined;

  const inbox = await client.getDmInbox();
  if (inbox.success && inbox.conversations) {
    const needle = handle.toLowerCase();
    const match = inbox.conversations.find((conversation) => {
      if (conversation.type && conversation.type !== 'ONE_TO_ONE') {
        return false;
      }
      return conversation.participants.some(
        (participant) =>
          (selfId === undefined || participant.id !== selfId) && participant.username?.toLowerCase() === needle,
      );
    });
    if (match) {
      return { id: match.id };
    }
  }

  if (!selfId) {
    console.error(`${ctx.p('err')}Failed to get current user: ${self.error ?? 'Unknown error'}`);
    process.exit(1);
  }

  const lookup = await client.getUserIdByUsername(handle);
  if (!lookup.success || !lookup.userId) {
    console.error(`${ctx.p('err')}Failed to resolve @${handle}: ${lookup.error ?? 'Unknown error'}`);
    process.exit(1);
  }

  const theirId = lookup.userId;
  return { id: `${theirId}-${selfId}`, alternateId: `${selfId}-${theirId}` };
}

async function fetchConversationWithFallback(
  client: TwitterClient,
  primaryId: string,
  alternateId: string | undefined,
  options: { maxId?: string },
): Promise<Awaited<ReturnType<TwitterClient['getDmConversation']>>> {
  const first = await client.getDmConversation(primaryId, options);
  if (first.success || !alternateId) {
    return first;
  }
  return client.getDmConversation(alternateId, options);
}

export function registerDmCommands(program: Command, ctx: CliContext): void {
  program
    .command('dms')
    .description('List Direct Message inbox conversations')
    .option('-n, --count <number>', 'Number of conversations to show', '20')
    .option('--json', 'Output as JSON')
    .action(async (cmdOpts: { count?: string; json?: boolean }) => {
      const opts = program.opts();
      const timeoutMs = ctx.resolveTimeoutFromOptions(opts);
      const count = Number.parseInt(cmdOpts.count || '20', 10);

      if (!Number.isFinite(count) || count <= 0) {
        console.error(`${ctx.p('err')}Invalid --count. Expected a positive integer.`);
        process.exit(1);
      }

      const { cookies, warnings } = await ctx.resolveCredentialsFromOptions(opts);

      for (const warning of warnings) {
        console.error(`${ctx.p('warn')}${warning}`);
      }

      if (!cookies.authToken || !cookies.ct0) {
        console.error(`${ctx.p('err')}Missing required credentials`);
        process.exit(1);
      }

      const client = new TwitterClient({ cookies, timeoutMs });
      const result = await client.getDmInbox();

      if (result.success && result.conversations) {
        const conversations = result.conversations.slice(0, count);
        if (cmdOpts.json) {
          console.log(JSON.stringify(conversations, null, 2));
        } else {
          printConversations(conversations);
        }
      } else {
        console.error(`${ctx.p('err')}Failed to fetch DM inbox: ${result.error ?? 'Unknown error'}`);
        process.exit(1);
      }
    });

  program
    .command('dm')
    .description('Show messages in a Direct Message conversation')
    .argument('<conversation-id-or-@handle>', 'Conversation id or @handle for a 1:1 DM')
    .option('-n, --count <number>', 'Number of messages to show', '20')
    .option('--cursor <max_id>', 'Page backward from this max_id (min_entry_id from prior response)')
    .option('--json', 'Output as JSON')
    .action(async (conversationIdOrHandle: string, cmdOpts: { count?: string; cursor?: string; json?: boolean }) => {
      const opts = program.opts();
      const timeoutMs = ctx.resolveTimeoutFromOptions(opts);
      const count = Number.parseInt(cmdOpts.count || '20', 10);

      if (!Number.isFinite(count) || count <= 0) {
        console.error(`${ctx.p('err')}Invalid --count. Expected a positive integer.`);
        process.exit(1);
      }

      const { cookies, warnings } = await ctx.resolveCredentialsFromOptions(opts);

      for (const warning of warnings) {
        console.error(`${ctx.p('warn')}${warning}`);
      }

      if (!cookies.authToken || !cookies.ct0) {
        console.error(`${ctx.p('err')}Missing required credentials`);
        process.exit(1);
      }

      const client = new TwitterClient({ cookies, timeoutMs });
      const resolved = await resolveConversationId(client, conversationIdOrHandle, ctx);
      const result = await fetchConversationWithFallback(client, resolved.id, resolved.alternateId, {
        maxId: cmdOpts.cursor,
      });

      if (result.success && result.messages) {
        const messages = result.messages.length > count ? result.messages.slice(-count) : result.messages;

        if (cmdOpts.json) {
          console.log(JSON.stringify(messages, null, 2));
        } else {
          printMessages(messages);
        }

        if (result.minEntryId && result.status !== 'AT_END') {
          console.error(`${ctx.p('info')}More messages available. Use --cursor "${result.minEntryId}" to continue.`);
        }
      } else {
        console.error(`${ctx.p('err')}Failed to fetch DM conversation: ${result.error ?? 'Unknown error'}`);
        process.exit(1);
      }
    });
}
