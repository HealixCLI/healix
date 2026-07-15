import { nanoid } from 'nanoid';
import type { Project, Tier } from '../storage/types.js';
import type { TestingScope, TestPlan, TestPlanItem } from '../modes/types.js';
import { tiersForScope } from '../modes/types.js';
import type { ProviderAdapter } from '../providers/types.js';
import type { RunOptions } from './types.js';

/** Shape the model is asked to emit inside a fenced JSON block. */
interface RawPlanItem {
  title?: unknown;
  reqTag?: unknown;
  tier?: unknown;
  intent?: unknown;
}

interface RawPlan {
  summary?: unknown;
  items?: unknown;
}

const KNOWN_TIERS: ReadonlyArray<Tier> = ['tierA-public', 'tierB-auth', 'tierC-api'];

/**
 * Hard cap on repo file paths interpolated into the planning prompt. The index
 * itself may carry hundreds of paths; the prompt only needs enough of them to
 * ground the plan in real routes/pages, and an unbounded list would blow the
 * provider's token budget on large repos.
 */
const MAX_PLAN_PROMPT_FILES = 80;

/** Bounded repo context for grounding the plan (see indexRepo / RepoIndex). */
export interface PlanRepoContext {
  summary: string;
  files: string[];
}

/**
 * Build the planning prompt. Asks the model for a single fenced ```json block so
 * the response is machine-parseable, while still leaving room for prose.
 *
 * When `repoIndex` is provided (white-box runs), a bounded repo-context section
 * (summary + up to MAX_PLAN_PROMPT_FILES file paths) is appended so the plan is
 * grounded in the actual repo instead of the model guessing generic flows.
 */
export function buildPlanPrompt(project: Project, opts: RunOptions, repoIndex?: PlanRepoContext): string {
  const scope = opts.testingScope ?? 'both';
  const tiers = tiersForScope(scope);

  const lines: string[] = [];
  lines.push('You are Healix, an autonomous QA engineer. Produce a concise end-to-end test plan');
  lines.push('for the application under test described below.');
  lines.push('');
  lines.push(`Project name: ${project.name}`);
  lines.push(`Testing scope: ${scopeLabel(scope)} — ONLY plan tests for these tier(s): ${tiers.join(', ')}.`);
  lines.push(`Test engine: ${project.mode}`);
  if (project.baseUrl) lines.push(`Base URL (black-box): ${project.baseUrl}`);
  if (project.repoPath) lines.push(`Repository path (white-box): ${project.repoPath}`);
  if (opts.prd && opts.prd.trim().length > 0) {
    lines.push('');
    lines.push('PRD / acceptance criteria to ground the plan:');
    lines.push('"""');
    lines.push(opts.prd.trim());
    lines.push('"""');
  }
  if (repoIndex && repoIndex.summary.trim().length > 0) {
    lines.push('');
    lines.push('Repository context (indexed):');
    lines.push(repoIndex.summary.trim());
    const shown = repoIndex.files.slice(0, MAX_PLAN_PROMPT_FILES);
    if (shown.length > 0) {
      lines.push(`Repository files (first ${shown.length}):`);
      for (const file of shown) lines.push(`- ${file}`);
      const remaining = repoIndex.files.length - shown.length;
      if (remaining > 0) lines.push(`... and ${remaining} more file(s) not listed.`);
    }
  }
  lines.push('');
  lines.push('Respond with exactly one fenced JSON code block of the shape:');
  lines.push('```json');
  lines.push('{');
  lines.push('  "summary": "one-paragraph overview of the test strategy",');
  lines.push('  "items": [');
  lines.push('    {');
  lines.push('      "title": "short human title",');
  lines.push('      "reqTag": "REQ-001 or null",');
  lines.push(`      "tier": "${tiers.join('" | "')}",`);
  lines.push('      "intent": "what this test verifies, in one or two sentences"');
  lines.push('    }');
  lines.push('  ]');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push(`Prefer 3-8 high-value scenarios, all within the "${tiers.join('", "')}" tier(s) above.`);
  lines.push(tierGuidanceFor(tiers));
  return lines.join('\n');
}

function scopeLabel(scope: TestingScope): string {
  switch (scope) {
    case 'frontend':
      return 'Frontend testing';
    case 'backend':
      return 'Backend testing';
    case 'both':
      return 'Frontend + backend testing';
  }
}

/** Tier-by-tier guidance, limited to whichever tiers are actually in scope. */
function tierGuidanceFor(tiers: ReadonlyArray<Tier>): string {
  const parts: string[] = [];
  if (tiers.includes('tierA-public')) parts.push('tierA-public for unauthenticated flows');
  if (tiers.includes('tierB-auth')) parts.push('tierB-auth for authenticated flows');
  if (tiers.includes('tierC-api')) parts.push('tierC-api for API-level checks');
  return `Use ${parts.join(', ')}.`;
}

