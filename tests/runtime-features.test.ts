import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addFeatureOverrides,
  applyFeatureOverrides,
  clearFeatureOverridesCache,
  getFeatureOverridesSnapshot,
  refreshFeatureOverridesCache,
} from '../src/lib/runtime-features.js';
import { buildLikesFeatures, buildListsFeatures, buildSearchFeatures } from '../src/lib/twitter-client-features.js';

describe('runtime-features', () => {
  afterEach(() => {
    delete process.env.BIRD_FEATURES_JSON;
    delete process.env.BIRD_FEATURES_CACHE;
    delete process.env.BIRD_FEATURES_PATH;
    clearFeatureOverridesCache();
  });

  it('applies global and set overrides from env json', () => {
    process.env.BIRD_FEATURES_JSON = JSON.stringify({
      global: {
        global_flag: true,
        ignored: 'nope',
      },
      sets: {
        search: {
          global_flag: false,
          search_only: true,
          bad: 1,
        },
        likes: {
          likes_only: true,
        },
        lists: {
          responsive_web_text_conversations_enabled: true,
        },
      },
    });

    clearFeatureOverridesCache();
    const search = buildSearchFeatures();
    expect(search.global_flag).toBe(false);
    expect(search.search_only).toBe(true);
    expect(search.bad).toBeUndefined();

    const likes = buildLikesFeatures();
    expect(likes.global_flag).toBe(true);
    expect(likes.likes_only).toBe(true);

    const lists = buildListsFeatures();
    expect(lists.responsive_web_text_conversations_enabled).toBe(true);
  });

  it('refresh merges defaults with existing cache', async () => {
    const cacheDir = path.join(os.tmpdir(), `bird-test-${randomUUID()}`);
    await mkdir(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, 'features.json');

    await writeFile(
      cachePath,
      JSON.stringify(
        {
          global: {
            existing_flag: true,
          },
          sets: {
            search: {
              existing_search: false,
            },
          },
        },
        null,
        2,
      ),
    );

    process.env.BIRD_FEATURES_PATH = cachePath;
    await refreshFeatureOverridesCache();

    const raw = await readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as {
      global?: Record<string, boolean>;
      sets?: Record<string, Record<string, boolean>>;
    };

    expect(parsed.global?.existing_flag).toBe(true);
    expect(parsed.global?.responsive_web_grok_annotations_enabled).toBe(false);
    expect(parsed.sets?.search?.existing_search).toBe(false);
  });

  it('applies overrides from cache file', async () => {
    const cacheDir = path.join(os.tmpdir(), `bird-test-${randomUUID()}`);
    await mkdir(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, 'features.json');

    await writeFile(
      cachePath,
      JSON.stringify(
        {
          global: {
            file_flag: true,
          },
          sets: {
            search: {
              file_search: true,
            },
          },
        },
        null,
        2,
      ),
    );

    process.env.BIRD_FEATURES_PATH = cachePath;
    clearFeatureOverridesCache();

    const search = buildSearchFeatures();
    expect(search.file_flag).toBe(true);
    expect(search.file_search).toBe(true);
  });

  it('includes required lists API feature flags', () => {
    const features = buildListsFeatures();
    expect(features.responsive_web_graphql_exclude_directive_enabled).toBe(true);
    expect(features.blue_business_profile_image_shape_enabled).toBe(true);
    expect(features.responsive_web_text_conversations_enabled).toBe(false);
    expect(features.tweetypie_unmention_optimization_enabled).toBe(true);
    expect(features.vibe_api_enabled).toBe(true);
    expect(features.interactive_text_enabled).toBe(true);
  });

  it('addFeatureOverrides persists merges and invalidates cache', async () => {
    const cacheDir = path.join(os.tmpdir(), `bird-test-${randomUUID()}`);
    await mkdir(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, 'features.json');
    process.env.BIRD_FEATURES_PATH = cachePath;
    clearFeatureOverridesCache();

    await addFeatureOverrides('likes', { healed_flag: true });

    const raw = JSON.parse(await readFile(cachePath, 'utf8')) as {
      sets?: Record<string, Record<string, boolean>>;
    };
    expect(raw.sets?.likes?.healed_flag).toBe(true);

    // Warm cache, then add another flag — applyFeatureOverrides must see both.
    expect(applyFeatureOverrides('likes', { base: false }).healed_flag).toBe(true);
    await addFeatureOverrides('likes', { second_flag: false });
    const merged = applyFeatureOverrides('likes', { base: true });
    expect(merged.healed_flag).toBe(true);
    expect(merged.second_flag).toBe(false);
    expect(merged.base).toBe(true);

    const snapshot = getFeatureOverridesSnapshot();
    expect(snapshot.cachePath).toBe(cachePath);
    expect(snapshot.overrides.sets?.likes?.second_flag).toBe(false);
  });
});
