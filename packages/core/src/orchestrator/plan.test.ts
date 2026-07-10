import { describe, expect, it } from 'vitest';
import type { Project } from '../storage/types.js';
import { buildPlanPrompt, parsePlan, synthesizePlan } from './plan.js';

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

  it('clamps an unknown/hallucinated tier to tierA-public', () => {
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
});
