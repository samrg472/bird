import type { AbstractConstructor, Mixin, TwitterClientBase } from './twitter-client-base.js';
import type {
  DmConversationResult,
  DmConversationSummary,
  DmInboxResult,
  DmMessage,
  DmParticipant,
} from './twitter-client-types.js';

/**
 * Read-only Direct Message mixin.
 * STRICT READ-ONLY: GET requests only. Never implement or call
 * update_last_seen_event_id, mark_read, trust, or any POST/PUT/DELETE DM endpoint.
 */

const DM_INBOX_URL = 'https://x.com/i/api/1.1/dm/inbox_initial_state.json';
const DM_CONVERSATION_URL = 'https://x.com/i/api/1.1/dm/conversation';

const DM_EXT =
  'mediaColor,altText,mediaStats,highlightedLabel,parodyCommentaryFanLabel,voiceInfo,birdwatchPivot,superFollowMetadata,unmentionInfo,editControl,article';

type DmUserMap = Record<
  string,
  {
    id_str?: string;
    screen_name?: string;
    name?: string;
  }
>;

type DmRawParticipant = {
  user_id?: string;
};

type DmRawConversation = {
  conversation_id?: string;
  type?: string;
  sort_timestamp?: string;
  sort_event_id?: string;
  last_read_event_id?: string;
  max_entry_id?: string;
  participants?: DmRawParticipant[];
};

type DmRawMessageData = {
  id?: string;
  sender_id?: string;
  text?: string;
  time?: string;
  attachment?: {
    photo?: { media_url_https?: string };
    video?: { media_url_https?: string };
  };
};

type DmRawEntry = {
  message?: {
    id?: string;
    time?: string;
    conversation_id?: string;
    message_data?: DmRawMessageData;
  };
};

export interface TwitterClientDirectMessageMethods {
  getDmInbox(): Promise<DmInboxResult>;
  getDmConversation(
    conversationId: string,
    options?: { maxId?: string; minId?: string },
  ): Promise<DmConversationResult>;
}

function applyBaseDmApiParams(params: URLSearchParams): void {
  // Mirrors addApiParams(..., false) from the twitter-scraper reference, then DM overrides.
  params.set('include_profile_interstitial_type', '1');
  params.set('include_blocking', '1');
  params.set('include_blocked_by', '1');
  params.set('include_followed_by', '1');
  params.set('include_want_retweets', '1');
  params.set('include_mute_edge', '1');
  params.set('include_can_dm', '1');
  params.set('include_can_media_tag', '1');
  params.set('include_ext_has_nft_avatar', '1');
  params.set('include_ext_is_blue_verified', '1');
  params.set('include_ext_verified_type', '1');
  params.set('skip_status', '1');
  params.set('cards_platform', 'Web-12');
  params.set('include_cards', '1');
  params.set('include_ext_alt_text', 'true');
  params.set('include_ext_limited_action_results', 'false');
  params.set('include_quote_count', 'true');
  params.set('include_reply_count', '1');
  params.set('tweet_mode', 'extended');
  params.set('include_ext_collab_control', 'true');
  params.set('include_ext_views', 'true');
  params.set('include_entities', 'true');
  params.set('include_user_entities', 'true');
  params.set('include_ext_media_color', 'true');
  params.set('include_ext_media_availability', 'true');
  params.set('include_ext_sensitive_media_warning', 'true');
  params.set('include_ext_trusted_friends_metadata', 'true');
  params.set('send_error_codes', 'true');
  params.set('simple_quoted_tweet', 'true');
  params.set('include_tweet_replies', 'false');
}

function epochMsToIso(time?: string): string | undefined {
  if (!time) {
    return undefined;
  }
  const ms = Number(time);
  if (!Number.isFinite(ms)) {
    return undefined;
  }
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString();
}

