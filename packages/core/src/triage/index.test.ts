/**
 * Unit tests for createTriageEngine().analyze — specifically that the
 * optional `signal` param is forwarded into provider.complete()'s options
 * unchanged. This is the wiring that lets the orchestrator's per-call timeout
 * actually kill the underlying CLI child process instead of abandoning it to
 * run in the background after triage has moved on (see orchestrator/index.ts
 * withTimeoutAbort).
 */
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CompleteOptions, CompletionResult, ProviderAdapter } from '../providers/types.js';
import { indexSource } from '../target/source-index.js';
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
    // Lets the provider resolve a per-task-type model/effort (see model-config.ts).
    expect(seenOpts?.taskType).toBe('triage');
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

// --- Isolated check against a real fixture repo (Item E4) -------------------
// Simulates a failing test mapped to a real RBAC source-context unit (the same shape the
// orchestrator builds — see orchestrator/index.ts's TRIAGE phase) and confirms analyze()'s
// prompt cites that real file's actual content.

describe('createTriageEngine().analyze — grounded with a real matched source file (isolated check)', () => {
  const RBAC_ROOT = path.join(
    'C:',
    'Users',
    'AdroyFernandes',
    'Documents',
    'TestApps',
    'Role-Based-Access-Control-RBAC-',
  );

  it.skipIf(!fs.existsSync(RBAC_ROOT))(
    "includes the real matched file's content in the prompt sent to the provider",
    async () => {
      const sourceContext = await indexSource(RBAC_ROOT, { maxUnits: 500 });
      const unit = sourceContext.units.find((u) => u.key === 'endpoint:GET /api/users/:id');
      expect(unit).toBeDefined();

      const sourceExcerpt = await readFile(path.join(RBAC_ROOT, unit!.file), 'utf-8');

      let capturedPrompt = '';
      const provider = fakeProvider(async (prompt) => {
        capturedPrompt = prompt;
        return { provider: 'claude', ok: true, text: '', raw: null, detail: '' };
      });

      const input: TriageInput = {
        title: 'GET /api/users/:id returns the user',
        error: 'expected 200, got 500',
        sourceFile: unit!.file,
        sourceExcerpt,
      };
      await createTriageEngine().analyze(input, provider);

      expect(capturedPrompt).toContain(`--- MATCHED SOURCE FILE: ${unit!.file} ---`);
      // Real content from the top of the actual file (the route handlers themselves are further
      // down, past commented Swagger docs, and may fall outside the prompt's truncation cap).
      expect(capturedPrompt).toContain('userController');
    },
  );
});
