import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TestModeContext } from '../types.js';
import { isXmlContentType } from '../../browser/index.js';
import type { ObservedEndpoint } from '../../browser/network-capture.js';
import type { ExternalDependency, ExternalDependencyCategory, MockResponse } from '../../target/types.js';
import {
  applyCanonicalIdentity,
  type CanonicalIdentity,
  endpointCategory,
  extractCanonicalIdentity,
  mergeGroundedResponse,
  reconcileAuthTokens,
  staticMockResponse,
} from '../../target/mock-responses.js';
import {
  TIERS,
  actionHighlighterFixtureContents,
  authSetupContents,
  checkpointReporterContents,
  gitignoreContents,
  mockFixtureContents,
  packageJsonContents,
  playwrightConfigContents,
  stepsReporterContents,
  suiteReadmeContents,
  tierReadmeContents,
  type MockRouteEntry,
} from './templates.js';

/** Same hostname-matching rule mock.fixture.ts's runtime `hostMatches()` applies: an exact
 * `host:port` pattern must match verbatim, otherwise compare bare hostname (exact or suffix). */
function observedHostMatchesDependency(observedHost: string, depHostnames: string[]): boolean {
  const hostname = observedHost.split(':')[0];
  return depHostnames.some((pattern) =>
    pattern.includes(':')
      ? observedHost === pattern
      : hostname === pattern || hostname.endsWith(`.${pattern}`),
  );
}

/**
 * Best-effort resolve of a captured response body for the runtime mock fixture.
 *
 * Tries `JSON.parse()` first. On failure, an XML/SOAP body (per `contentType`) is passed
 * through as-is: `browser/index.ts`'s `truncateBody()` routes XML content-types through a
 * structural, well-formedness-preserving truncator (GAP-069), so the raw string is always
 * safe to serve verbatim — `templates.ts`'s `serializeBody()` already knows to emit a
 * non-JSON `body` string as-is by content-type instead of `JSON.stringify`-encoding it.
 * Any other non-JSON body (HTML, plaintext, or a genuinely malformed capture) still falls
 * back to `{}`: serving an invalid-JSON string AS the mock response body would silently
 * corrupt the fixture (every property access resolving to `undefined` instead of throwing,
 * producing confusing app-level failures that look like real bugs).
 */
function parseObservedBody(sampleResponseBody: string | undefined, contentType: string | undefined): unknown {
  if (!sampleResponseBody) return {};
  try {
    return JSON.parse(sampleResponseBody);
  } catch {
    return isXmlContentType(contentType) ? sampleResponseBody : {};
  }
}

/** Reconciles a purely-synthetic (static/AI) response's identity fields against `canonical`,
 * a no-op when nothing real has been captured yet (see `extractCanonicalIdentity`). For an
 * auth-classified response, also regenerates its JWT-bearing fields so the token's own
 * encoded subject agrees with `canonical.id` — otherwise a correctly-reconciled `user.id`
 * would still be contradicted by an unrelated, still-fake token (see `reconcileAuthTokens`). */
function withCanonicalIdentity(
  response: MockResponse,
  canonical: CanonicalIdentity | null,
  category?: ExternalDependencyCategory,
): MockResponse {
  if (!canonical) return response;
  const body = applyCanonicalIdentity(response.body, canonical);
  return { ...response, body: category === 'auth' ? reconcileAuthTokens(body, canonical) : body };
}