function extractMediaUrls(messageData: DmRawMessageData | undefined): string[] | undefined {
  const attachment = messageData?.attachment;
  if (!attachment) {
    return undefined;
  }
  const urls: string[] = [];
  const photoUrl = attachment.photo?.media_url_https;
  const videoUrl = attachment.video?.media_url_https;
  if (photoUrl) {
    urls.push(photoUrl);
  }
  if (videoUrl) {
    urls.push(videoUrl);
  }
  return urls.length > 0 ? urls : undefined;
}

function mapParticipant(userId: string, users: DmUserMap): DmParticipant {
  const user = users[userId];
  return {
    id: userId,
    username: user?.screen_name,
    name: user?.name,
  };
}

function parseMessageEntry(entry: DmRawEntry, users: DmUserMap): DmMessage | null {
  const message = entry.message;
  const data = message?.message_data;
  if (!message || !data) {
    return null;
  }

  const conversationId = message.conversation_id;
  const senderId = data.sender_id;
  const id = data.id ?? message.id;
  if (!conversationId || !senderId || !id) {
    return null;
  }

  const text = typeof data.text === 'string' ? data.text : '';
  const createdAt = epochMsToIso(data.time ?? message.time);
  const sender = users[senderId];

  return {
    id,
    conversationId,
    senderId,
    senderUsername: sender?.screen_name,
    text,
    createdAt,
    mediaUrls: extractMediaUrls(data),
  };
}

function buildInboxParams(): URLSearchParams {
  const params = new URLSearchParams();
  applyBaseDmApiParams(params);
  params.set('nsfw_filtering_enabled', 'false');
  params.set('filter_low_quality', 'true');
  params.set('include_quality', 'all');
  params.set('include_ext_profile_image_shape', '1');
  params.set('dm_secret_conversations_enabled', 'false');
  params.set('krs_registration_enabled', 'false');
  params.set('include_ext_limited_action_results', 'true');
  params.set('dm_users', 'true');
  params.set('include_groups', 'true');
  params.set('include_inbox_timelines', 'true');
  params.set('supports_reactions', 'true');
  params.set('supports_edit', 'true');
  params.set('include_ext_edit_control', 'true');
  params.set('include_ext_business_affiliations_label', 'true');
  params.set('include_ext_parody_commentary_fan_label', 'true');
  params.set('ext', DM_EXT);
  return params;
}

function buildConversationParams(options?: { maxId?: string; minId?: string }): URLSearchParams {
  const params = new URLSearchParams();
  applyBaseDmApiParams(params);
  params.set('context', 'FETCH_DM_CONVERSATION_HISTORY');
  params.set('include_ext_profile_image_shape', '1');
  params.set('dm_secret_conversations_enabled', 'false');
  params.set('krs_registration_enabled', 'false');
  params.set('include_ext_limited_action_results', 'true');
  params.set('dm_users', 'true');
  params.set('include_groups', 'true');
  params.set('include_inbox_timelines', 'true');
  params.set('supports_reactions', 'true');
  params.set('supports_edit', 'true');
  params.set('include_conversation_info', 'true');
  params.set('ext', DM_EXT);
  if (options?.maxId) {
    params.set('max_id', options.maxId);
  }
  if (options?.minId) {
    params.set('min_id', options.minId);
  }
  return params;
}

