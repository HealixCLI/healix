import { describe, expect, it } from 'vitest';
import type { Project } from '../storage/types.js';
import { tiersForScope } from '../modes/types.js';
import {
  buildBatchPlanPrompt,
  buildGapFillPlanPrompt,
  buildPlanPrompt,
  parsePlan,
  parsePlanWithDiagnostics,
  synthesizePlan,
} from './plan.js';
import type { FunctionalityUnit } from '../target/functionality-index.js';

/** Minimal black-box project fixture (baseUrl set so synthesize yields URL-flavoured items). */
function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'prj_test',
    name: 'Demo',
    mode: 'playwright',
    repoPath: null,
    baseUrl: 'https://example.test',
    createdAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
    testUsername: null,
    testPassword: null,
    ...overrides,
  };
}

describe('parsePlan', () => {
  it('parses a fenced ```json code block', () => {
    const text = [
      'Here is the plan you asked for:',
      '```json',
      JSON.stringify({
        summary: 'Cover the public landing flows.',
        items: [
          { title: 'Home loads', reqTag: 'REQ-001', tier: 'tierA-public', intent: 'Landing renders.' },
          { title: 'Login works', reqTag: 'REQ-002', tier: 'tierB-auth', intent: 'User can sign in.' },
        ],
      }),
      '```',
      'Let me know if you want changes.',
    ].join('\n');

    const plan = parsePlan(text);
    expect(plan).not.toBeNull();
    expect(plan?.summary).toBe('Cover the public landing flows.');
    expect(plan?.items).toHaveLength(2);
    expect(plan?.items[0]).toMatchObject({
      title: 'Home loads',
      reqTag: 'REQ-001',
      tier: 'tierA-public',
      intent: 'Landing renders.',
    });
    // Every item gets a generated id.
    expect(plan?.items[0]?.id).toMatch(/^pli_/);
    expect(plan?.items[1]?.tier).toBe('tierB-auth');
  });

  it('parses a bare JSON object with no fences', () => {
    const text = JSON.stringify({
      summary: 'Bare object plan.',
      items: [{ title: 'Smoke', tier: 'tierC-api', intent: 'API responds.' }],
    });

    const plan = parsePlan(text);
    expect(plan).not.toBeNull();
    expect(plan?.summary).toBe('Bare object plan.');
    expect(plan?.items).toHaveLength(1);
    expect(plan?.items[0]?.tier).toBe('tierC-api');
    // reqTag absent in source must not appear on the normalized item.
    expect(plan?.items[0]?.reqTag).toBeUndefined();
  });

  it('clamps an unknown/hallucinated tier to tierA-public (default "both" scope)', () => {
    const text = [
      '```json',
      JSON.stringify({
        summary: 'Plan with a bogus tier.',
        items: [{ title: 'Weird tier', tier: 'tierZ-quantum', intent: 'Should be clamped.' }],
      }),
      '```',
    ].join('\n');

    const plan = parsePlan(text);
    expect(plan).not.toBeNull();
    expect(plan?.items[0]?.tier).toBe('tierA-public');
  });

  it('clamps to the first in-scope tier for a restricted scope, not tierA-public unconditionally', () => {
    const text = JSON.stringify({
      summary: 'Backend-only plan with a bogus tier.',
      items: [{ title: 'Weird tier', tier: 'tierZ-quantum', intent: 'Should clamp within scope.' }],
    });

    const plan = parsePlan(text, 'backend');
    expect(plan?.items[0]?.tier).toBe('tierC-api');
  });

  it('preserves a recognized-but-out-of-scope tier as-is (the orchestrator filters it, not this)', () => {
    // A real tier name that's outside the requested scope must NOT be
    // coerced into scope here — the orchestrator applies the actual scope
    // boundary as a filter right after planning, and that filter needs the
    // item's real tier to drop it correctly. Clamping it here would make
    // every item look "in scope" by the time the filter runs, defeating it.
    const text = JSON.stringify({
      summary: 'Frontend-only plan with an out-of-scope API item.',
      items: [{ title: 'API check', tier: 'tierC-api', intent: 'A real (but out-of-scope) tier.' }],
    });

    const plan = parsePlan(text, 'frontend');
    expect(plan?.items[0]?.tier).toBe('tierC-api');
    expect(tiersForScope('frontend')).not.toContain(plan?.items[0]?.tier);
  });

  it('keeps an in-scope tier as-is', () => {
    const text = JSON.stringify({
      summary: 'Backend-only plan.',
      items: [{ title: 'API check', tier: 'tierC-api', intent: 'A real API test.' }],
    });

    const plan = parsePlan(text, 'backend');
    expect(plan?.items[0]?.tier).toBe('tierC-api');
  });

  it('falls back to a default summary when summary is missing', () => {
    const text = JSON.stringify({
      items: [{ title: 'No summary', tier: 'tierA-public', intent: 'Still parses.' }],
    });

    const plan = parsePlan(text);
    expect(plan).not.toBeNull();
    expect(plan?.summary).toBe('Generated test plan.');
  });

  it('returns null for malformed / unusable model output', () => {
    expect(parsePlan('I could not produce a plan, sorry.')).toBeNull();
    expect(parsePlan('```json\n{ not valid json ]\n```')).toBeNull();
    // Valid JSON but zero usable items (no titles) is also unusable.
    expect(parsePlan(JSON.stringify({ summary: 'empty', items: [{ tier: 'tierA-public' }] }))).toBeNull();
    expect(parsePlan('')).toBeNull();
  });

  it('parses a scenarios array with positive/negative/edge kinds and a unitKey', () => {
    const text = JSON.stringify({
      summary: 'Plan with scenarios.',
      items: [
        {
          title: 'Checkout',
          reqTag: 'REQ-010',
          tier: 'tierA-public',
          intent: 'Checkout flow works.',
          unitKey: 'route:/checkout',
          scenarios: [
            { kind: 'positive', description: 'completes with valid card' },
            { kind: 'negative', description: 'rejects an expired card' },
            { kind: 'edge', description: 'handles a zero-total cart' },
          ],
        },
      ],
    });

    const plan = parsePlan(text);
    expect(plan?.items[0]?.unitKey).toBe('route:/checkout');
    expect(plan?.items[0]?.scenarios).toEqual([
      { kind: 'positive', description: 'completes with valid card' },
      { kind: 'negative', description: 'rejects an expired card' },
      { kind: 'edge', description: 'handles a zero-total cart' },
    ]);
  });

  it('coerces an unknown scenario kind to positive and drops scenarios with no description', () => {
    const text = JSON.stringify({
      summary: 'Plan with a bogus scenario kind.',
      items: [
        {
          title: 'Weird scenario',
          tier: 'tierA-public',
          intent: 'Should still parse.',
          scenarios: [
            { kind: 'catastrophic', description: 'treated as positive' },
            { kind: 'negative', description: '' },
          ],
        },
      ],
    });

    const plan = parsePlan(text);
    expect(plan?.items[0]?.scenarios).toEqual([{ kind: 'positive', description: 'treated as positive' }]);
  });

  it('falls back to a single positive scenario derived from intent when scenarios is missing/malformed', () => {
    const text = JSON.stringify({
      summary: 'Plan with no scenarios field.',
      items: [{ title: 'Legacy item', tier: 'tierA-public', intent: 'Still works without scenarios.' }],
    });

    const plan = parsePlan(text);
    expect(plan?.items[0]?.scenarios).toEqual([
      { kind: 'positive', description: 'Still works without scenarios.' },
    ]);
  });
});

