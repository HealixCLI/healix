import { nanoid } from 'nanoid';
import type { Project, Tier } from '../storage/types.js';
import type { TestPlan, TestPlanItem } from '../modes/types.js';
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
  const lines: string[] = [];
  lines.push('You are Healix, an autonomous QA engineer. Produce a concise end-to-end test plan');
  lines.push('for the application under test described below.');
  lines.push('');
  lines.push(`Project name: ${project.name}`);
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
  lines.push(`      "tier": "${KNOWN_TIERS.join('" | "')}",`);
  lines.push('      "intent": "what this test verifies, in one or two sentences"');
  lines.push('    }');
  lines.push('  ]');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('Prefer 3-8 high-value scenarios. Use tierA-public for unauthenticated flows,');
  lines.push('tierB-auth for authenticated flows, and tierC-api for API-level checks.');
  return lines.join('\n');
}

/**
 * Robustly parse a model completion into a TestPlan. Tries (in order):
 *   1. a fenced ```json block,
 *   2. a fenced ``` block,
 *   3. the first balanced top-level JSON object in the text.
 * Returns null when nothing parseable/usable is found.
 */
export function parsePlan(text: string): TestPlan | null {
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
    .map((it) => normalizeItem(it))
    .filter((it): it is TestPlanItem => it !== null);

  if (items.length === 0) return null;

  const summary =
    typeof raw.summary === 'string' && raw.summary.trim().length > 0
      ? raw.summary.trim()
      : 'Generated test plan.';

  return { summary, items, raw };
}

/** Deterministic fallback plan when the model produced nothing usable. */
export function synthesizePlan(project: Project): TestPlan {
  const items: TestPlanItem[] = [];
  if (project.baseUrl) {
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

function normalizeItem(it: RawPlanItem): TestPlanItem | null {
  if (!it || typeof it !== 'object') return null;
  const title = typeof it.title === 'string' ? it.title.trim() : '';
  if (title.length === 0) return null;
  const intent = typeof it.intent === 'string' && it.intent.trim().length > 0 ? it.intent.trim() : title;
  const reqTag =
    typeof it.reqTag === 'string' && it.reqTag.trim().length > 0 && it.reqTag.trim() !== 'null'
      ? it.reqTag.trim()
      : undefined;
  const tier = normalizeTier(it.tier);
  const item: TestPlanItem = { id: `pli_${nanoid(8)}`, title, tier, intent };
  if (reqTag) item.reqTag = reqTag;
  return item;
}

function normalizeTier(value: unknown): Tier {
  if (typeof value === 'string') {
    const v = value.trim();
    const match = KNOWN_TIERS.find((t) => t === v);
    if (match) return match;
  }
  // Unknown/hallucinated tiers clamp to a known default rather than leaking through.
  return 'tierA-public';
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
