import { appendFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Tier } from '../../storage/types.js';
import type { ObservedEndpoint } from '../../browser/network-capture.js';
import type { GeneratedSpec, PlanScenario, TestModeContext, TestPlan, TestPlanItem } from '../types.js';
import { ProviderUnavailableError } from '../types.js';
import { ABSOLUTE_BACKSTOP_MS } from '../../providers/types.js';
import { TIERS, tierLabel } from './templates.js';
import { splitTestBlocks } from './quality-audit.js';
import {
  buildRequirementTokens,
  NON_SEMANTIC_ROLES,
  rankRouteElements,
} from '../../util/requirement-tokens.js';

// Re-exported for call sites/tests that import it alongside generate() —
// the class itself lives in modes/types.ts since it's shared across modes,
// not Playwright-specific (see that definition for the full rationale).
export { ProviderUnavailableError } from '../types.js';

function emit(ctx: TestModeContext, message: string, data?: unknown): void {
  ctx.emit?.('generate', message, data);
}

const MAX_MOCK_CONTENT_LINES = 20;
// The 'auth' category's static mock body (mock-responses.ts) serializes to ~550 chars —
// 400 would mid-JSON-truncate it in this prompt, which invites the model to invent the
// rest of the shape rather than see the real one.
const MAX_MOCK_BODY_CHARS = 800;

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

/**
 * Surface a detected LOCAL backend's real origin in tierC-api guidance
 * regardless of `mockExternalDependencies` (F-08). Without this, a
 * non-mocked tierC-api item has no visibility into F-04's `local-backend`
 * dependency category and defaults to a relative path against the frontend's
 * `baseURL` — wrong whenever the real backend lives on a different origin.
 */
function formatLocalBackendGuidance(ctx: TestModeContext): string {
  const dep = (ctx.externalDependencies ?? []).find((d) => d.category === 'local-backend' && d.reachable);
  const host = dep?.hostnames?.[0];
  if (!host) return '';
  const origin = `http://${host}`;
  return ` A local backend was detected and confirmed reachable at ${origin} — this is a SEPARATE origin from the frontend's configured baseURL. For tierC-api requests, use this backend's real origin directly instead of a bare relative path: either an absolute URL (e.g. \`await request.get('${origin}/api/...')\`) or a scoped context (\`await request.newContext({ baseURL: '${origin}' })\`). Do NOT assume the frontend's playwright.config.ts baseURL is this backend's origin.`;
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

/** Matches a literal 3xx status assertion, e.g. `expect(response.status()).toBe(302)`. */
const REDIRECT_STATUS_LITERAL_RE = /\.status\(\)\s*\)\.toBe\(\s*3\d\d\s*\)/;
/** Matches a 3xx range-style assertion, e.g. `expect(response.status()).toBeGreaterThanOrEqual(300)`. */
const REDIRECT_STATUS_RANGE_RE = /\.status\(\)\s*\)\.toBeGreaterThanOrEqual\(\s*3\d\d\s*\)/;

/**
 * F-09: a test asserting a 3xx-range status via the `request` fixture is asserting on
 * something Playwright's `request` fixture will never actually let it observe unless the
 * request call itself passes `{ maxRedirects: 0 }` — Playwright auto-follows redirects by
 * default, so without this option the test always sees the FINAL response after every
 * redirect, never the intermediate 3xx it thinks it's checking. Checked per test.describe
 * block (via splitTestBlocks, same primitive demoteEscapeHatchBlocks uses) rather than
 * globally, so one test's 3xx assertion doesn't get satisfied by another test's unrelated
 * `maxRedirects: 0` elsewhere in the same spec file.
 */
function findMissingMaxRedirects(source: string): string[] {
  const findings: string[] = [];
  for (const block of splitTestBlocks(source)) {
    const assertsRedirectStatus =
      REDIRECT_STATUS_LITERAL_RE.test(block.body) || REDIRECT_STATUS_RANGE_RE.test(block.body);
    if (!assertsRedirectStatus) continue;
    if (/maxRedirects\s*:\s*0\b/.test(block.body)) continue;
    findings.push(
      'a test asserts a 3xx-range response status but its request call is missing `{ maxRedirects: 0 }` — without it, Playwright auto-follows the redirect and the test will never actually observe that status',
    );
  }
  return findings;
}

/** Retry note when the previous attempt asserted a 3xx status without `maxRedirects: 0` (F-09). */
function retryNoteMissingMaxRedirects(): string {
  return "Your previous output was rejected because it asserted a 3xx-range response status without passing `{ maxRedirects: 0 }` on the request call. Playwright's `request` fixture auto-follows redirects by default, so without this option your test will always see the FINAL response after the redirect, never the 3xx status itself. Add `maxRedirects: 0` to the SAME request call whose response status you assert against, e.g. `await request.post(url, { maxRedirects: 0, ... })`.";
}

// ---- Grounding-validation gate ------------------------------------------------

/** A marker the model can use (per formatSnapshotInventory's ESCAPE HATCH) to acknowledge an intentionally-unobserved element instead of inventing one — findUngroundedReferences downgrades hard failures to warnings when it's present. */
const ESCAPE_HATCH_MARKER = '// TODO: unobserved element';