describe('parsePlanWithDiagnostics', () => {
  it('classifies a response cut off mid-fence (no closing fence at all) as truncated', () => {
    // The model's output stopped generating before it ever emitted a closing
    // ``` fence — the classic output-length/token-limit cutoff signature.
    const text = '```json\n{\n  "summary": "A big plan",\n  "items": [\n    { "title": "First item"';
    const result = parsePlanWithDiagnostics(text);
    expect(result.plan).toBeNull();
    expect(result.failureReason).toBe('truncated');
  });

  it('classifies a closed fence with an unbalanced object body as truncated', () => {
    // Fence closes, but the JSON body itself never balances its braces —
    // structurally indistinguishable from truncation, so treated the same
    // (worth one retry) rather than as a hard parse failure.
    const result = parsePlanWithDiagnostics('```json\n{ "summary": "x", "items": [ ]\n```');
    expect(result.plan).toBeNull();
    expect(result.failureReason).toBe('truncated');
  });

  it('classifies prose with no JSON object at all as no-json (not truncated)', () => {
    const result = parsePlanWithDiagnostics('I could not produce a plan, sorry.');
    expect(result.plan).toBeNull();
    expect(result.failureReason).toBe('no-json');
  });

  it('classifies an empty response as no-json', () => {
    const result = parsePlanWithDiagnostics('');
    expect(result.plan).toBeNull();
    expect(result.failureReason).toBe('no-json');
  });

  it('classifies a complete but syntactically invalid JSON object as invalid-json', () => {
    // Balanced braces (so not truncated), but the content between them isn't
    // valid JSON syntax.
    const result = parsePlanWithDiagnostics('```json\n{ "items": [1, 2,] }\n```');
    expect(result.plan).toBeNull();
    expect(result.failureReason).toBe('invalid-json');
  });

  it('classifies valid JSON with zero usable items as no-items', () => {
    const result = parsePlanWithDiagnostics(
      JSON.stringify({ summary: 'empty', items: [{ tier: 'tierA-public' }] }),
    );
    expect(result.plan).toBeNull();
    expect(result.failureReason).toBe('no-items');
  });

  it('returns the parsed plan with no failureReason on success', () => {
    const text = JSON.stringify({
      summary: 'A fine plan.',
      items: [{ title: 'Works', tier: 'tierA-public', intent: 'It works.' }],
    });
    const result = parsePlanWithDiagnostics(text);
    expect(result.plan).not.toBeNull();
    expect(result.failureReason).toBeUndefined();
  });

  it('parsePlan stays a thin wrapper returning only the plan (or null)', () => {
    expect(parsePlan('no json here')).toBeNull();
    expect(
      parsePlan(JSON.stringify({ items: [{ title: 'X', tier: 'tierA-public', intent: 'x' }] })),
    ).not.toBeNull();
  });
});

