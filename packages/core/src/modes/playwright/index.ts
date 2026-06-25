import { notImplemented } from '../../util/not-implemented.js';
import type {
  ExecOutcome,
  GeneratedSpec,
  SuiteBundle,
  TestMode,
  TestModeContext,
  TestPlan,
} from '../types.js';

/** Foundation stub — real Playwright engine implemented in M1 (modes/playwright module). */
export function createPlaywrightMode(): TestMode {
  return {
    id: 'playwright',
    scaffold(_ctx: TestModeContext): Promise<void> {
      return notImplemented('PlaywrightMode.scaffold');
    },
    generate(_ctx: TestModeContext, _plan: TestPlan): Promise<GeneratedSpec[]> {
      return notImplemented('PlaywrightMode.generate');
    },
    execute(_ctx: TestModeContext, _specs: GeneratedSpec[]): Promise<ExecOutcome> {
      return notImplemented('PlaywrightMode.execute');
    },
    collectArtifacts(_ctx: TestModeContext): Promise<{ dir: string; files: string[] }> {
      return notImplemented('PlaywrightMode.collectArtifacts');
    },
    export(_ctx: TestModeContext): Promise<SuiteBundle> {
      return notImplemented('PlaywrightMode.export');
    },
  };
}