/**
 * Merge a dependency's statically-detected `endpoints[]` with any real traffic EXPLORE
 * observed for that same hostname (see GAP-046 / network-capture.ts). Additive: real-traffic
 * ground truth is included even when static detection skipped endpoint-level attribution
 * entirely (dependencies.ts only attaches static endpoints when exactly one mockable
 * dependency exists; a multi-dependency app like a typical SPA with several backend hosts
 * would otherwise fall back to one flat, dependency-wide response for every path on that
 * host — including paths a canned generic body doesn't remotely resemble).
 *
 * When BOTH a static and an observed entry exist for the same (method, pathPattern), the
 * static entry no longer wins outright — its body is grounded field-by-field in the observed
 * one (`mergeGroundedResponse`), so a real captured login/profile response actually reaches
 * the running fixture instead of being discarded in favor of a generic/AI-guessed shape (this
 * used to silently reproduce the exact bug this module exists to prevent, for any endpoint —
 * most visibly auth ones, since dependencies.ts always statically attaches those regardless of
 * how many mockable dependencies exist, so real captured login traffic was always the one
 * being thrown away). Secret-shaped fields that arrived redacted (see
 * `export/sanitize.ts`'s `redactSecrets()`) are skipped during the merge, falling back to the
 * static/floor value for that field — never serving the literal "<REDACTED>" as a token.
 */
type EndpointEntry = NonNullable<MockRouteEntry['endpoints']>[number];

function mergedEndpoints(
  dep: ExternalDependency,
  observedEndpoints: ObservedEndpoint[],
  canonicalIdentity: CanonicalIdentity | null,
): EndpointEntry[] {
  const staticEndpoints = dep.endpoints ?? [];
  const depHostnames = dep.hostnames ?? [];
  const merged: EndpointEntry[] = [];
  const indexByKey = new Map<string, number>();
  const categoryByKey = new Map<string, ExternalDependencyCategory>();

  for (const e of staticEndpoints) {
    const key = `${e.method.toUpperCase()} ${e.pathPattern}`;
    const category = endpointCategory(dep, e);
    indexByKey.set(key, merged.length);
    categoryByKey.set(key, category);
    merged.push({
      method: e.method,
      pathPattern: e.pathPattern,
      // Reconcile identity BEFORE the observed-traffic merge below, so a static/AI-guessed
      // endpoint agrees with real captured identity from elsewhere in the same run.
      response: withCanonicalIdentity(
        e.response ?? staticMockResponse(category),
        canonicalIdentity,
        category,
      ),
    });
  }

  for (const observed of observedEndpoints) {
    if (!observed.host || !observedHostMatchesDependency(observed.host, depHostnames)) continue;
    const key = `${observed.method.toUpperCase()} ${observed.pathPattern}`;
    const observedBody = parseObservedBody(observed.sampleResponseBody, observed.contentType);
    const observedHeaders = observed.contentType ? { 'content-type': observed.contentType } : undefined;
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, merged.length);
      merged.push({
        method: observed.method,
        pathPattern: observed.pathPattern,
        response: { status: observed.status, body: observedBody, headers: observedHeaders },
      });
      continue;
    }
    const category = categoryByKey.get(key) ?? dep.category;
    const current = merged[existingIndex];
    merged[existingIndex] = {
      method: current.method,
      pathPattern: current.pathPattern,
      response: mergeGroundedResponse(
        category,
        current.response ?? staticMockResponse(category),
        observedBody,
        observed.status,
        observedHeaders,
      ),
    };
  }

  return merged;
}

/** Route-intercept/both dependencies with resolved mock content, for the mock fixture. */
function mockRouteEntries(ctx: TestModeContext): MockRouteEntry[] {
  const deps = ctx.externalDependencies ?? [];
  const responses = ctx.mockResponses ?? {};
  const observedEndpoints = ctx.exploration?.observedEndpoints ?? [];
  // Computed ONCE for the whole run: real captured traffic's identity (if any) is the single
  // source of truth every purely-synthetic sibling endpoint gets reconciled against below —
  // see extractCanonicalIdentity's doc comment (Cluster B).
  const canonicalIdentity = extractCanonicalIdentity(observedEndpoints);
  const entries: MockRouteEntry[] = [];
  for (const dep of deps) {
    if (dep.mockStrategy !== 'route-intercept' && dep.mockStrategy !== 'both') continue;
    if (!dep.hostnames || dep.hostnames.length === 0) continue;
    const depResponse = responses[dep.id];
    if (!depResponse) continue;
    const response = withCanonicalIdentity(depResponse, canonicalIdentity, dep.category);
    const endpoints = mergedEndpoints(dep, observedEndpoints, canonicalIdentity);
    entries.push({
      id: dep.id,
      hostnames: dep.hostnames,
      response,
      ...(endpoints.length > 0 ? { endpoints } : {}),
    });
  }
  return entries;
}