describe('buildBatchPlanPrompt', () => {
  it('scopes the prompt to only the given batch units and notes the batch position when there are multiple batches', () => {
    const project = makeProject({ repoPath: '/repo/demo', baseUrl: null });
    const batchUnits: FunctionalityUnit[] = [
      { key: 'route:/checkout', kind: 'route', label: 'page: /checkout', file: 'app/checkout/page.tsx' },
    ];
    const prompt = buildBatchPlanPrompt(project, { projectId: project.id }, batchUnits, 2, 5, {
      summary: 'Framework: next.',
      files: [],
      functionality: [
        { key: 'route:/other', kind: 'route', label: 'page: /other', file: 'app/other/page.tsx' },
        ...batchUnits,
      ],
    });

    expect(prompt).toContain('batch 2 of 5');
    expect(prompt).toContain('route:/checkout');
    // Only this batch's unit is listed, not the other detected unit.
    expect(prompt).not.toContain('route:/other');
  });

  it('omits the batch-position prefix entirely when there is only one batch', () => {
    const project = makeProject({ repoPath: '/repo/demo', baseUrl: null });
    const batchUnits: FunctionalityUnit[] = [
      { key: 'route:/checkout', kind: 'route', label: 'page: /checkout', file: 'app/checkout/page.tsx' },
    ];
    const prompt = buildBatchPlanPrompt(project, { projectId: project.id }, batchUnits, 1, 1, {
      summary: '',
      files: [],
      functionality: batchUnits,
    });

    expect(prompt).not.toContain('batch 1 of 1');
    expect(prompt).not.toContain('more detected functionality');
  });
});