function parseInboxConversations(
  conversations: Record<string, DmRawConversation> | undefined,
  users: DmUserMap,
  entries: DmRawEntry[] | undefined,
): DmConversationSummary[] {
  if (!conversations || typeof conversations !== 'object') {
    return [];
  }

  const lastByConversation = new Map<string, { text: string; at?: string; sortKey: number }>();
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const parsed = parseMessageEntry(entry, users);
      if (!parsed) {
        continue;
      }
      const timeRaw = entry.message?.message_data?.time ?? entry.message?.time;
      const sortKey = timeRaw && Number.isFinite(Number(timeRaw)) ? Number(timeRaw) : 0;
      const existing = lastByConversation.get(parsed.conversationId);
      if (!existing || sortKey >= existing.sortKey) {
        lastByConversation.set(parsed.conversationId, {
          text: parsed.text,
          at: parsed.createdAt,
          sortKey,
        });
      }
    }
  }

  const summaries: DmConversationSummary[] = [];
  for (const [key, conversation] of Object.entries(conversations)) {
    if (!conversation || typeof conversation !== 'object') {
      continue;
    }
    const id = conversation.conversation_id ?? key;
    const participants: DmParticipant[] = Array.isArray(conversation.participants)
      ? conversation.participants
          .map((p) => (p?.user_id ? mapParticipant(p.user_id, users) : null))
          .filter((p): p is DmParticipant => p !== null)
      : [];

    const last = lastByConversation.get(id);
    const lastRead = conversation.last_read_event_id;
    const latestEvent = conversation.sort_event_id ?? conversation.max_entry_id;
    const unread = lastRead !== undefined && latestEvent !== undefined ? lastRead !== latestEvent : undefined;

    summaries.push({
      id,
      type: conversation.type,
      participants,
      lastMessageText: last?.text,
      lastMessageAt: last?.at ?? epochMsToIso(conversation.sort_timestamp),
      unread,
    });
  }

  summaries.sort((a, b) => {
    const aMs = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
    const bMs = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
    return bMs - aMs;
  });

  return summaries;
}

export function withDirectMessages<TBase extends AbstractConstructor<TwitterClientBase>>(
  Base: TBase,
): Mixin<TBase, TwitterClientDirectMessageMethods> {
  abstract class TwitterClientDirectMessages extends Base {
    // biome-ignore lint/complexity/noUselessConstructor lint/suspicious/noExplicitAny: TS mixin constructor requirement.
    constructor(...args: any[]) {
      super(...args);
    }

    async getDmInbox(): Promise<DmInboxResult> {
      const params = buildInboxParams();
      const url = `${DM_INBOX_URL}?${params.toString()}`;

      try {
        const response = await this.fetchWithTimeout(url, {
          method: 'GET',
          headers: this.getHeaders(),
        });

        if (!response.ok) {
          const text = await response.text();
          return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
        }

        const data = (await response.json()) as {
          inbox_initial_state?: {
            conversations?: Record<string, DmRawConversation>;
            users?: DmUserMap;
            entries?: DmRawEntry[];
          };
        };

        const state = data.inbox_initial_state;
        const users = state?.users ?? {};
        const conversations = parseInboxConversations(state?.conversations, users, state?.entries);
        return { success: true, conversations };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    async getDmConversation(
      conversationId: string,
      options?: { maxId?: string; minId?: string },
    ): Promise<DmConversationResult> {
      const params = buildConversationParams(options);
      const url = `${DM_CONVERSATION_URL}/${encodeURIComponent(conversationId)}.json?${params.toString()}`;

      try {
        const response = await this.fetchWithTimeout(url, {
          method: 'GET',
          headers: this.getHeaders(),
        });

        if (!response.ok) {
          const text = await response.text();
          return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
        }

        const data = (await response.json()) as {
          conversation_timeline?: {
            status?: string;
            min_entry_id?: string;
            max_entry_id?: string;
            entries?: DmRawEntry[];
            users?: DmUserMap;
          };
        };

        const timeline = data.conversation_timeline;
        const users = timeline?.users ?? {};
        const messages: DmMessage[] = [];
        if (Array.isArray(timeline?.entries)) {
          for (const entry of timeline.entries) {
            const parsed = parseMessageEntry(entry, users);
            if (parsed) {
              messages.push(parsed);
            }
          }
        }

        messages.sort((a, b) => {
          const aMs = a.createdAt ? Date.parse(a.createdAt) : 0;
          const bMs = b.createdAt ? Date.parse(b.createdAt) : 0;
          return aMs - bMs;
        });

        return {
          success: true,
          messages,
          status: timeline?.status,
          minEntryId: timeline?.min_entry_id,
          maxEntryId: timeline?.max_entry_id,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  return TwitterClientDirectMessages;
}