/** Matches a test-block opening call (`test(`, `test.only(`, `test.skip(`) at an exact source offset — used to rewrite it to `test.fixme(` in place without disturbing anything else in the block. */
const TEST_OPEN_AT_RE = /test(?:\.(?:only|skip|fixme))?\(/y;

/** Captures the model's own explanation trailing its ESCAPE_HATCH_MARKER comment — the
 * genuinely useful half ("the login form fields were not captured in the inventory for the
 * login route itself") rather than just the fact that something was unobserved. */
// Every gap is [ \t] rather than \s so the capture can never cross the newline and pick up the
// following line of test code as if it were the explanation.
const ESCAPE_HATCH_REASON_RE = /\/\/[ \t]*TODO:[ \t]*unobserved element[ \t]*[-–—:]?[ \t]*([^\r\n]*)/;
/** Keeps one long model comment from dominating a report cell. */
const SKIP_REASON_MAX_LENGTH = 300;

/**
 * Builds the `TestDetails` argument carrying the skip reason as a real Playwright annotation.
 *
 * The reason has to reach Playwright's ANNOTATIONS, not just a source comment: execute.ts's
 * extractSkipReason and report.ts's skip-reason cell both read annotations, so a comment-only
 * marker leaves the report's "why was this skipped" column blank — for what is, in practice,
 * the most common skip cause there is. `JSON.stringify` does the embedding because the text is
 * model-authored and can hold quotes, backslashes, or newlines.
 */
function escapeHatchDetails(body: string): string {
  const detail = ESCAPE_HATCH_REASON_RE.exec(body)?.[1]?.trim() ?? '';
  const full = detail ? `unobserved element — ${detail}` : 'unobserved element — needs review';
  const description =
    full.length > SKIP_REASON_MAX_LENGTH ? `${full.slice(0, SKIP_REASON_MAX_LENGTH - 1)}…` : full;
  return `, { annotation: { type: 'fixme', description: ${JSON.stringify(description)} } }`;
}

/**
 * A test the model itself flagged as built on a guess (the escape-hatch marker anywhere in
 * its body) still passes every other gate and, until now, shipped to execute as an ordinary
 * `test(...)` — indistinguishable in the report from a fully-grounded test, and reliably
 * failing/hanging when the guess is wrong (see docs/fix-backlog.md P1 item 7,
 * "self-healing selectors" — no closed-loop repair exists yet to make good on the guess).
 * Downgrade just that block to `test.fixme(...)` so Playwright reports it as
 * needs-review/skipped rather than a hard failure, while every other test in the same spec
 * (with no marker) ships and runs normally.
 *
 * Also attaches the reason as a Playwright annotation (see escapeHatchDetails) so it survives
 * into the report instead of living only in a source comment no reader of the results ever sees.
 */
export function demoteEscapeHatchBlocks(source: string): string {
  const targets = splitTestBlocks(source).filter((b) => b.body.includes(ESCAPE_HATCH_MARKER));
  if (targets.length === 0) return source;

  let result = source;
  for (const block of [...targets].sort((a, b) => b.start - a.start)) {
    TEST_OPEN_AT_RE.lastIndex = block.start;
    const m = TEST_OPEN_AT_RE.exec(result);
    if (!m || m.index !== block.start) continue;

    // Insert the details argument BEFORE rewriting the opening call: titleEnd sits after
    // block.start, so splicing at the later offset first leaves the earlier one valid. Skipped
    // when the block's first argument isn't a string literal — there's no title to insert after,
    // and the fixme downgrade below still matters more than the annotation.
    if (block.titleEnd !== undefined) {
      result =
        result.slice(0, block.titleEnd) + escapeHatchDetails(block.body) + result.slice(block.titleEnd);
    }

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
  /**
   * lowercased CSS attribute name -> observed value(s) for that attribute, seen anywhere in the
   * selected inventory (see GAP-047). Populated from two sources: (1) attr="value" fragments
   * embedded in a selectorFor()-style selector string (tier-1/2 selectors already look like
   * `input[name="firstName"]`), and (2) each input element's own `type` attribute (via
   * InteractiveElement.inputType), which is known regardless of which selector tier was chosen —
   * a selector referencing a real native `type="email"` shouldn't warn just because the id-based
   * selector path never surfaced `type` textually.
   */
  attributes: Map<string, Set<string>>;
}

/** Pull a `data-testid="..."` (or `data-test="..."`) value out of a selectorFor()-style CSS selector string, if present. */
function extractTestidFromSelector(selector: string): string | null {
  const m = /data-test(?:id)?=["']([^"']+)["']/.exec(selector);
  return m ? m[1] : null;
}

/** attr="value" / attr='value' fragments embedded in a selectorFor()-style CSS selector string (e.g. `input[name="firstName"]`). */
const SELECTOR_ATTR_FRAGMENT_RE = /([\w-]+)=["']([^"']+)["']/g;

/** Record an observed (attr, value) pair into a GroundTruth.attributes-shaped map, lowercasing the attribute name for case-insensitive lookup. */
function addObservedAttribute(attributes: Map<string, Set<string>>, attr: string, value: string): void {
  const key = attr.toLowerCase();
  const values = attributes.get(key) ?? new Set<string>();
  values.add(value);
  attributes.set(key, values);
}

/**
 * Build the ground-truth the grounding-validation gate checks a generated spec against.
 * MUST read from the same selectInventoryElements() the model was actually shown, WITH the same
 * `item` (see that function's doc comment) — otherwise this gate could reject a selector the
 * model never had the option to use. Endpoint ground truth is separate: dependency-level
 * (endpoint-less) mocks don't produce a comparable (method, path) pair, so
 * `hasEndpointLevelMocks` tracks whether a real comparison is even possible for this run.
 */
export function collectGroundTruth(
  ctx: TestModeContext,
  tier: Tier,
  item?: TestPlanItem,
  opts?: InventoryOpts,
): GroundTruth {
  const { selected, truncated } = selectInventoryElements(ctx, tier, item, opts);

  const testids = new Set<string>();
  const selectors = new Set<string>();
  const names: string[] = [];
  const roleByName = new Map<string, Set<string>>();
  const attributes = new Map<string, Set<string>>();
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
    for (const m of el.selector.matchAll(SELECTOR_ATTR_FRAGMENT_RE)) {
      addObservedAttribute(attributes, m[1]!, m[2]!);
    }
    if (el.inputType) addObservedAttribute(attributes, 'type', el.inputType);
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
    attributes,
  };
}

const TESTID_CALL_RE = /getByTestId\(\s*['"]([^'"]+)['"]\s*\)/g;
const TESTID_ATTR_RE = /data-test(?:id)?=["']([^"']+)["']/g;
/** Matches a CSS attribute-selector fragment inside a `page.locator(...)`-style string, e.g. `input[name="firstName"]` or `[type='email']`. Excludes `data-testid`/`data-test`, which are already hard-checked via TESTID_ATTR_RE — see GAP-047. */
const CSS_ATTR_SELECTOR_RE = /\[([\w-]+)=["']([^"']+)["']\]/g;
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
 *   - generic CSS attribute selectors (`input[name="firstName"]`, `[type="email"]`) not matching
 *     any observed (attr, value) pair (see GAP-047): WARN always — attribute selectors are more
 *     guessable/coincidentally-correct than a testid, so this never hard-fails.
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

  // F-07: a BARE getByText(...) whose text is shared by more than one distinct role in the
  // observed inventory (e.g. an <h1> and a <button> with the same visible text) is a
  // guaranteed Playwright strict-mode violation, independent of whether the text is grounded —
  // grounded-but-ambiguous is still broken. Checked as its own pass since it can fire for TEXT
  // that DID match above (this isn't a hallucination, it's an ambiguity). A locator already
  // narrowed with .first()/.nth()/.filter(...) right after the getByText(...) call is exempt.
  for (const m of source.matchAll(TEXT_CALL_RE)) {
    const alternatives = m[1] ? splitTextAlternatives(m[1]) : [normalizeText(m[2] ?? '')];
    const matchEnd = (m.index ?? 0) + m[0].length;
    const tail = source.slice(matchEnd, matchEnd + 40);
    const isNarrowed = /^\s*\)\s*\.\s*(first|nth|filter)\s*\(/.test(tail);
    if (isNarrowed) continue;
    for (const alt of alternatives) {
      if (!alt) continue;
      const roles = gt.roleByName.get(alt);
      if (!roles || roles.size <= 1) continue;
      const label = `getByText("${alt}") is ambiguous — shared by multiple elements with different roles (${[...roles].join('/')}) and WILL throw a Playwright strict-mode violation unless narrowed (e.g. .filter({ hasText: ... }).first(), a role-qualified locator, or .first()/.nth())`;
      if (!hasEscapeHatch) hard.push(label);
      else warn.push(label);
    }
  }

  for (const m of source.matchAll(MOCK_OVERRIDE_RE)) {
    const method = m[1];
    const path = m[2];
    if (endpointMatches(path, method, gt)) continue;
    const label = `mockOverride('${method}', '${path}') doesn't match any statically-detected endpoint`;
    if (gt.hasEndpointLevelMocks && !hasEscapeHatch) hard.push(label);
    else warn.push(label);
  }

  // Generic CSS attribute selectors (`input[name="firstName"]`, `[type="email"]`) — see GAP-047.
  // `data-testid`/`data-test` are skipped here since they're already hard-checked above; checking
  // them again against `gt.attributes` would just double-report the same fabrication. Always
  // WARN, never HARD: an attribute selector is inherently more guessable/coincidentally-correct
  // than a testid (e.g. a legitimately-observed native `type="email"` that just wasn't spelled out
  // in this exact attribute form anywhere else), so hard-failing here risks real false positives.
  for (const m of source.matchAll(CSS_ATTR_SELECTOR_RE)) {
    const attr = m[1]!.toLowerCase();
    if (attr === 'data-testid' || attr === 'data-test') continue;
    const value = m[2]!;
    const observedValues = gt.attributes.get(attr);
    if (observedValues && observedValues.has(value)) continue;
    warn.push(`[${attr}="${value}"] not found in the observed element inventory`);
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
  return `Your previous output was rejected because it referenced selectors/endpoints that were never observed: ${hard.join('; ')}. Use ONLY the real selectors/endpoints provided in the prompt context, or the ESCAPE HATCH rule (a text-based locator, or a "${ESCAPE_HATCH_MARKER}" comment) for anything genuinely unobserved — never invent a plausible-sounding data-testid or endpoint path. ${available} The inventory shown below has been expanded with more elements in case the one you needed was previously omitted for length.`;
}

/** Per-route cap — keeps one busy page (header+footer+nav+form) from starving every other route's budget. */
const MAX_ELEMENTS_PER_ROUTE = 30;
/** Overall ceiling across the whole crawl (keeps the prompt bounded even with many routes). */
const MAX_SNAPSHOT_ELEMENTS = 120;
/** Widened per-route cap used only on a hallucinated-selector retry (see InventoryOpts.expand) — the relevant element the model needed may have sat just past the default cutoff. */
const MAX_ELEMENTS_PER_ROUTE_EXPANDED = 60;
/** Widened overall ceiling used only on a hallucinated-selector retry (see InventoryOpts.expand). */
const MAX_SNAPSHOT_ELEMENTS_EXPANDED = 240;
/** Truncate an accessible name so one pathological element can't bloat the prompt. */
const MAX_ELEMENT_NAME_LEN = 80;
/**
 * Threaded through selectInventoryElements -> formatSnapshotInventory -> buildPrompt and
 * collectGroundTruth -> validateAndPersist so a hallucinated-selector retry (see generateOne) can
 * widen the DOM inventory shown to the model. collectGroundTruth MUST receive the identical opts
 * as the prompt builder for the same attempt — the grounding gate has to validate against exactly
 * what the model was shown, never a narrower or wider inventory.
 */
interface InventoryOpts {
  expand?: boolean;
}

type CrawledRouteLike = NonNullable<TestModeContext['exploration']>['crawl']['routes'][number];
type InventoryElementLike = CrawledRouteLike['snapshot']['interactiveElements'][number];
interface SelectedElement {
  route: CrawledRouteLike;
  el: InventoryElementLike;
}

interface InventorySelection {
  ordered: CrawledRouteLike[];
  selected: SelectedElement[];
  totalCount: number;
  truncated: boolean;
}

/**
 * The route path a plan item's matched unit encodes, when it's a `route`-kind unit (e.g.
 * "route:/checkout" -> "/checkout") — the criterion prompt-trimming filters crawled routes/URLs
 * down to. Returns null for an item with no unitKey, no matching unit, or a non-route unit
 * (endpoint/component units don't correspond to a crawled DOM route by path).
 */
function routePathForItem(ctx: TestModeContext, item: TestPlanItem | undefined): string | null {
  const unit = item?.unitKey ? ctx.sourceContext?.units.find((u) => u.key === item.unitKey) : undefined;
  if (!unit || unit.kind !== 'route') return null;
  return unit.key.replace(/^route:/, '');
}

/**
 * Narrow `routes` down to the ones actually relevant to a plan item, so its prompt isn't padded
 * with the same tier-wide dump every other item in the same tier also gets. Falls back to the
 * FULL list whenever nothing matches (no route path to filter by, or the filter would leave
 * nothing) — grounding must never go from "too much" to "none" just because the match missed.
 */
export function filterRoutesForItem<T extends { url: string }>(routes: T[], routePath: string | null): T[] {
  if (!routePath) return routes;
  const matched = routes.filter((r) => r.url.includes(routePath));
  return matched.length > 0 ? matched : routes;
}

/**
 * Select the interactive-element inventory shown to the model AND checked by the
 * grounding-validation gate (findUngroundedReferences) — the two MUST read from this same
 * function (with the same `item`, when one is passed), or the gate could reject a selector the
 * model was never even shown. Applies a per-route cap (MAX_ELEMENTS_PER_ROUTE) so one busy page
 * can't starve every other route's budget, plus an overall ceiling (MAX_SNAPSHOT_ELEMENTS) so a
 * huge crawl can't blow up the prompt. Tier-aware ordering surfaces the most relevant role first:
 * authenticated routes for tierB-auth items, anonymous routes otherwise. Returns an empty
 * selection for the tierC-api tier (must not drive a browser page at all) or when there's no
 * exploration data.
 *
 * `item`, when passed, narrows the crawled routes to the one(s) its unitKey resolves to (see
 * filterRoutesForItem) BEFORE the tier-wide ordering/selection below runs — so an item's prompt
 * is grounded in what's actually relevant to it, not the same tier-wide dump every other item in
 * the same tier also receives.
 *
 * Within each route, elements are ranked by relevance (rankRouteElements: keyword overlap with
 * `item`'s requirement text, action-verb bonuses, non-semantic-role penalty, locator-stability
 * tier) BEFORE the per-route/global caps below are applied — so a relevant element sitting past
 * the old positional cutoff can still survive truncation. Ties (including the no-`item`/no-signal
 * case) break on original DOM order, so an inventory with no relevance signal degrades to exactly
 * the previous first-K-by-DOM-order behavior.
 */
function selectInventoryElements(
  ctx: TestModeContext,
  tier: Tier,
  item?: TestPlanItem,
  opts?: InventoryOpts,
): InventorySelection {
  if (tier === 'tierC-api') return { ordered: [], selected: [], totalCount: 0, truncated: false };
  const allRoutes = ctx.exploration?.crawl.routes ?? [];
  if (allRoutes.length === 0) return { ordered: [], selected: [], totalCount: 0, truncated: false };
  const routes = filterRoutesForItem(allRoutes, routePathForItem(ctx, item));

  const preferredRole = tier === 'tierB-auth' ? 'authenticated' : 'anonymous';
  const ordered = [...routes].sort(
    (a, b) => Number(b.role === preferredRole) - Number(a.role === preferredRole),
  );

  const perRouteCap = opts?.expand ? MAX_ELEMENTS_PER_ROUTE_EXPANDED : MAX_ELEMENTS_PER_ROUTE;
  const globalCap = opts?.expand ? MAX_SNAPSHOT_ELEMENTS_EXPANDED : MAX_SNAPSHOT_ELEMENTS;
  const reqTokens = buildRequirementTokens(item);
  const selected: SelectedElement[] = [];
  let totalCount = 0;
  for (const route of ordered) {
    let perRouteCount = 0;
    const ranked = rankRouteElements(route, reqTokens, preferredRole);
    for (const el of ranked) {
      totalCount += 1;
      if (perRouteCount >= perRouteCap || selected.length >= globalCap) continue;
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
 *
 * A tier-4 (positional, e.g. nth-of-type) selector gets an inline warning since it's fragile
 * against list/table reordering; when the element also captured a `repeatedRowText` (it sits
 * among repeated siblings, e.g. a table row), the warning suggests a text-anchored
 * `.filter({ hasText: "..." })` pattern instead of trusting the raw index path.
 */
function formatSnapshotInventory(
  ctx: TestModeContext,
  tier: Tier,
  item?: TestPlanItem,
  opts?: InventoryOpts,
): string {
  const { ordered, selected, totalCount, truncated } = selectInventoryElements(ctx, tier, item, opts);
  if (selected.length === 0) return '';

  const lines = selected.map(({ route, el }) => {
    const name =
      el.name.length > MAX_ELEMENT_NAME_LEN ? `${el.name.slice(0, MAX_ELEMENT_NAME_LEN)}…` : el.name;
    const genericNote = NON_SEMANTIC_ROLES.has(el.role)
      ? " (NOT a semantic link/button — use text or the selector shown, never getByRole('link'/'button'))"
      : '';
    const ambiguousNote = el.ambiguousMatch
      ? ' (⚠ AMBIGUOUS: another element on this page shares this exact role+name — a plain getByRole/getByText by role+name WILL throw a strict-mode violation here; use the selector shown, narrow it further, or chain .first()/.nth())'
      : '';
    // A positional path encodes where the element sat on the ONE route it was captured from, so
    // it silently resolves to nothing (or worse, to something else) on any other route. The same
    // logical control genuinely appears in this inventory more than once with DIFFERENT paths —
    // observed live: one "apple wallet" control listed as `div:nth-of-type(2) > …` on the vouchers
    // route and `div:nth-of-type(6) > …` on the dashboard. A generated test picked one path and
    // used it on the other route, so `toBeVisible()` failed on an element that was really there.
    // Stating the route restriction inline is what the plain "prefer a better anchor" advice was
    // missing, since the route is printed on every line but never flagged as a constraint.
    const routeScopedNote =
      el.selectorTier === 4
        ? ` — this path is valid ONLY on ${el.name ? `this route (${route.url})` : route.url}; if another line lists the same element on a different route, its path differs and is NOT interchangeable`
        : '';
    const tierNote =
      el.selectorTier === 4
        ? el.repeatedRowText
          ? ` (⚠ POSITIONAL selector among repeated rows — prefer anchoring on this row's own text instead, e.g. .filter({ hasText: "${el.repeatedRowText.slice(0, 60)}" }), rather than trusting the index if the list can reorder${routeScopedNote})`
          : ` (⚠ POSITIONAL selector — fragile if this element's position among its siblings can change; prefer a more specific attribute/text anchor when one is available above${routeScopedNote})`
        : '';
    // A readonly field is visible and enabled, so nothing else in this line hints that filling
    // it is impossible — and a .fill() against one does not fail fast, it retries "element is
    // not editable" until the test's whole timeout is gone.
    const readOnlyNote = el.readOnly
      ? ' (⚠ READONLY — this field cannot be typed into; a .fill()/.type() here will retry until the test times out. It is gated by the app (a precondition elsewhere in the flow unlocks it), so drive that precondition first, or assert its value/state instead of writing to it)'
      : '';
    return `- [${route.role}] ${el.role} "${name}" on ${route.url} -> ${el.selector}${genericNote}${ambiguousNote}${tierNote}${readOnlyNote}`;
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

Interactive elements observed during exploration across ${ordered.length} route(s). ${completeness}. RULE: you MUST target only selectors, roles, and accessible names that appear in this list — inventing a data-testid, id, role, or accessible name that is not listed here is a HALLUCINATED SELECTOR and is FORBIDDEN, exactly as serious a violation as importing a forbidden module. This also means using the selector shown EXACTLY as given — do NOT modify it, combine it with your own guessed parent/child CSS combinator (e.g. turning a real "#checkbox" into an invented "#checkbox > input"), or otherwise assume a DOM nesting relationship you were not shown; the string after "->" is already the complete, correct selector for that exact element. Elements tagged [authenticated] require the logged-in session (tierB-auth already assumes storageState applies). ESCAPE HATCH: if a scenario needs an element that genuinely isn't in this inventory (e.g. a state only reachable via a mocked error response), do NOT invent a selector — instead use a text-based locator (getByText/:has-text against real visible copy) or, if even that's undeterminable, add a "// TODO: unobserved element" comment and assert a coarser observable signal (URL/status/title) instead:
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

/** Cap on distinct route URLs listed, so a large crawl can't blow up the prompt. */
const MAX_ROUTES_LISTED = 30;

/**
 * Real URLs actually visited during EXPLORE — grounds toHaveURL()/navigation assertions in
 * what the app really does, not a guessed conventional path. A recurring real-data failure
 * pattern this closes: a generated test asserting `toHaveURL(/register/)` or a redirect to
 * "/" when the real app actually uses "/signup" or "/signin" for the same concept — the model
 * guessed a common convention instead of using the route this list already contains. Returns
 * '' when no exploration data exists (e.g. tierC-api, or a black-box run with nothing crawled).
 */
function formatObservedRoutes(ctx: TestModeContext, item?: TestPlanItem): string {
  const allRoutes = ctx.exploration?.crawl.routes ?? [];
  if (allRoutes.length === 0) return '';
  const routes = filterRoutesForItem(allRoutes, routePathForItem(ctx, item));
  const urls = Array.from(new Set(routes.map((r) => r.url)));
  const shown = urls.slice(0, MAX_ROUTES_LISTED);
  const omitted = urls.length - shown.length;
  const more = omitted > 0 ? ` (+${omitted} more not shown)` : '';
  return `

Real URLs observed during exploration${more}: ${shown.join(', ')}. RULE: when asserting a navigation target (toHaveURL, expect(page).toHaveURL, etc.), use one of these real observed URLs/paths, or a regex scoped only to what you're sure of (e.g. that the path changed away from the current one) — do NOT guess a conventional path (e.g. "/register", "/login", "/") for a concept the app might name differently (e.g. it actually uses "/signup", "/signin"); this list is authoritative over any naming convention.`;
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
function formatSourceGrounding(ctx: TestModeContext, item: TestPlanItem, tier: Tier): string {
  const unit = item.unitKey ? ctx.sourceContext?.units.find((u) => u.key === item.unitKey) : undefined;
  if (!unit) return '';

  const lines: string[] = [
    '',
    '',
    `Source grounding — this feature maps to real source at ${unit.file}${unit.method ? ` (${unit.method})` : ''}.`,
    `You MUST include a comment "// [SRC:${unit.file}]" somewhere in the generated spec, naming this exact file, so its grounding is traceable.`,
  ];

  // Real-data-traced bug: a tierC-api item can get matched to a frontend `route`/`component`
  // unit (e.g. a React Router path from AppRouter.tsx) rather than a real backend `endpoint` —
  // the unit is legitimately grounded (the file IS real), but it serves HTML/JS navigation, not
  // a JSON API. Without this warning the model happily calls `request.get(unit.file's path)`
  // expecting the feature's described JSON payload and gets an empty/unrelated response instead.
  if (tier === 'tierC-api' && unit.kind !== 'endpoint') {
    lines.push(
      `WARNING: this source unit is a ${unit.kind === 'route' ? 'frontend client-side route (React Router/page navigation)' : 'frontend component'}, NOT a confirmed backend REST endpoint — it may only serve the app's HTML/JS shell, not JSON data. Do NOT assume a raw HTTP request (the \`request\` fixture) to this exact path returns the JSON payload described in this feature's intent unless a real backend endpoint/controller/spec confirms it elsewhere in this prompt — if nothing confirms it, treat the request/response shape as unknown and assert only what you can verify (e.g. that the request doesn't 500), rather than specific fields you're guessing at.`,
    );
  }

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

function buildPrompt(
  item: TestPlanItem,
  ctx: TestModeContext,
  tier: Tier,
  retryNote: string | null,
  opts?: InventoryOpts,
): string {
  const baseUrl = (ctx.baseUrl ?? '').trim() || 'the application under test';
  const reqTag = item.reqTag ?? item.id;
  // Appended at the very end of the returned prompt (not interpolated here)
  // so a retry's prompt stays an exact byte-for-byte extension of the
  // previous attempt's prompt — that lets Anthropic's prefix-based prompt
  // cache hit on retry instead of the note splicing mid-string and breaking
  // the shared prefix between attempt 1 and attempt 2. This invariant only
  // holds for the non-expanded retry path — an expand:true retry necessarily
  // shows a different (wider) inventory, so its prompt is not a byte-for-byte
  // extension of attempt 1's; that's an accepted, deliberate tradeoff, not a bug.
  const strictNote = retryNote ? `\n\nIMPORTANT: ${retryNote}` : '';
  const inventory = formatSnapshotInventory(ctx, tier, item, opts);
  const routingGuidance = formatRoutingGuidance(ctx);
  const observedRoutes = formatObservedRoutes(ctx, item);
  const sourceGrounding = formatSourceGrounding(ctx, item, tier);
  const scenarios =
    item.scenarios.length > 0 ? item.scenarios : [{ kind: 'positive' as const, description: item.intent }];
  const scenarioList = formatScenarios(scenarios);

  const tierGuidance =
    tier === 'tierC-api'
      ? `This is an API/backend test: use the \`request\` fixture (e.g. \`await request.get(...)\`) and assert on response status/body. Do NOT drive a browser page. NEVER assert a specific status code (2xx, 3xx, 4xx, or 5xx) for ANY endpoint unless it is directly grounded — by the source/schema grounding below, by a real observed request/response in the routes or mock content above, or by an explicit statement in the feature intent/scenario description. A guessed status code is one of the single biggest causes of false test failures. In particular: (1) For a negative/invalid-input/unauthorized scenario, do NOT assume a "success-shaped" status (e.g. 200 with an error body) — many apps respond to a failed form-based auth with a redirect (302/303) rather than 200, and to a failed API auth with 401/403. (2) Do NOT assume a bare path triggers special behavior (a redirect, a specific response) that actually requires a query string, request body, or header seen only on a DIFFERENT observed URL for the same feature — a redirect/action endpoint commonly only activates with specific parameters, and the bare path just serves a normal 200 page; use the exact URL (including its query string) from the observed routes above, never a stripped-down guess. When you lack real grounding for the exact status, assert what you can be sure of instead (e.g. \`expect(response.status()).not.toBe(200)\`, a 3xx/4xx range check, or a documented error field) rather than guessing one fixed status code. For a file-upload endpoint, use the \`multipart\` option on the request call (e.g. \`await request.post(url, { multipart: { file: { name: "x.txt", mimeType: "text/plain", buffer: Buffer.from("...") } } })\`) — never pass a raw Node stream/fs.ReadStream or a hand-built multipart body as the request payload, which throws at runtime rather than failing a real assertion.${formatLocalBackendGuidance(ctx)}`
      : tier === 'tierB-auth'
        ? `This is an authenticated flow: assume the user is already logged in via the configured storageState; verify authenticated UI/behaviour.${formatRoleGuidance(ctx, tier)}`
        : 'This is a public flow requiring no authentication.';

  const importSource = ctx.mockExternalDependencies
    ? MOCK_FIXTURE_IMPORT_PATH
    : ACTION_HIGHLIGHTER_IMPORT_PATH;
  const mockNote = ctx.mockExternalDependencies
    ? `\n- This run mocks some external dependencies; importing test/expect from '${importSource}' (instead of '@playwright/test') already wires up the necessary network interception — use test/expect exactly as you normally would. For a test that needs a SPECIFIC failure scenario for one call (e.g. a 500/401/403/timeout), request the \`mockOverride\` fixture and call it before triggering the request: \`mockOverride('GET', '/the/path', { status: 500, body: {} })\` — do not expect a fixed success response to also produce your error scenario. CRITICAL: the mock matches ONLY by method + path — it never inspects headers, tokens, or the request body, so it CANNOT organically reject a missing/invalid Authorization header, an unauthorized role, or cross-tenant/ownership access with a 401/403/404. If a scenario asserts that kind of rejection, you MUST call \`mockOverride(...)\` with that exact status first, or the mock will silently return its default success response and the assertion will fail every time — this is true even for a request you never customized before.${formatMockContent(ctx)}`
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
- After EVERY page.goto(...) (or a click that navigates), before interacting with any page-specific
  element, verify the navigation actually landed on a real, expected page — not a 404/error/blank
  page — using a SHORT, bounded check (e.g. \`await expect(page.locator('body')).not.toContainText('Not Found', { timeout: 3000 })\`,
  or asserting an element from the inventory that should always be present on that page). Skipping
  this is the single biggest cause of a mysterious full-timeout hang: if navigation silently lands on
  the wrong page (a transient server error, a redirect you didn't expect, a typo'd path), every
  subsequent locator for that page's real elements will never resolve, and the test burns the ENTIRE
  default test timeout (tens of seconds) waiting on something that will never appear, instead of
  failing fast with a clear, diagnosable reason.
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
- Do NOT assert a tight, arbitrary hardcoded duration/performance threshold (e.g.
  \`expect(elapsedMs).toBeLessThan(200)\`) for how fast an action completes — real environments
  (CI machines, headless vs. headed, network conditions) vary widely in speed, making this
  assertion flaky/brittle regardless of whether the app works correctly. Verify the OUTCOME of an
  action (e.g. the swap/update actually happened) using Playwright's own built-in waiting/retry
  behavior instead of a manual millisecond comparison.
- Before calling a single-target action (click/fill/check/dblclick/selectOption/hover) on a locator,
  make sure it can only match ONE element on the real page — Playwright throws a strict-mode
  violation (and the test fails) if the locator resolves to more than one match. A bare
  \`getByRole('link'/'button'/etc.)\`, a short \`getByText(...)\`, or a class/tag CSS selector are the
  ones most likely to collide with another real element. Narrow it with a distinguishing
  \`{ name: ... }\`/\`{ exact: true }\` filter, a more specific visible text/data-testid/id, or chain
  \`.first()\`/\`.nth()\` when you intend a specific match — only rely on an unscoped locator when the
  inventory above shows it is the sole element of that role/name on the page.
- Be self-contained and runnable; do not import any other local helpers beyond the one import above.
- When a scenario CREATES a new resource that the app enforces as unique (e.g. registering a user
  by email, creating an account/username), do NOT hardcode a fixed literal value for that unique
  field — embed \`Date.now()\` (or a similarly varying value) in it, e.g.
  \`\`email-\${Date.now()}@example.com\`\`. A fixed value passes once against a real, persistent
  backend and then fails every later re-run with a duplicate/conflict error, since the app correctly
  remembers what earlier runs already created. Scenarios that deliberately test the duplicate/conflict
  path itself should still register their own fresh unique value first, then reuse THAT same value for
  the collision attempt within the same test.
- ${tierGuidance}${mockNote}${inventory}${routingGuidance}${observedRoutes}${sourceGrounding}

Scenarios to cover, one test(...) each, in this order:
${scenarioList}

Feature: ${item.title}
Feature intent: ${item.intent}
Tier: ${tierLabel(tier)}${strictNote}`;
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

// ---- Write-through per-item checkpoint (mirrors execute.ts's write-through
// per-test checkpoint — see templates.ts's checkpointReporterContents() for
// the rationale). GENERATE has no separate subprocess/reporter the way
// EXECUTE does (every call here happens in-process), so the read/append/clear
// helpers live directly alongside the code that produces each item's outcome. ----

/** File name for GENERATE's own write-through checkpoint, at the suite project root (alongside EXEC_CHECKPOINT_FILENAME). */
export const GEN_CHECKPOINT_FILENAME = 'healix-generate-checkpoint.ndjson';

/**
 * One plan item's FINAL generation outcome, persisted the moment it's decided
 * (see recordGenOutcome) instead of only after the whole GENERATE phase
 * returns. Without this, a crash mid-phase loses every item's progress even
 * though their spec FILES already survived on disk — resume would have to
 * re-ask the AI for all of them again, batches it had already paid for
 * included. 'skipped' is recorded only for an item that exhausted its retries
 * under NORMAL operation (content genuinely rejected); an item still in
 * flight when a pause/abort hits is deliberately left unrecorded (see
 * recordGenOutcome) so it's retried fresh next time, not written off.
 */
export interface GenCheckpointEntry {
  itemId: string;
  title: string;
  reqTag: string;
  tier: Tier;
  status: 'generated' | 'skipped';
  /** Absolute path to the written spec file — only present when status === 'generated'. */
  specPath?: string;
  /** The reqTag-prefixed report title (matches GeneratedSpec.title) — only present when status === 'generated'. */
  specTitle?: string;
  /** Why the item was skipped — only present when status === 'skipped'. */
  reason?: string;
}

function genCheckpointFilePath(projectDir: string): string {
  return join(projectDir, GEN_CHECKPOINT_FILENAME);
}

/** Best-effort read; a missing/corrupt file just means "nothing finished yet" — same tolerance as execute.ts's readCheckpointEntries. */
export async function readGenerateCheckpointEntries(projectDir: string): Promise<GenCheckpointEntry[]> {
  let raw: string;
  try {
    raw = await readFile(genCheckpointFilePath(projectDir), 'utf-8');
  } catch {
    return [];
  }
  const byId = new Map<string, GenCheckpointEntry>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as GenCheckpointEntry;
      if (entry && typeof entry.itemId === 'string') byId.set(entry.itemId, entry);
    } catch {
      // One malformed line (e.g. a write truncated by the same crash this file exists to survive)
      // must not lose every other entry in it.
    }
  }
  return [...byId.values()];
}

// Serializes appends per projectDir: GEN_CONCURRENCY runs multiple batch tasks
// concurrently IN THIS SAME PROCESS (unlike execute.ts's reporter, which is
// naturally serialized by Playwright's single main-process reporter model), so
// without this queue two concurrent appendFile calls could interleave partial
// writes to the same file.
const appendQueues = new Map<string, Promise<void>>();

async function appendGenerateCheckpointEntry(projectDir: string, entry: GenCheckpointEntry): Promise<void> {
  const line = `${JSON.stringify(entry)}\n`;
  const prior = appendQueues.get(projectDir) ?? Promise.resolve();
  const next = prior
    .then(() => appendFile(genCheckpointFilePath(projectDir), line, 'utf-8'))
    .catch(() => {
      // best-effort — never fail generation over a checkpoint write
    });
  appendQueues.set(projectDir, next);
  await next;
}

/** Best-effort cleanup once generate() completes without being interrupted — nothing left to resume. */
export async function clearGenerateCheckpoint(projectDir: string): Promise<void> {
  await unlink(genCheckpointFilePath(projectDir)).catch(() => {});
}

/**
 * Records an item's outcome as FINAL, unless a pause/abort is the reason
 * we're looking at it right now — in which case nothing is written, so the
 * item is retried fresh (not written off as permanently skipped) the next
 * time generate() runs. This is the per-item analogue of execute.ts's
 * `cmd.aborted || ctx.signal?.aborted` check gating its own checkpoint logic.
 */
async function recordGenOutcome(
  ctx: TestModeContext,
  item: TestPlanItem,
  outcome: GenOneOutcome,
): Promise<void> {
  if (ctx.signal?.aborted) return;
  const entry: GenCheckpointEntry = {
    itemId: item.id,
    title: item.title,
    reqTag: item.reqTag ?? item.id,
    tier: resolveTier(item.tier),
    status: outcome.spec ? 'generated' : 'skipped',
    ...(outcome.spec ? { specPath: outcome.spec.path, specTitle: outcome.spec.title } : {}),
    ...(!outcome.spec && outcome.reason ? { reason: outcome.reason } : {}),
  };
  await appendGenerateCheckpointEntry(ctx.projectDir, entry);
}

/** Reconstructs a GeneratedSpec for an already-finished item from an earlier, interrupted generate() call — by re-reading its spec file rather than re-asking the AI. Returns null (best-effort) if the file is gone or the entry wasn't a 'generated' one. */
async function restoreGeneratedSpec(entry: GenCheckpointEntry): Promise<GeneratedSpec | null> {
  if (entry.status !== 'generated' || !entry.specPath || !entry.specTitle) return null;
  try {
    const contents = await readFile(entry.specPath, 'utf-8');
    return { path: entry.specPath, title: entry.specTitle, reqTag: entry.reqTag, tier: entry.tier, contents };
  } catch {
    return null;
  }
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

/** Result of validateAndPersist: either an accepted, on-disk spec, or enough detail (reason,
 * violations, a ready-to-use retryNote, and any non-blocking grounding warnings) for a caller to
 * decide whether/how to retry. */
interface ValidationOutcome {
  spec: GeneratedSpec | null;
  reason?: string;
  violations?: string[];
  /** Present whenever a re-attempt could plausibly do better with this fed back into the prompt. */
  retryNote?: string;
  /** Non-blocking grounding-gate findings (see findUngroundedReferences), regardless of pass/fail. */
  ungroundedWarn?: string[];
  /**
   * Set when rejection was specifically the grounding-validation gate (a hallucinated
   * selector/endpoint), as opposed to any other rejection reason (missing citation, forbidden
   * API, wrong scenario count, etc). generateOne keys off this typed flag — rather than
   * string-matching `reason` — to decide whether the next attempt should widen the DOM inventory
   * (see InventoryOpts.expand).
   */
  hallucinated?: boolean;
  /**
   * True when this item's DOM inventory (post selectInventoryElements, at the SAME expand
   * setting as this attempt) had to omit elements for length — there was more real context not
   * shown. F-10: generateOne widens the retry inventory whenever a rejection happens AND this is
   * true, regardless of rejection reason — not just on a hallucinated-selector rejection — since a
   * thin/truncated inventory is just as plausibly the root cause of any other rejection reason.
   */
  inventoryTruncated?: boolean;
}

/**
 * The full validation-gate chain (spec-shape, expect count, scenario count, [REQ:...] tagging,
 * [SRC:...] citation, forbidden-API deny-list, grounding-validation) plus the on-success
 * transforms (ensureReqTag, demoteEscapeHatchBlocks, tierB-auth storageState insertion) and
 * disk-write — given raw model OUTPUT TEXT for exactly one item, decides whether it's acceptable
 * and, if so, persists it. Deliberately takes no knowledge of "attempt number" or retry looping —
 * that's the caller's concern (generateOne's single-item loop, or the batch path's per-item
 * solo-retry) — so this same gate serves both without duplicating any of these checks.
 */
async function validateAndPersist(
  ctx: TestModeContext,
  item: TestPlanItem,
  text: string,
  usedPaths: Set<string>,
  opts?: InventoryOpts,
): Promise<ValidationOutcome> {
  const tier = resolveTier(item.tier);
  const reqTag = item.reqTag ?? item.id;
  const slug = slugify(item.title || item.id);
  const extraAllowedImport = ctx.mockExternalDependencies
    ? MOCK_FIXTURE_IMPORT_PATH
    : ACTION_HIGHLIGHTER_IMPORT_PATH;
  // Computed once up front (not just at the grounding gate further down) so EVERY rejection
  // reason — not only a hallucinated selector — can report whether this attempt's inventory was
  // truncated (see ValidationOutcome.inventoryTruncated, F-10).
  const groundTruth = collectGroundTruth(ctx, tier, item, opts);
  const inventoryTruncated = groundTruth.inventoryTruncated;

  let source = stripCodeFences(text);
  if (!source) {
    return { spec: null, reason: 'empty output', inventoryTruncated };
  }
  if (!looksLikePlaywrightSpec(source, extraAllowedImport)) {
    return { spec: null, reason: 'did not look like a Playwright spec', inventoryTruncated };
  }
  if (!hasExpect(source)) {
    return {
      spec: null,
      reason: 'no valid spec with an expect(...)',
      retryNote: RETRY_NOTE_NO_EXPECT,
      inventoryTruncated,
    };
  }

  const expectedScenarios = item.scenarios.length || 1;
  const actualTestCases = countTestCases(source);
  if (actualTestCases < expectedScenarios) {
    return {
      spec: null,
      reason: `only ${actualTestCases}/${expectedScenarios} scenario(s) covered`,
      retryNote: retryNoteMissingScenarios(expectedScenarios, actualTestCases),
      inventoryTruncated,
    };
  }

  const reqTagOccurrences = countReqTagOccurrences(source, reqTag);
  if (reqTagOccurrences < expectedScenarios) {
    // The tag must be on every individual test(...) title, not just the describe block, so
    // results/coverage-tracking can match each scenario result back to this item.
    return {
      spec: null,
      reason: `[REQ:${reqTag}] missing from individual test titles`,
      retryNote: retryNoteMissingPerTestTag(reqTag),
      inventoryTruncated,
    };
  }

  // Source-citation gate: only enforced when this item actually matched a real
  // source-context unit (formatSourceGrounding only demands the citation in that case) — an
  // item with no unitKey/match has no file to cite, so nothing to gate here.
  const matchedUnit = item.unitKey ? ctx.sourceContext?.units.find((u) => u.key === item.unitKey) : undefined;
  if (matchedUnit && !hasSrcCitation(source, matchedUnit.file)) {
    return {
      spec: null,
      reason: `missing [SRC:${matchedUnit.file}] citation`,
      retryNote: retryNoteMissingSrcCitation(matchedUnit.file),
      inventoryTruncated,
    };
  }

  // Deny-list gate.
  const violations = findForbiddenApis(source, extraAllowedImport);
  if (violations.length > 0) {
    return {
      spec: null,
      reason: `forbidden APIs in generated spec: ${violations.join('; ')}`,
      violations,
      retryNote: retryNoteForbidden(violations, extraAllowedImport ?? '@playwright/test'),
      inventoryTruncated,
    };
  }

  // F-09: a tierC-api spec asserting a 3xx status must pass maxRedirects: 0 on the same
  // request call, or the assertion can never actually observe that status.
  if (tier === 'tierC-api') {
    const missingMaxRedirects = findMissingMaxRedirects(source);
    if (missingMaxRedirects.length > 0) {
      return {
        spec: null,
        reason: `redirect assertion missing maxRedirects: 0: ${missingMaxRedirects.join('; ')}`,
        retryNote: retryNoteMissingMaxRedirects(),
        inventoryTruncated,
      };
    }
  }

  // Grounding-validation gate: catches selectors/endpoints the model wrote that don't
  // correspond to anything actually observed during EXPLORE (or statically detected for
  // mocks) — see findUngroundedReferences' doc comment for the hard/warn severity split.
  const { hard: ungroundedHard, warn: ungroundedWarn } = findUngroundedReferences(source, groundTruth);
  if (ungroundedHard.length > 0) {
    return {
      spec: null,
      reason: `hallucinated selector/endpoint references: ${ungroundedHard.join('; ')}`,
      retryNote: retryNoteUngrounded(ungroundedHard, groundTruth),
      ungroundedWarn,
      hallucinated: true,
      inventoryTruncated,
    };
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
    ungroundedWarn: ungroundedWarn.length > 0 ? ungroundedWarn : undefined,
  };
}

async function generateOne(
  ctx: TestModeContext,
  item: TestPlanItem,
  usedPaths: Set<string>,
): Promise<GenOneOutcome> {
  const tier = resolveTier(item.tier);

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
  // Set once attempt 0 is rejected specifically for a hallucinated selector/endpoint (see
  // ValidationOutcome.hallucinated) — the very next attempt then widens the DOM inventory shown
  // (InventoryOpts.expand), since the element the model needed may have simply sat past the
  // default per-route/global cutoff rather than being genuinely unobserved.
  let expandInventory = false;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const inventoryOpts: InventoryOpts | undefined = expandInventory ? { expand: true } : undefined;
    let text = '';
    try {
      const res = await ctx.provider.complete(buildPrompt(item, ctx, tier, retryNote, inventoryOpts), {
        cwd: ctx.repoPath ?? undefined,
        timeoutMs: ABSOLUTE_BACKSTOP_MS,
        // Codegen must NEVER let the provider agent mutate the user's repo:
        // cwd points INSIDE it for white-box context, and an agentic CLI with
        // default permissions could edit/delete files there. Codex already
        // runs in a read-only sandbox; readOnly closes the Claude side by
        // forcing --permission-mode plan. The spec is written to projectDir by
        // US below — the provider only ever needs to return text.
        readOnly: true,
        signal: ctx.signal,
        taskType: 'codegen',
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

    const validated = await validateAndPersist(ctx, item, text, usedPaths, inventoryOpts);
    if (validated.ungroundedWarn && validated.ungroundedWarn.length > 0) {
      emit(
        ctx,
        `Output for "${item.title}" has unverifiable selector/endpoint references (attempt ${attempt + 1}, not blocking): ${validated.ungroundedWarn.join('; ')}`,
      );
    }
    if (validated.spec) {
      return { spec: validated.spec };
    }

    emit(ctx, `Output for "${item.title}" rejected (attempt ${attempt + 1}): ${validated.reason}; retrying`, {
      ...(validated.violations ? { violations: validated.violations } : {}),
    });
    retryNote = validated.retryNote ?? null;
    lastReason = validated.reason ? `${validated.reason} after retry` : lastReason;
    lastViolations = validated.violations ?? lastViolations;
    // F-10: widen on ANY rejection when this attempt's inventory was truncated, not just a
    // hallucinated-selector rejection — a thin/truncated inventory is just as plausibly the root
    // cause of a missing-expect, forbidden-API, or any other rejection reason.
    if (validated.hallucinated || validated.inventoryTruncated) expandInventory = true;
  }

  return { spec: null, reason: lastReason, violations: lastViolations, providerFailureDetail };
}

/** Recursion guard for the halve-and-retry split on total batch parse failure — mirrors runPlanPhase's PLAN_MAX_SPLIT_DEPTH shape (orchestrator/index.ts) for a truncated plan batch. */
const GEN_MAX_SPLIT_DEPTH = 3;
/** Target sum of scenario-weight (see binPackByScenarioWeight) per generation batch. Tunable, not final. */
const GEN_BATCH_SCENARIO_WEIGHT_BUDGET = 12;
/** Hard item-count cap per batch regardless of scenario weight, as a structural safety net. Tunable, not final. */
const GEN_BATCH_MAX_ITEMS = 8;
/** Share of a tier's parseable-unitKey items a route segment-1 value must cover to be treated as a shared namespace/role/API-mount prefix (e.g. "api", "maltora-seller") rather than a real feature boundary — see routeClusterKey. Tunable, not final. */
const GEN_DOMINANT_PREFIX_THRESHOLD = 0.4;
/**
 * Minimum number of same-tier parseable items that must NOT share a candidate's segment-1 value,
 * required in addition to GEN_DOMINANT_PREFIX_THRESHOLD before that value is treated as a
 * namespace/mount prefix (see GAP-048). A real mount prefix like "api"/"maltora-seller" dominates
 * across a large, feature-diverse route population, so plenty of non-matching items are always
 * around to validate the classification against. A small, incidentally single-feature-heavy tier
 * (e.g. 10 items, 6 of them under "login") can cross the share threshold too, but with too few
 * "other" items for that to mean anything — this floor exists specifically to reject that case
 * without weakening the real namespace-prefix detection. Tunable, not final.
 */
const GEN_DOMINANT_PREFIX_MIN_OTHER_ITEMS = 5;

/**
 * Parses a plan item's unitKey into path segments for clustering, tolerating both the
 * "route:"/"endpoint:<METHOD> " prefixed convention and bare paths (real stored plans persist
 * both — see buildGenerationBatches doc comment). Returns null for anything that isn't a
 * route/endpoint unit (e.g. "component:..." keys) or has no unitKey at all.
 */
function unitKeySegments(unitKey: string | undefined): string[] | null {
  if (!unitKey) return null;
  let rest = unitKey;
  if (rest.startsWith('route:')) {
    rest = rest.slice('route:'.length);
  } else if (rest.startsWith('endpoint:')) {
    const spaceIdx = rest.indexOf(' ');
    rest = spaceIdx >= 0 ? rest.slice(spaceIdx + 1) : rest.slice('endpoint:'.length);
  } else if (!rest.startsWith('/')) {
    // Not a bare path and not a recognized route/endpoint prefix (e.g. "component:Foo") —
    // not clusterable by route.
    return null;
  }
  const segments = rest.split('/').filter((s) => s.length > 0);
  return segments.length > 0 ? segments : null;
}

/**
 * Computes the set of segment-1 values that are so common across a tier's items that they can't
 * be discriminating between features — a shared namespace/role/API-mount prefix (e.g. "api" on an
 * RBAC backend, "maltora-seller" on a role-prefixed frontend), not a real feature boundary. A
 * segment-1 value must both cover more than `threshold` of the tier's parseable-unitKey items AND
 * leave at least `minOtherItems` items that don't share it (see GAP-048 / GEN_DOMINANT_PREFIX_MIN_OTHER_ITEMS —
 * a high share on too few "other" items is as likely to be a small tier's single dominant feature
 * as a genuine shared namespace) before it's treated this way, extending clustering to segment 2
 * for those items (see routeClusterKey).
 */
export function findDominantPrefixes(
  items: TestPlanItem[],
  threshold = GEN_DOMINANT_PREFIX_THRESHOLD,
  minOtherItems = GEN_DOMINANT_PREFIX_MIN_OTHER_ITEMS,
): Set<string> {
  const counts = new Map<string, number>();
  let parseable = 0;
  for (const item of items) {
    const segments = unitKeySegments(item.unitKey);
    if (!segments) continue;
    parseable += 1;
    counts.set(segments[0]!, (counts.get(segments[0]!) ?? 0) + 1);
  }
  const dominant = new Set<string>();
  if (parseable === 0) return dominant;
  for (const [segment, count] of counts) {
    if (count / parseable > threshold && parseable - count >= minOtherItems) dominant.add(segment);
  }
  return dominant;
}

/**
 * Cluster key for one item's unitKey: segment 1 alone, or "segment1/segment2" when segment 1 is a
 * dominant (shared-namespace) prefix per findDominantPrefixes — so a role-prefixed/API-mounted
 * app's routes cluster by their real feature (segment 2), while a flat app's routes cluster by
 * segment 1 directly. Returns null when the unitKey isn't a parseable route/endpoint key.
 */
export function routeClusterKey(unitKey: string | undefined, dominantPrefixes: Set<string>): string | null {
  const segments = unitKeySegments(unitKey);
  if (!segments) return null;
  const [first, second] = segments;
  if (dominantPrefixes.has(first!) && second) return `${first}/${second}`;
  return first!;
}

/**
 * Greedily group items into batches whose scenario-weight (scenarios.length || 1, summed) stays
 * within `weightBudget`, also capping each batch at `maxItems` regardless of weight. Mirrors
 * orchestrator/index.ts's buildWeightedBatches shape exactly (same greedy-cut structure), applied
 * here to TestPlanItem's scenario count instead of estimateUnitWeight. A single item whose own
 * weight already exceeds the budget still gets its own batch — an item can't be split further.
 */
export function binPackByScenarioWeight(
  items: TestPlanItem[],
  weightBudget: number,
  maxItems: number,
): TestPlanItem[][] {
  const batches: TestPlanItem[][] = [];
  let current: TestPlanItem[] = [];
  let currentWeight = 0;
  for (const item of items) {
    const w = item.scenarios.length || 1;
    if (current.length > 0 && (currentWeight + w > weightBudget || current.length >= maxItems)) {
      batches.push(current);
      current = [];
      currentWeight = 0;
    }
    current.push(item);
    currentWeight += w;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Groups same-tier items into generation batches by route relatedness before bin-packing by
 * scenario weight, so items covering the same feature (e.g. /login, /login/resetpassword,
 * /login/passwordupdate) share a batch — and its shared preamble/tier guidance cost — instead of
 * landing in unrelated batches purely by plan order. Items with no usable unitKey (no functionality
 * -index grounding) fall into one catch-all pool per tier, bin-packed in plan order — this
 * naturally degrades to a pure weight-budget chunking for plans with no route grounding at all,
 * which is a strict generalization of the old fixed-size GEN_BATCH_SIZE chunking.
 *
 * Batch composition is intentionally not stable across resumes — generate()'s checkpoint-resume
 * filter may leave a previously-clustered group split across batches after a partial resume; this
 * is harmless since all DOM/source grounding is built per-item, not per-batch (see buildBatchPrompt).
 */
export function buildGenerationBatches(items: TestPlanItem[]): TestPlanItem[][] {
  const dominantPrefixes = findDominantPrefixes(items);
  const clusters = new Map<string, TestPlanItem[]>();
  const catchAll: TestPlanItem[] = [];
  for (const item of items) {
    const key = routeClusterKey(item.unitKey, dominantPrefixes);
    if (key === null) {
      catchAll.push(item);
      continue;
    }
    const list = clusters.get(key) ?? [];
    list.push(item);
    clusters.set(key, list);
  }

  const batches: TestPlanItem[][] = [];
  for (const clusterItems of clusters.values()) {
    batches.push(
      ...binPackByScenarioWeight(clusterItems, GEN_BATCH_SCENARIO_WEIGHT_BUDGET, GEN_BATCH_MAX_ITEMS),
    );
  }
  batches.push(...binPackByScenarioWeight(catchAll, GEN_BATCH_SCENARIO_WEIGHT_BUDGET, GEN_BATCH_MAX_ITEMS));
  return batches;
}

function batchMarkerStart(reqTag: string): string {
  return `===== BEGIN SPEC [REQ:${reqTag}] =====`;
}
function batchMarkerEnd(reqTag: string): string {
  return `===== END SPEC [REQ:${reqTag}] =====`;
}

/**
 * Build ONE prompt requesting specs for MULTIPLE same-tier plan items instead of paying for a
 * separate provider call — and a separate copy of every tier-wide/app-wide rule — per item.
 * generate() only ever batches items sharing a tier, so the tier guidance/mock note below are
 * genuinely shared, not approximated. Every substantive rule here is the same one buildPrompt
 * states for a single item; wording is generalized to refer to "that feature's own reqTag/title"
 * since a batch covers several distinct reqTags in one response.
 */
function buildBatchPrompt(items: TestPlanItem[], ctx: TestModeContext, tier: Tier): string {
  const baseUrl = (ctx.baseUrl ?? '').trim() || 'the application under test';
  const importSource = ctx.mockExternalDependencies
    ? MOCK_FIXTURE_IMPORT_PATH
    : ACTION_HIGHLIGHTER_IMPORT_PATH;
  const routingGuidance = formatRoutingGuidance(ctx);

  const tierGuidance =
    tier === 'tierC-api'
      ? `This is an API/backend test: use the \`request\` fixture (e.g. \`await request.get(...)\`) and assert on response status/body. Do NOT drive a browser page. NEVER assert a specific status code (2xx, 3xx, 4xx, or 5xx) for ANY endpoint unless it is directly grounded — by the source/schema grounding below, by a real observed request/response in the routes or mock content above, or by an explicit statement in the feature intent/scenario description. A guessed status code is one of the single biggest causes of false test failures. In particular: (1) For a negative/invalid-input/unauthorized scenario, do NOT assume a "success-shaped" status (e.g. 200 with an error body) — many apps respond to a failed form-based auth with a redirect (302/303) rather than 200, and to a failed API auth with 401/403. (2) Do NOT assume a bare path triggers special behavior (a redirect, a specific response) that actually requires a query string, request body, or header seen only on a DIFFERENT observed URL for the same feature — a redirect/action endpoint commonly only activates with specific parameters, and the bare path just serves a normal 200 page; use the exact URL (including its query string) from the observed routes above, never a stripped-down guess. When you lack real grounding for the exact status, assert what you can be sure of instead (e.g. \`expect(response.status()).not.toBe(200)\`, a 3xx/4xx range check, or a documented error field) rather than guessing one fixed status code. For a file-upload endpoint, use the \`multipart\` option on the request call (e.g. \`await request.post(url, { multipart: { file: { name: "x.txt", mimeType: "text/plain", buffer: Buffer.from("...") } } })\`) — never pass a raw Node stream/fs.ReadStream or a hand-built multipart body as the request payload, which throws at runtime rather than failing a real assertion.${formatLocalBackendGuidance(ctx)}`
      : tier === 'tierB-auth'
        ? `This is an authenticated flow: assume the user is already logged in via the configured storageState; verify authenticated UI/behaviour.${formatRoleGuidance(ctx, tier)}`
        : 'This is a public flow requiring no authentication.';

  const mockNote = ctx.mockExternalDependencies
    ? `\n- This run mocks some external dependencies; importing test/expect from '${importSource}' (instead of '@playwright/test') already wires up the necessary network interception — use test/expect exactly as you normally would. For a test that needs a SPECIFIC failure scenario for one call (e.g. a 500/401/403/timeout), request the \`mockOverride\` fixture and call it before triggering the request: \`mockOverride('GET', '/the/path', { status: 500, body: {} })\` — do not expect a fixed success response to also produce your error scenario. CRITICAL: the mock matches ONLY by method + path — it never inspects headers, tokens, or the request body, so it CANNOT organically reject a missing/invalid Authorization header, an unauthorized role, or cross-tenant/ownership access with a 401/403/404. If a scenario asserts that kind of rejection, you MUST call \`mockOverride(...)\` with that exact status first, or the mock will silently return its default success response and the assertion will fail every time — this is true even for a request you never customized before.${formatMockContent(ctx)}`
    : '';

  const header = `You are generating Playwright test spec files in TypeScript for ${items.length} DIFFERENT, INDEPENDENT features in ONE response — ${items.length} SEPARATE self-contained spec files, not one spec covering all of them.

For EACH feature listed below, output ONE complete spec file wrapped EXACTLY like this, with no markdown/code fences around or inside the markers:
===== BEGIN SPEC [REQ:<that feature's reqTag, exactly as shown for it below>] =====
<the full TypeScript source for that ONE feature's spec>
===== END SPEC [REQ:<the same reqTag>] =====

Output all ${items.length} specs this way, each within its own BEGIN/END pair using the EXACT reqTag shown for that feature, in the same order the features are listed below. Nothing else outside the markers.

Requirements that apply to EVERY feature's spec below:
- Begin with: import { test, expect } from '${importSource}';
- Wrap that feature's cases in: test.describe('[REQ:<its reqTag>] <its title>', () => { ... }) — using EXACTLY that feature's own reqTag and title, given in its own section below.
- Output exactly one test(...) per scenario listed for that feature, IN THE SAME ORDER.
- EVERY test(...) title MUST itself start with "[REQ:<its reqTag>]" too (not just the describe title),
  followed by its scenario kind, e.g. test('[REQ:REQ-1] positive: succeeds with valid input', ...).
  This tag on every individual test is REQUIRED for coverage tracking — do not omit it.
- Use relative paths against the configured baseURL (${baseUrl}); call page.goto('/') for the root.
- After EVERY page.goto(...) (or a click that navigates), before interacting with any page-specific
  element, verify the navigation actually landed on a real, expected page — not a 404/error/blank
  page — using a SHORT, bounded check (e.g. \`await expect(page.locator('body')).not.toContainText('Not Found', { timeout: 3000 })\`,
  or asserting an element from that feature's own inventory that should always be present on that page). Skipping
  this is the single biggest cause of a mysterious full-timeout hang: if navigation silently lands on
  the wrong page (a transient server error, a redirect you didn't expect, a typo'd path), every
  subsequent locator for that page's real elements will never resolve, and the test burns the ENTIRE
  default test timeout (tens of seconds) waiting on something that will never appear, instead of
  failing fast with a clear, diagnosable reason.
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
- Do NOT assert a tight, arbitrary hardcoded duration/performance threshold (e.g.
  \`expect(elapsedMs).toBeLessThan(200)\`) for how fast an action completes — real environments
  (CI machines, headless vs. headed, network conditions) vary widely in speed, making this
  assertion flaky/brittle regardless of whether the app works correctly. Verify the OUTCOME of an
  action (e.g. the swap/update actually happened) using Playwright's own built-in waiting/retry
  behavior instead of a manual millisecond comparison.
- Before calling a single-target action (click/fill/check/dblclick/selectOption/hover) on a locator,
  make sure it can only match ONE element on the real page — Playwright throws a strict-mode
  violation (and the test fails) if the locator resolves to more than one match. A bare
  \`getByRole('link'/'button'/etc.)\`, a short \`getByText(...)\`, or a class/tag CSS selector are the
  ones most likely to collide with another real element. Narrow it with a distinguishing
  \`{ name: ... }\`/\`{ exact: true }\` filter, a more specific visible text/data-testid/id, or chain
  \`.first()\`/\`.nth()\` when you intend a specific match — only rely on an unscoped locator when that
  feature's own inventory below shows it is the sole element of that role/name on the page.
- Be self-contained and runnable; do not import any other local helpers beyond the one import above.
- When a scenario CREATES a new resource that the app enforces as unique (e.g. registering a user
  by email, creating an account/username), do NOT hardcode a fixed literal value for that unique
  field — embed \`Date.now()\` (or a similarly varying value) in it, e.g.
  \`\`email-\${Date.now()}@example.com\`\`. A fixed value passes once against a real, persistent
  backend and then fails every later re-run with a duplicate/conflict error, since the app correctly
  remembers what earlier runs already created. Scenarios that deliberately test the duplicate/conflict
  path itself should still register their own fresh unique value first, then reuse THAT same value for
  the collision attempt within the same test.
- ${tierGuidance}${mockNote}${routingGuidance}`;

  const sections = items.map((item) => {
    const reqTag = item.reqTag ?? item.id;
    const scenarios =
      item.scenarios.length > 0 ? item.scenarios : [{ kind: 'positive' as const, description: item.intent }];
    const scenarioList = formatScenarios(scenarios);
    const inventory = formatSnapshotInventory(ctx, tier, item);
    const observedRoutes = formatObservedRoutes(ctx, item);
    const sourceGrounding = formatSourceGrounding(ctx, item, tier);
    return `

----- FEATURE (reqTag: "${reqTag}") -----
Feature: ${item.title}
Feature intent: ${item.intent}
Scenarios to cover, one test(...) each, in this order:
${scenarioList}${inventory}${observedRoutes}${sourceGrounding}
Output this feature's spec between:
${batchMarkerStart(reqTag)}
...
${batchMarkerEnd(reqTag)}`;
  });

  return `${header}
${sections.join('\n')}`;
}

/**
 * Pull each item's own spec text out of a batch response by its BEGIN/END markers. An item whose
 * markers are missing or whose captured body is empty is simply absent from the returned map —
 * generateBatch solo-retries those individually via generateOne rather than failing the whole
 * batch over one item.
 */
function extractBatchSpecs(text: string, items: TestPlanItem[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const item of items) {
    const reqTag = item.reqTag ?? item.id;
    const escaped = reqTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `=====\\s*BEGIN SPEC \\[REQ:${escaped}\\]\\s*=====([\\s\\S]*?)=====\\s*END SPEC \\[REQ:${escaped}\\]\\s*=====`,
    );
    const body = re.exec(text)?.[1]?.trim();
    if (body) result.set(reqTag, body);
  }
  return result;
}

/**
 * Generate specs for a batch of same-tier items with ONE provider call. Bottoms out at the
 * existing single-item generateOne (its own 2-attempt retry loop, untouched) in two situations:
 * a batch of exactly one item (the base case), and any item that individually fails validation
 * within an otherwise-usable batch response — no new per-item retry logic is invented here, only
 * routing to the one that already exists.
 *
 * On a TOTAL parse failure (nothing at all extracted from an ok response, or the call itself
 * failed at the provider level — both leave `extracted` empty) the batch is split in half and
 * each half retried recursively, mirroring runPlanPhase's truncated-batch split
 * (splitUnitsByWeight/PLAN_MAX_SPLIT_DEPTH in orchestrator/index.ts) rather than assuming every
 * item needs its own solo call — a batch merely too big for one response often succeeds once
 * halved. Once the split depth is exhausted, the remaining items simply solo-retry individually
 * (the same per-item fallback used for a single missing/invalid item), a graceful bottom-out
 * rather than a special case.
 */
async function generateBatch(
  ctx: TestModeContext,
  batchItems: TestPlanItem[],
  usedPaths: Set<string>,
  depth: number,
): Promise<Array<{ item: TestPlanItem } & GenOneOutcome>> {
  if (batchItems.length === 1) {
    const item = batchItems[0]!;
    const outcome = await generateOne(ctx, item, usedPaths);
    await recordGenOutcome(ctx, item, outcome);
    return [{ item, ...outcome }];
  }

  const tier = resolveTier(batchItems[0]!.tier);
  let text = '';
  try {
    const res = await ctx.provider.complete(buildBatchPrompt(batchItems, ctx, tier), {
      cwd: ctx.repoPath ?? undefined,
      timeoutMs: ABSOLUTE_BACKSTOP_MS,
      readOnly: true,
      signal: ctx.signal,
      taskType: 'codegen',
    });
    ctx.onUsage?.('generate', `batch of ${batchItems.length}`, ctx.provider.id, res.raw);
    if (!res.ok) {
      emit(ctx, `Batched codegen provider error for ${batchItems.length} item(s): ${res.detail}`);
    } else {
      text = res.text;
    }
  } catch (err) {
    emit(
      ctx,
      `Batched codegen threw for ${batchItems.length} item(s): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const extracted = text ? extractBatchSpecs(text, batchItems) : new Map<string, string>();

  if (extracted.size === 0 && depth < GEN_MAX_SPLIT_DEPTH) {
    emit(
      ctx,
      `Batched generation for ${batchItems.length} item(s) came back unusable; splitting and retrying.`,
    );
    const mid = Math.ceil(batchItems.length / 2);
    // Sequential, not Promise.all — matches runPlanPhase's planBatch split precedent exactly
    // (orchestrator/index.ts). Recursing concurrently here would let a burst of simultaneous
    // batch failures (this is itself a failure path) fan out beyond GEN_CONCURRENCY, since this
    // recursion runs INSIDE an already-running top-level batch task and isn't governed by the
    // outer runWithConcurrency pool — a real concurrency-cap leak, not just a cosmetic mismatch
    // with the pattern it's supposed to mirror.
    const leftOut = await generateBatch(ctx, batchItems.slice(0, mid), usedPaths, depth + 1);
    const rightOut = await generateBatch(ctx, batchItems.slice(mid), usedPaths, depth + 1);
    return [...leftOut, ...rightOut];
  }

  const results: Array<{ item: TestPlanItem } & GenOneOutcome> = [];
  for (const item of batchItems) {
    const reqTag = item.reqTag ?? item.id;
    const itemText = extracted.get(reqTag);
    if (!itemText) {
      emit(ctx, `Batched response was missing a spec for "${item.title}"; solo-retrying.`);
      const soloOutcome = await generateOne(ctx, item, usedPaths);
      await recordGenOutcome(ctx, item, soloOutcome);
      results.push({ item, ...soloOutcome });
      continue;
    }
    const validated = await validateAndPersist(ctx, item, itemText, usedPaths);
    if (validated.ungroundedWarn && validated.ungroundedWarn.length > 0) {
      emit(
        ctx,
        `Batched output for "${item.title}" has unverifiable selector/endpoint references (not blocking): ${validated.ungroundedWarn.join('; ')}`,
      );
    }
    if (validated.spec) {
      const outcome: GenOneOutcome = { spec: validated.spec };
      await recordGenOutcome(ctx, item, outcome);
      results.push({ item, spec: validated.spec });
      continue;
    }
    emit(
      ctx,
      `Batched output for "${item.title}" failed validation (${validated.reason}); solo-retrying via the single-item path.`,
      { ...(validated.violations ? { violations: validated.violations } : {}) },
    );
    const soloOutcome = await generateOne(ctx, item, usedPaths);
    await recordGenOutcome(ctx, item, soloOutcome);
    results.push({ item, ...soloOutcome });
  }
  return results;
}

/** Number of generation BATCHES (see buildGenerationBatches) run concurrently. */
const GEN_CONCURRENCY = 3;

/**
 * Run up to `concurrency` promises at a time from `tasks`. Returns results in
 * the same order as `tasks` regardless of completion order. `shouldStop`
 * (checked before each task is popped, e.g. a live pause or a proactive
 * credit-budget ceiling tripping mid-GENERATE — see orchestrator/index.ts's
 * checkBudget) lets a worker stop pulling NEW batches without disturbing
 * batches already in flight; a task never dispatched simply leaves its slot
 * `undefined` — callers must filter those out before use (see generate()'s
 * `.filter(Boolean)` below).
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  shouldStop?: () => boolean,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      if (shouldStop?.()) return;
      const i = nextIndex++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * Group plan items into same-tier batches (see buildGenerationBatches), then for each batch ask the
 * provider (read-only) for all of that batch's specs in ONE call (see generateBatch) — validating
 * each (must look like a spec, contain >=1 expect, pass the forbidden-API and grounding gates),
 * solo-retrying any individual failure via the existing single-item generateOne, and writing
 * accepted specs to tests/<tier>/<slug>.spec.ts.
 *
 * Runs up to GEN_CONCURRENCY batches in parallel to increase throughput on plans with many items
 * (same wall-clock-parallelism benefit the old one-item-per-task scheme had, now applied across
 * batches); per-batch/per-item order doesn't matter since each spec is independent, but path
 * de-dup (usedPaths) still guarantees unique files.
 */
export async function generate(ctx: TestModeContext, plan: TestPlan): Promise<GeneratedSpec[]> {
  const items = plan.items ?? [];

  // Restore whatever finished in an earlier, interrupted generate() call (see
  // recordGenOutcome/readGenerateCheckpointEntries above) — only entries for
  // items still present in THIS plan count, so a later, unrelated generate()
  // call reusing the same projectDir never inherits stale entries (same
  // precedent as execute.ts's clearExecCheckpoint doc comment).
  const priorEntriesAll = await readGenerateCheckpointEntries(ctx.projectDir);
  const currentItemIds = new Set(items.map((it) => it.id));
  const priorEntries = priorEntriesAll.filter((e) => currentItemIds.has(e.itemId));
  const doneIds = new Set(priorEntries.map((e) => e.itemId));
  const remainingItems = items.filter((it) => !doneIds.has(it.id));
  if (priorEntries.length > 0) {
    emit(ctx, `Resuming: ${priorEntries.length} item(s) already finished; skipping them this run.`, {
      alreadyFinished: priorEntries.length,
    });
  }

  // Batch same-tier items together so a shared tier-wide/app-wide context (rules, tier guidance,
  // mock note, routing guidance) is paid for ONCE per batch instead of once per item — items from
  // different tiers are never mixed into the same batch, since their tier guidance genuinely
  // differs (see buildBatchPrompt). Within a tier, buildGenerationBatches further clusters items by
  // route relatedness and bin-packs by scenario weight (see its doc comment) instead of chunking
  // in fixed-size, order-only groups.
  const byTier = new Map<Tier, TestPlanItem[]>();
  for (const item of remainingItems) {
    const tier = resolveTier(item.tier);
    const list = byTier.get(tier) ?? [];
    list.push(item);
    byTier.set(tier, list);
  }
  const batches: TestPlanItem[][] = [];
  for (const list of byTier.values()) {
    batches.push(...buildGenerationBatches(list));
  }

  emit(
    ctx,
    `Generating ${remainingItems.length} spec(s) across ${batches.length} batch(es) (up to ${GEN_CONCURRENCY} batch(es) in parallel)`,
    { count: remainingItems.length, batches: batches.length },
  );

  const specs: GeneratedSpec[] = [];
  const usedPaths = new Set<string>();
  let completed = 0;
  const total = remainingItems.length;

  // Path de-dup happens inside validateAndPersist/generateOne (before writeFile) via the shared
  // usedPaths set, so each accepted spec persists to a unique file on disk even when several
  // batches are generated at once.
  const tasks = batches.map((batchItems, i) => async () => {
    emit(ctx, `Dispatched batch ${i + 1}/${batches.length}: ${batchItems.length} item(s)`, {
      ids: batchItems.map((it) => it.id),
      tier: batchItems[0]?.tier,
    });
    const batchOutcomes = await generateBatch(ctx, batchItems, usedPaths, 0);
    completed += batchOutcomes.length;
    emit(ctx, `Progress: ${completed}/${total} done`, { completed, total });
    return batchOutcomes;
  });

  // shouldStop lets a live pause/budget-ceiling abort stop new batches from
  // being dispatched (batches already in flight still finish); a batch never
  // dispatched leaves an undefined slot, filtered out before flattening.
  const outcomes = (await runWithConcurrency(tasks, GEN_CONCURRENCY, () => ctx.signal?.aborted === true))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .flat();

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
  // nothing usable," which stays today's normal zero-specs outcome. Scoped to
  // remainingItems: if everything was already finished in an earlier attempt,
  // there's nothing left to dispatch and therefore nothing to classify.
  // outcomes.length > 0 guards against Array.prototype.every's vacuous-true
  // on an empty array: a signal already aborted before any batch even
  // dispatched (runWithConcurrency's shouldStop, e.g. a live pause/budget
  // ceiling) leaves outcomes empty — that's "we were told to stop", not a
  // provider outage, and must not be misclassified as one.
  if (
    remainingItems.length > 0 &&
    specs.length === 0 &&
    outcomes.length > 0 &&
    outcomes.every((o) => o.providerFailureDetail !== undefined)
  ) {
    throw new ProviderUnavailableError(
      lastProviderFailureDetail ?? 'Provider unavailable during generation.',
    );
  }

  // Fold in whatever finished during an earlier, interrupted attempt (and was
  // therefore skipped this run) so the returned list covers the WHOLE
  // GENERATE phase, not just what this particular invocation produced —
  // mirrors execute.ts's equivalent merge of checkpoint-restored entries.
  if (priorEntries.length > 0) {
    const restored = await Promise.all(priorEntries.map((e) => restoreGeneratedSpec(e)));
    for (const spec of restored) if (spec) specs.push(spec);
  }

  emit(ctx, `Generation complete: ${specs.length}/${items.length} spec(s) accepted`, {
    accepted: specs.length,
    requested: items.length,
  });

  // Completed without interruption — nothing left to resume. A pause/abort
  // leaves the write-through checkpoint IN PLACE (not cleared) so the NEXT
  // generate() call resumes from it instead of redoing already-finished work;
  // only a clean, uninterrupted completion clears it — same condition
  // execute.ts's clearExecCheckpoint call site uses.
  if (!ctx.signal?.aborted) {
    await clearGenerateCheckpoint(ctx.projectDir);
  }
  return specs;
}