describe('synthesizePlan', () => {
  it('synthesizes a minimal plan when the model produced nothing usable', () => {
    // Simulate the orchestrator fallback: malformed text -> parsePlan null -> synthesize.
    const malformed = 'no json here at all';
    const project = makeProject();
    const plan = parsePlan(malformed) ?? synthesizePlan(project);

    expect(plan.items.length).toBeGreaterThan(0);
    // Every synthesized item carries a known tier (clamped by construction).
    for (const item of plan.items) {
      expect(['tierA-public', 'tierB-auth', 'tierC-api']).toContain(item.tier);
      expect(item.id).toMatch(/^pli_/);
      expect(item.title.length).toBeGreaterThan(0);
    }
    expect(plan.summary).toContain('https://example.test');
  });

  it('synthesizes a no-baseUrl smoke plan', () => {
    const plan = synthesizePlan(makeProject({ baseUrl: null }));
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.tier).toBe('tierA-public');
  });

  it('falls back to a tierC-api item for a backend-only scope instead of tierA-public', () => {
    // A tierA-public fallback would be filtered out entirely by the caller's
    // scope filter, leaving an empty plan — must synthesize something in scope.
    const plan = synthesizePlan(makeProject(), 'backend');
    expect(plan.items.length).toBeGreaterThan(0);
    for (const item of plan.items) expect(item.tier).toBe('tierC-api');
  });

  it('keeps the tierA-public fallback for frontend and both scopes', () => {
    expect(synthesizePlan(makeProject(), 'frontend').items[0]?.tier).toBe('tierA-public');
    expect(synthesizePlan(makeProject(), 'both').items[0]?.tier).toBe('tierA-public');
  });
});

describe('buildPlanPrompt (repo context)', () => {
  it('omits the repo-context section when no repoIndex is provided', () => {
    const prompt = buildPlanPrompt(makeProject(), { projectId: 'prj_test' });
    expect(prompt).not.toContain('Repository context');
    // The core instructions are still present.
    expect(prompt).toContain('fenced JSON code block');
  });

  it('appends the summary and file paths when a repoIndex is provided', () => {
    const project = makeProject({ repoPath: '/repo/demo', baseUrl: null });
    const prompt = buildPlanPrompt(
      project,
      { projectId: project.id },
      {
        summary: 'Framework: next. Key directories: app, components.',
        files: ['app/page.tsx', 'app/login/page.tsx'],
      },
    );

    expect(prompt).toContain('Repository context (indexed):');
    expect(prompt).toContain('Framework: next. Key directories: app, components.');
    expect(prompt).toContain('- app/page.tsx');
    expect(prompt).toContain('- app/login/page.tsx');
    // Nothing was truncated, so no "more file(s)" trailer appears.
    expect(prompt).not.toContain('more file(s) not listed');
  });

  it('bounds the file list at 80 paths and notes how many were omitted', () => {
    const project = makeProject({ repoPath: '/repo/demo', baseUrl: null });
    const files = Array.from({ length: 100 }, (_, i) => `src/file-${String(i).padStart(3, '0')}.ts`);
    const prompt = buildPlanPrompt(
      project,
      { projectId: project.id },
      { summary: '100 files indexed.', files },
    );

    // First 80 are present, the 81st is not, and the omission is called out.
    expect(prompt).toContain('- src/file-000.ts');
    expect(prompt).toContain('- src/file-079.ts');
    expect(prompt).not.toContain('src/file-080.ts');
    expect(prompt).toContain('... and 20 more file(s) not listed.');
  });

  it('does not cap scenario count at "3-8" — the old ceiling is gone', () => {
    const prompt = buildPlanPrompt(makeProject(), { projectId: 'prj_test' });
    expect(prompt).not.toContain('3-8');
    expect(prompt).not.toMatch(/prefer\s+\d+-\d+/i);
  });

  it('lists detected functionality units and instructs one item per unit', () => {
    const project = makeProject({ repoPath: '/repo/demo', baseUrl: null });
    const units: FunctionalityUnit[] = [
      { key: 'route:/checkout', kind: 'route', label: 'page: /checkout', file: 'app/checkout/page.tsx' },
      { key: 'endpoint:GET /health', kind: 'endpoint', label: 'GET /health', file: 'src/server.ts' },
    ];
    const prompt = buildPlanPrompt(
      project,
      { projectId: project.id },
      { summary: 'Framework: next.', files: [], functionality: units },
    );

    expect(prompt).toContain('Detected routes/endpoints');
    expect(prompt).toContain('[route] page: /checkout (unitKey: "route:/checkout")');
    expect(prompt).toContain('[endpoint] GET /health (unitKey: "endpoint:GET /health")');
    expect(prompt).toContain('one item per distinct route/endpoint');
    expect(prompt).toContain('"unitKey"');
  });
});

