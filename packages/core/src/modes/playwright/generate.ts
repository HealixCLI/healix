import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Tier } from '../../storage/types.js';
import type { ObservedEndpoint } from '../../browser/network-capture.js';
import type { GeneratedSpec, PlanScenario, TestModeContext, TestPlan, TestPlanItem } from '../types.js';
import { ProviderUnavailableError } from '../types.js';
import { TIERS, tierLabel } from './templates.js';
import { splitTestBlocks } from './quality-audit.js';

const GEN_TIMEOUT_MS = 180_000;

// Re-exported for call sites/tests that import it alongside generate() —
// the class itself lives in modes/types.ts since it's shared across modes,
// not Playwright-specific (see that definition for the full rationale).
export { ProviderUnavailableError } from '../types.js';

function emit(ctx: TestModeContext, message: string, data?: unknown): void {
  ctx.emit?.('generate', message, data);
}

const MAX_MOCK_CONTENT_LINES = 20;
const MAX_MOCK_BODY_CHARS = 400;

/**
 * Ground assertions in the ACTUAL resolved mock content, not a guess. Without
 * this, GENERATE only knows mocking is active (see mockNote below) but not
 * what a mocked call actually returns — a model can write a perfectly
 * plausible assertion (e.g. a specific balance/name) that simply doesn't
 * match what the mock server/fixture will serve, failing for a reason
 * that has nothing to do with the app under test.
 */
export function formatMockContent(ctx: TestModeContext): string {
  const deps = ctx.externalDependencies ?? [];
  const lines: string[] = [];
  // Endpoints EXPLORE actually observed on the wire (see GAP-046) — higher-trust ground
  // truth than a statically-inferred/AI-guessed body. Tracked so anything matched here is
  // skipped from the "observed but not in static analysis" pass below.
  const matchedObserved = new Set<ObservedEndpoint>();
  for (const dep of deps) {
    if (dep.mockStrategy === 'undeterminable') continue;
    if (lines.length >= MAX_MOCK_CONTENT_LINES) break;
    if (dep.endpoints && dep.endpoints.length > 0) {
      for (const e of dep.endpoints) {
        if (lines.length >= MAX_MOCK_CONTENT_LINES) break;
        const observed = findObservedEndpoint(ctx, e.method, e.pathPattern);
        if (observed) {
          matchedObserved.add(observed);
          const body = (observed.sampleResponseBody ?? '').slice(0, MAX_MOCK_BODY_CHARS);
          lines.push(`- ${e.method} ${e.pathPattern} -> OBSERVED status ${observed.status}, body: ${body}`);
          continue;
        }
        if (!e.response) continue;
        const body = JSON.stringify(e.response.body).slice(0, MAX_MOCK_BODY_CHARS);
        lines.push(`- ${e.method} ${e.pathPattern} -> status ${e.response.status}, body: ${body}`);
      }
    } else {
      const fallback = ctx.mockResponses?.[dep.id];
      if (!fallback) continue;
      const body = JSON.stringify(fallback.body).slice(0, MAX_MOCK_BODY_CHARS);
      lines.push(`- ${dep.label} (any call to this dependency) -> status ${fallback.status}, body: ${body}`);
    }
  }
  // Real traffic EXPLORE observed that no statically-detected dependency accounts for —
  // additive ground truth the static scan alone can't provide (see GAP-046).
  for (const observed of ctx.exploration?.observedEndpoints ?? []) {
    if (lines.length >= MAX_MOCK_CONTENT_LINES) break;
    if (matchedObserved.has(observed)) continue;
    const body = (observed.sampleResponseBody ?? '').slice(0, MAX_MOCK_BODY_CHARS);
    lines.push(
      `- ${observed.method} ${observed.pathPattern} -> OBSERVED (not in static analysis) status ${observed.status}, body: ${body}`,
    );
  }
  if (lines.length === 0) return '';
  return (
    '\n\nMocked response content — assert against this EXACT data (do not invent plausible-sounding ' +
    'values that differ from it). RULE: mockOverride() may only target the endpoints listed here; do not ' +
    'invent an endpoint path. Lines marked OBSERVED were captured from real traffic during exploration; ' +
    'unmarked lines are statically detected and may be INCOMPLETE for dynamic endpoints — if a scenario ' +
    'genuinely needs an endpoint not listed here, follow the ESCAPE HATCH rule instead of guessing a ' +
    'plausible-looking path:\n' +
    lines.join('\n')
  );
}

/** Same slug transform as templates.ts's roleStorageStatePath — must stay in sync so a role name always resolves to the same file. */
function roleStorageStateFilename(role: string): string {
  const slug = role
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `fixtures/.auth/user-${slug || 'role'}.json`;
}

/**
 * When the project has more than one test credential, tell tierB-auth
 * generation about the available roles so a test that's clearly ABOUT one
 * role's behavior (an admin-only page, a specific account type) can opt into
 * that role's own session — everything else silently keeps using the
 * default storageState, unchanged from the single-credential case. This is a
 * best-effort HINT to the model; matchRoleForItem()/insertRoleStorageState()
 * below are what actually GUARANTEE the routing happens, deterministically,
 * regardless of whether the model itself added a test.use() call.
 */
function formatRoleGuidance(ctx: TestModeContext, tier: Tier): string {
  if (tier !== 'tierB-auth') return '';
  const roles = [...new Set((ctx.credentials ?? []).map((c) => c.role).filter((r): r is string => !!r))];
  if (roles.length === 0) return '';
  const lines = roles.map((r) => `- "${r}" -> test.use({ storageState: '${roleStorageStateFilename(r)}' })`);
  return (
    '\n\nThis project has multiple test accounts with distinct roles. The default session (no action needed) ' +
    "is a generic/roleless account. ONLY when this specific test is clearly about one of these roles' own " +
    "behavior, add the matching test.use(...) INSIDE this file's test.describe(...) block, before any test(...) calls:\n" +
    lines.join('\n')
  );
}

/**
 * Deterministic role routing: does this plan item's title/intent name one of
 * the project's configured roles (e.g. a plan item literally titled "Admin
 * dashboard access control")? Whole-word, case-insensitive match against
 * EVERY configured role; the first match wins. Returns null when nothing
 * matches — the item keeps using the default (roleless) session, exactly
 * like a single-credential project always has.
 */