/**
 * Robustly parse a model completion into a TestPlan. Tries (in order):
 *   1. a fenced ```json block,
 *   2. a fenced ``` block,
 *   3. the first balanced top-level JSON object in the text.
 * Returns null when nothing parseable/usable is found.
 */
export function parsePlan(text: string, scope: TestingScope = 'both'): TestPlan | null {
  const candidate = extractJsonObject(text);
  if (!candidate) return null;

  let raw: RawPlan;
  try {
    raw = JSON.parse(candidate) as RawPlan;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;

  const itemsRaw = Array.isArray(raw.items) ? (raw.items as RawPlanItem[]) : [];
  const items: TestPlanItem[] = itemsRaw
    .map((it) => normalizeItem(it, scope))
    .filter((it): it is TestPlanItem => it !== null);

  if (items.length === 0) return null;

  const summary =
    typeof raw.summary === 'string' && raw.summary.trim().length > 0
      ? raw.summary.trim()
      : 'Generated test plan.';

  return { summary, items, raw };
}

/**
 * Deterministic fallback plan when the model produced nothing usable. Scope-
 * aware: a backend-only scope must not fall back to tierA-public items, which
 * the caller's tier filter would then discard entirely, leaving an empty plan.
 */
export function synthesizePlan(project: Project, scope: TestingScope = 'both'): TestPlan {
  const tiers = tiersForScope(scope);
  const items: TestPlanItem[] = [];

  if (!tiers.includes('tierA-public') && tiers.includes('tierC-api')) {
    // Backend-only scope: a UI smoke check would be filtered out, so fall
    // back to a basic API reachability check instead.
    items.push({
      id: `pli_${nanoid(8)}`,
      title: 'API responds to a basic request',
      tier: 'tierC-api',
      intent: project.baseUrl
        ? `Send a basic request to ${project.baseUrl} and verify a successful HTTP response.`
        : 'Confirm the API responds to a basic health-check request.',
    });
  } else if (project.baseUrl) {
    items.push({
      id: `pli_${nanoid(8)}`,
      title: 'Home page loads',
      tier: 'tierA-public',
      intent: `Navigate to ${project.baseUrl} and verify the page renders without console/network errors.`,
    });
    items.push({
      id: `pli_${nanoid(8)}`,
      title: 'Primary navigation works',
      tier: 'tierA-public',
      intent: 'Exercise the main navigation links and confirm each destination is reachable.',
    });
  } else {
    items.push({
      id: `pli_${nanoid(8)}`,
      title: 'Smoke: application boots',
      tier: 'tierA-public',
      intent: 'Confirm the application under test starts and serves its entry point.',
    });
  }
  return {
    summary: project.baseUrl
      ? `Minimal smoke plan synthesized for ${project.baseUrl}.`
      : 'Minimal smoke plan synthesized (no base URL configured).',
    items,
  };
}

/**
 * Build a single-item revision prompt: the item's current content plus the
 * human's free-text feedback, asking for exactly one revised JSON item.
 * Reuses buildPlanPrompt's project/scope/repo-context boilerplate so the
 * revision is grounded the same way the original plan was.
 */
export function buildReviseItemPrompt(
  project: Project,
  opts: RunOptions,
  item: TestPlanItem,
  suggestion: string,
  repoIndex?: PlanRepoContext,
): string {
  const scope = opts.testingScope ?? 'both';
  const tiers = tiersForScope(scope);

  const lines: string[] = [];
  lines.push('You are Healix, an autonomous QA engineer. A human reviewer is revising ONE item from');
  lines.push('a proposed test plan. Regenerate ONLY this item, incorporating their feedback.');
  lines.push('');
  lines.push(`Project name: ${project.name}`);
  lines.push(`Testing scope: ${scopeLabel(scope)} — keep the item within these tier(s): ${tiers.join(', ')},`);
  lines.push('unless the feedback clearly requires a different tier.');
  lines.push(`Test engine: ${project.mode}`);
  if (project.baseUrl) lines.push(`Base URL (black-box): ${project.baseUrl}`);
  if (project.repoPath) lines.push(`Repository path (white-box): ${project.repoPath}`);
  if (repoIndex && repoIndex.summary.trim().length > 0) {
    lines.push('');
    lines.push('Repository context (indexed):');
    lines.push(repoIndex.summary.trim());
  }
  lines.push('');
  lines.push('Current item:');
  lines.push('```json');
  lines.push(
    JSON.stringify(
      { title: item.title, reqTag: item.reqTag ?? null, tier: item.tier, intent: item.intent },
      null,
      2,
    ),
  );
  lines.push('```');
  lines.push('');
  lines.push('Reviewer feedback that MUST be incorporated:');
  lines.push('"""');
  lines.push(suggestion.trim());
  lines.push('"""');
  lines.push('');
  lines.push('Respond with exactly one fenced JSON code block of the shape:');
  lines.push('```json');
  lines.push('{');
  lines.push('  "title": "short human title",');
  lines.push('  "reqTag": "REQ-001 or null",');
  lines.push(`  "tier": "${tiers.join('" | "')}",`);
  lines.push('  "intent": "what this test verifies, in one or two sentences"');
  lines.push('}');
  lines.push('```');
  lines.push(tierGuidanceFor(tiers));
  return lines.join('\n');
}

/**
 * Parse a single revised item from a model completion. The revision replaces
 * content, not identity — existingId is preserved so callers keyed on item id
 * (renderer state, React keys) stay stable across a revision.
 */
export function parseReviseItemResponse(
  text: string,
  scope: TestingScope,
  existingId: string,
): TestPlanItem | null {
  const candidate = extractJsonObject(text);
  if (!candidate) return null;
  let raw: RawPlanItem;
  try {
    raw = JSON.parse(candidate) as RawPlanItem;
  } catch {
    return null;
  }
  const normalized = normalizeItem(raw, scope);
  if (!normalized) return null;
  return { ...normalized, id: existingId };
}

/**
 * Orchestrate a single-item revision: build the prompt, call the provider,
 * parse the result. No provider-fallback retry on parse failure — the user is
 * actively watching this call, so surfacing an error is better than silently
 * substituting something unrelated.
 */
export async function reviseItem(
  provider: ProviderAdapter,
  project: Project,
  opts: RunOptions,
  item: TestPlanItem,
  suggestion: string,
  repoIndex?: PlanRepoContext,
): Promise<{ ok: true; item: TestPlanItem } | { ok: false; detail: string }> {
  const prompt = buildReviseItemPrompt(project, opts, item, suggestion, repoIndex);
  let completion: Awaited<ReturnType<ProviderAdapter['complete']>>;
  try {
    completion = await provider.complete(prompt, {
      mode: 'plan',
      cwd: project.repoPath ?? undefined,
      signal: opts.signal,
    });
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  if (!completion.ok || !completion.text) {
    return { ok: false, detail: completion.detail || `Provider "${provider.id}" returned no usable revision.` };
  }
  const revised = parseReviseItemResponse(completion.text, opts.testingScope ?? 'both', item.id);
  if (!revised) {
    return { ok: false, detail: 'Could not parse a revised item from the provider response.' };
  }
  return { ok: true, item: revised };
}

export function normalizeItem(it: RawPlanItem, scope: TestingScope): TestPlanItem | null {
  if (!it || typeof it !== 'object') return null;
  const title = typeof it.title === 'string' ? it.title.trim() : '';
  if (title.length === 0) return null;
  const intent = typeof it.intent === 'string' && it.intent.trim().length > 0 ? it.intent.trim() : title;
  const reqTag =
    typeof it.reqTag === 'string' && it.reqTag.trim().length > 0 && it.reqTag.trim() !== 'null'
      ? it.reqTag.trim()
      : undefined;
  const tier = normalizeTier(it.tier, scope);
  const item: TestPlanItem = { id: `pli_${nanoid(8)}`, title, tier, intent };
  if (reqTag) item.reqTag = reqTag;
  return item;
}

function normalizeTier(value: unknown, scope: TestingScope): Tier {
  if (typeof value === 'string') {
    const v = value.trim();
    const match = KNOWN_TIERS.find((t) => t === v);
    // A recognized tier is kept AS-IS even when it's outside the requested
    // scope — the orchestrator applies the actual scope boundary as a filter
    // right after planning (packages/core/src/orchestrator/index.ts), and
    // that filter needs the item's real tier to correctly drop it. Coercing
    // it into scope here would defeat that filter entirely (every item would
    // already read as "in scope" by the time it got there).
    if (match) return match;
  }
  // Only a genuinely unrecognized/hallucinated value has no real tier to
  // preserve — for that (and only that) case, clamp to the first in-scope
  // tier so the item survives as a usable guess instead of being dropped.
  return tiersForScope(scope)[0];
}

/** Extract a JSON object string from arbitrary model output. */
function extractJsonObject(text: string): string | null {
  if (!text) return null;

  const fencedJson = /```json\s*([\s\S]*?)```/i.exec(text);
  if (fencedJson && fencedJson[1]) {
    const inner = sliceBalanced(fencedJson[1]);
    if (inner) return inner;
  }

  const fenced = /```\s*([\s\S]*?)```/.exec(text);
  if (fenced && fenced[1]) {
    const inner = sliceBalanced(fenced[1]);
    if (inner) return inner;
  }

  return sliceBalanced(text);
}

/** Return the first balanced {...} object substring, respecting strings/escapes. */
function sliceBalanced(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
