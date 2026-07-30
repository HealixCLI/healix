import { nanoid } from 'nanoid';
import type { Project, Tier } from '../storage/types.js';
import type { PlanScenario, TestingScope, TestPlan, TestPlanItem } from '../modes/types.js';
import { tiersForScope } from '../modes/types.js';
import type { ProviderAdapter } from '../providers/types.js';
import type { FunctionalityUnit } from '../target/functionality-index.js';
import type { RunOptions } from './types.js';

const KNOWN_SCENARIO_KINDS: ReadonlyArray<PlanScenario['kind']> = ['positive', 'negative', 'edge'];

/** Shape the model is asked to emit inside a fenced JSON block. */
interface RawScenario {
  kind?: unknown;
  description?: unknown;
}

interface RawPlanItem {
  title?: unknown;
  reqTag?: unknown;
  tier?: unknown;
  intent?: unknown;
  scenarios?: unknown;
  unitKey?: unknown;
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

/** Hard cap on functionality-index units interpolated into the planning prompt (see functionality-index.ts). */
const MAX_PLAN_PROMPT_UNITS = 150;

/** Bounded repo context for grounding the plan (see indexRepo / RepoIndex). */
export interface PlanRepoContext {
  summary: string;
  files: string[];
  /** Regex-extracted routes/endpoints (see indexFunctionality); optional, additive to files/summary. */
  functionality?: FunctionalityUnit[];
}

/**
 * Build the planning prompt. Asks the model for a single fenced ```json block so
 * the response is machine-parseable, while still leaving room for prose.
 *
 * When `repoIndex` is provided (white-box runs), a bounded repo-context section
 * (summary + up to MAX_PLAN_PROMPT_FILES file paths, plus any extracted
 * routes/endpoints) is appended so the plan is grounded in the actual repo
 * instead of the model guessing generic flows.
 *
 * Unlike earlier revisions, this does NOT cap the number of scenarios: when a
 * functionality inventory is available the model is asked to cover every
 * distinct unit; item count is expected to scale with the app's real surface
 * area, not an arbitrary "3-8" ceiling.
 */
export function buildPlanPrompt(project: Project, opts: RunOptions, repoIndex?: PlanRepoContext): string {
  const scope = opts.testingScope ?? 'both';
  const tiers = tiersForScope(scope);
  const units = repoIndex?.functionality ?? [];

  const lines: string[] = [];
  lines.push('You are Healix, an autonomous QA engineer. Produce a thorough end-to-end test plan');
  lines.push('for the application under test described below, aiming for comprehensive coverage');
  lines.push('of its real functionality — not just a handful of generic smoke checks.');
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
  if (opts.instructions && opts.instructions.trim().length > 0) {
    lines.push('');
    lines.push(
      'Additional instructions from the user — follow these when deciding what/how to plan (they describe HOW to test, not what the app does):',
    );
    lines.push('"""');
    lines.push(opts.instructions.trim());
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
  if (units.length > 0) {
    const shownUnits = units.slice(0, MAX_PLAN_PROMPT_UNITS);
    lines.push('');
    lines.push(
      `Detected routes/endpoints (${shownUnits.length}${units.length > shownUnits.length ? ` of ${units.length}` : ''}) — produce one plan item per unit below that is testable within the in-scope tier(s), unless it is clearly not user/API-facing:`,
    );
    for (const u of shownUnits) lines.push(`- [${u.kind}] ${u.label} (unitKey: "${u.key}")`);
    const remainingUnits = units.length - shownUnits.length;
    if (remainingUnits > 0) lines.push(`... and ${remainingUnits} more unit(s) not listed.`);
    if (tiers.includes('tierC-api')) {
      lines.push(
        'RULE for tierC-api items: only pair a tierC-api item with a "[endpoint]"-kind unit above — never a ' +
          '"[route]" or "[component]"-kind unit. A "[route]" is a frontend client-side navigation path (e.g. a ' +
          'React Router/Next.js page) that serves HTML/JS, not a JSON API; a raw HTTP request to that same path ' +
          'will NOT return the data a UI test would see rendered there. If a feature only has a route-kind unit ' +
          'and no matching backend endpoint was detected, either plan it under a UI tier instead or leave its ' +
          'unitKey null rather than pairing a tierC-api item with the wrong kind of unit.',
      );
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
  lines.push('      "intent": "what this test verifies, in one or two sentences",');
  lines.push('      "unitKey": "the unitKey from the detected list above, or null",');
  lines.push('      "scenarios": [');
  lines.push('        { "kind": "positive", "description": "a happy-path case" },');
  lines.push(
    '        { "kind": "positive", "description": "another distinct happy-path case, if the feature has more than one" },',
  );
  lines.push(
    '        { "kind": "negative", "description": "an invalid-input/unauthorized/error case, if applicable" },',
  );
  lines.push(
    '        { "kind": "negative", "description": "another distinct negative case, if applicable" },',
  );
  lines.push('        { "kind": "edge", "description": "a boundary condition, if applicable" }');
  lines.push('      ]');
  lines.push('    }');
  lines.push('  ]');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push(
    'The scenarios array is NOT limited to one entry per kind — include as many "positive", "negative", and ' +
      '"edge" scenarios as the feature genuinely has (e.g. three distinct negative cases is fine; so is zero edge ' +
      'cases for a feature with no real boundary condition). Never pad the list to force a fixed count.',
  );
  lines.push(
    'If a validation rule has multiple distinct concrete example inputs worth testing (e.g. several malformed ' +
      'email formats), give each example its OWN scenario entry — do not bundle them into one description like ' +
      "\"Malformed email formats ('abc', 'abc@', 'abc@.com') show 'Invalid email' error\". Exactly one test " +
      'is generated per scenario, so a bundled description only ever gets ONE example actually executed while the ' +
      "rest silently never run. Prefer: one scenario per example, e.g. \"Malformed email format 'abc' shows " +
      "'Invalid email' error\", another for 'abc@', another for 'abc@.com'.",
  );
  lines.push(
    units.length > 0
      ? 'Produce one item per distinct route/endpoint listed above that is testable in scope — do not skip any without good reason. Every item needs at least one "positive" scenario; add "negative" and "edge" scenarios only where genuinely applicable to that feature (do not fabricate them for a feature that has none).'
      : 'Enumerate every distinct user-facing flow or API surface you can identify from the context above — do not artificially limit the number of items. Every item needs at least one "positive" scenario; add "negative" and "edge" scenarios only where genuinely applicable to that feature.',
  );
  lines.push(`All items must stay within the "${tiers.join('", "')}" tier(s) above.`);
  lines.push(tierGuidanceFor(tiers));
  return lines.join('\n');
}

/**
 * Build buildPlanPrompt scoped to only `units`, with a caller-supplied note
 * explaining the scoping appended AFTER the base prompt rather than prepended
 * before it — this keeps buildPlanPrompt's static preamble as the true
 * leading prefix of the final prompt, so it stays a stable, cacheable prefix
 * shared across plan-generate/gap-fill/batch calls instead of being pushed
 * out of leading position by a per-call-variable scoping sentence.
 */
function buildScopedPlanPrompt(
  project: Project,
  opts: RunOptions,
  units: FunctionalityUnit[],
  repoIndex: PlanRepoContext | undefined,
  suffixNote: string,
): string {
  const scopedIndex: PlanRepoContext = {
    summary: repoIndex?.summary ?? '',
    files: [],
    functionality: units,
  };
  const base = buildPlanPrompt(project, opts, scopedIndex);
  return suffixNote ? `${base}\n\n${suffixNote}` : base;
}

/**
 * Build a follow-up plan prompt scoped to ONLY the given uncovered functionality
 * units — used by the orchestrator's coverage-feedback loop (see coverage.ts) to
 * fill remaining gaps after an initial plan/generate/execute pass falls short of
 * its coverage target, without re-asking for units already covered.
 */
export function buildGapFillPlanPrompt(
  project: Project,
  opts: RunOptions,
  uncoveredUnits: FunctionalityUnit[],
  repoIndex?: PlanRepoContext,
): string {
  return buildScopedPlanPrompt(
    project,
    opts,
    uncoveredUnits,
    repoIndex,
    'A previous pass already planned and tested other parts of this application. ' +
      'The list below is ONLY the functionality still missing coverage — focus exclusively on these.',
  );
}

/**
 * Build an initial-planning prompt scoped to ONLY one batch of the detected
 * functionality units — used by the orchestrator's plan phase (index.ts) to
 * split a large functionality inventory across several smaller completions
 * instead of one monolithic request covering every unit at once. Asking for
 * an unbounded single JSON response over e.g. 150 units is what makes the
 * model's output likely to get cut off (see PlanParseFailureReason
 * 'truncated'); batching keeps each individual response small.
 */
export function buildBatchPlanPrompt(
  project: Project,
  opts: RunOptions,
  batchUnits: FunctionalityUnit[],
  batchIndex: number,
  totalBatches: number,
  repoIndex?: PlanRepoContext,
): string {
  const suffixNote =
    totalBatches > 1
      ? `This application has more detected functionality than fits in one planning pass. This is ` +
        `batch ${batchIndex} of ${totalBatches} — the list below is ONLY this batch's units; a separate ` +
        `pass covers the rest. Plan for ONLY the units listed below.`
      : '';
  return buildScopedPlanPrompt(project, opts, batchUnits, repoIndex, suffixNote);
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
 * Why `parsePlan` produced no usable plan — lets callers decide whether the
 * failure is worth retrying:
 *   - 'no-json': no `{...}` object found at all (model refused/replied prose only).
 *   - 'truncated': an opening `{` was found but never balanced by EOF — the
 *     classic signature of the model's output getting cut off mid-response
 *     (output-length/token limit) before the JSON closed. Transient by nature:
 *     the identical request may well complete on a retry.
 *   - 'invalid-json': a complete, balanced `{...}` was found but JSON.parse
 *     failed on it (genuinely malformed syntax, not a length cutoff).
 *   - 'no-items': valid JSON, but zero usable items survived normalization
 *     (e.g. every item was missing a title).
 */
export type PlanParseFailureReason = 'no-json' | 'truncated' | 'invalid-json' | 'no-items';

export interface PlanParseResult {
  plan: TestPlan | null;
  failureReason?: PlanParseFailureReason;
}

/**
 * Robustly parse a model completion into a TestPlan, with diagnostics on
 * *why* parsing failed (see PlanParseFailureReason) so callers can decide
 * whether the failure is worth retrying instead of treating every parse
 * failure identically. Tries (in order):
 *   1. a fenced ```json block,
 *   2. a fenced ``` block,
 *   3. the first balanced top-level JSON object in the text.
 */
export function parsePlanWithDiagnostics(text: string, scope: TestingScope = 'both'): PlanParseResult {
  const extracted = extractJsonObject(text);
  if (!extracted.json) {
    return { plan: null, failureReason: extracted.truncated ? 'truncated' : 'no-json' };
  }

  let raw: RawPlan;
  try {
    raw = JSON.parse(extracted.json) as RawPlan;
  } catch {
    return { plan: null, failureReason: 'invalid-json' };
  }
  if (!raw || typeof raw !== 'object') return { plan: null, failureReason: 'invalid-json' };

  const itemsRaw = Array.isArray(raw.items) ? (raw.items as RawPlanItem[]) : [];
  const items: TestPlanItem[] = itemsRaw
    .map((it) => normalizeItem(it, scope))
    .filter((it): it is TestPlanItem => it !== null);

  if (items.length === 0) return { plan: null, failureReason: 'no-items' };

  const summary =
    typeof raw.summary === 'string' && raw.summary.trim().length > 0
      ? raw.summary.trim()
      : 'Generated test plan.';

  return { plan: { summary, items, raw } };
}

/**
 * Robustly parse a model completion into a TestPlan. Thin wrapper around
 * parsePlanWithDiagnostics for callers that only care whether parsing
 * succeeded, not why it failed. Returns null when nothing parseable/usable
 * is found.
 */
export function parsePlan(text: string, scope: TestingScope = 'both'): TestPlan | null {
  return parsePlanWithDiagnostics(text, scope).plan;
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
      scenarios: [
        {
          kind: 'positive',
          description: project.baseUrl
            ? `Send a basic request to ${project.baseUrl} and verify a successful HTTP response.`
            : 'Confirm the API responds to a basic health-check request.',
        },
      ],
    });
  } else if (project.baseUrl) {
    items.push({
      id: `pli_${nanoid(8)}`,
      title: 'Home page loads',
      tier: 'tierA-public',
      intent: `Navigate to ${project.baseUrl} and verify the page renders without console/network errors.`,
      scenarios: [
        {
          kind: 'positive',
          description: `Navigate to ${project.baseUrl} and verify the page renders without console/network errors.`,
        },
      ],
    });
    items.push({
      id: `pli_${nanoid(8)}`,
      title: 'Primary navigation works',
      tier: 'tierA-public',
      intent: 'Exercise the main navigation links and confirm each destination is reachable.',
      scenarios: [
        {
          kind: 'positive',
          description: 'Exercise the main navigation links and confirm each destination is reachable.',
        },
      ],
    });
  } else {
    items.push({
      id: `pli_${nanoid(8)}`,
      title: 'Smoke: application boots',
      tier: 'tierA-public',
      intent: 'Confirm the application under test starts and serves its entry point.',
      scenarios: [
        {
          kind: 'positive',
          description: 'Confirm the application under test starts and serves its entry point.',
        },
      ],
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
  lines.push(
    `Testing scope: ${scopeLabel(scope)} — keep the item within these tier(s): ${tiers.join(', ')},`,
  );
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
      {
        title: item.title,
        reqTag: item.reqTag ?? null,
        tier: item.tier,
        intent: item.intent,
        unitKey: item.unitKey ?? null,
        scenarios: item.scenarios,
      },
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
  lines.push('  "intent": "what this test verifies, in one or two sentences",');
  lines.push('  "unitKey": "keep the current unitKey, or null",');
  lines.push('  "scenarios": [');
  lines.push('    { "kind": "positive", "description": "the happy-path case" },');
  lines.push(
    '    { "kind": "negative", "description": "an invalid-input/unauthorized/error case, if applicable" },',
  );
  lines.push('    { "kind": "edge", "description": "a boundary condition, if applicable" }');
  lines.push('  ]');
  lines.push('}');
  lines.push('```');
  lines.push(
    'The scenarios array is NOT limited to one entry per kind — include as many "positive"/"negative"/"edge" ' +
      'entries as the feature genuinely has; never pad it to force a fixed count.',
  );
  lines.push(
    'If a validation rule has multiple distinct concrete example inputs worth testing, give each example its ' +
      'OWN scenario entry rather than bundling them into one description — exactly one test is generated per ' +
      'scenario, so a bundled description only ever gets one example actually executed.',
  );
  lines.push(
    'Include the full revised scenarios array (keep scenarios unaffected by the feedback as-is; revise only what the feedback requires).',
  );
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
  const candidate = extractJsonObject(text).json;
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
      taskType: 'plan-revise-item',
    });
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  if (!completion.ok || !completion.text) {
    return {
      ok: false,
      detail: completion.detail || `Provider "${provider.id}" returned no usable revision.`,
    };
  }
  const revised = parseReviseItemResponse(completion.text, opts.testingScope ?? 'both', item.id);
  if (!revised) {
    return { ok: false, detail: 'Could not parse a revised item from the provider response.' };
  }
  return { ok: true, item: revised };
}

/**
 * Matches ANY parenthesized, comma-separated list, e.g. `('abc', 'abc@')` or
 * `(13, 15, 17)` — a CANDIDATE bundle. Whether it's actually treated as one
 * (vs. an ordinary parenthetical aside) is decided by isVariantBundle below,
 * not by this regex alone. No nested-parens support needed here: descriptions
 * are short, flat sentences, not code.
 */
const PARENTHESIZED_LIST_RE = /\(([^()]+)\)/;

/** Cap on how many variants get split out of one bundled description — a pathological huge list is left bundled rather than exploding into dozens of tests. */
const MAX_SPLIT_VARIANTS = 8;

function isQuotedLiteral(token: string): boolean {
  return (
    (token.startsWith("'") && token.endsWith("'") && token.length >= 2) ||
    (token.startsWith('"') && token.endsWith('"') && token.length >= 2)
  );
}

/**
 * A bare (unquoted) token is treated as a literal data value only when it's a
 * single word with no internal whitespace AND contains at least one
 * non-letter character (a digit or symbol) — realistic malformed-format
 * examples almost always do ('abc@', '000-000', '13/45/2020'), while an
 * ordinary prose enumeration (field names, browser names, etc.) is almost
 * always pure alphabetic words ('name', 'email', 'Chrome'). This is a
 * deliberately conservative heuristic: it would rather miss an unquoted,
 * all-letters variant list than mis-split a normal sentence like "(name,
 * email, phone) fields are required".
 */
function looksLikeBareVariantToken(token: string): boolean {
  return /^\S+$/.test(token) && /[^a-zA-Z]/.test(token);
}

/** Every item in the list is either a quoted literal or a bare "value-like" token (see looksLikeBareVariantToken) — a mix of the two is fine (e.g. one quoted, one bare-numeric). */
function isVariantBundle(items: string[]): boolean {
  return items.every((item) => isQuotedLiteral(item) || looksLikeBareVariantToken(item));
}

/**
 * A scenario like "Malformed email formats ('abc', 'abc@', 'abc@.com') show
 * 'Invalid email' error" describes ONE validation rule but bundles THREE
 * concrete example inputs into its description — left as-is, GENERATE's own
 * "exactly one test(...) per scenario" contract (see generate.ts's
 * formatScenarios/count-mismatch retry) means only ONE test gets written for
 * it, so the model picks a single example and the other two are silently
 * never executed, never reported, and never recorded (the bug this fixes).
 * The same happens for an unquoted bundle like "Invalid ages (13, 15, 17)
 * are rejected".
 *
 * Splits such a description into one scenario per bundled example, each
 * naming just that one value — so each becomes its own generated test with
 * its own pass/fail/skip row and its own recording. A description with no
 * bundled list, or a parenthetical that isn't a data-value list (e.g. "(name,
 * email, phone) fields are required" — plain words, no digits/symbols), is
 * left completely unchanged; see isVariantBundle's own doc comment for why
 * that distinction matters.
 */
function splitBundledVariants(scenario: PlanScenario): PlanScenario[] {
  const match = PARENTHESIZED_LIST_RE.exec(scenario.description);
  if (!match) return [scenario];
  const items = match[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (items.length < 2 || items.length > MAX_SPLIT_VARIANTS) return [scenario];
  if (!isVariantBundle(items)) return [scenario];
  const [fullMatch] = match;
  const start = match.index;
  return items.map((item) => ({
    kind: scenario.kind,
    description:
      scenario.description.slice(0, start) + item + scenario.description.slice(start + fullMatch.length),
  }));
}

/** Parse and normalize a raw scenarios array; unknown/malformed entries are dropped, not coerced into noise. */
function normalizeScenarios(raw: unknown): PlanScenario[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanScenario[] = [];
  for (const entry of raw as RawScenario[]) {
    if (!entry || typeof entry !== 'object') continue;
    const description = typeof entry.description === 'string' ? entry.description.trim() : '';
    if (description.length === 0) continue;
    const kindRaw = typeof entry.kind === 'string' ? entry.kind.trim().toLowerCase() : '';
    const kind = (KNOWN_SCENARIO_KINDS.find((k) => k === kindRaw) ?? 'positive') as PlanScenario['kind'];
    out.push(...splitBundledVariants({ kind, description }));
  }
  return out;
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
  const unitKey =
    typeof it.unitKey === 'string' && it.unitKey.trim().length > 0 && it.unitKey.trim() !== 'null'
      ? it.unitKey.trim()
      : undefined;
  const tier = normalizeTier(it.tier, scope);
  let scenarios = normalizeScenarios(it.scenarios);
  // A malformed/missing scenarios array shouldn't sink an otherwise-usable item —
  // fall back to a single positive scenario derived from intent, same as the
  // pre-scenarios behavior where intent alone drove generation.
  if (scenarios.length === 0) scenarios = [{ kind: 'positive', description: intent }];
  const item: TestPlanItem = { id: `pli_${nanoid(8)}`, title, tier, intent, scenarios };
  if (reqTag) item.reqTag = reqTag;
  if (unitKey) item.unitKey = unitKey;
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

interface BalancedResult {
  json: string | null;
  /** True when an opening `{` was found but never balanced before EOF — the
   * signature of output cut off mid-response, as opposed to no JSON at all. */
  truncated: boolean;
}

/** Extract a JSON object string from arbitrary model output, with a truncation signal. */
function extractJsonObject(text: string): BalancedResult {
  if (!text) return { json: null, truncated: false };

  // A response cut off mid-generation, before ever emitting the closing ```
  // fence, means neither fenced regex below matches at all (both require a
  // closing fence) — falling through to sliceBalanced(text) on the raw text
  // still finds the (unclosed) opening brace and correctly reports truncation.
  const fencedJson = /```json\s*([\s\S]*?)```/i.exec(text);
  if (fencedJson && fencedJson[1]) {
    const inner = sliceBalanced(fencedJson[1]);
    if (inner.json || inner.truncated) return inner;
  }

  const fenced = /```\s*([\s\S]*?)```/.exec(text);
  if (fenced && fenced[1]) {
    const inner = sliceBalanced(fenced[1]);
    if (inner.json || inner.truncated) return inner;
  }

  return sliceBalanced(text);
}

/**
 * Return the first balanced {...} object substring, respecting strings/
 * escapes, plus whether an opening `{` was found but never balanced by EOF
 * (truncated output) as distinct from no `{` at all (no JSON present).
 */
function sliceBalanced(text: string): BalancedResult {
  const start = text.indexOf('{');
  if (start === -1) return { json: null, truncated: false };
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
      if (depth === 0) return { json: text.slice(start, i + 1), truncated: false };
    }
  }
  // Reached EOF with an opening brace that never closed (depth > 0, or still
  // mid-string) — the classic output-truncation signature.
  return { json: null, truncated: true };
}
