import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderId } from '../providers/types.js';
import type { SuiteMode, Tier } from '../storage/types.js';
import type { TestingScope, TestPlan } from '../modes/types.js';

/**
 * The "knowledge base + tracker" a pause/interruption leaves behind: enough
 * to resume a run without re-planning, without re-asking the AI for specs it
 * already generated, and without re-executing tiers that already ran.
 * Written to `<runDir>/checkpoint.json`, mirroring the existing plan.json
 * persistence convention (see orchestrator/index.ts's writeJson).
 */
export interface ResumeCheckpoint {
  runId: string;
  projectId: string;
  /** Orchestrator phase to resume INTO — always past planning/approval, which never re-run on resume. */
  phase: 'generate' | 'execute' | 'triage' | 'report';
  /** The run's original request, so resume continues with identical configuration. */
  runOptions: {
    testingScope?: TestingScope;
    suiteMode?: SuiteMode;
    baseRunId?: string;
    provider?: ProviderId;
    autoApprove?: boolean;
    prd?: string;
    instructions?: string;
    prdSourceKind?: 'text' | 'file' | 'spreadsheet';
    prdFileName?: string;
    prdSelectedSheets?: string[];
  };
  /** The finalized, human-approved plan — resume never re-plans or re-shows the approval gate. */
  plan: TestPlan;
  /** Plan item ids whose spec has already been generated and accepted — skipped on resume's GENERATE pass. */
  generatedItemIds: string[];
  /** Enough to reconstruct GeneratedSpec[] for already-generated items without re-invoking the AI. */
  generatedSpecs: Array<{ path: string; title: string; reqTag?: string; tier: Tier }>;
  /** Tiers whose Playwright invocation already completed and was persisted — skipped on resume's EXECUTE pass. */
  completedTiers: Tier[];
  /** Accumulated results from completedTiers, merged with newly-executed tiers on resume. */
  partialOutcome?: {
    passed: number;
    failed: number;
    blocked: number;
    flaky: number;
    results: Array<{
      title: string;
      status: string;
      durationMs?: number;
      error?: string;
      artifacts?: string[];
    }>;
  };
  /**
   * Stable-key -> testId rows already inserted for this run (see index.ts's
   * registerSpecRows). Resume rehydrates this directly instead of re-deriving
   * it, so an EXECUTE-resume's persistResults() call updates the SAME rows
   * GENERATE created rather than inserting duplicates.
   */
  testIdByKey?: Record<string, string>;
  updatedAt: string;
}

function checkpointPath(runDir: string): string {
  return join(runDir, 'checkpoint.json');
}

/** Best-effort write — a checkpoint failure must never abort the run it's trying to protect. */
export async function writeCheckpoint(runDir: string, checkpoint: ResumeCheckpoint): Promise<void> {
  try {
    await writeFile(checkpointPath(runDir), JSON.stringify(checkpoint, null, 2), 'utf-8');
  } catch {
    /* best-effort; resume simply won't have this snapshot if it fails */
  }
}

/** Read a run's checkpoint, or null if none exists (never started resumable work, or was cleaned up). */
export async function readCheckpoint(runDir: string): Promise<ResumeCheckpoint | null> {
  try {
    const raw = await readFile(checkpointPath(runDir), 'utf-8');
    return JSON.parse(raw) as ResumeCheckpoint;
  } catch {
    return null;
  }
}

/** Best-effort delete once a run reaches a terminal, non-paused state — nothing left to resume. */
export async function deleteCheckpoint(runDir: string): Promise<void> {
  try {
    await unlink(checkpointPath(runDir));
  } catch {
    /* best-effort; absent is the common case */
  }
}

/** Transient-failure signatures worth auto-resuming from, vs. a genuine bug/config error that should still hard-fail. */
export type TransientFailureReason = 'network' | 'credits-exhausted';

/** Connection/DNS/timeout signatures — the process couldn't reach the provider or target at all. */
const RE_NETWORK =
  /(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|network ?error|fetch failed|socket hang up|net::ERR_)/i;

/** Rate-limit/quota/credit-exhaustion signatures from a provider's own error text. */
const RE_CREDITS =
  /(rate.?limit|quota exceeded|insufficient[_ ]?(credits?|balance|quota)|usage limit|credit(s)? exhausted|429|billing|out of credits|too many requests)/i;

/**
 * Classify a failure's error text as a known transient interruption, or null
 * for anything else (a genuine bug/bad config, which must keep hard-failing
 * exactly as it does today rather than being silently retried forever).
 * Deterministic pattern match, same static-first approach the triage engine
 * already uses for test-failure classification (see triage/rules.ts).
 */
export function classifyTransientFailure(detail: string): TransientFailureReason | null {
  const text = detail ?? '';
  if (RE_CREDITS.test(text)) return 'credits-exhausted';
  if (RE_NETWORK.test(text)) return 'network';
  return null;
}
