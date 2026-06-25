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

function buildPrompt(item: TestPlanItem, ctx: TestModeContext, tier: Tier, stricter: boolean): string {
  const baseUrl = (ctx.baseUrl ?? '').trim() || 'the application under test';
  const reqTag = item.reqTag ?? item.id;
  const strictNote = stricter
    ? `\nIMPORTANT: Your previous output was rejected because it contained no expect(...) assertion. You MUST include at least one concrete expect(...) assertion that verifies real behaviour.`
    : '';

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

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stricter = attempt > 0;
    let text = '';
    try {
      const res = await ctx.provider.complete(buildPrompt(item, ctx, tier, stricter), {
        cwd: ctx.repoPath ?? undefined,
        timeoutMs: GEN_TIMEOUT_MS,
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
      emit(ctx, `Output for "${item.title}" did not look like a Playwright spec (attempt ${attempt + 1}); retrying`);
      continue;
    }
    if (!hasExpect(source)) {
      // Reject zero-expect specs; the loop retries once with a stricter prompt.
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

  return { spec: null, reason: 'no valid spec with an expect(...) after retry' };
}

/**
 * For each plan item, ask the provider for a single Playwright spec, validate it
 * (must look like a spec and contain >=1 expect), retry once stricter on failure,
 * write it to tests/<tier>/<slug>.spec.ts, and return the accepted specs.
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
    const { spec, reason } = await generateOne(ctx, item, usedPaths);
    if (!spec) {
      ctx.emit?.('generate', `Skipped "${item.title}": ${reason ?? 'generation failed'}`, { id: item.id });
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
