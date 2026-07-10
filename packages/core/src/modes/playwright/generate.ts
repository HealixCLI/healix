import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Tier } from '../../storage/types.js';
import type { GeneratedSpec, TestModeContext, TestPlan, TestPlanItem } from '../types.js';
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

/** Retry note when the previous attempt used forbidden APIs (deny-list gate). */
function retryNoteForbidden(violations: string[]): string {
  return `Your previous output was rejected because it used forbidden APIs: ${violations.join('; ')}. The spec MUST be fully self-contained: import ONLY from '@playwright/test'; never import or require any other module; never touch the filesystem, spawn processes, use eval/new Function, or call process.exit.`;
}

function buildPrompt(item: TestPlanItem, ctx: TestModeContext, tier: Tier, retryNote: string | null): string {
  const baseUrl = (ctx.baseUrl ?? '').trim() || 'the application under test';
  const reqTag = item.reqTag ?? item.id;
  const strictNote = retryNote ? `\nIMPORTANT: ${retryNote}` : '';

  const tierGuidance =
    tier === 'tierC-api'
      ? 'This is an API/backend test: use the `request` fixture (e.g. `await request.get(...)`) and assert on response status/body. Do NOT drive a browser page.'
      : tier === 'tierB-auth'
        ? 'This is an authenticated flow: assume the user is already logged in via the configured storageState; verify authenticated UI/behaviour.'
        : 'This is a public flow requiring no authentication.';

  return `You are generating ONE Playwright test spec file in TypeScript.

Output ONLY the TypeScript source for the spec. No markdown, no code fences, no explanation.

Requirements:
- Begin with: import { test, expect } from '@playwright/test';
- The test (or test.describe) title MUST start with "[REQ:${reqTag}]".
- Use relative paths against the configured baseURL (${baseUrl}); call page.goto('/') for the root.
- Include AT LEAST ONE concrete expect(...) assertion.
- Be self-contained and runnable; do not import local helpers.
- ${tierGuidance}${strictNote}

Test intent: ${item.intent}
Test title hint: ${item.title}
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

/**
 * For each plan item, ask the provider (read-only) for a single Playwright
 * spec, validate it (must look like a spec, contain >=1 expect, and pass the
 * forbidden-API gate), retry once stricter on failure, write it to
 * tests/<tier>/<slug>.spec.ts, and return the accepted specs.
 */
export async function generate(ctx: TestModeContext, plan: TestPlan): Promise<GeneratedSpec[]> {
  const items = plan.items ?? [];
  emit(ctx, `Generating ${items.length} spec(s)`, { count: items.length });

  const specs: GeneratedSpec[] = [];
  const usedPaths = new Set<string>();

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    emit(ctx, `[${i + 1}/${items.length}] Generating "${item.title}"`, { id: item.id, tier: item.tier });

    // Path de-dup happens inside generateOne (before writeFile) via usedPaths,
    // so each accepted spec persists to a unique file on disk.
    const { spec, reason, violations } = await generateOne(ctx, item, usedPaths);
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