function emit(ctx: TestModeContext, message: string, data?: unknown): void {
  ctx.emit?.('scaffold', message, data);
}

/** Best-effort: derive a friendly package name from the project dir basename. */
function suiteName(projectDir: string): string {
  const base = projectDir.split(/[\\/]/).filter(Boolean).pop() ?? 'healix-suite';
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug || 'healix-suite';
}

/**
 * Lay down a standalone, runnable Playwright project under ctx.projectDir:
 * package.json, playwright.config.ts (tiers as projects), per-tier test dirs,
 * fixtures (auth setup) and READMEs. Idempotent — safe to re-run.
 */
export async function scaffold(ctx: TestModeContext): Promise<void> {
  const { projectDir } = ctx;
  emit(ctx, `Scaffolding Playwright suite at ${projectDir}`);

  await mkdir(projectDir, { recursive: true });

  // Directory layout.
  const testsDir = join(projectDir, 'tests');
  const fixturesDir = join(projectDir, 'fixtures');
  const authDir = join(fixturesDir, '.auth');
  await mkdir(testsDir, { recursive: true });
  await mkdir(fixturesDir, { recursive: true });
  await mkdir(authDir, { recursive: true });

  for (const tier of TIERS) {
    const tierDir = join(testsDir, tier);
    await mkdir(tierDir, { recursive: true });
    await writeFile(join(tierDir, 'README.md'), tierReadmeContents(tier), 'utf-8');
  }

  // Project files.
  const files: Array<[string, string]> = [
    [join(projectDir, 'package.json'), packageJsonContents({ name: suiteName(projectDir) })],
    [
      join(projectDir, 'playwright.config.ts'),
      playwrightConfigContents({
        baseUrl: ctx.baseUrl,
        // See F-18: only skip auth-setup when the plan is KNOWN to have no
        // tierB-auth items — undefined (not yet known) keeps today's
        // always-scaffold behavior.
        includeAuthSetup: ctx.hasTierBAuthPlanItems !== false,
      }),
    ],
    [join(fixturesDir, 'auth.setup.ts'), authSetupContents()],
    [join(fixturesDir, 'action-highlighter.ts'), actionHighlighterFixtureContents()],
    [join(fixturesDir, 'steps-reporter.cjs'), stepsReporterContents()],
    [join(fixturesDir, 'checkpoint-reporter.cjs'), checkpointReporterContents()],
    [join(projectDir, 'README.md'), suiteReadmeContents({ baseUrl: ctx.baseUrl })],
    [join(projectDir, '.gitignore'), gitignoreContents()],
  ];

  for (const [filePath, contents] of files) {
    await writeFile(filePath, contents, 'utf-8');
  }

  // Keep an empty anonymous storageState so Tier B can load before any login.
  await writeFile(join(authDir, 'user.json'), JSON.stringify({ cookies: [], origins: [] }), 'utf-8');

  // Mock fixture: always written when mocking is enabled for the run (even with
  // zero route-intercept dependencies — an empty routes list is a harmless
  // passthrough), so generate.ts's import path always resolves.
  if (ctx.mockExternalDependencies) {
    const routes = mockRouteEntries(ctx);
    await writeFile(join(fixturesDir, 'mock.fixture.ts'), mockFixtureContents(routes), 'utf-8');
    emit(ctx, `Wrote mock fixture with ${routes.length} route(s)`, { routes: routes.map((r) => r.id) });
  }

  emit(ctx, 'Scaffold complete', { tiers: TIERS });
}