function matchRoleForItem(item: TestPlanItem, roles: string[]): string | null {
  const haystack = `${item.title} ${item.intent}`.toLowerCase();
  for (const role of roles) {
    const escaped = role.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`).test(haystack)) return role;
  }
  return null;
}

/**
 * Force the matched role's storageState onto this spec — inserted right
 * after the test.describe(...) opening, ahead of every test(...) call — so
 * role routing is guaranteed by the orchestrator, not left to the model's
 * discretion. A no-op if the model already added its own test.use() (per
 * formatRoleGuidance's hint above): never insert a second, possibly
 * conflicting override.
 */
function insertRoleStorageState(source: string, role: string): string {
  // Only skip if the model already set storageState itself — an unrelated
  // test.use() (viewport, locale, etc.) must not block routing, since
  // Playwright merges multiple test.use() calls in the same file anyway.
  if (/test\.use\s*\(\s*\{[^}]*storageState/.test(source)) return source;
  const match = /test\.describe\([\s\S]*?=>\s*\{/.exec(source);
  if (!match) return source;
  const insertAt = match.index + match[0].length;
  const line = `\n  test.use({ storageState: '${roleStorageStateFilename(role)}' });`;
  return source.slice(0, insertAt) + line + source.slice(insertAt);
}

/** Coerce an arbitrary plan-item tier into one of the three known tiers. */
function resolveTier(raw: Tier | string | undefined): Tier {
  const v = String(raw ?? '').toLowerCase();
  if (v.startsWith('tierb') || v.includes('auth')) return 'tierB-auth';
  if (v.startsWith('tierc') || v.includes('api') || v.includes('backend')) return 'tierC-api';
  if (v.startsWith('tiera') || v.includes('public')) return 'tierA-public';
  return TIERS.includes(raw as Tier) ? (raw as Tier) : 'tierA-public';
}

/** URL/file-safe slug for a spec filename. */
function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'spec';
}

/** Strip ``` / ```ts / ```typescript markdown fences and surrounding prose. */
export function stripCodeFences(text: string): string {
  let t = (text ?? '').trim();
  // Prefer the contents of the first fenced block if one exists.
  const fenced = t.match(/```(?:[a-zA-Z]+)?\s*\n([\s\S]*?)```/);
  if (fenced && fenced[1]) {
    t = fenced[1];
  } else {
    // No closing fence — drop a leading/trailing bare fence line if present.
    t = t.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return t.trim();
}

/** A usable spec must import from @playwright/test and assert at least once. */
export function hasExpect(source: string): boolean {
  return /\bexpect\s*\(/.test(source);
}

// ---- Forbidden-API gate ------------------------------------------------------

/** Static `import ... from 'x'` / bare `import 'x'` module specifiers. */
const STATIC_IMPORT_RE = /\bimport\s+(?:type\s+)?(?:[\w$*{},\s]+?\s+from\s+)?['"]([^'"]+)['"]/g;
/** Dynamic `import('x')` and `require('x')` module specifiers. */
const DYNAMIC_IMPORT_RE = /\b(require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
/** Filesystem WRITE APIs — read-only fs use would be caught by the import gate anyway. */
const FS_WRITE_RE = /\b(writeFile|appendFile|rm\s*\(|rmSync|unlink|mkdir|rename|cp\s*\(|copyFile)/g;
/** Process-spawning tokens that matter once child_process is in play. */
const CHILD_PROCESS_TOKEN_RE = /\b(execSync|spawnSync|exec\s*\(|spawn\s*\()/g;

function collectModuleSpecifiers(source: string): string[] {
  const mods: string[] = [];
  for (const m of source.matchAll(STATIC_IMPORT_RE)) mods.push(m[1]);
  for (const m of source.matchAll(DYNAMIC_IMPORT_RE)) mods.push(m[2]);
  return mods;
}

/**
 * Deny-list gate over a generated spec's source. Returns a human-readable list
 * of violations (empty = clean).
 *
 * WHY: generated specs are UNTRUSTED MODEL OUTPUT that we later execute on the
 * user's machine via `npx playwright test`. Until now the only validation was
 * "imports playwright + contains expect(" — a spec that also imported
 * child_process or fs would run shell commands / rewrite files with the user's
 * privileges. The prompt already demands self-contained specs that import ONLY
 * '@playwright/test', so the pragmatic rule is an import allowlist of exactly
 * that one module: any other import/require (node:fs, net, http, local helpers,
 * …) is flagged. On top of that we flag dangerous tokens that need no import at
 * all (eval, new Function, process.exit) and — belt-and-braces, since the
 * import gate already fires — child_process spawn tokens and fs write APIs.
 *
 * This is a tripwire against a compromised/hallucinating model, not a sandbox:
 * a determined adversary can evade static analysis. Defense in depth continues
 * at execution time (env allowlist in execute.ts).
 *
 * `extraAllowedImport` widens the allowlist by exactly one additional module
 * specifier — used only when mocking is enabled for the run, to permit specs
 * to import test/expect from the Healix-authored (not model-authored) mock
 * fixture instead of '@playwright/test' directly. That fixture file's own
 * contents are never model output, so this doesn't reopen the untrusted-import
 * surface the gate exists to close.
 */
export function findForbiddenApis(source: string, extraAllowedImport?: string): string[] {
  const violations = new Set<string>();

  // Import allowlist: '@playwright/test', plus exactly one extra module when
  // mocking is enabled for this run. Everything else is flagged.
  for (const mod of collectModuleSpecifiers(source)) {
    if (mod !== '@playwright/test' && mod !== extraAllowedImport) {
      const allowed = extraAllowedImport
        ? `'@playwright/test' or '${extraAllowedImport}'`
        : "'@playwright/test'";
      violations.add(`import/require of '${mod}' (only ${allowed} is allowed)`);
    }
  }

  // child_process by any route (import already flagged above; the token checks
  // also catch indirection like `process.binding` tricks that mention it).
  if (/\bchild_process\b/.test(source)) {
    violations.add('references child_process');
    for (const m of source.matchAll(CHILD_PROCESS_TOKEN_RE)) {
      violations.add(`child_process API: ${m[1].replace(/\s*\($/, '(')}`);
    }
  }

  // Dangerous without any import at all.
  if (/\beval\s*\(/.test(source)) violations.add('eval(...)');
  if (/\bnew\s+Function\s*\(/.test(source)) violations.add('new Function(...)');
  if (/\bprocess\.exit\b/.test(source)) violations.add('process.exit');

  // fs write APIs — only meaningful when an fs module is actually imported
  // (bare words like `rename` appear in legit UI test copy otherwise).
  const fsImported = collectModuleSpecifiers(source).some(
    (mod) => mod === 'fs' || mod === 'node:fs' || mod.startsWith('fs/') || mod.startsWith('node:fs/'),
  );
  if (fsImported) {
    for (const m of source.matchAll(FS_WRITE_RE)) {
      violations.add(`fs write API: ${m[1].replace(/\s*\($/, '(')}`);
    }
  }

  return [...violations];
}

/**
 * Relative import path (constant across all specs, which always land two
 * directories deep at tests/<tier>/<slug>.spec.ts) to the Healix-authored mock
 * fixture — see scaffold.ts's mockFixtureContents(). Used in place of
 * ACTION_HIGHLIGHTER_IMPORT_PATH when mocking is enabled for the run (the mock
 * fixture itself chains on top of the highlighter, so both are always active).
 */
export const MOCK_FIXTURE_IMPORT_PATH = '../../fixtures/mock.fixture';

/**
 * Relative import path to the Healix-authored action-highlighter fixture —
 * see templates.ts's actionHighlighterFixtureContents(). This is the DEFAULT
 * import source for every generated spec (mocking-enabled runs use
 * MOCK_FIXTURE_IMPORT_PATH instead, which itself imports from here) — no spec
 * ever imports '@playwright/test' directly anymore, so every recorded video
 * gets the visual action highlighter regardless of mocking.
 */
export const ACTION_HIGHLIGHTER_IMPORT_PATH = '../../fixtures/action-highlighter';

export function looksLikePlaywrightSpec(source: string, extraAllowedImport?: string): boolean {
  const importsTest =
    /@playwright\/test/.test(source) ||
    (extraAllowedImport !== undefined && source.includes(extraAllowedImport));
  return importsTest && /\btest\s*(?:\.\w+)?\s*\(/.test(source);
}

/** Matches bare `test(...)` and `test.only/skip/fixme(...)` calls — deliberately excludes `test.describe(...)`. */
const TEST_CASE_RE = /\btest(?:\.(?:only|skip|fixme))?\s*\(/g;

/** Count actual test-case blocks in a spec (not the enclosing describe block). */
function countTestCases(source: string): number {
  return [...source.matchAll(TEST_CASE_RE)].length;
}

/** Ensure the generated title carries the [REQ:...] tag for traceability. */
function ensureReqTag(source: string, reqTag: string | undefined): string {
  if (!reqTag) return source;
  const tag = `[REQ:${reqTag}]`;
  if (source.includes(tag)) return source;
  // Inject the tag into the first test/test.describe title if missing.
  return source.replace(
    /(\b(?:test|test\.describe)\s*(?:\.\w+)?\s*\(\s*)(['"`])/,
    (_m, head: string, quote: string) => `${head}${quote}${tag} `,
  );
}

/** Retry note when the previous attempt produced a spec without an assertion. */
const RETRY_NOTE_NO_EXPECT =
  'Your previous output was rejected because it contained no expect(...) assertion. You MUST include at least one concrete expect(...) assertion that verifies real behaviour.';

/** Retry note when the previous attempt didn't include a test() case for every requested scenario. */
function retryNoteMissingScenarios(expected: number, actual: number): string {
  return `Your previous output was rejected because it had ${actual} test case(s) but ${expected} scenario(s) were requested. Output exactly one test(...) per scenario listed below, in the same order.`;
}

/** Retry note when individual test() titles are missing the [REQ:tag] marker (only the describe had it). */
function retryNoteMissingPerTestTag(reqTag: string): string {
  return `Your previous output was rejected because "[REQ:${reqTag}]" only appeared on the describe block, not on every individual test(...) title. EVERY test(...) title must start with "[REQ:${reqTag}]" — this is required for coverage tracking.`;
}

/** Count occurrences of the "[REQ:<tag>]" marker in the source (used to confirm it's on every test, not just the describe). */
function countReqTagOccurrences(source: string, reqTag: string): number {
  const escaped = reqTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\[REQ:${escaped}\\]`, 'g');
  return [...source.matchAll(re)].length;
}

/** Retry note when a source-grounded item's output is missing its mandatory [SRC:file] citation. */
function retryNoteMissingSrcCitation(file: string): string {
  return `Your previous output was rejected because it didn't include a "// [SRC:${file}]" comment. Add exactly that comment, naming this file, somewhere in the generated spec so its grounding is traceable.`;
}

/** True iff a "// [SRC:<file>]"-shaped comment naming this exact file appears anywhere in the source. */
function hasSrcCitation(source: string, file: string): boolean {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\[SRC:${escaped}\\]`).test(source);
}

/** Retry note when the previous attempt used forbidden APIs (deny-list gate). */
function retryNoteForbidden(violations: string[], allowedImport: string): string {
  return `Your previous output was rejected because it used forbidden APIs: ${violations.join('; ')}. The spec MUST be fully self-contained: import ONLY from '${allowedImport}'; never import or require any other module; never touch the filesystem, spawn processes, use eval/new Function, or call process.exit.`;
}

// ---- Grounding-validation gate ------------------------------------------------

/** A marker the model can use (per formatSnapshotInventory's ESCAPE HATCH) to acknowledge an intentionally-unobserved element instead of inventing one — findUngroundedReferences downgrades hard failures to warnings when it's present. */
const ESCAPE_HATCH_MARKER = '// TODO: unobserved element';

/** Matches a test-block opening call (`test(`, `test.only(`, `test.skip(`) at an exact source offset — used to rewrite it to `test.fixme(` in place without disturbing anything else in the block. */
const TEST_OPEN_AT_RE = /test(?:\.(?:only|skip|fixme))?\(/y;

/**
 * A test the model itself flagged as built on a guess (the escape-hatch marker anywhere in
 * its body) still passes every other gate and, until now, shipped to execute as an ordinary
 * `test(...)` — indistinguishable in the report from a fully-grounded test, and reliably
 * failing/hanging when the guess is wrong (see docs/fix-backlog.md P1 item 7,
 * "self-healing selectors" — no closed-loop repair exists yet to make good on the guess).
 * Downgrade just that block to `test.fixme(...)` so Playwright reports it as
 * needs-review/skipped rather than a hard failure, while every other test in the same spec
 * (with no marker) ships and runs normally.
 */
export function demoteEscapeHatchBlocks(source: string): string {
  const targets = splitTestBlocks(source).filter((b) => b.body.includes(ESCAPE_HATCH_MARKER));
  if (targets.length === 0) return source;

  let result = source;
  for (const block of [...targets].sort((a, b) => b.start - a.start)) {
    TEST_OPEN_AT_RE.lastIndex = block.start;
    const m = TEST_OPEN_AT_RE.exec(result);
    if (!m || m.index !== block.start) continue;
    result =
      result.slice(0, block.start) +
      '/* healix: unobserved element — needs review */ test.fixme(' +
      result.slice(block.start + m[0].length);
  }
  return result;
}

export interface GroundTruth {
  testids: Set<string>;
  selectors: Set<string>;
  /** lowercased accessible names observed anywhere in the selected inventory */
  names: string[];
  /** lowercased accessible name -> observed role(s) for that name */
  roleByName: Map<string, Set<string>>;
  endpoints: Array<{ method: string; pathPattern: string }>;
  /** true when at least one ExternalDependency carries statically-detected (method, path) endpoints — makes an unmatched mockOverride() provable, not just unproven */
  hasEndpointLevelMocks: boolean;
  /** true when selectInventoryElements() had to omit elements for length — can't prove a selector's absence against an incomplete inventory */
  inventoryTruncated: boolean;
}

/** Pull a `data-testid="..."` (or `data-test="..."`) value out of a selectorFor()-style CSS selector string, if present. */
function extractTestidFromSelector(selector: string): string | null {
  const m = /data-test(?:id)?=["']([^"']+)["']/.exec(selector);
  return m ? m[1] : null;
}

/**
 * Build the ground-truth the grounding-validation gate checks a generated spec against.
 * MUST read from the same selectInventoryElements() the model was actually shown (see that
 * function's doc comment) — otherwise this gate could reject a selector the model never had
 * the option to use. Endpoint ground truth is separate: dependency-level (endpoint-less)
 * mocks don't produce a comparable (method, path) pair, so `hasEndpointLevelMocks` tracks
 * whether a real comparison is even possible for this run.
 */
export function collectGroundTruth(ctx: TestModeContext, tier: Tier): GroundTruth {
  const { selected, truncated } = selectInventoryElements(ctx, tier);

  const testids = new Set<string>();
  const selectors = new Set<string>();
  const names: string[] = [];
  const roleByName = new Map<string, Set<string>>();
  for (const { el } of selected) {
    selectors.add(el.selector);
    const testid = extractTestidFromSelector(el.selector);
    if (testid) testids.add(testid);
    const lname = el.name.trim().toLowerCase();
    if (lname) {
      names.push(lname);
      const roles = roleByName.get(lname) ?? new Set<string>();
      roles.add(el.role);
      roleByName.set(lname, roles);
    }
  }

  const endpoints: Array<{ method: string; pathPattern: string }> = [];
  let hasEndpointLevelMocks = false;
  for (const dep of ctx.externalDependencies ?? []) {
    if (dep.endpoints && dep.endpoints.length > 0) {
      hasEndpointLevelMocks = true;
      for (const e of dep.endpoints) endpoints.push({ method: e.method, pathPattern: e.pathPattern });
    }
  }
  // Real traffic observed during EXPLORE (see GAP-046) is just as provable a ground truth
  // as a statically-detected endpoint — include it, and let it make the comparison provable
  // even on a run with no endpoint-level static dependency.
  for (const o of ctx.exploration?.observedEndpoints ?? []) {
    hasEndpointLevelMocks = true;
    endpoints.push({ method: o.method, pathPattern: o.pathPattern });
  }

  return {
    testids,
    selectors,
    names,
    roleByName,
    endpoints,
    hasEndpointLevelMocks,
    inventoryTruncated: truncated,
  };
}

const TESTID_CALL_RE = /getByTestId\(\s*['"]([^'"]+)['"]\s*\)/g;
const TESTID_ATTR_RE = /data-test(?:id)?=["']([^"']+)["']/g;
const ROLE_CALL_RE =
  /getByRole\(\s*['"](\w+)['"]\s*(?:,\s*\{[^}]*name:\s*(?:\/((?:[^/\\]|\\.)+)\/[a-z]*|['"]([^'"]+)['"]))?/g;
const MOCK_OVERRIDE_RE = /mockOverride\(\s*['"](\w+)['"]\s*,\s*['"]([^'"]+)['"]/g;
/** Matches `getByText('literal')` or `getByText(/regex/flags)` — the two forms generation actually produces. */
const TEXT_CALL_RE = /getByText\(\s*(?:\/((?:[^/\\]|\\.)+)\/[a-z]*|['"]([^'"]*)['"])/g;

/** Collapse whitespace/case so a `getByText` argument compares fairly against the observed accessible-name corpus. */
function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * A regex-literal `getByText` argument is often an alternation of a few
 * candidate phrases (`/zabudli ste heslo|forgot password/i`) rather than a
 * single string — split on top-level `|` so each alternative is checked
 * against the observed-name corpus independently. Not a real regex parser
 * (doesn't handle nested groups/escapes precisely), just enough to catch the
 * common flat-alternation shape generation actually produces.
 */
function splitTextAlternatives(source: string): string[] {
  return source
    .split('|')
    .map((alt) => normalizeText(alt.replace(/\\(.)/g, '$1')))
    .filter(Boolean);
}

/**
 * Forgiving (substring, either direction) match against every accessible
 * name observed in the selected inventory (`gt.names` — link/button/input
 * text, already lowercased/whitespace-collapsed by selectorFor()'s clamp()).
 * Only covers text that lives on an INTERACTIVE element (the inventory's own
 * scope) — a `getByText` targeting plain static copy (a banner, a profile
 * field) isn't checked here and falls through as unproven, same as any
 * selector against a page EXPLORE never visited.
 */
function textMatchesInventory(alt: string, gt: GroundTruth): boolean {
  if (!alt) return true;
  return gt.names.some((name) => name.includes(alt) || alt.includes(name));
}

/** Normalize an endpoint path pattern (glob wildcards, `:param` placeholders) for a forgiving substring comparison. */
function normalizeEndpointPath(path: string): string {
  return path
    .toLowerCase()
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/:[a-zA-Z0-9_]+/g, ':param')
    .replace(/^\/+|\/+$/g, '');
}

/** Forgiving (substring, either direction) match — exact glob/path-template reproduction isn't required, just genuine overlap. */
function endpointMatches(calledPath: string, method: string, gt: GroundTruth): boolean {
  const normCalled = normalizeEndpointPath(calledPath);
  if (!normCalled) return true;
  return gt.endpoints.some((e) => {
    if (e.method.toUpperCase() !== method.toUpperCase()) return false;
    const normKnown = normalizeEndpointPath(e.pathPattern);
    return normKnown.length > 0 && (normCalled.includes(normKnown) || normKnown.includes(normCalled));
  });
}

/** Same forgiving comparison as endpointMatches(), but returns the matching ObservedEndpoint
 * (rather than a boolean) so formatMockContent() can surface its real captured status/body
 * in place of a statically-guessed one. */
function findObservedEndpoint(
  ctx: TestModeContext,
  method: string,
  pathPattern: string,
): ObservedEndpoint | undefined {
  const normStatic = normalizeEndpointPath(pathPattern);
  if (!normStatic) return undefined;
  return (ctx.exploration?.observedEndpoints ?? []).find((o) => {
    if (o.method.toUpperCase() !== method.toUpperCase()) return false;
    const normObserved = normalizeEndpointPath(o.pathPattern);
    return (
      normObserved.length > 0 && (normStatic.includes(normObserved) || normObserved.includes(normStatic))
    );
  });
}

/**
 * Scan a generated spec's source for selector/role/mock-endpoint references and check each
 * against ground truth actually observed during EXPLORE (or statically detected for mocks).
 * Severity is deliberately split so this can't become a false-positive machine that blocks
 * legitimate generation:
 *   - unrecognized data-testid: HARD only when the inventory was NOT truncated and is
 *     non-empty (i.e. absence is actually provable); otherwise WARN, since we can't prove a
 *     selector doesn't exist against an inventory we know is incomplete.
 *   - unmatched mockOverride endpoint: HARD only when this dependency has endpoint-level
 *     (not just dependency-level) mocks, so there's a real (method, path) list to compare
 *     against; otherwise WARN.
 *   - getByRole(role, {name}) vs. the name's observed role: WARN always — accessible-role
 *     computation is fuzzy enough (implicit ARIA semantics, nested content) that a hard-fail
 *     here risks real false positives.
 *   - getByText(literal-or-regex) with every alternative missing from the observed
 *     accessible-name corpus (link/button/input text — see textMatchesInventory): same
 *     HARD/WARN split as data-testid. Only covers text that lives on an interactive element;
 *     free-standing copy (banners, profile fields) isn't in the inventory at all and so never
 *     produces a HARD finding here — it's unproven, not confirmed grounded.
 * A `// TODO: unobserved element` marker anywhere in the source (the sanctioned ESCAPE HATCH,
 * see formatSnapshotInventory) downgrades every hard finding in this spec to a warning — an
 * acknowledged, intentional gap isn't the same defect as a silent fabrication.
 */
export function findUngroundedReferences(
  source: string,
  gt: GroundTruth,
): { hard: string[]; warn: string[] } {
  const hard: string[] = [];
  const warn: string[] = [];
  const hasEscapeHatch = source.includes(ESCAPE_HATCH_MARKER);
  const inventoryKnown = gt.testids.size > 0 || gt.selectors.size > 0;

  const seenTestids = new Set<string>();
  for (const m of source.matchAll(TESTID_CALL_RE)) seenTestids.add(m[1]);
  for (const m of source.matchAll(TESTID_ATTR_RE)) seenTestids.add(m[1]);
  for (const testid of seenTestids) {
    if (gt.testids.has(testid)) continue;
    const label = `data-testid "${testid}" not found in the observed element inventory`;
    if (inventoryKnown && !gt.inventoryTruncated && !hasEscapeHatch) hard.push(label);
    else warn.push(label);
  }

  for (const m of source.matchAll(ROLE_CALL_RE)) {
    const role = m[1];
    const name = (m[2] ?? m[3] ?? '').trim().toLowerCase();
    if (!name) continue;
    const observedRoles = gt.roleByName.get(name);
    if (!observedRoles || observedRoles.has(role)) continue;
    warn.push(
      `getByRole('${role}', { name: "${name}" }) but the observed role was ${[...observedRoles].join('/')}`,
    );
  }

  for (const m of source.matchAll(TEXT_CALL_RE)) {
    const alternatives = m[1] ? splitTextAlternatives(m[1]) : [normalizeText(m[2] ?? '')];
    const unmatched = alternatives.filter((alt) => alt && !textMatchesInventory(alt, gt));
    // Every alternative must miss — `/zabudli ste heslo|forgot password/i` still legitimately
    // matches an English-language build even if the Slovak alternative never fires.
    if (unmatched.length === 0 || unmatched.length !== alternatives.filter(Boolean).length) continue;
    const label = `getByText("${unmatched.join('|')}") not found in the observed accessible-name inventory`;
    if (inventoryKnown && !gt.inventoryTruncated && !hasEscapeHatch) hard.push(label);
    else warn.push(label);
  }

  for (const m of source.matchAll(MOCK_OVERRIDE_RE)) {
    const method = m[1];
    const path = m[2];
    if (endpointMatches(path, method, gt)) continue;
    const label = `mockOverride('${method}', '${path}') doesn't match any statically-detected endpoint`;
    if (gt.hasEndpointLevelMocks && !hasEscapeHatch) hard.push(label);
    else warn.push(label);
  }

  return { hard, warn };
}

/** Retry note when the grounding-validation gate finds hallucinated selectors/endpoints — lists the specific violations plus a sample of real, available ones so the retry can self-correct. */
function retryNoteUngrounded(hard: string[], gt: GroundTruth): string {
  const sampleSelectors = [...gt.testids].slice(0, 8).map((t) => `data-testid="${t}"`);
  const sampleEndpoints = gt.endpoints.slice(0, 8).map((e) => `${e.method} ${e.pathPattern}`);
  const sampleNames = gt.names.slice(0, 8).map((n) => `"${n}"`);
  const available = [
    sampleSelectors.length > 0 ? `Real testids available: ${sampleSelectors.join(', ')}.` : '',
    sampleEndpoints.length > 0 ? `Real endpoints available: ${sampleEndpoints.join(', ')}.` : '',
    sampleNames.length > 0 ? `Real observed link/button/input text: ${sampleNames.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `Your previous output was rejected because it referenced selectors/endpoints that were never observed: ${hard.join('; ')}. Use ONLY the real selectors/endpoints provided in the prompt context, or the ESCAPE HATCH rule (a text-based locator, or a "${ESCAPE_HATCH_MARKER}" comment) for anything genuinely unobserved — never invent a plausible-sounding data-testid or endpoint path. ${available}`;
}

/** Per-route cap — keeps one busy page (header+footer+nav+form) from starving every other route's budget. */
const MAX_ELEMENTS_PER_ROUTE = 30;
/** Overall ceiling across the whole crawl (keeps the prompt bounded even with many routes). */
const MAX_SNAPSHOT_ELEMENTS = 120;
/** Truncate an accessible name so one pathological element can't bloat the prompt. */
const MAX_ELEMENT_NAME_LEN = 80;
/**
 * Roles the DOM doesn't natively expose as `link`/`button` even though the element is
 * clickable (e.g. a `<div>` with a click handler and no `role` attribute) — the single
 * biggest source of `getByRole('link'/'button', ...)` hallucination in production.
 */
const NON_SEMANTIC_ROLES = new Set(['generic']);

type CrawledRouteLike = NonNullable<TestModeContext['exploration']>['crawl']['routes'][number];
interface SelectedElement {
  route: CrawledRouteLike;
  el: CrawledRouteLike['snapshot']['interactiveElements'][number];
}
interface InventorySelection {
  ordered: CrawledRouteLike[];
  selected: SelectedElement[];
  totalCount: number;
  truncated: boolean;
}

/**
 * Select the interactive-element inventory shown to the model AND checked by the
 * grounding-validation gate (findUngroundedReferences) — the two MUST read from this same
 * function, or the gate could reject a selector the model was never even shown. Applies a
 * per-route cap (MAX_ELEMENTS_PER_ROUTE) so one busy page can't starve every other route's
 * budget, plus an overall ceiling (MAX_SNAPSHOT_ELEMENTS) so a huge crawl can't blow up the
 * prompt. Tier-aware ordering surfaces the most relevant role first: authenticated routes
 * for tierB-auth items, anonymous routes otherwise. Returns an empty selection for the
 * tierC-api tier (must not drive a browser page at all) or when there's no exploration data.
 */
function selectInventoryElements(ctx: TestModeContext, tier: Tier): InventorySelection {
  if (tier === 'tierC-api') return { ordered: [], selected: [], totalCount: 0, truncated: false };
  const routes = ctx.exploration?.crawl.routes ?? [];
  if (routes.length === 0) return { ordered: [], selected: [], totalCount: 0, truncated: false };

  const preferredRole = tier === 'tierB-auth' ? 'authenticated' : 'anonymous';
  const ordered = [...routes].sort(
    (a, b) => Number(b.role === preferredRole) - Number(a.role === preferredRole),
  );

  const selected: SelectedElement[] = [];
  let totalCount = 0;
  for (const route of ordered) {
    let perRouteCount = 0;
    for (const el of route.snapshot.interactiveElements) {
      totalCount += 1;
      if (perRouteCount >= MAX_ELEMENTS_PER_ROUTE || selected.length >= MAX_SNAPSHOT_ELEMENTS) continue;
      selected.push({ route, el });
      perRouteCount += 1;
    }
  }
  return { ordered, selected, totalCount, truncated: totalCount > selected.length };
}

/**
 * Render the interactive-element inventory captured during the multi-page EXPLORE crawl
 * (ctx.exploration) as a compact list, so generation targets REAL selectors instead of
 * guessing. Returns '' when selectInventoryElements() has nothing to show.
 *
 * The wording here is a HARD rule, not a preference — a softer "prefer these real
 * selectors" framing was found (via production runs against a real app) to be routinely
 * ignored by the model, which fabricated its own data-testids/roles instead. Non-semantic
 * elements (role: 'generic' — a clickable <div> with no ARIA role) are annotated inline,
 * since `getByRole('link'/'button', ...)` against one of these is the single biggest
 * observed hallucination pattern. An ESCAPE HATCH is included so a scenario that
 * legitimately targets a state EXPLORE never visited (e.g. content behind a mocked error
 * response) has a sanctioned way out that isn't "invent a selector" — this same marker is
 * recognized by findUngroundedReferences() to avoid penalizing an acknowledged gap.
 */
function formatSnapshotInventory(ctx: TestModeContext, tier: Tier): string {
  const { ordered, selected, totalCount, truncated } = selectInventoryElements(ctx, tier);
  if (selected.length === 0) return '';

  const lines = selected.map(({ route, el }) => {
    const name =
      el.name.length > MAX_ELEMENT_NAME_LEN ? `${el.name.slice(0, MAX_ELEMENT_NAME_LEN)}…` : el.name;
    const genericNote = NON_SEMANTIC_ROLES.has(el.role)
      ? " (NOT a semantic link/button — use text or the selector shown, never getByRole('link'/'button'))"
      : '';
    return `- [${route.role}] ${el.role} "${name}" on ${route.url} -> ${el.selector}${genericNote}`;
  });

  const omitted = totalCount - selected.length;
  const more =
    omitted > 0
      ? `\n(+${omitted} more not shown — do not invent selectors for them; use the ESCAPE HATCH rule if you need one)`
      : '';
  const completeness = truncated
    ? 'This is a PARTIAL inventory (some elements were omitted for length)'
    : 'This is the AUTHORITATIVE, COMPLETE inventory of elements observed for the routes shown';

  return `

Interactive elements observed during exploration across ${ordered.length} route(s). ${completeness}. RULE: you MUST target only selectors, roles, and accessible names that appear in this list — inventing a data-testid, id, role, or accessible name that is not listed here is a HALLUCINATED SELECTOR and is FORBIDDEN, exactly as serious a violation as importing a forbidden module. Elements tagged [authenticated] require the logged-in session (tierB-auth already assumes storageState applies). ESCAPE HATCH: if a scenario needs an element that genuinely isn't in this inventory (e.g. a state only reachable via a mocked error response), do NOT invent a selector — instead use a text-based locator (getByText/:has-text against real visible copy) or, if even that's undeterminable, add a "// TODO: unobserved element" comment and assert a coarser observable signal (URL/status/title) instead:
${lines.join('\n')}${more}`;
}

/**
 * Hash-routed SPAs (React Router HashRouter etc.) often gate content behind
 * an invariant locale/region segment (e.g. "#/SK") observed via the app's own
 * redirect during EXPLORE (see browser/crawler.ts detectRoutePrefix). Without
 * this, generated specs default to a plain path-based page.goto() that never
 * reaches the real route. Returns '' for non-hash apps or when no routing
 * info was captured.
 */
function formatRoutingGuidance(ctx: TestModeContext): string {
  const routing = ctx.exploration?.routing;
  if (!routing?.hashRouted) return '';
  const prefixNote = routing.invariantPrefix
    ? ` with an observed invariant prefix "${routing.invariantPrefix}"`
    : '';
  return `

This app uses hash-based routing${prefixNote}. Preserve any hash URLs shown in the interactive-element inventory above verbatim in page.goto() calls — never replace or guess a different path unless proven by that inventory.`;
}

/** Render a plan item's scenarios as a numbered list for the generation prompt. */
function formatScenarios(scenarios: PlanScenario[]): string {
  return scenarios.map((s, i) => `${i + 1}. [${s.kind}] ${s.description}`).join('\n');
}

/** Cap on a JSON-stringified schema's length injected into the prompt, so one huge spec-derived schema can't blow it up. */
const MAX_SCHEMA_CHARS = 600;

function truncateJson(value: unknown, maxChars: number): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? 'null';
  } catch {
    return 'null';
  }
  return json.length > maxChars ? `${json.slice(0, maxChars)}…` : json;
}

/**
 * Render white-box static-analysis grounding for the plan item's matched source unit (see
 * target/source-index.ts), when one exists: the real source file (with a mandatory `[SRC:...]`
 * citation requirement, enforced by generateOne()'s own gate below — the same closed-loop pattern
 * already used for the `[REQ:...]` tag), authoritative request/response schema + auth-requiredness
 * for spec-derived (provenance: 'spec') units, and any real form fields observed in that file.
 * Returns '' when the item has no unitKey or nothing in sourceContext matches it.
 */
function formatSourceGrounding(ctx: TestModeContext, item: TestPlanItem): string {
  const unit = item.unitKey ? ctx.sourceContext?.units.find((u) => u.key === item.unitKey) : undefined;
  if (!unit) return '';

  const lines: string[] = [
    '',
    '',
    `Source grounding — this feature maps to real source at ${unit.file}${unit.method ? ` (${unit.method})` : ''}.`,
    `You MUST include a comment "// [SRC:${unit.file}]" somewhere in the generated spec, naming this exact file, so its grounding is traceable.`,
  ];

  if (unit.provenance === 'spec') {
    lines.push(
      'This endpoint is defined in an authoritative API spec below — do not invent request/response fields beyond what is shown.',
    );
    if (unit.requestSchema !== undefined)
      lines.push(`Request shape: ${truncateJson(unit.requestSchema, MAX_SCHEMA_CHARS)}`);
    if (unit.responseSchema !== undefined)
      lines.push(`Response shape: ${truncateJson(unit.responseSchema, MAX_SCHEMA_CHARS)}`);
    if (unit.authRequired !== undefined) lines.push(`Auth required: ${unit.authRequired ? 'yes' : 'no'}.`);
  }

  const form = ctx.sourceContext?.forms.find((f) => f.file === unit.file);
  if (form && form.fields.length > 0) {
    const fieldList = form.fields
      .map((f) => `${f.name} (${f.type}${f.required ? ', required' : ''})`)
      .join(', ');
    lines.push(`Real form fields observed in ${unit.file}: ${fieldList}.`);
  }

  return lines.join('\n');
}

function buildPrompt(item: TestPlanItem, ctx: TestModeContext, tier: Tier, retryNote: string | null): string {
  const baseUrl = (ctx.baseUrl ?? '').trim() || 'the application under test';
  const reqTag = item.reqTag ?? item.id;
  const strictNote = retryNote ? `\nIMPORTANT: ${retryNote}` : '';
  const inventory = formatSnapshotInventory(ctx, tier);
  const routingGuidance = formatRoutingGuidance(ctx);
  const sourceGrounding = formatSourceGrounding(ctx, item);
  const scenarios =
    item.scenarios.length > 0 ? item.scenarios : [{ kind: 'positive' as const, description: item.intent }];
  const scenarioList = formatScenarios(scenarios);

  const tierGuidance =
    tier === 'tierC-api'
      ? 'This is an API/backend test: use the `request` fixture (e.g. `await request.get(...)`) and assert on response status/body. Do NOT drive a browser page.'
      : tier === 'tierB-auth'
        ? `This is an authenticated flow: assume the user is already logged in via the configured storageState; verify authenticated UI/behaviour.${formatRoleGuidance(ctx, tier)}`
        : 'This is a public flow requiring no authentication.';

  const importSource = ctx.mockExternalDependencies
    ? MOCK_FIXTURE_IMPORT_PATH
    : ACTION_HIGHLIGHTER_IMPORT_PATH;
  const mockNote = ctx.mockExternalDependencies
    ? `\n- This run mocks some external dependencies; importing test/expect from '${importSource}' (instead of '@playwright/test') already wires up the necessary network interception — use test/expect exactly as you normally would. For a test that needs a SPECIFIC failure scenario for one call (e.g. a 500/401/403/timeout), request the \`mockOverride\` fixture and call it before triggering the request: \`mockOverride('GET', '/the/path', { status: 500, body: {} })\` — do not expect a fixed success response to also produce your error scenario.${formatMockContent(ctx)}`
    : '';

  return `You are generating ONE Playwright test spec file in TypeScript covering ONE feature with
multiple test cases (positive/negative/edge), not just a single check.

Output ONLY the TypeScript source for the spec. No markdown, no code fences, no explanation.

Requirements:
- Begin with: import { test, expect } from '${importSource}';
- Wrap all cases in: test.describe('[REQ:${reqTag}] ${item.title}', () => { ... });
- Output exactly one test(...) per scenario listed below, IN THE SAME ORDER.
- EVERY test(...) title MUST itself start with "[REQ:${reqTag}]" too (not just the describe title),
  followed by its scenario kind, e.g. test('[REQ:${reqTag}] positive: succeeds with valid input', ...).
  This tag on every individual test is REQUIRED for coverage tracking — do not omit it.
- Use relative paths against the configured baseURL (${baseUrl}); call page.goto('/') for the root.
- Every test(...) MUST include at least one concrete expect(...) assertion.
- Wrap each meaningful action or assertion group in test.step('<clear, plain-English description>', async () => { ... }),
  e.g. test.step('Enter a valid email and password', async () => { ... }) or
  test.step('Verify the error message is shown', async () => { ... }) — write the description the way a
  human tester would narrate what they're doing, NOT a restatement of the code (not "Fill input" or
  "Click button"). This becomes the step-by-step breakdown shown in the run report; a test with no
  test.step(...) wrapping still passes, but only Playwright's own generic action log appears instead.
- For a negative/invalid-input scenario, do NOT fill invalid data and then click a submit-like
  control assuming the click succeeds and a validation message appears afterward — many real apps
  correctly disable that control on invalid input, and clicking a disabled control hangs until
  timeout. Either assert the control STAYS disabled (\`await expect(locator).toBeDisabled()\`), or
  assert the inline validation message directly without depending on a successful click.
- Be self-contained and runnable; do not import any other local helpers beyond the one import above.
- When a scenario CREATES a new resource that the app enforces as unique (e.g. registering a user
  by email, creating an account/username), do NOT hardcode a fixed literal value for that unique
  field — embed \`Date.now()\` (or a similarly varying value) in it, e.g.
  \`\`email-\${Date.now()}@example.com\`\`. A fixed value passes once against a real, persistent
  backend and then fails every later re-run with a duplicate/conflict error, since the app correctly
  remembers what earlier runs already created. Scenarios that deliberately test the duplicate/conflict
  path itself should still register their own fresh unique value first, then reuse THAT same value for
  the collision attempt within the same test.
- ${tierGuidance}${mockNote}${strictNote}${inventory}${routingGuidance}${sourceGrounding}

Scenarios to cover, one test(...) each, in this order:
${scenarioList}

Feature: ${item.title}
Feature intent: ${item.intent}
Tier: ${tierLabel(tier)}`;
}

interface GenOneOutcome {
  spec: GeneratedSpec | null;
  reason?: string;
  /** Deny-list violations from the LAST rejected attempt (for the skip event). */
  violations?: string[];
  /**
   * Set only when EVERY attempt failed at the provider-communication level
   * (thrown, or `res.ok === false`) — never once got far enough to validate
   * model output. Distinguishes "the AI produced something we rejected"
   * (normal, not a systemic problem) from "we couldn't reach the provider at
   * all" (see generate()'s ProviderUnavailableError, which resume/checkpoint
   * treats very differently from an ordinary content-validation skip).
   */
  providerFailureDetail?: string;
}

/**
 * Compute a collision-free relative spec path within a tier. Tracks already-used
 * paths and suffixes -2/-3/... on collision so two same-tier items with the same
 * slug both persist to disk instead of overwriting each other.
 */
function uniqueRelPath(tier: Tier, slug: string, usedPaths: Set<string>): string {
  const base = join('tests', tier, slug);
  let rel = `${base}.spec.ts`;
  let n = 2;
  while (usedPaths.has(rel)) {
    rel = `${base}-${n}.spec.ts`;
    n += 1;
  }
  usedPaths.add(rel);
  return rel;
}

async function generateOne(
  ctx: TestModeContext,
  item: TestPlanItem,
  usedPaths: Set<string>,
): Promise<GenOneOutcome> {
  const tier = resolveTier(item.tier);
  const reqTag = item.reqTag ?? item.id;
  const slug = slugify(item.title || item.id);
  const extraAllowedImport = ctx.mockExternalDependencies
    ? MOCK_FIXTURE_IMPORT_PATH
    : ACTION_HIGHLIGHTER_IMPORT_PATH;

  // Carried across attempts: the note explaining WHY the last output was
  // rejected (fed back into the retry prompt) and the last violation list
  // (surfaced in the skip event if the retry fails too).
  let retryNote: string | null = null;
  let lastReason = 'no valid spec with an expect(...) after retry';
  let lastViolations: string[] | undefined;
  // Tracks whether we EVER got far enough to validate model output — cleared
  // the moment a completion succeeds, regardless of what content-validation
  // does with it afterward. Stays set only when every attempt failed before
  // that point (thrown, or ok:false), which is the systemic-outage signal.
  let providerFailureDetail: string | undefined;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let text = '';
    try {
      const res = await ctx.provider.complete(buildPrompt(item, ctx, tier, retryNote), {
        cwd: ctx.repoPath ?? undefined,
        timeoutMs: GEN_TIMEOUT_MS,
        // Codegen must NEVER let the provider agent mutate the user's repo:
        // cwd points INSIDE it for white-box context, and an agentic CLI with
        // default permissions could edit/delete files there. Codex already
        // runs in a read-only sandbox; readOnly closes the Claude side by
        // forcing --permission-mode plan. The spec is written to projectDir by
        // US below — the provider only ever needs to return text.
        readOnly: true,
        signal: ctx.signal,
      });
      ctx.onUsage?.('generate', item.title, ctx.provider.id, res.raw);
      if (!res.ok) {
        emit(ctx, `Codegen provider error for "${item.title}" (attempt ${attempt + 1}): ${res.detail}`);
        providerFailureDetail = res.detail;
        continue;
      }
      providerFailureDetail = undefined;
      text = res.text;
    } catch (err) {
      emit(ctx, `Codegen threw for "${item.title}" (attempt ${attempt + 1}): ${String(err)}`);
      providerFailureDetail = err instanceof Error ? err.message : String(err);
      continue;
    }

    let source = stripCodeFences(text);
    if (!source) {
      continue;
    }
    if (!looksLikePlaywrightSpec(source, extraAllowedImport)) {
      emit(
        ctx,
        `Output for "${item.title}" did not look like a Playwright spec (attempt ${attempt + 1}); retrying`,
      );
      continue;
    }
    if (!hasExpect(source)) {
      // Reject zero-expect specs; the loop retries once with a stricter prompt.
      retryNote = RETRY_NOTE_NO_EXPECT;
      lastReason = 'no valid spec with an expect(...) after retry';
      continue;
    }

    const expectedScenarios = item.scenarios.length || 1;
    const actualTestCases = countTestCases(source);
    if (actualTestCases < expectedScenarios) {
      // Same retry-once-then-skip treatment: a spec covering fewer cases than
      // requested isn't the positive/negative/edge bundle the plan asked for.
      emit(
        ctx,
        `Output for "${item.title}" had ${actualTestCases}/${expectedScenarios} scenario(s) (attempt ${attempt + 1}); retrying`,
      );
      retryNote = retryNoteMissingScenarios(expectedScenarios, actualTestCases);
      lastReason = `only ${actualTestCases}/${expectedScenarios} scenario(s) covered after retry`;
      continue;
    }

    const reqTagOccurrences = countReqTagOccurrences(source, reqTag);
    if (reqTagOccurrences < expectedScenarios) {
      // The tag must be on every individual test(...) title, not just the
      // describe block, so results/coverage-tracking can match each scenario
      // result back to this item (see orchestrator/index.ts persistResults).
      emit(
        ctx,
        `Output for "${item.title}" only tagged ${reqTagOccurrences}/${expectedScenarios} test(s) with [REQ:${reqTag}] (attempt ${attempt + 1}); retrying`,
      );
      retryNote = retryNoteMissingPerTestTag(reqTag);
      lastReason = `[REQ:${reqTag}] missing from individual test titles after retry`;
      continue;
    }

    // Source-citation gate: only enforced when this item actually matched a real
    // source-context unit (formatSourceGrounding only demands the citation in that case) — an
    // item with no unitKey/match has no file to cite, so nothing to gate here.
    const matchedUnit = item.unitKey
      ? ctx.sourceContext?.units.find((u) => u.key === item.unitKey)
      : undefined;
    if (matchedUnit && !hasSrcCitation(source, matchedUnit.file)) {
      emit(
        ctx,
        `Output for "${item.title}" is missing its [SRC:${matchedUnit.file}] citation (attempt ${attempt + 1}); retrying`,
      );
      retryNote = retryNoteMissingSrcCitation(matchedUnit.file);
      lastReason = `missing [SRC:${matchedUnit.file}] citation after retry`;
      continue;
    }

    // Deny-list gate: same retry-once-then-skip treatment as the zero-expect
    // case, but the stricter note lists the concrete violations so the retry
    // can actually fix them.
    const violations = findForbiddenApis(source, extraAllowedImport);
    if (violations.length > 0) {
      emit(
        ctx,
        `Output for "${item.title}" used forbidden APIs (attempt ${attempt + 1}): ${violations.join('; ')}`,
        {
          violations,
        },
      );
      retryNote = retryNoteForbidden(violations, extraAllowedImport ?? '@playwright/test');
      lastReason = `forbidden APIs in generated spec: ${violations.join('; ')}`;
      lastViolations = violations;
      continue;
    }

    // Grounding-validation gate: catches selectors/endpoints the model wrote that don't
    // correspond to anything actually observed during EXPLORE (or statically detected for
    // mocks) — see findUngroundedReferences' doc comment for the hard/warn severity split.
    const groundTruth = collectGroundTruth(ctx, tier);
    const { hard: ungroundedHard, warn: ungroundedWarn } = findUngroundedReferences(source, groundTruth);
    if (ungroundedWarn.length > 0) {
      emit(
        ctx,
        `Output for "${item.title}" has unverifiable selector/endpoint references (attempt ${attempt + 1}, not blocking): ${ungroundedWarn.join('; ')}`,
      );
    }
    if (ungroundedHard.length > 0) {
      emit(
        ctx,
        `Output for "${item.title}" referenced hallucinated selectors/endpoints (attempt ${attempt + 1}): ${ungroundedHard.join('; ')}`,
        { ungrounded: ungroundedHard },
      );
      retryNote = retryNoteUngrounded(ungroundedHard, groundTruth);
      lastReason = `hallucinated selector/endpoint references: ${ungroundedHard.join('; ')}`;
      continue;
    }

    source = ensureReqTag(source, reqTag);
    source = demoteEscapeHatchBlocks(source);
    if (tier === 'tierB-auth') {
      const roles = [...new Set((ctx.credentials ?? []).map((c) => c.role).filter((r): r is string => !!r))];
      const matchedRole = roles.length > 0 ? matchRoleForItem(item, roles) : null;
      if (matchedRole) source = insertRoleStorageState(source, matchedRole);
    }
    if (!source.endsWith('\n')) source += '\n';

    // Resolve a unique path BEFORE writing so same-tier slug collisions don't
    // overwrite each other on disk.
    const relPath = uniqueRelPath(tier, slug, usedPaths);
    const absPath = join(ctx.projectDir, relPath);
    await mkdir(join(ctx.projectDir, 'tests', tier), { recursive: true });
    await writeFile(absPath, source, 'utf-8');

    const title = `[REQ:${reqTag}] ${item.title}`;
    return {
      spec: { path: absPath, title, reqTag, tier, contents: source },
    };
  }

  return { spec: null, reason: lastReason, violations: lastViolations, providerFailureDetail };
}

/** Number of plan items generated concurrently. */
const GEN_CONCURRENCY = 3;

/**
 * Run up to `concurrency` promises at a time from `tasks`. Returns results in
 * the same order as `tasks` regardless of completion order.
 */
async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * For each plan item, ask the provider (read-only) for a single Playwright
 * spec, validate it (must look like a spec, contain >=1 expect, and pass the
 * forbidden-API gate), retry once stricter on failure, write it to
 * tests/<tier>/<slug>.spec.ts, and return the accepted specs.
 *
 * Runs up to GEN_CONCURRENCY items in parallel to increase throughput on
 * plans with many items; per-item order doesn't matter since each spec is
 * independent, but path de-dup (usedPaths) still guarantees unique files.
 */
export async function generate(ctx: TestModeContext, plan: TestPlan): Promise<GeneratedSpec[]> {
  const items = plan.items ?? [];
  emit(ctx, `Generating ${items.length} spec(s) (up to ${GEN_CONCURRENCY} in parallel)`, {
    count: items.length,
  });

  const specs: GeneratedSpec[] = [];
  const usedPaths = new Set<string>();
  let completed = 0;

  // Path de-dup happens inside generateOne (before writeFile) via the shared
  // usedPaths set, so each accepted spec persists to a unique file on disk
  // even when several items are generated at once.
  const tasks = items.map((item, i) => async () => {
    emit(ctx, `Dispatched ${i + 1}/${items.length}: Generating "${item.title}"`, {
      id: item.id,
      tier: item.tier,
    });
    const outcome = await generateOne(ctx, item, usedPaths);
    completed += 1;
    emit(ctx, `Progress: ${completed}/${items.length} done`, { completed, total: items.length });
    return { item, ...outcome };
  });

  const outcomes = await runWithConcurrency(tasks, GEN_CONCURRENCY);

  let lastProviderFailureDetail: string | undefined;
  for (const { item, spec, reason, violations, providerFailureDetail } of outcomes) {
    if (!spec) {
      // Include the violation list so the UI/logs show WHAT was forbidden,
      // not just that the spec was skipped.
      ctx.emit?.('generate', `Skipped "${item.title}": ${reason ?? 'generation failed'}`, {
        id: item.id,
        ...(violations ? { violations } : {}),
      });
      if (providerFailureDetail) lastProviderFailureDetail = providerFailureDetail;
      continue;
    }

    specs.push(spec);
    emit(ctx, `Wrote ${spec.path}`, { title: spec.title });
  }

  // Systemic outage check: every item failed, and NONE of them ever got past
  // the provider-communication stage (every outcome carried a
  // providerFailureDetail — a partial mix of provider- and content-failures
  // is ordinary generation, not this). Only then is this a network/credits
  // interruption worth checkpointing, rather than "the model produced
  // nothing usable," which stays today's normal zero-specs outcome.
  if (
    items.length > 0 &&
    specs.length === 0 &&
    outcomes.every((o) => o.providerFailureDetail !== undefined)
  ) {
    throw new ProviderUnavailableError(
      lastProviderFailureDetail ?? 'Provider unavailable during generation.',
    );
  }

  emit(ctx, `Generation complete: ${specs.length}/${items.length} spec(s) accepted`, {
    accepted: specs.length,
    requested: items.length,
  });
  return specs;
}
