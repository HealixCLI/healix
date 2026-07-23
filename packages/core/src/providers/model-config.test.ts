import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_CONFIG,
  readModelConfigOverrides,
  resolveModelAndEffort,
  writeModelConfigOverrides,
} from './model-config.js';

describe('resolveModelAndEffort', () => {
  it('returns the hardcoded default when no overrides are given', () => {
    expect(resolveModelAndEffort('triage', undefined)).toEqual(DEFAULT_MODEL_CONFIG.triage);
    expect(resolveModelAndEffort('triage', null)).toEqual(DEFAULT_MODEL_CONFIG.triage);
  });

  it('returns the hardcoded default when overrides exist but not for this task type', () => {
    expect(resolveModelAndEffort('triage', { 'plan-generate': { model: 'haiku' } })).toEqual(
      DEFAULT_MODEL_CONFIG.triage,
    );
  });

  it('applies a full override (both model and effort)', () => {
    expect(resolveModelAndEffort('triage', { triage: { model: 'sonnet', effort: 'max' } })).toEqual({
      model: 'sonnet',
      effort: 'max',
    });
  });

  it('applies a partial override, falling back to the default for the unset field', () => {
    expect(resolveModelAndEffort('triage', { triage: { model: 'sonnet' } })).toEqual({
      model: 'sonnet',
      effort: DEFAULT_MODEL_CONFIG.triage.effort,
    });
    expect(resolveModelAndEffort('triage', { triage: { effort: 'low' } })).toEqual({
      model: DEFAULT_MODEL_CONFIG.triage.model,
      effort: 'low',
    });
  });

  it('accepts an explicit opus or fable model override (manual-only tiers, no task defaults to them)', () => {
    expect(resolveModelAndEffort('plan-generate', { 'plan-generate': { model: 'opus' } })).toEqual({
      model: 'opus',
      effort: DEFAULT_MODEL_CONFIG['plan-generate'].effort,
    });
    expect(resolveModelAndEffort('codegen', { codegen: { model: 'fable', effort: 'xhigh' } })).toEqual({
      model: 'fable',
      effort: 'xhigh',
    });
  });

  it('every task type in DEFAULT_MODEL_CONFIG has a model and effort', () => {
    for (const task of Object.keys(DEFAULT_MODEL_CONFIG) as (keyof typeof DEFAULT_MODEL_CONFIG)[]) {
      expect(DEFAULT_MODEL_CONFIG[task].model).toBeTruthy();
      expect(DEFAULT_MODEL_CONFIG[task].effort).toBeTruthy();
    }
  });
});

describe('readModelConfigOverrides / writeModelConfigOverrides (best-effort persistence)', () => {
  let dataDir: string;
  let prevEnv: string | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'healix-model-config-test-'));
    prevEnv = process.env.HEALIX_DATA_DIR;
    process.env.HEALIX_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.HEALIX_DATA_DIR;
    else process.env.HEALIX_DATA_DIR = prevEnv;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('returns null when no config file has ever been written', async () => {
    expect(await readModelConfigOverrides()).toBeNull();
  });

  it('round-trips a written override', async () => {
    const overrides = { triage: { model: 'sonnet' as const } };
    await writeModelConfigOverrides(overrides);
    expect(await readModelConfigOverrides()).toEqual(overrides);
  });

  it('returns null (not throw) when the config file contains corrupt JSON', async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'model-config.json'), 'not valid json{{{', 'utf-8');
    expect(await readModelConfigOverrides()).toBeNull();
  });
});
