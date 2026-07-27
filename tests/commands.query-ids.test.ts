import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliContext } from '../src/cli/shared.js';
import { registerQueryIdsCommand } from '../src/commands/query-ids.js';
import * as runtimeFeatures from '../src/lib/runtime-features.js';
import { runtimeQueryIds } from '../src/lib/runtime-query-ids.js';
import { TARGET_QUERY_ID_OPERATIONS } from '../src/lib/twitter-client-constants.js';

describe('query-ids command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refreshes every operation in TARGET_QUERY_ID_OPERATIONS on --fresh', async () => {
    const program = new Command();
    const ctx = {
      p: () => '',
    } as unknown as CliContext;

    const refreshSpy = vi.spyOn(runtimeQueryIds, 'refresh').mockResolvedValue(null);
    vi.spyOn(runtimeFeatures, 'refreshFeatureOverridesCache').mockResolvedValue({
      cachePath: '/tmp/features.json',
      overrides: {},
    });
    vi.spyOn(runtimeFeatures, 'getFeatureOverridesSnapshot').mockReturnValue({
      cachePath: '/tmp/features.json',
      overrides: {},
    });
    vi.spyOn(runtimeQueryIds, 'getSnapshotInfo').mockResolvedValue(null);

    registerQueryIdsCommand(program, ctx);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await program.parseAsync(['node', 'bird', 'query-ids', '--fresh']);
      expect(refreshSpy).toHaveBeenCalledWith([...TARGET_QUERY_ID_OPERATIONS], { force: true });
      expect(refreshSpy.mock.calls[0]?.[0]).toEqual(TARGET_QUERY_ID_OPERATIONS);
      expect(refreshSpy.mock.calls[0]?.[0]).toHaveLength(TARGET_QUERY_ID_OPERATIONS.length);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
