import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getStore, resetStoreForTests } from '../storage/store.js';
import type { HealixStore } from '../storage/store.js';
import type { GeneratedSpec, TestPlanItem } from '../modes/types.js';
import { persistResults, registerSpecRows } from './index.js';

/**
 * Reproduces the report.html-vs-Results-tab count mismatch reported live:
 * persistResults is invoked once per tier with only THAT tier's own specs
 * (see index.ts's EXECUTE loop), but a result can still surface for a
 * DIFFERENT tier's reqTag in that call (e.g. a Playwright invocation that
 * ran more than its own --project filter intended). Before the fix, such a
 * result's spec object couldn't be found in `specs`, so `base` (the stable
 * identity key) went null even though the title carried a perfectly good
 * "[REQ:tag]" marker — sending it down the fallback-insert path and creating
 * a phantom tier:null duplicate of the row registerSpecRows already made.
 */
describe('persistResults — cross-tier result still matches its pre-registered row', () => {
  let dataDir: string;
  let store: HealixStore;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'healix-persist-results-test-'));
    process.env.HEALIX_DATA_DIR = dataDir;
    resetStoreForTests();
    const opened = await getStore();
    if (!opened) throw new Error('getStore() returned null — node:sqlite unavailable in this runtime');
    store = opened;
  });

  afterEach(() => {
    resetStoreForTests();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('does not create a duplicate tier:null row for a result whose spec is outside this call’s `specs` list', () => {
    const project = store.createProject({ name: 'cross-tier-project', baseUrl: 'https://cross-tier.test' });
    const run = store.createRun(project.id);

    const item: TestPlanItem = {
      id: 'pli_test1',
      title: 'Widget list',
      reqTag: 'pli_test1',
      tier: 'tierA-public',
      intent: 'Verify the widget list loads.',
      scenarios: [{ kind: 'positive', description: 'loads successfully' }],
    };
    const spec: GeneratedSpec = {
      path: '/repo/tests/tierA-public/widget-list.spec.ts',
      title: 'Widget list',
      reqTag: 'pli_test1',
      tier: 'tierA-public',
      contents: '// generated spec',
    };

    const testIdByKey = new Map<string, string>();
    // GENERATE phase: registers the real, correctly-tiered row.
    registerSpecRows(store, run.id, '/repo', spec, [item], testIdByKey);

    const preRegistered = store.listTests(run.id);
    expect(preRegistered).toHaveLength(1);
    expect(preRegistered[0]?.tier).toBe('tierA-public');

    // EXECUTE phase for a DIFFERENT tier's call: `specs` only contains that
    // tier's own specs, but the outcome (e.g. from a Playwright invocation
    // that ran more than intended) still carries this reqTag's result.
    persistResults(
      store,
      run.id,
      [], // no matching GeneratedSpec in this call's own specs
      {
        passed: 1,
        failed: 0,
        blocked: 0,
        flaky: 0,
        results: [
          {
            title: '[REQ:pli_test1] positive: loads successfully',
            status: 'passed',
          },
        ],
      },
      testIdByKey,
      () => {},
      () => {},
    );

    const testsAfter = store.listTests(run.id);
    expect(testsAfter).toHaveLength(1);
    expect(testsAfter[0]?.tier).toBe('tierA-public');
    expect(testsAfter[0]?.status).toBe('passed');
  });
});
