import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Tier } from '../../storage/types.js';
import type { GeneratedSpec, PlanScenario, TestModeContext, TestPlan, TestPlanItem } from '../types.js';
import { TIERS, tierLabel } from './templates.js';

const GEN_TIMEOUT_MS = 180_000;

function emit(ctx: TestModeContext, message: string, data?: unknown): void {
  ctx.emit?.('generate', message, data);
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
 */
export function findForbiddenApis(source: string): string[] {
  const violations = new Set<string>();

  // Import allowlist: exactly '@playwright/test'. Everything else is flagged.
  for (const mod of collectModuleSpecifiers(source)) {
    if (mod !== '@playwright/test') {
      violations.add(`import/require of '${mod}' (only '@playwright/test' is allowed)`);
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

function looksLikePlaywrightSpec(source: string): boolean {
  return /@playwright\/test/.test(source) && /\btest\s*(?:\.\w+)?\s*\(/.test(source);
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

/** Retry note when the previous attempt used forbidden APIs (deny-list gate). */
function retryNoteForbidden(violations: string[]): string {
  return `Your previous output was rejected because it used forbidden APIs: ${violations.join('; ')}. The spec MUST be fully self-contained: import ONLY from '@playwright/test'; never import or require any other module; never touch the filesystem, spawn processes, use eval/new Function, or call process.exit.`;
}

/** Cap on interactive elements injected into a prompt (keeps it bounded). */
const MAX_SNAPSHOT_ELEMENTS = 40;
/** Truncate an accessible name so one pathological element can't bloat the prompt. */
const MAX_ELEMENT_NAME_LEN = 80;

/**
 * Render the interactive-element inventory captured during computer-use
 * exploration (ctx.snapshot) as a compact list, so generation targets REAL
 * selectors instead of guessing. Returns '' when there is nothing to add:
 *   - no snapshot (no live URL to explore, or exploration failed) or no elements observed;
 *   - an API tier (tierC-api), which must not drive a browser page at all.
 * The list is capped at MAX_SNAPSHOT_ELEMENTS with an explicit "+N more" note so
 * a huge page can't blow up the prompt (and the omission isn't silent).
 */
function formatSnapshotInventory(ctx: TestModeContext, tier: Tier): string {
  if (tier === 'tierC-api') return '';
  const elements = ctx.snapshot?.interactiveElements ?? [];
  if (elements.length === 0) return '';

  const shown = elements.slice(0, MAX_SNAPSHOT_ELEMENTS);
  const lines = shown.map((el) => {
    const name =
      el.name.length > MAX_ELEMENT_NAME_LEN ? `${el.name.slice(0, MAX_ELEMENT_NAME_LEN)}…` : el.name;
    return `- ${el.role} "${name}" -> ${el.selector}`;
  });
  const omitted = elements.length - shown.length;
  const more = omitted > 0 ? `\n(+${omitted} more not shown)` : '';
  const where = ctx.snapshot?.url ? ` on ${ctx.snapshot.url}` : '';

  return `

Interactive elements observed${where} during exploration — PREFER these real selectors over guessing:
${lines.join('\n')}${more}`;
}

/** Render a plan item's scenarios as a numbered list for the generation prompt. */
function formatScenarios(scenarios: PlanScenario[]): string {
  return scenarios.map((s, i) => `${i + 1}. [${s.kind}] ${s.description}`).join('\n');
}

function buildPrompt(item: TestPlanItem, ctx: TestModeContext, tier: Tier, retryNote: string | null): string {
  const baseUrl = (ctx.baseUrl ?? '').trim() || 'the application under test';
  const reqTag = item.reqTag ?? item.id;
  const strictNote = retryNote ? `\nIMPORTANT: ${retryNote}` : '';
  const inventory = formatSnapshotInventory(ctx, tier);
  const scenarios =
    item.scenarios.length > 0 ? item.scenarios : [{ kind: 'positive' as const, description: item.intent }];
  const scenarioList = formatScenarios(scenarios);

  const tierGuidance =
    tier === 'tierC-api'
      ? 'This is an API/backend test: use the `request` fixture (e.g. `await request.get(...)`) and assert on response status/body. Do NOT drive a browser page.'
      : tier === 'tierB-auth'
        ? 'This is an authenticated flow: assume the user is already logged in via the configured storageState; verify authenticated UI/behaviour.'
        : 'This is a public flow requiring no authentication.';

  return `You are generating ONE Playwright test spec file in TypeScript covering ONE feature with
multiple test cases (positive/negative/edge), not just a single check.

Output ONLY the TypeScript source for the spec. No markdown, no code fences, no explanation.

Requirements:
- Begin with: import { test, expect } from '@playwright/test';
- Wrap all cases in: test.describe('[REQ:${reqTag}] ${item.title}', () => { ... });
- Output exactly one test(...) per scenario listed below, IN THE SAME ORDER.
- EVERY test(...) title MUST itself start with "[REQ:${reqTag}]" too (not just the describe title),
  followed by its scenario kind, e.g. test('[REQ:${reqTag}] positive: succeeds with valid input', ...).
  This tag on every individual test is REQUIRED for coverage tracking — do not omit it.
- Use relative paths against the configured baseURL (${baseUrl}); call page.goto('/') for the root.
- Every test(...) MUST include at least one concrete expect(...) assertion.
- Be self-contained and runnable; do not import local helpers.
- ${tierGuidance}${strictNote}${inventory}

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

  // Carried across attempts: the note explaining WHY the last output was
  // rejected (fed back into the retry prompt) and the last violation list
  // (surfaced in the skip event if the retry fails too).
  let retryNote: string | null = null;
  let lastReason = 'no valid spec with an expect(...) after retry';
  let lastViolations: string[] | undefined;

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
      if (!res.ok) {
        emit(ctx, `Codegen provider error for "${item.title}" (attempt ${attempt + 1}): ${res.detail}`);
        continue;
      }
      text = res.text;
    } catch (err) {
      emit(ctx, `Codegen threw for "${item.title}" (attempt ${attempt + 1}): ${String(err)}`);
      continue;
    }

    let source = stripCodeFences(text);
    if (!source) {
      continue;
    }
    if (!looksLikePlaywrightSpec(source)) {
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

    // Deny-list gate: same retry-once-then-skip treatment as the zero-expect
    // case, but the stricter note lists the concrete violations so the retry
    // can actually fix them.
    const violations = findForbiddenApis(source);
    if (violations.length > 0) {
      emit(
        ctx,
        `Output for "${item.title}" used forbidden APIs (attempt ${attempt + 1}): ${violations.join('; ')}`,
        {
          violations,
        },
      );
      retryNote = retryNoteForbidden(violations);
      lastReason = `forbidden APIs in generated spec: ${violations.join('; ')}`;
      lastViolations = violations;
      continue;
    }

    source = ensureReqTag(source, reqTag);
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

  return { spec: null, reason: lastReason, violations: lastViolations };
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

  for (const { item, spec, reason, violations } of outcomes) {
    if (!spec) {
      // Include the violation list so the UI/logs show WHAT was forbidden,
      // not just that the spec was skipped.
      ctx.emit?.('generate', `Skipped "${item.title}": ${reason ?? 'generation failed'}`, {
        id: item.id,
        ...(violations ? { violations } : {}),
      });
      continue;
    }

    specs.push(spec);
    emit(ctx, `Wrote ${spec.path}`, { title: spec.title });
  }

  emit(ctx, `Generation complete: ${specs.length}/${items.length} spec(s) accepted`, {
    accepted: specs.length,
    requested: items.length,
  });
  return specs;
}
