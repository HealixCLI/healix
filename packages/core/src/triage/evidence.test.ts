import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type HealixStore, getStore, resetStoreForTests } from '../index.js';
import {
  buildExecutionEvidence,
  buildExplorationContext,
  buildKbTriageEvidence,
  buildMockEvidence,
  buildRequirementContext,
  loadKbRunContext,
} from './evidence.js';

/**
 * Hermetic store-backed tests for triage's KB-evidence builders — same
 * pattern as storage/store.test.ts (throwaway SQLite DB per test).
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'healix-triage-evidence-test-'));
  process.env.HEALIX_DATA_DIR = dataDir;
  resetStoreForTests();
});

afterEach(() => {
  resetStoreForTests();
  delete process.env.HEALIX_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

async function store(): Promise<HealixStore> {
  const s = await getStore();
  expect(s, 'getStore() returned null — node:sqlite unavailable in this runtime').not.toBeNull();
  return s as HealixStore;
}

describe('buildRequirementContext', () => {
  it('includes tag + description when a requirement matches the reqTag', async () => {
    const s = await store();
    const project = s.createProject({ name: 'ev-req-project', baseUrl: 'https://ev-req.test' });
    const run = s.createRun(project.id);
    s.seedRequirement(run.id, 'REQ-1', 'Login UI flow');

    const ctx = loadKbRunContext(s, run.id);
    expect(buildRequirementContext(ctx, 'REQ-1')).toEqual({ tag: 'REQ-1', description: 'Login UI flow' });
  });

  it('omits description when the requirement has none', async () => {
    const s = await store();
    const project = s.createProject({ name: 'ev-req-nodesc-project', baseUrl: 'https://ev-req-nodesc.test' });
    const run = s.createRun(project.id);
    s.seedRequirement(run.id, 'REQ-1', null);

    const ctx = loadKbRunContext(s, run.id);
    expect(buildRequirementContext(ctx, 'REQ-1')).toEqual({ tag: 'REQ-1' });
  });

  it('is undefined when reqTag is absent or matches no requirement', async () => {
    const s = await store();
    const project = s.createProject({ name: 'ev-req-none-project', baseUrl: 'https://ev-req-none.test' });
    const run = s.createRun(project.id);
    s.seedRequirement(run.id, 'REQ-1', 'Login UI flow');

    const ctx = loadKbRunContext(s, run.id);
    expect(buildRequirementContext(ctx, undefined)).toBeUndefined();
    expect(buildRequirementContext(ctx, null)).toBeUndefined();
    expect(buildRequirementContext(ctx, 'REQ-UNKNOWN')).toBeUndefined();
  });
});

describe('buildMockEvidence', () => {
  it('joins test_mock_usage -> mock_responses into full, structured entries', async () => {
    const s = await store();
    const project = s.createProject({ name: 'ev-mock-project', baseUrl: 'https://ev-mock.test' });
    const run = s.createRun(project.id);
    const test = s.insertTest({
      runId: run.id,
      title: 'logs in',
      reqTag: null,
      tier: 'tierA-public',
      status: 'pending',
    });
    const mockId = s.upsertMockResponse({
      runId: run.id,
      dependencyId: 'dep_1',
      category: 'auth',
      method: 'POST',
      pathPattern: '/api/login',
      mockStrategy: 'route-intercept',
      mockStatus: 200,
      mockBodyJson: JSON.stringify({ message: 'Login successful' }),
      mockHeadersJson: null,
    });
    s.recordMockUsage(test.id, mockId, 3);

    const ctx = loadKbRunContext(s, run.id);
    expect(buildMockEvidence(s, ctx, test.id)).toEqual([
      {
        category: 'auth',
        method: 'POST',
        pathPattern: '/api/login',
        mockStatus: 200,
        mockBody: JSON.stringify({ message: 'Login successful' }),
        observedStatus: null,
        observedBody: null,
      },
    ]);
  });

  it('is undefined when the test has no test_mock_usage rows', async () => {
    const s = await store();
    const project = s.createProject({ name: 'ev-mock-none-project', baseUrl: 'https://ev-mock-none.test' });
    const run = s.createRun(project.id);
    const test = s.insertTest({
      runId: run.id,
      title: 'unrelated',
      reqTag: null,
      tier: 'tierA-public',
      status: 'pending',
    });

    const ctx = loadKbRunContext(s, run.id);
    expect(buildMockEvidence(s, ctx, test.id)).toBeUndefined();
  });

  it('is undefined when testId is absent', async () => {
    const s = await store();
    const project = s.createProject({
      name: 'ev-mock-notestid-project',
      baseUrl: 'https://ev-mock-notestid.test',
    });
    const run = s.createRun(project.id);
    const ctx = loadKbRunContext(s, run.id);
    expect(buildMockEvidence(s, ctx, undefined)).toBeUndefined();
    expect(buildMockEvidence(s, ctx, null)).toBeUndefined();
  });
});

describe('buildExecutionEvidence', () => {
  it('parses a persisted evidence_json blob', () => {
    const json = JSON.stringify({
      tracePath: 'traces/a.zip',
      videoPath: 'videos/a.webm',
      screenshotPaths: ['shots/a.png'],
      mockedRequestCounts: { dep_1: 2 },
      apiEvidence: 'HEALIX MOCK: 200 {}',
    });
    expect(buildExecutionEvidence(json)).toEqual({
      tracePath: 'traces/a.zip',
      videoPath: 'videos/a.webm',
      screenshotPaths: ['shots/a.png'],
      mockedRequestCounts: { dep_1: 2 },
      apiEvidence: 'HEALIX MOCK: 200 {}',
    });
  });

  it('is undefined for null/absent evidence_json', () => {
    expect(buildExecutionEvidence(null)).toBeUndefined();
    expect(buildExecutionEvidence(undefined)).toBeUndefined();
  });

  it('is undefined for malformed JSON rather than throwing', () => {
    expect(buildExecutionEvidence('{not valid json')).toBeUndefined();
  });
});

describe('buildExplorationContext', () => {
  it('best-effort matches the longest route found in the haystack text', async () => {
    const s = await store();
    const project = s.createProject({ name: 'ev-explore-project', baseUrl: 'https://ev-explore.test' });
    const run = s.createRun(project.id);
    s.insertExplorationSummary({
      runId: run.id,
      route: '/',
      selectorsJson: null,
      formsJson: null,
      authPattern: null,
      stateProbeCount: null,
    });
    s.insertExplorationSummary({
      runId: run.id,
      route: '/login',
      selectorsJson: JSON.stringify([{ selector: '#email' }]),
      formsJson: null,
      authPattern: 'password-form',
      stateProbeCount: null,
    });

    const ctx = loadKbRunContext(s, run.id);
    expect(buildExplorationContext(ctx, ["await page.goto('/login')"])).toEqual({
      route: '/login',
      selectors: JSON.stringify([{ selector: '#email' }]),
      authPattern: 'password-form',
    });
  });

  it('is undefined when no exploration route appears in any haystack', async () => {
    const s = await store();
    const project = s.createProject({
      name: 'ev-explore-none-project',
      baseUrl: 'https://ev-explore-none.test',
    });
    const run = s.createRun(project.id);
    s.insertExplorationSummary({
      runId: run.id,
      route: '/login',
      selectorsJson: null,
      formsJson: null,
      authPattern: null,
      stateProbeCount: null,
    });

    const ctx = loadKbRunContext(s, run.id);
    expect(buildExplorationContext(ctx, ["await page.goto('/dashboard')", null, undefined])).toBeUndefined();
  });

  it('a genuine homepage test still matches the short route "/" via a quoted navigation reference', async () => {
    const s = await store();
    const project = s.createProject({
      name: 'ev-explore-home-project',
      baseUrl: 'https://ev-explore-home.test',
    });
    const run = s.createRun(project.id);
    s.insertExplorationSummary({
      runId: run.id,
      route: '/',
      selectorsJson: JSON.stringify([{ selector: '#welcome-heading' }]),
      formsJson: null,
      authPattern: null,
      stateProbeCount: null,
    });

    const ctx = loadKbRunContext(s, run.id);
    // A real Playwright home-page test — quoted navigation call.
    expect(buildExplorationContext(ctx, ["await page.goto('/');"])).toEqual({
      route: '/',
      selectors: JSON.stringify([{ selector: '#welcome-heading' }]),
    });
    // Also matches a quoted mention in error text, with double quotes and
    // extra whitespace inside the quote (the "optional whitespace" case).
    expect(buildExplorationContext(ctx, ['Expected URL: "  /"'])).toEqual({
      route: '/',
      selectors: JSON.stringify([{ selector: '#welcome-heading' }]),
    });
  });

  it('an unrelated failure with an incidental slash does NOT spuriously match the short route "/" (regression)', async () => {
    // Root-cause regression: `text.includes(route)` alone made a bare "/"
    // match almost any real spec/error text, since a slash shows up
    // constantly in file paths, imports, and unrelated URLs that have
    // nothing to do with navigating to the root route.
    const s = await store();
    const project = s.createProject({
      name: 'ev-explore-false-positive-project',
      baseUrl: 'https://ev-explore-false-positive.test',
    });
    const run = s.createRun(project.id);
    s.insertExplorationSummary({
      runId: run.id,
      route: '/',
      selectorsJson: JSON.stringify([{ selector: '#welcome-heading' }]),
      formsJson: null,
      authPattern: null,
      stateProbeCount: null,
    });

    const ctx = loadKbRunContext(s, run.id);
    // An unrelated failure's error text mentions a path with a slash, but
    // never as a quoted navigation reference to the root route.
    const unrelatedError = 'GET /api/users returned 500 at handleClick (/app/src/components/Login.tsx:42:10)';
    expect(buildExplorationContext(ctx, [unrelatedError])).toBeUndefined();
  });
});

describe('buildKbTriageEvidence', () => {
  it('assembles every KB-sourced field when all four sources have data', async () => {
    const s = await store();
    const project = s.createProject({ name: 'ev-all-project', baseUrl: 'https://ev-all.test' });
    const run = s.createRun(project.id);
    s.seedRequirement(run.id, 'REQ-1', 'Login UI flow');
    const test = s.insertTest({
      runId: run.id,
      title: 'logs in',
      reqTag: 'REQ-1',
      tier: 'tierA-public',
      status: 'pending',
    });
    const mockId = s.upsertMockResponse({
      runId: run.id,
      dependencyId: 'dep_1',
      category: 'auth',
      method: 'POST',
      pathPattern: '/api/login',
      mockStrategy: 'route-intercept',
      mockStatus: 200,
      mockBodyJson: JSON.stringify({ message: 'ok' }),
      mockHeadersJson: null,
    });
    s.recordMockUsage(test.id, mockId, 1);
    s.insertExplorationSummary({
      runId: run.id,
      route: '/login',
      selectorsJson: null,
      formsJson: null,
      authPattern: 'password-form',
      stateProbeCount: null,
    });
    const evidenceJson = JSON.stringify({ tracePath: 'traces/a.zip' });

    const ctx = loadKbRunContext(s, run.id);
    const result = buildKbTriageEvidence(s, ctx, {
      reqTag: 'REQ-1',
      testId: test.id,
      evidenceJson,
      routeHaystacks: ["await page.goto('/login')"],
    });

    expect(result.requirement).toEqual({ tag: 'REQ-1', description: 'Login UI flow' });
    expect(result.mockEvidence).toHaveLength(1);
    expect(result.executionEvidence).toEqual({ tracePath: 'traces/a.zip' });
    expect(result.explorationContext).toEqual({ route: '/login', authPattern: 'password-form' });
  });

  it('omits each field individually when its source is absent', async () => {
    const s = await store();
    const project = s.createProject({ name: 'ev-none-project', baseUrl: 'https://ev-none.test' });
    const run = s.createRun(project.id);
    const test = s.insertTest({
      runId: run.id,
      title: 'unrelated',
      reqTag: null,
      tier: 'tierA-public',
      status: 'pending',
    });

    const ctx = loadKbRunContext(s, run.id);
    const result = buildKbTriageEvidence(s, ctx, {
      reqTag: null,
      testId: test.id,
      evidenceJson: null,
      routeHaystacks: ['no route mentioned here'],
    });

    expect(result).toEqual({});
  });
});
