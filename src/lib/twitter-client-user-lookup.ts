import { normalizeHandle } from './normalize-handle.js';
import type { AbstractConstructor, Mixin, TwitterClientBase } from './twitter-client-base.js';
import { TWITTER_API_BASE } from './twitter-client-constants.js';
import { buildUserProfileFeatures } from './twitter-client-features.js';
import type { AboutAccountResult, TwitterUser, UserProfileResult } from './twitter-client-types.js';

/** Result of username to userId lookup */
export interface UserLookupResult {
  success: boolean;
  userId?: string;
  username?: string;
  name?: string;
  error?: string;
}

export interface TwitterClientUserLookupMethods {
  getUserIdByUsername(username: string): Promise<UserLookupResult>;
  getUserAboutAccount(username: string): Promise<AboutAccountResult>;
  getUserProfile(username: string): Promise<UserProfileResult>;
}

export function withUserLookup<TBase extends AbstractConstructor<TwitterClientBase>>(
  Base: TBase,
): Mixin<TBase, TwitterClientUserLookupMethods> {
  abstract class TwitterClientUserLookup extends Base {
    // biome-ignore lint/complexity/noUselessConstructor lint/suspicious/noExplicitAny: TS mixin constructor requirement.
    constructor(...args: any[]) {
      super(...args);
    }

    private async getUserByScreenNameGraphQL(screenName: string): Promise<UserLookupResult> {
      const queryIds = await this.getUserByScreenNameQueryIds();

      const variables = {
        screen_name: screenName,
        withSafetyModeUserFields: true,
      };

      const features = {
        hidden_profile_subscriptions_enabled: true,
        hidden_profile_likes_enabled: true,
        rweb_tipjar_consumption_enabled: true,
        responsive_web_graphql_exclude_directive_enabled: true,
        verified_phone_label_enabled: false,
        subscriptions_verification_info_is_identity_verified_enabled: true,
        subscriptions_verification_info_verified_since_enabled: true,
        highlights_tweets_tab_ui_enabled: true,
        responsive_web_twitter_article_notes_tab_enabled: true,
        subscriptions_feature_can_gift_premium: true,
        creator_subscriptions_tweet_preview_api_enabled: true,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        responsive_web_graphql_timeline_navigation_enabled: true,
        blue_business_profile_image_shape_enabled: true,
      };

      const fieldToggles = {
        withAuxiliaryUserLabels: false,
      };

      const params = new URLSearchParams({
        variables: JSON.stringify(variables),
        features: JSON.stringify(features),
        fieldToggles: JSON.stringify(fieldToggles),
      });

      let lastError: string | undefined;

      for (const queryId of queryIds) {
        const url = `${TWITTER_API_BASE}/${queryId}/UserByScreenName?${params.toString()}`;

        try {
          const response = await this.fetchWithTimeout(url, {
            method: 'GET',
            headers: this.getHeaders(),
          });

          if (!response.ok) {
            const text = await response.text();
            if (response.status === 404) {
              // Try next query ID
              lastError = `HTTP ${response.status}`;
              continue;
            }
            lastError = `HTTP ${response.status}: ${text.slice(0, 200)}`;
            continue;
          }

          const data = (await response.json()) as {
            data?: {
              user?: {
                result?: {
                  __typename?: string;
                  rest_id?: string;
                  legacy?: {
                    screen_name?: string;
                    name?: string;
                  };
                  core?: {
                    screen_name?: string;
                    name?: string;
                  };
                };
              };
            };
            errors?: Array<{ message: string }>;
          };

          // Check for user not found
          if (data.data?.user?.result?.__typename === 'UserUnavailable') {
            return { success: false, error: `User @${screenName} not found or unavailable` };
          }

          const userResult = data.data?.user?.result;
          const userId = userResult?.rest_id;
          const username = userResult?.legacy?.screen_name ?? userResult?.core?.screen_name;
          const name = userResult?.legacy?.name ?? userResult?.core?.name;

          if (userId && username) {
            return {
              success: true,
              userId,
              username,
              name,
            };
          }

          if (data.errors && data.errors.length > 0) {
            lastError = data.errors.map((e) => e.message).join(', ');
            continue;
          }

          lastError = 'Could not parse user data from response';
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }

      return { success: false, error: lastError ?? 'Unknown error looking up user' };
    }

    /**
     * Look up a user's ID by their username/handle.
     * Uses GraphQL UserByScreenName first, then falls back to REST on transient failures.
     */
    async getUserIdByUsername(username: string): Promise<UserLookupResult> {
      const cleanUsername = normalizeHandle(username);
      if (!cleanUsername) {
        return { success: false, error: `Invalid username: ${username}` };
      }

      const graphqlResult = await this.getUserByScreenNameGraphQL(cleanUsername);
      if (graphqlResult.success) {
        return graphqlResult;
      }

      // If GraphQL definitively says user is unavailable, don't retry with REST
      if (graphqlResult.error?.includes('not found or unavailable')) {
        return graphqlResult;
      }

      // Fallback to REST API for transient GraphQL errors
      const urls = [
        `https://x.com/i/api/1.1/users/show.json?screen_name=${encodeURIComponent(cleanUsername)}`,
        `https://api.twitter.com/1.1/users/show.json?screen_name=${encodeURIComponent(cleanUsername)}`,
      ];

      let lastError: string | undefined = graphqlResult.error;

      for (const url of urls) {
        try {
          const response = await this.fetchWithTimeout(url, {
            method: 'GET',
            headers: this.getHeaders(),
          });

          if (!response.ok) {
            const text = await response.text();
            if (response.status === 404) {
              return { success: false, error: `User @${cleanUsername} not found` };
            }
            lastError = `HTTP ${response.status}: ${text.slice(0, 200)}`;
            continue;
          }

          const data = (await response.json()) as {
            id_str?: string;
            id?: number;
            screen_name?: string;
            name?: string;
          };

          const userId = data.id_str ?? (data.id ? String(data.id) : null);
          if (!userId) {
            lastError = 'Could not parse user ID from response';
            continue;
          }

          return {
            success: true,
            userId,
            username: data.screen_name ?? cleanUsername,
            name: data.name,
          };
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }

      return { success: false, error: lastError ?? 'Unknown error looking up user' };
    }

    private async getUserByScreenNameQueryIds(): Promise<string[]> {
      const primary = await this.getQueryId('UserByScreenName');
      return Array.from(
        new Set([primary, 'xc8f1g7BYqr6VTzTbvNlGw', 'qW5u-DAuXpMEG0zA1F7UGQ', 'sLVLhk0bGj3MVFEKTdax1w']),
      );
    }

    /**
     * Get a user's full profile (bio, counts, location, website, join date).
     * Uses the same UserByScreenName query as getUserIdByUsername but maps the full payload.
     */
    async getUserProfile(username: string): Promise<UserProfileResult> {
      const cleanUsername = normalizeHandle(username);
      if (!cleanUsername) {
        return { success: false, error: `Invalid username: ${username}` };
      }

      return this.withFeatureHeal('userProfile', async () => {
        const variables = {
          screen_name: cleanUsername,
          withSafetyModeUserFields: true,
        };

        const features = buildUserProfileFeatures();

        const fieldToggles = {
          withAuxiliaryUserLabels: false,
        };

        const params = new URLSearchParams({
          variables: JSON.stringify(variables),
          features: JSON.stringify(features),
          fieldToggles: JSON.stringify(fieldToggles),
        });

        const tryOnce = async () => {
          let lastError: string | undefined;
          let had404 = false;
          const queryIds = await this.getUserByScreenNameQueryIds();

          for (const queryId of queryIds) {
            const url = `${TWITTER_API_BASE}/${queryId}/UserByScreenName?${params.toString()}`;

            try {
              const response = await this.fetchWithTimeout(url, {
                method: 'GET',
                headers: this.getHeaders(),
              });

              if (!response.ok) {
                const text = await response.text();
                if (response.status === 404) {
                  had404 = true;
                  lastError = `HTTP ${response.status}`;
                  continue;
                }
                return {
                  success: false as const,
                  error: `HTTP ${response.status}: ${text.slice(0, 400)}`,
                  had404,
                };
              }

              const data = (await response.json()) as {
                data?: {
                  user?: {
                    result?: {
                      __typename?: string;
                      rest_id?: string;
                      is_blue_verified?: boolean;
                      legacy?: {
                        screen_name?: string;
                        name?: string;
                        description?: string;
                        followers_count?: number;
                        friends_count?: number;
                        statuses_count?: number;
                        created_at?: string;
                        location?: string;
                        url?: string;
                        profile_image_url_https?: string;
                        entities?: {
                          url?: {
                            urls?: Array<{ url?: string; expanded_url?: string }>;
                          };
                        };
                      };
                      core?: {
                        screen_name?: string;
                        name?: string;
                        created_at?: string;
                      };
                      location?: {
                        location?: string;
                      };
                      avatar?: {
                        image_url?: string;
                      };
                    };
                  };
                };
                errors?: Array<{ message: string }>;
              };

              if (data.data?.user?.result?.__typename === 'UserUnavailable') {
                return {
                  success: false as const,
                  error: `User @${cleanUsername} not found or unavailable`,
                  had404,
                };
              }

              if (data.errors && data.errors.length > 0) {
                return {
                  success: false as const,
                  error: data.errors.map((e) => e.message).join(', '),
                  had404,
                };
              }

              const result = data.data?.user?.result;
              const userId = result?.rest_id;
              const screenName = result?.legacy?.screen_name ?? result?.core?.screen_name;

              if (!result || !userId || !screenName) {
                lastError = 'Could not parse user data from response';
                continue;
              }

              const legacy = result.legacy;
              const websiteUrl = legacy?.entities?.url?.urls?.[0]?.expanded_url ?? legacy?.url;
              const user: TwitterUser = {
                id: userId,
                username: screenName,
                name: legacy?.name ?? result.core?.name ?? screenName,
                description: legacy?.description || undefined,
                followersCount: legacy?.followers_count,
                followingCount: legacy?.friends_count,
                tweetsCount: legacy?.statuses_count,
                location: legacy?.location || result.location?.location || undefined,
                websiteUrl: websiteUrl || undefined,
                isBlueVerified: result.is_blue_verified,
                profileImageUrl: legacy?.profile_image_url_https ?? result.avatar?.image_url,
                createdAt: legacy?.created_at ?? result.core?.created_at,
              };

              return { success: true as const, user, had404 };
            } catch (error) {
              lastError = error instanceof Error ? error.message : String(error);
            }
          }

          return {
            success: false as const,
            error: lastError ?? 'Unknown error fetching user profile',
            had404,
          };
        };

        const { result } = await this.withRefreshedQueryIdsOn404(tryOnce);
        if (result.success) {
          return { success: true as const, user: result.user };
        }
        return { success: false as const, error: result.error };
      });
    }

    private async getAboutAccountQueryIds(): Promise<string[]> {
      const primary = await this.getQueryId('AboutAccountQuery');
      return Array.from(new Set([primary, 'zs_jFPFT78rBpXv9Z3U2YQ']));
    }

    /**
     * Get account origin and location information for a user.
     * Returns data from Twitter's "About this account" feature.
     */
    async getUserAboutAccount(username: string): Promise<AboutAccountResult> {
      const cleanUsername = normalizeHandle(username);
      if (!cleanUsername) {
        return { success: false, error: `Invalid username: ${username}` };
      }

      const variables = {
        screenName: cleanUsername,
      };

      const params = new URLSearchParams({
        variables: JSON.stringify(variables),
      });

      const tryOnce = async () => {
        let lastError: string | undefined;
        let had404 = false;
        const queryIds = await this.getAboutAccountQueryIds();

        for (const queryId of queryIds) {
          const url = `${TWITTER_API_BASE}/${queryId}/AboutAccountQuery?${params.toString()}`;

          try {
            const response = await this.fetchWithTimeout(url, {
              method: 'GET',
              headers: this.getHeaders(),
            });

            if (!response.ok) {
              const text = await response.text();
              if (response.status === 404) {
                had404 = true;
                lastError = `HTTP ${response.status}`;
                continue;
              }
              lastError = `HTTP ${response.status}: ${text.slice(0, 200)}`;
              continue;
            }

            const data = (await response.json()) as {
              data?: {
                user_result_by_screen_name?: {
                  result?: {
                    about_profile?: {
                      account_based_in?: string;
                      source?: string;
                      created_country_accurate?: boolean;
                      location_accurate?: boolean;
                      learn_more_url?: string;
                    };
                  };
                };
              };
              errors?: Array<{ message: string }>;
            };

            if (data.errors && data.errors.length > 0) {
              lastError = data.errors.map((e) => e.message).join(', ');
              continue;
            }

            const aboutProfile = data.data?.user_result_by_screen_name?.result?.about_profile;
            if (!aboutProfile) {
              lastError = 'Missing about_profile in response';
              continue;
            }

            return {
              success: true as const,
              aboutProfile: {
                accountBasedIn: aboutProfile.account_based_in,
                source: aboutProfile.source,
                createdCountryAccurate: aboutProfile.created_country_accurate,
                locationAccurate: aboutProfile.location_accurate,
                learnMoreUrl: aboutProfile.learn_more_url,
              },
              had404,
            };
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
          }
        }

        return {
          success: false as const,
          error: lastError ?? 'Unknown error fetching account details',
          had404,
        };
      };

      const { result } = await this.withRefreshedQueryIdsOn404(tryOnce);
      if (result.success) {
        return { success: true, aboutProfile: result.aboutProfile };
      }
      return { success: false, error: result.error };
    }
  }

  return TwitterClientUserLookup;
}