describe('buildGapFillPlanPrompt', () => {
  it('scopes the prompt to only the given uncovered units and notes prior coverage', () => {
    const project = makeProject({ repoPath: '/repo/demo', baseUrl: null });
    const uncovered: FunctionalityUnit[] = [
      { key: 'route:/settings', kind: 'route', label: 'page: /settings', file: 'app/settings/page.tsx' },
    ];
    const prompt = buildGapFillPlanPrompt(project, { projectId: project.id }, uncovered, {
      summary: 'Framework: next.',
      files: ['app/checkout/page.tsx', 'app/settings/page.tsx'],
      functionality: [
        { key: 'route:/checkout', kind: 'route', label: 'page: /checkout', file: 'app/checkout/page.tsx' },
        ...uncovered,
      ],
    });

    expect(prompt).toContain('already planned and tested other parts');
    expect(prompt).toContain('route:/settings');
    // Only the uncovered unit is listed, not the already-covered one.
    expect(prompt).not.toContain('route:/checkout');
  });
});

describe('buildPlanPrompt (testing scope)', () => {
  it('defaults to "both" and lists all three tiers when no scope is given', () => {
    const prompt = buildPlanPrompt(makeProject(), { projectId: 'prj_test' });
    expect(prompt).toContain('"tierA-public" | "tierB-auth" | "tierC-api"');
    expect(prompt).toContain('tierA-public for unauthenticated flows');
    expect(prompt).toContain('tierB-auth for authenticated flows');
    expect(prompt).toContain('tierC-api for API-level checks');
  });

  it('restricts the tier enum and guidance to frontend tiers only', () => {
    const prompt = buildPlanPrompt(makeProject(), { projectId: 'prj_test', testingScope: 'frontend' });
    expect(prompt).toContain('"tierA-public" | "tierB-auth"');
    expect(prompt).not.toContain('tierC-api');
    expect(prompt).toContain('tierA-public for unauthenticated flows');
    expect(prompt).toContain('tierB-auth for authenticated flows');
  });

  it('restricts the tier enum and guidance to tierC-api only for backend', () => {
    const prompt = buildPlanPrompt(makeProject(), { projectId: 'prj_test', testingScope: 'backend' });
    expect(prompt).toContain('"tierC-api"');
    expect(prompt).not.toContain('tierA-public');
    expect(prompt).not.toContain('tierB-auth');
    expect(prompt).toContain('tierC-api for API-level checks');
  });

  it('names the selected scope in the prompt', () => {
    expect(buildPlanPrompt(makeProject(), { projectId: 'p', testingScope: 'frontend' })).toContain(
      'Testing scope: Frontend testing',
    );
    expect(buildPlanPrompt(makeProject(), { projectId: 'p', testingScope: 'backend' })).toContain(
      'Testing scope: Backend testing',
    );
    expect(buildPlanPrompt(makeProject(), { projectId: 'p', testingScope: 'both' })).toContain(
      'Testing scope: Frontend + backend testing',
    );
  });
});
