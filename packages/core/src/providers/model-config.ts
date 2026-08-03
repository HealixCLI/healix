import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appDataDir } from '../env/app-data.js';
import type { TaskType } from './types.js';

/** Model aliases accepted by the Claude Code CLI's `--model` flag. */
export type ClaudeModel = 'sonnet' | 'opus' | 'haiku' | 'fable';

/** Reasoning-effort levels accepted by the Claude Code CLI's `--effort` flag. */
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelEffortSetting {
  model: ClaudeModel;
  effort: ClaudeEffort;
}

export type ModelEffortConfig = Record<TaskType, ModelEffortSetting>;

/**
 * The user's last-used per-task-type model/effort selections, persisted
 * verbatim on every Settings-page change and read back as-is on restart —
 * this only ever holds the task types the user has actually touched at least
 * once; any task type absent here (never touched, or added in a later Healix
 * version after the user's last save) falls back to DEFAULT_MODEL_CONFIG's
 * recommended seed value. The UI does not distinguish "using the seed" from
 * "explicitly set" — both just show as the task's current value.
 */
export type ModelEffortOverrides = Partial<Record<TaskType, Partial<ModelEffortSetting>>>;

/**
 * Hardcoded per-task-type recommended defaults, used only as the initial seed
 * value for a task type the user has never changed (first run, or a task type
 * added in a later version). Each task's model/effort is chosen against its
 * reliability bar and whether a deterministic/static fallback already exists
 * (see docs/adr for the full rationale) — safe-to-downgrade tasks
 * (mock-response, triage, health-probe) move to the cheap model tier, while
 * plan-generate/codegen stay on the capable tier since their output must be
 * strictly parseable/valid with no further fallback.
 */
export const DEFAULT_MODEL_CONFIG: ModelEffortConfig = {
  'plan-generate': { model: 'sonnet', effort: 'high' },
  'plan-gapfill': { model: 'sonnet', effort: 'medium' },
  'plan-revise-item': { model: 'sonnet', effort: 'low' },
  codegen: { model: 'sonnet', effort: 'high' },
  'mock-response': { model: 'haiku', effort: 'high' },
  triage: { model: 'haiku', effort: 'high' },
  'triage-summary': { model: 'haiku', effort: 'high' },
  'health-probe': { model: 'haiku', effort: 'low' },
  // Bounded, mechanical per-turn action selection (click/type/pressKey/done) from a fixed
  // vocabulary over a small text summary — not open-ended reasoning, so the cheap tier fits.
  'explore-gapfill': { model: 'haiku', effort: 'low' },
};

/** Merge the user's last-used per-task setting over the recommended seed for that one task type. */
export function resolveModelAndEffort(
  taskType: TaskType,
  overrides?: ModelEffortOverrides | null,
): ModelEffortSetting {
  const base = DEFAULT_MODEL_CONFIG[taskType];
  const override = overrides?.[taskType];
  if (!override) return base;
  return {
    model: override.model ?? base.model,
    effort: override.effort ?? base.effort,
  };
}

function modelConfigPath(): string {
  return join(appDataDir(), 'model-config.json');
}

/**
 * Best-effort read of the user's last-used per-task-type selections. Returns
 * null on a missing file, corrupt JSON, or any other read failure — callers
 * treat null the same as "nothing saved yet" and fall through to the
 * hardcoded recommended seed values.
 */
export async function readModelConfigOverrides(): Promise<ModelEffortOverrides | null> {
  try {
    const raw = await readFile(modelConfigPath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as ModelEffortOverrides;
    return null;
  } catch {
    return null;
  }
}

/** Best-effort write — a failure here must never abort the Settings-page auto-save. */
export async function writeModelConfigOverrides(overrides: ModelEffortOverrides): Promise<void> {
  try {
    await writeFile(modelConfigPath(), JSON.stringify(overrides, null, 2), 'utf-8');
  } catch {
    /* best-effort; the Settings UI surfaces its own failure toast if needed */
  }
}
