import type { ProviderAdapter } from '../providers/types.js';
import type { UsageRecorder } from '../providers/usage.js';

export type Verdict = 'test_is_wrong' | 'app_is_wrong' | 'environment' | 'flaky' | 'ambiguous';

export interface TriageInput {
  title: string;
  error: string;
  specSource?: string;
  reqTag?: string;
  tracePath?: string;
  /** Relative path of the source-context unit (see target/source-index.ts) the failing test's plan item mapped to, when known. */
  sourceFile?: string;
  /** That file's content (or a leading slice of it) — first-party repo code, cited normally rather than fenced as untrusted. */
  sourceExcerpt?: string;
  /**
   * Compact summary of the actual HTTP call(s) this test made via the
   * `request` fixture (see modes/types.ts's ExecOutcome.apiEvidence) — which
   * backend actually answered (Healix's own mock, or the real one), the
   * status, and a truncated body. App-derived (captured from the app/mock
   * under test), so treated as untrusted data in the prompt, same as `error`.
   * Absent when the failing test never called `request`, or predates this
   * feature.
   */
  apiEvidence?: string;
  /**
   * Real evidence that THIS test's own request(s) fell through the generated mock fixture
   * unintercepted (see modes/types.ts's ExecOutcome.mockPassthrough) — its hostname matched
   * no detected dependency and no `mockOverride` matched either, so it hit the real
   * (often unreachable, sandboxed) backend and hung. A very likely cause of a bare timeout
   * with no assertion error — a mock-configuration gap, not the app being slow or a real
   * environment/infra problem. App/mock-derived, so treated as untrusted data in the prompt,
   * same as `error`/`apiEvidence`. Absent when the failing test's own requests were either
   * all intercepted, or predates this feature.
   */
  mockPassthroughEvidence?: string;
  /**
   * The project's configured/detected base URL (e.g.
   * `http://localhost:4202/#/SK/home`) — project configuration, not
   * app-rendered output, so it's cited normally rather than fenced as
   * untrusted. Lets a rule compare a failing test's OWN `page.goto(...)`
   * target against the app's real navigation convention (e.g. a required
   * locale/route segment in the hash) to catch a generated test that never
   * reaches a real route, rather than inferring an app defect from the
   * resulting "content never appeared" symptom.
   */
  baseUrl?: string;
}

export interface TriageResult {
  verdict: Verdict;
  confidence: number;
  rationale: string;
  /**
   * Recommended fix, present when the model could be concrete. Its shape
   * depends on `verdict`: for `test_is_wrong` it's a corrected test code
   * snippet; for `app_is_wrong` it's a prose recommendation for engineers
   * (likely root cause + where to look), not literal app source — the
   * triage engine never sees the app's codebase. Omitted for
   * environment/flaky/ambiguous, where there is no code-level fix.
   */
  suggestedPatch?: string;
  /**
   * Where this verdict actually came from — surfaced to users so a verdict
   * can be told apart from a genuinely AI-reviewed judgment vs. one that
   * fell back to the deterministic rule baseline because the AI call itself
   * errored, timed out, or returned an unparseable reply (or simply because
   * a rule matched with high enough confidence that classify() never needed
   * to escalate). Always set — 'rule_fallback' by classifyByRules() itself,
   * upgraded to 'ai_reviewed' only by reconcile() when a real AI reply was
   * successfully parsed and used.
   */
  verdictSource: 'ai_reviewed' | 'rule_fallback';
}

/** One failure entered into a batched analyze() call, keyed by a caller-assigned id (stable across the batch/split-retry lifecycle — not the test's own reqTag/title, which may repeat or be absent). */
export interface TriageBatchItem {
  id: string;
  input: TriageInput;
}

/** Deterministic classifier first, AI hypothesis second (ported from TestBot failure-triage). */
export interface TriageEngine {
  classify(input: TriageInput): TriageResult;
  /**
   * `signal` lets the caller cancel the underlying provider call (and kill its
   * CLI child process) when its own patience runs out, instead of abandoning
   * it to keep running in the background untracked.
   */
  analyze(
    input: TriageInput,
    provider: ProviderAdapter,
    signal?: AbortSignal,
    onUsage?: UsageRecorder,
    cwd?: string,
  ): Promise<TriageResult>;
  /**
   * Analyze several failures in ONE provider call instead of N separate ones —
   * each item still gets its own evidence block in the prompt, but the fixed
   * instructions/schema preamble is only paid once per batch.
   *
   * `results` is keyed by each item's `id`; an id absent from it means that
   * one item's entry within an otherwise-parseable reply was missing or
   * malformed — the caller falls back to `classify()`'s baseline for it,
   * exactly as it already does for a solo `analyze()` timeout/failure.
   *
   * `truncated` is true only when the reply genuinely attempted a JSON array
   * but was cut off mid-object (see prompt.ts's looksLikeTruncatedBatchReply)
   * — the ONE case worth halving the batch and retrying (smaller output has a
   * real chance of not truncating). A reply with no array-like structure at
   * all (garbled text, a stub response) is NOT truncated — a smaller batch
   * has no reason to fix that, so the caller should not retry-split for it.
   */
  analyzeBatch(
    items: TriageBatchItem[],
    provider: ProviderAdapter,
    signal?: AbortSignal,
    onUsage?: UsageRecorder,
    cwd?: string,
  ): Promise<{ results: Map<string, TriageResult>; truncated: boolean }>;
}
