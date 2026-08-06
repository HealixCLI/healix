import { describe, expect, it } from 'vitest';
import type { Project } from '../storage/types.js';
import { tiersForScope } from '../modes/types.js';
import type { TestPlanItem } from '../modes/types.js';
import type { CompleteOptions, ProviderAdapter } from '../providers/types.js';
import {
  applyAuthGuardTierOverrides,
  buildBatchPlanPrompt,
  buildGapFillPlanPrompt,
  buildPlanPrompt,
  parsePlan,
  parsePlanWithDiagnostics,
  reviseItem,
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
    credentials: [],
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

  describe('bundled data-variant splitting (each example gets its own executed test)', () => {
    it("splits a description bundling multiple quoted examples into one scenario per example, since GENERATE only ever writes one test per scenario — otherwise only the model's single picked example ever runs, executes, or gets a recording", () => {
      const text = JSON.stringify({
        summary: 'Plan with a bundled negative scenario.',
        items: [
          {
            title: 'Email validation',
            tier: 'tierA-public',
            intent: 'Malformed emails are rejected.',
            scenarios: [
              {
                kind: 'negative',
                description: "Malformed email formats ('abc', 'abc@', 'abc@.com') show 'Invalid email' error",
              },
            ],
          },
        ],
      });

      const plan = parsePlan(text);
      expect(plan?.items[0]?.scenarios).toEqual([
        { kind: 'negative', description: "Malformed email formats 'abc' show 'Invalid email' error" },
        { kind: 'negative', description: "Malformed email formats 'abc@' show 'Invalid email' error" },
        { kind: 'negative', description: "Malformed email formats 'abc@.com' show 'Invalid email' error" },
      ]);
    });

    it('leaves an ordinary (non-bundled) description with a single quoted value untouched', () => {
      const text = JSON.stringify({
        summary: 'Plan with a normal scenario.',
        items: [
          {
            title: 'Login',
            tier: 'tierA-public',
            intent: 'User can sign in.',
            scenarios: [{ kind: 'positive', description: "Submitting 'valid@example.com' logs the user in" }],
          },
        ],
      });

      const plan = parsePlan(text);
      expect(plan?.items[0]?.scenarios).toEqual([
        { kind: 'positive', description: "Submitting 'valid@example.com' logs the user in" },
      ]);
    });

    it('does not split a pathologically large bundled list (over the cap) — left as one scenario rather than exploding into dozens of tests', () => {
      const many = Array.from({ length: 9 }, (_, i) => `'v${i}'`).join(', ');
      const bundled = `Many formats (${many}) are all rejected`;
      const text = JSON.stringify({
        summary: 'Plan with an oversized bundle.',
        items: [
          {
            title: 'Bulk validation',
            tier: 'tierA-public',
            intent: 'n/a',
            scenarios: [{ kind: 'negative', description: bundled }],
          },
        ],
      });

      const plan = parsePlan(text);
      expect(plan?.items[0]?.scenarios).toEqual([{ kind: 'negative', description: bundled }]);
    });

    it('splits a bundle using double-quoted (or mixed-quote) examples the same way', () => {
      const text = JSON.stringify({
        summary: 'Plan with double-quoted bundled examples.',
        items: [
          {
            title: 'Phone validation',
            tier: 'tierA-public',
            intent: 'n/a',
            scenarios: [
              { kind: 'negative', description: 'Invalid phone formats ("123", \'abc\') are rejected' },
            ],
          },
        ],
      });

      const plan = parsePlan(text);
      expect(plan?.items[0]?.scenarios).toEqual([
        { kind: 'negative', description: 'Invalid phone formats "123" are rejected' },
        { kind: 'negative', description: "Invalid phone formats 'abc' are rejected" },
      ]);
    });

    it('splits an UNQUOTED bundled list of numeric values (no quotes needed for a value list to count)', () => {
      const text = JSON.stringify({
        summary: 'Plan with an unquoted numeric bundle.',
        items: [
          {
            title: 'Age validation',
            tier: 'tierA-public',
            intent: 'n/a',
            scenarios: [{ kind: 'negative', description: 'Invalid ages (13, 15, 17) are rejected' }],
          },
        ],
      });

      const plan = parsePlan(text);
      expect(plan?.items[0]?.scenarios).toEqual([
        { kind: 'negative', description: 'Invalid ages 13 are rejected' },
        { kind: 'negative', description: 'Invalid ages 15 are rejected' },
        { kind: 'negative', description: 'Invalid ages 17 are rejected' },
      ]);
    });

    it('splits an unquoted bundle whose bare tokens contain symbols (still recognizably literal values, not prose)', () => {
      const text = JSON.stringify({
        summary: 'Plan with an unquoted symbol-bearing bundle.',
        items: [
          {
            title: 'Date validation',
            tier: 'tierA-public',
            intent: 'n/a',
            scenarios: [
              { kind: 'negative', description: 'Malformed dates (13/45/2020, 00/00/0000) show an error' },
            ],
          },
        ],
      });

      const plan = parsePlan(text);
      expect(plan?.items[0]?.scenarios).toEqual([
        { kind: 'negative', description: 'Malformed dates 13/45/2020 show an error' },
        { kind: 'negative', description: 'Malformed dates 00/00/0000 show an error' },
      ]);
    });

    it('does NOT split an ordinary parenthetical listing plain words (e.g. field names) — avoids corrupting prose unrelated to data variants', () => {
      const text = JSON.stringify({
        summary: 'Plan with an ordinary field-name aside.',
        items: [
          {
            title: 'Registration form',
            tier: 'tierA-public',
            intent: 'n/a',
            scenarios: [
              { kind: 'positive', description: 'All required fields (name, email, phone) are validated' },
            ],
          },
        ],
      });

      const plan = parsePlan(text);
      expect(plan?.items[0]?.scenarios).toEqual([
        { kind: 'positive', description: 'All required fields (name, email, phone) are validated' },
      ]);
    });

    it('does NOT split a bare list containing a multi-word item (not a flat value list)', () => {
      const text = JSON.stringify({
        summary: 'Plan with a multi-word parenthetical.',
        items: [
          {
            title: 'Browser support',
            tier: 'tierA-public',
            intent: 'n/a',
            scenarios: [
              {
                kind: 'positive',
                description: 'Works across browsers (Google Chrome, Mozilla Firefox) consistently',
              },
            ],
          },
        ],
      });

      const plan = parsePlan(text);
      expect(plan?.items[0]?.scenarios).toEqual([
        {
          kind: 'positive',
          description: 'Works across browsers (Google Chrome, Mozilla Firefox) consistently',
        },
      ]);
    });
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
    // The batch-position note must be appended AFTER buildPlanPrompt's static
    // preamble, not prepended before it — otherwise the preamble stops being
    // a stable, cacheable leading prefix shared across plan-generate/gap-fill/
    // batch calls (see orchestrator/plan.ts's buildScopedPlanPrompt).
    expect(prompt.startsWith('You are Healix, an autonomous QA engineer.')).toBe(true);
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

  it('warns against pairing tierC-api items with a route/component-kind unit when tierC-api is in scope', () => {
    const project = makeProject({ repoPath: '/repo/demo', baseUrl: null });
    const units: FunctionalityUnit[] = [
      { key: 'route:/', kind: 'route', label: 'page: /', file: 'src/routes/AppRouter.tsx' },
      {
        key: 'endpoint:GET /get-customers',
        kind: 'endpoint',
        label: 'GET /get-customers',
        file: 'src/server.ts',
      },
    ];
    const prompt = buildPlanPrompt(
      project,
      { projectId: project.id, testingScope: 'both' },
      { summary: 'Framework: next.', files: [], functionality: units },
    );

    expect(prompt).toContain('RULE for tierC-api items');
    expect(prompt).toContain('only pair a tierC-api item with a "[endpoint]"-kind unit');
  });

  it('omits the tierC-api route-pairing rule when tierC-api is out of scope', () => {
    const project = makeProject({ repoPath: '/repo/demo', baseUrl: null });
    const units: FunctionalityUnit[] = [
      { key: 'route:/checkout', kind: 'route', label: 'page: /checkout', file: 'app/checkout/page.tsx' },
    ];
    const prompt = buildPlanPrompt(
      project,
      { projectId: project.id, testingScope: 'frontend' },
      { summary: 'Framework: next.', files: [], functionality: units },
    );

    expect(prompt).not.toContain('RULE for tierC-api items');
  });

  it('annotates a unit carrying a detected route-guard, and adds the tierB-auth guidance line', () => {
    const project = makeProject({ repoPath: '/repo/demo', baseUrl: null });
    const units: FunctionalityUnit[] = [
      {
        key: 'route:/dashboard/unsubscribepage',
        kind: 'route',
        label: 'route: /dashboard/unsubscribepage',
        file: 'src/routes/AppRoutes.tsx',
        authGuardName: 'ProtectedRoute',
      },
      { key: 'route:/login', kind: 'route', label: 'route: /login', file: 'src/routes/AppRoutes.tsx' },
    ];
    const prompt = buildPlanPrompt(
      project,
      { projectId: project.id, testingScope: 'both' },
      { summary: 'Framework: react.', files: [], functionality: units },
    );

    expect(prompt).toContain(
      '[route] route: /dashboard/unsubscribepage (unitKey: "route:/dashboard/unsubscribepage") [route-guard detected: ProtectedRoute — MUST be tierB-auth]',
    );
    expect(prompt).toContain('[route] route: /login (unitKey: "route:/login")\n');
    expect(prompt).toContain('MUST be planned as tierB-auth, never');
  });

  it('omits the route-guard guidance line when no unit carries a detected guard', () => {
    const project = makeProject({ repoPath: '/repo/demo', baseUrl: null });
    const units: FunctionalityUnit[] = [
      { key: 'route:/login', kind: 'route', label: 'route: /login', file: 'src/routes/AppRoutes.tsx' },
    ];
    const prompt = buildPlanPrompt(
      project,
      { projectId: project.id, testingScope: 'both' },
      { summary: 'Framework: react.', files: [], functionality: units },
    );
    expect(prompt).not.toContain('route-guard detected');
    expect(prompt).not.toContain('MUST be planned as tierB-auth');
  });
});

describe('applyAuthGuardTierOverrides (Cluster C)', () => {
  const guardedUnit: FunctionalityUnit = {
    key: 'route:/dashboard/unsubscribepage',
    kind: 'route',
    label: 'route: /dashboard/unsubscribepage',
    file: 'src/routes/AppRoutes.tsx',
    authGuardName: 'ProtectedRoute',
  };
  const unguardedUnit: FunctionalityUnit = {
    key: 'route:/login',
    kind: 'route',
    label: 'route: /login',
    file: 'src/routes/AppRoutes.tsx',
  };

  function makeItem(overrides: Partial<TestPlanItem> = {}): TestPlanItem {
    return {
      id: 'pli_test',
      title: 'Test item',
      tier: 'tierA-public',
      intent: 'test',
      scenarios: [{ kind: 'positive', description: 'test' }],
      ...overrides,
    };
  }

  it('corrects a wrongly-tiered item whose unit is guarded, recording tierOverride', () => {
    const item = makeItem({ tier: 'tierA-public', unitKey: guardedUnit.key });
    const [corrected] = applyAuthGuardTierOverrides([item], [guardedUnit], 'both');
    expect(corrected!.tier).toBe('tierB-auth');
    expect(corrected!.tierOverride).toEqual({
      from: 'tierA-public',
      to: 'tierB-auth',
      reason: expect.stringContaining('ProtectedRoute'),
    });
    // Original item must not be mutated.
    expect(item.tier).toBe('tierA-public');
    expect(item.tierOverride).toBeUndefined();
  });

  it('leaves an already-tierB-auth item for a guarded unit untouched (no spurious tierOverride)', () => {
    const item = makeItem({ tier: 'tierB-auth', unitKey: guardedUnit.key });
    const [result] = applyAuthGuardTierOverrides([item], [guardedUnit], 'both');
    expect(result).toBe(item);
    expect(result!.tierOverride).toBeUndefined();
  });

  it('leaves an item with no unitKey untouched', () => {
    const item = makeItem({ tier: 'tierA-public' });
    const [result] = applyAuthGuardTierOverrides([item], [guardedUnit], 'both');
    expect(result).toBe(item);
  });

  it('leaves an item whose unitKey does not match any guarded unit untouched', () => {
    const item = makeItem({ tier: 'tierA-public', unitKey: unguardedUnit.key });
    const [result] = applyAuthGuardTierOverrides([item], [guardedUnit, unguardedUnit], 'both');
    expect(result).toBe(item);
  });

  it('is a no-op when tierB-auth is out of scope (e.g. backend-only)', () => {
    const item = makeItem({ tier: 'tierC-api', unitKey: guardedUnit.key });
    const result = applyAuthGuardTierOverrides([item], [guardedUnit], 'backend');
    expect(result).toEqual([item]);
    expect(result[0]!.tierOverride).toBeUndefined();
  });

  it('is a no-op when no unit in the index is guarded (returns the same array reference)', () => {
    const items = [makeItem({ tier: 'tierA-public', unitKey: unguardedUnit.key })];
    const result = applyAuthGuardTierOverrides(items, [unguardedUnit], 'both');
    expect(result).toBe(items);
  });
});

describe('buildPlanPrompt (PRD + interactive instructions)', () => {
  it('omits both the PRD and instructions sections when neither is provided', () => {
    const prompt = buildPlanPrompt(makeProject(), { projectId: 'prj_test' });
    expect(prompt).not.toContain('PRD / acceptance criteria');
    expect(prompt).not.toContain('Additional instructions from the user');
  });

  it('includes the PRD text verbatim when provided', () => {
    const prompt = buildPlanPrompt(makeProject(), {
      projectId: 'prj_test',
      prd: 'Users must be able to reset their password via email.',
    });
    expect(prompt).toContain('PRD / acceptance criteria to ground the plan:');
    expect(prompt).toContain('Users must be able to reset their password via email.');
  });

  it("includes the user's additional instructions verbatim, separate from the PRD section", () => {
    const prompt = buildPlanPrompt(makeProject(), {
      projectId: 'prj_test',
      instructions: 'Focus on accessibility; prefer data-testid selectors; skip mobile viewports.',
    });
    expect(prompt).toContain('Additional instructions from the user');
    expect(prompt).toContain('Focus on accessibility; prefer data-testid selectors; skip mobile viewports.');
  });

  it('includes both PRD and instructions together when both are provided', () => {
    const prompt = buildPlanPrompt(makeProject(), {
      projectId: 'prj_test',
      prd: 'Checkout must support three payment methods.',
      instructions: 'Only plan tierA-public scenarios for now.',
    });
    expect(prompt).toContain('Checkout must support three payment methods.');
    expect(prompt).toContain('Only plan tierA-public scenarios for now.');
  });

  it('ignores whitespace-only instructions (same as whitespace-only PRD)', () => {
    const prompt = buildPlanPrompt(makeProject(), { projectId: 'prj_test', instructions: '   \n  ' });
    expect(prompt).not.toContain('Additional instructions from the user');
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
    // The "previous pass" note must be appended AFTER buildPlanPrompt's static
    // preamble, not prepended before it — see the batch-prompt test above.
    expect(prompt.startsWith('You are Healix, an autonomous QA engineer.')).toBe(true);
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

describe('reviseItem — provider call wiring', () => {
  const ITEM: TestPlanItem = {
    id: 'pli_1',
    title: 'Home loads',
    reqTag: 'REQ-001',
    tier: 'tierA-public',
    intent: 'Landing renders.',
    scenarios: [{ kind: 'positive', description: 'Home page loads successfully.' }],
  };

  function fakeProvider(onComplete: (opts: CompleteOptions | undefined) => void): ProviderAdapter {
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
      async complete(_prompt, opts) {
        onComplete(opts);
        // A parse failure here is fine — this test only cares about how
        // reviseItem calls the provider, not the revision's own outcome.
        return { provider: 'claude', ok: false, text: '', raw: null, detail: 'unused' };
      },
    };
  }

  it('requests taskType "plan-revise-item" (per-task-type model/effort routing)', async () => {
    let seenOpts: CompleteOptions | undefined;
    const provider = fakeProvider((opts) => {
      seenOpts = opts;
    });

    await reviseItem(provider, makeProject(), { projectId: 'prj_test' }, ITEM, 'Also check the footer.');

    expect(seenOpts?.taskType).toBe('plan-revise-item');
    expect(seenOpts?.mode).toBe('plan');
  });
});
