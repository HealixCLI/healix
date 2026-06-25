/**
 * Two-hypothesis triage prompt + robust reply parsing.
 *
 * The prompt frames every failure as a competition between two grounded
 * hypotheses (the test is wrong vs. the app is wrong), plus the escape hatches
 * `environment`, `flaky`, and `ambiguous`. Grounding the model in the actual
 * error text and spec source — and forcing a fenced JSON reply — keeps it from
 * defaulting to its "blame the test" bias.
 */
import type { TriageInput, TriageResult, Verdict } from './types.js';

const VERDICTS: readonly Verdict[] = [
  'test_is_wrong',
  'app_is_wrong',
  'environment',
  'flaky',
  'ambiguous',
];

const MAX_ERROR_CHARS = 4_000;
const MAX_SPEC_CHARS = 6_000;

function truncate(value: string | undefined, max: number): string {
  const s = String(value ?? '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… [truncated, ${s.length - max} more chars]`;
}

/**
 * Build the two-hypothesis prompt. The model is told to weigh both sides, lean
 * on the provided evidence, and answer ONLY with a fenced ```json block.
 */
export function buildTriagePrompt(input: TriageInput): string {
  const title = truncate(input.title, 500) || '(no title provided)';
  const error = truncate(input.error, MAX_ERROR_CHARS) || '(no error text captured)';
  const specSource = input.specSource
    ? truncate(input.specSource, MAX_SPEC_CHARS)
    : '(spec source unavailable)';
  const reqLine = input.reqTag ? `\nRequirement tag: ${input.reqTag}` : '';

  return [
    'You are a senior test-failure triage engine. A single automated end-to-end',
    'test failed. Decide WHO is at fault by weighing two competing hypotheses,',
    'grounded strictly in the evidence below. Do not assume the test is wrong by',
    'default — content/URL assertion failures frequently indicate a real app',
    'regression.',
    '',
    'HYPOTHESIS A — test_is_wrong: the test itself is incorrect or stale (bad or',
    '  hallucinated selector, wrong expected value, outdated flow, racey wait).',
    'HYPOTHESIS B — app_is_wrong: the application has a genuine defect or',
    '  regression (wrong content rendered, 5xx error, broken navigation, missing',
    '  feature) that the test correctly caught.',
    '',
    'If neither clearly wins, choose one of:',
    '  environment — infrastructure/config issue (server down, auth context',
    '    missing, DNS, navigation timeout) unrelated to test or app logic.',
    '  flaky — non-deterministic timing/visibility issue likely to pass on retry.',
    '  ambiguous — genuinely insufficient evidence to attribute fault.',
    '',
    `Allowed verdict values (use EXACTLY one): ${VERDICTS.join(' | ')}.`,
    '',
    '--- FAILED TEST ---',
    `Title: ${title}${reqLine}`,
    '',
    '--- ERROR / STACK ---',
    error,
    '',
    '--- TEST SPEC SOURCE ---',
    specSource,
    '',
    '--- INSTRUCTIONS ---',
    'Reply with NOTHING except a single fenced JSON code block in this exact',
    'shape (suggestedPatch only when verdict is test_is_wrong and you can propose',
    'a concrete corrected snippet):',
    '',
    '```json',
    '{',
    '  "verdict": "test_is_wrong | app_is_wrong | environment | flaky | ambiguous",',
    '  "confidence": 0.0,',
    '  "rationale": "one or two sentences citing the specific evidence",',
    '  "suggestedPatch": "optional corrected test snippet"',
    '}',
    '```',
  ].join('\n');
}

function isVerdict(value: unknown): value is Verdict {
  return typeof value === 'string' && (VERDICTS as readonly string[]).includes(value);
}

function clampConfidence(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n <= 1) return Number(n.toFixed(2));
  // Above 1: this is either a 0–100 percentage or a small-integer scale (1–5,
  // 1–10). Only divide by 100 when the value is clearly on a 0–100 scale —
  // integer-ish AND >= 10 — so a model answering "2" or "5" does not collapse
  // to 0.02 / 0.05. Otherwise the value already overflows [0,1]; clamp to 1.
  const isPercentage = n >= 10 && n <= 100 && Math.abs(n - Math.round(n)) < 1e-9;
  if (isPercentage) return Number((n / 100).toFixed(2));
  return 1;
}

/**
 * Pull the first plausible JSON object out of a model reply. Handles:
 *   - ```json … ``` fenced blocks (preferred),
 *   - bare ``` … ``` fences,
 *   - fenced blocks whose JSON `suggestedPatch` itself contains a nested
 *     triple-backtick fence (the outer fence is matched greedily so the inner
 *     fence does not truncate the block),
 *   - a raw {...} object embedded in surrounding prose.
 * Returns the parsed object or null if nothing parses.
 */
function extractJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null;

  const candidates: string[] = [];

  // Outer fence matched GREEDILY: span from the first ```json/``` opener to the
  // LAST closing ``` in the reply. This tolerates a nested triple-backtick
  // fence inside suggestedPatch — the non-greedy variant below would stop at
  // the inner closing fence and truncate the JSON.
  const greedyFenceRe = /```(?:json)?\s*([\s\S]*)```/i;
  const greedy = greedyFenceRe.exec(text);
  if (greedy && greedy[1]) candidates.push(greedy[1].trim());

  // Non-greedy fenced blocks (json-tagged first, then any fence) for the common
  // single-fence case and replies with multiple independent blocks.
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    if (m[1]) candidates.push(m[1].trim());
  }

  // First balanced-looking {...} span as a fallback.
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1).trim());
  }

  for (const candidate of candidates) {
    const parsed = tryParse(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function tryParse(candidate: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(candidate);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Parse a model reply into a TriageResult. Returns null when the reply does not
 * contain a usable verdict so the caller can fall back to deterministic rules.
 */
export function parseTriageReply(text: string): TriageResult | null {
  const obj = extractJsonObject(String(text ?? ''));
  if (!obj) return null;

  if (!isVerdict(obj.verdict)) return null;

  const rationale =
    typeof obj.rationale === 'string' && obj.rationale.trim().length > 0
      ? obj.rationale.trim()
      : 'AI returned a verdict without a rationale.';

  const result: TriageResult = {
    verdict: obj.verdict,
    confidence: clampConfidence(obj.confidence),
    rationale,
  };

  const patch = obj.suggestedPatch;
  if (typeof patch === 'string' && patch.trim().length > 0) {
    result.suggestedPatch = patch.trim();
  }

  return result;
}
