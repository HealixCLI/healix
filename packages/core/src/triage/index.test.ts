/**
 * Unit tests for createTriageEngine().analyze — specifically that the
 * optional `signal` param is forwarded into provider.complete()'s options
 * unchanged. This is the wiring that lets the orchestrator's per-call timeout
 * actually kill the underlying CLI child process instead of abandoning it to
 * run in the background after triage has moved on (see orchestrator/index.ts
 * withTimeoutAbort).
 */
import { describe, expect, it } from 'vitest';
import type { CompleteOptions, CompletionResult, ProviderAdapter } from '../providers/types.js';
import { createTriageEngine } from './index.js';
import type { TriageInput } from './types.js';

function fakeProvider(complete: ProviderAdapter['complete']): ProviderAdapter {
  return {
    id: 'claude',
    label: 'fake',
    capabilities: ['plan'],
    async detect() {
      return { installed: true, binPath: '/fake', version: '0.0.0' };
    },
    async health() {
      return {
        provider: 'claude',
        status: 'ready',
        installed: true,
        binPath: '/fake',
        version: '0.0.0',
        authenticated: true,
        model: null,
        latencyMs: null,
        detail: '',
      };
    },
    async plan() {
      return { provider: 'claude', ok: true, plan: '', raw: null, detail: '' };
    },
    complete,
  };
}

const INPUT: TriageInput = { title: 'Home page loads', error: 'expect(locator).toBeVisible() failed' };

describe('createTriageEngine().analyze — signal forwarding', () => {
  it('forwards the caller-provided signal into provider.complete() unchanged', async () => {
    let seenOpts: CompleteOptions | undefined;
    const provider = fakeProvider(async (_prompt, opts) => {
      seenOpts = opts;
      return { provider: 'claude', ok: true, text: '', raw: null, detail: '' } satisfies CompletionResult;
    });
    const controller = new AbortController();

    await createTriageEngine().analyze(INPUT, provider, controller.signal);

    expect(seenOpts?.signal).toBe(controller.signal);
  });

  it('works with no signal at all (orchestrator call sites that opt out)', async () => {
    let seenOpts: CompleteOptions | undefined;
    const provider = fakeProvider(async (_prompt, opts) => {
      seenOpts = opts;
      return { provider: 'claude', ok: true, text: '', raw: null, detail: '' } satisfies CompletionResult;
    });

    await createTriageEngine().analyze(INPUT, provider);

    expect(seenOpts?.signal).toBeUndefined();
  });

  it('falls back to the deterministic baseline when the provider call is aborted', async () => {
    const provider = fakeProvider(async (_prompt, opts) => {
      // Simulate runCli's abort contract: resolves (never rejects) with ok:false.
      if (opts?.signal?.aborted) {
        return { provider: 'claude', ok: false, text: '', raw: null, detail: 'Completion aborted.' };
      }
      return { provider: 'claude', ok: true, text: '', raw: null, detail: '' };
    });
    const controller = new AbortController();
    controller.abort();

    const result = await createTriageEngine().analyze(INPUT, provider, controller.signal);

    // classifyByRules() always returns a verdict — this proves analyze() never
    // throws/leaks on an aborted call, it degrades to the rule-based baseline.
    expect(result.verdict).toBeDefined();
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });
});
