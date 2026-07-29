import { Fragment, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentEvent, TestCase, TestResult, TestStatus, UsageRow } from '@healix/core';
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderOpen,
  History,
  Image as ImageIcon,
  PackageOpen,
  RotateCcw,
  Wrench,
  X,
} from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { StatTile, StatTileRow } from './StatTiles';
import { TestCaseHistoryDrawer } from './TestCaseHistoryDrawer';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { Tabs } from './ui/tabs';
import type { RunDetail, ReportTriageEntryShape, StartRunArgs } from '../lib/ipc-types';
import { asRunReport, reportDegradationNotes } from '../lib/ipc-types';
import { SHOW_REPAIR_ACTION, SHOW_TOKEN_USAGE } from '../lib/feature-flags';
import { cn } from '../lib/utils';
import {
  artifactKind,
  artifactLeaf,
  artifactUrl,
  computeStageDurations,
  computeTotalDurationMs,
  eventLevelColor,
  formatCost,
  formatDuration,
  formatStageBreakdown,
  formatTime,
  formatTokens,
  runStatusTone,
  sumNullable,
  testStatusTone,
} from '../lib/run-format';
import type { StageDuration } from '../lib/run-format';

type DetailTab = 'timeline' | 'results' | 'triage' | 'usage';

const VERDICT_TONE: Record<string, 'ok' | 'warn' | 'err' | 'muted' | 'default'> = {
  app_is_wrong: 'err',
  test_is_wrong: 'warn',
  environment: 'warn',
  flaky: 'warn',
  ambiguous: 'muted',
};

/** Full detail for a selected historical run: timeline, results, triage, artifacts. */
export function RunDetailPanel({
  detail,
  loading,
  onSelectRun,
  onRetryPass,
}: {
  detail: RunDetail | null;
  loading: boolean;
  /** Jump to a different run (e.g. from the Test Case History drawer). Omit to disable those jumps. */
  onSelectRun?: (runId: string) => void;
  /**
   * Start a targeted regeneration run (Retry-pass/Repair): given a ready
   * StartRunArgs (suiteMode 'topup', baseRunId this run, retryItemIds set),
   * the caller runs it through the same start-or-queue path as any other
   * run. Omit to hide the Retry-pass/Repair buttons entirely.
   */
  onRetryPass?: (args: StartRunArgs) => void;
}) {
  const [tab, setTab] = useState<DetailTab>('timeline');
  const [busy, setBusy] = useState<'reveal' | 'export' | 'retry' | 'repair' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<TestStatus | 'all'>('all');
  const [historyCaseKey, setHistoryCaseKey] = useState<{ reqTag: string | null; title: string } | null>(null);
  // Opened from a Results row's own inline evidence (screenshots/recordings).
  const [preview, setPreview] = useState<Preview | null>(null);

  const report = useMemo(() => asRunReport(detail?.report ?? null), [detail?.report]);
  const triage = report?.triage ?? [];
  const degradationNotes = useMemo(() => reportDegradationNotes(report), [report]);

  // Join results to their test rows so the table can show title / REQ / tier.
  const rows = useMemo(() => joinResults(detail?.tests ?? [], detail?.results ?? []), [detail]);
  // A status filter only ever narrows the Results tab; other tabs ignore it.
  const filteredRows = useMemo(
    () => (statusFilter === 'all' ? rows : rows.filter((r) => (r.status ?? 'pending') === statusFilter)),
    [rows, statusFilter],
  );
  const summary = useMemo(() => summarizeStatuses(rows), [rows]);
  const totalTimeMs = useMemo(
    () => (detail?.run ? computeTotalDurationMs(detail.run, detail.events) : null),
    [detail?.run, detail?.events],
  );
  const stageDurations = useMemo(() => computeStageDurations(detail?.events ?? []), [detail?.events]);

  // Reset any active filter and tab when a different run is opened.
  useEffect(() => {
    setStatusFilter('all');
    setTab('timeline');
  }, [detail?.run?.id]);

  const selectStatus = (status: TestStatus | 'all'): void => {
    setStatusFilter((prev) => (prev === status ? 'all' : status));
    setTab('results');
  };

  const suiteDir = detail?.suiteDir ?? null;

  const reveal = async (target: string): Promise<void> => {
    setBusy('reveal');
    setNote(null);
    try {
      const res = await window.healix.revealPath(target);
      if (!res.ok) setNote('Could not open the path.');
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const exportSuite = async (): Promise<void> => {
    if (!suiteDir) return;
    setBusy('export');
    setNote(null);
    try {
      const bundle = await window.healix.exportSuite({
        suiteDir,
        zip: true,
        sanitize: true,
        projectId: run.projectId,
      });
      const target = bundle.zipPath ?? bundle.dir;
      setNote(`Exported to ${target}`);
      await window.healix.revealPath(target);
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Regenerate ONLY the plan items from this run that never got a test
   * generated, OR got generated but never actually executed (a spec was
   * registered, then the run errored out before EXECUTE produced a result
   * for it — see main/index.ts's runs:generationGaps / matchGenerationGaps's
   * doc comment) — a targeted top-up instead of a full re-plan. No-op (with
   * an explanatory note) when this run's plan had no gaps to fill.
   */
  const startRetryPass = async (): Promise<void> => {
    if (!onRetryPass || !detail?.run) return;
    setBusy('retry');
    setNote(null);
    try {
      const gaps = await window.healix.generationGaps(detail.run.id);
      if (gaps.length === 0) {
        setNote('Nothing to retry — every planned item already has a generated, executed test.');
        return;
      }
      onRetryPass({
        projectId: detail.run.projectId,
        testingScope: detail.runConfig?.testingScope,
        provider: detail.runConfig?.provider,
        suiteMode: 'topup',
        baseRunId: detail.run.id,
        autoApprove: true,
        retryItemIds: gaps.map((g) => g.id),
      });
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Regenerate ONLY the tests this run's triage verdicted 'test_is_wrong' —
   * the test itself is the problem (not the app), so a fresh generation
   * attempt is the fix, not a re-run. Reuses Retry-pass's exact
   * retryItemIds mechanism (see main/index.ts's runs:repairCandidates,
   * built on the same base-plan-id matching as runs:generationGaps), just
   * with triage verdicts as the candidate source instead of generation gaps.
   */
  const startRepair = async (): Promise<void> => {
    if (!onRetryPass || !detail?.run) return;
    setBusy('repair');
    setNote(null);
    try {
      const candidates = await window.healix.repairCandidates(detail.run.id);
      if (candidates.length === 0) {
        setNote('Nothing to repair — no tests were triaged "test is wrong" for this run.');
        return;
      }
      onRetryPass({
        projectId: detail.run.projectId,
        testingScope: detail.runConfig?.testingScope,
        provider: detail.runConfig?.provider,
        suiteMode: 'topup',
        baseRunId: detail.run.id,
        autoApprove: true,
        retryItemIds: candidates.map((c) => c.id),
      });
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (!detail && loading) {
    return <div className="flex h-full items-center justify-center text-sm text-muted">Loading run…</div>;
  }
  if (!detail || !detail.run) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        Select a run from the history to inspect it.
      </div>
    );
  }

  const { run } = detail;

  const usage = detail.usage ?? [];

  // Usage tab is gated behind SHOW_TOKEN_USAGE — see feature-flags.ts.
  const TABS: ReadonlyArray<{ value: DetailTab; label: string }> = [
    { value: 'timeline', label: `Timeline · ${detail.events.length}` },
    { value: 'results', label: `Results · ${rows.length}` },
    { value: 'triage', label: `Triage · ${triage.length}` },
    ...(SHOW_TOKEN_USAGE ? [{ value: 'usage' as const, label: `Usage · ${usage.length}` }] : []),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
        <div className="flex items-center gap-2">
          <Badge tone={runStatusTone(run.status)}>{run.status}</Badge>
          {run.mode && <span className="font-mono text-xs text-muted">{run.mode}</span>}
          {run.suiteMode && run.suiteMode !== 'fresh' && (
            <Badge tone="default" title={run.baseRunId ? `Based on run ${run.baseRunId}` : undefined}>
              {run.suiteMode}
            </Badge>
          )}
          <span className="font-mono text-[11px] text-muted/70">{run.id}</span>
        </div>
        <div className="flex items-center gap-2">
          {detail.reportHtmlPath && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void reveal(detail.reportHtmlPath!)}
              disabled={busy !== null}
            >
              <FileText className="h-4 w-4" />
              Report
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => suiteDir && void reveal(suiteDir)}
            disabled={!suiteDir || busy !== null}
          >
            <FolderOpen className="h-4 w-4" />
            Reveal suite
          </Button>
          <Button size="sm" onClick={exportSuite} disabled={!suiteDir || busy !== null}>
            <PackageOpen className="h-4 w-4" />
            {busy === 'export' ? 'Exporting…' : 'Export suite'}
          </Button>
          {onRetryPass && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void startRetryPass()}
              disabled={busy !== null}
              title="Regenerate only the plan items from this run that never got a test, or never got executed"
            >
              <RotateCcw className="h-4 w-4" />
              {busy === 'retry' ? 'Checking…' : 'Retry-pass'}
            </Button>
          )}
          {/* Held back for a later release — see feature-flags.ts's SHOW_REPAIR_ACTION doc comment. */}
          {onRetryPass && SHOW_REPAIR_ACTION && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void startRepair()}
              disabled={busy !== null}
              title="Regenerate only the tests this run's triage marked 'test is wrong'"
            >
              <Wrench className="h-4 w-4" />
              {busy === 'repair' ? 'Checking…' : 'Repair'}
            </Button>
          )}
        </div>
      </div>

      {note && <p className="mt-2 break-all text-xs text-muted">{note}</p>}

      {degradationNotes.length > 0 && (
        <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <p className="font-medium">⚠ This run's suite may be smaller than intended</p>
          <ul className="mt-1 list-disc pl-4">
            {degradationNotes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3">
        <Tabs items={TABS} value={tab} onChange={setTab} />
      </div>

      <div className="mt-3 flex min-h-0 flex-1 flex-col">
        {tab === 'timeline' && (
          <div className="min-h-0 flex-1 overflow-auto">
            <Timeline events={detail.events} />
          </div>
        )}
        {tab === 'results' && (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <TestSummary
              summary={summary}
              activeStatus={statusFilter}
              onSelect={selectStatus}
              totalTimeMs={totalTimeMs}
              stageDurations={stageDurations}
            />
            <div className="min-h-0 flex-1 overflow-auto">
              <ResultsTable
                rows={filteredRows}
                onShowHistory={(row) => setHistoryCaseKey({ reqTag: row.reqTag, title: row.title })}
                setPreview={setPreview}
              />
            </div>
          </div>
        )}
        {tab === 'triage' && (
          <div className="min-h-0 flex-1 overflow-auto">
            {report?.groupingSummary && (
              <p className="mb-3 rounded-lg border border-border bg-panel/40 px-3 py-2 text-sm italic text-fg">
                {report.groupingSummary}
              </p>
            )}
            <TriageList entries={triage} />
          </div>
        )}
        {tab === 'usage' && SHOW_TOKEN_USAGE && (
          <div className="min-h-0 flex-1 overflow-auto">
            <UsagePanel usage={usage} />
          </div>
        )}
      </div>

      {preview && <Lightbox preview={preview} onClose={() => setPreview(null)} />}

      {historyCaseKey && (
        <TestCaseHistoryDrawer
          caseKey={{
            projectId: run.projectId,
            reqTag: historyCaseKey.reqTag ?? undefined,
            title: historyCaseKey.title,
          }}
          onClose={() => setHistoryCaseKey(null)}
          onSelectRun={
            onSelectRun
              ? (runId) => {
                  setHistoryCaseKey(null);
                  onSelectRun(runId);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

interface JoinedRow {
  key: string;
  title: string;
  reqTag: string | null;
  tier: string | null;
  status: TestResult['status'] | TestCase['status'];
  durationMs: number | null;
  error: string | null;
  /** QA request: why a 'skipped' row was skipped (Playwright's own test.skip(cond, 'reason')/test.fixme(...) annotation description, when given). */
  skipReason: string | null;
  description: string | null;
  details: string | null;
  /** This test's own artifact paths (relative to the suite's test-results dir), from TestResult.artifactsJson. */
  artifacts: string[];
  /** Step-by-step breakdown (click, fill, navigate, assert...) from TestResult.stepsJson — present for both passed and failed tests. */
  steps: StepItem[];
}

interface StepItem {
  title: string;
  durationMs: number;
  error?: string;
  /** The raw actions performed inside a human-authored test.step(...) task, when present. */
  steps?: StepItem[];
}

/** TestResult.artifactsJson is a JSON array of relative paths; malformed/missing rows just have no evidence. */
function parseArtifacts(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** TestResult.stepsJson is a JSON array of {title, durationMs, error?}; malformed/missing rows just show no steps. */
function parseSteps(json: string | null | undefined): StepItem[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is StepItem => !!s && typeof s === 'object' && typeof (s as StepItem).title === 'string',
    );
  } catch {
    return [];
  }
}

function joinResults(tests: TestCase[], results: TestResult[]): JoinedRow[] {
  const byTestId = new Map<string, TestResult>();
  for (const r of results) byTestId.set(r.testId, r);
  if (tests.length > 0) {
    return tests.map((t) => {
      const r = byTestId.get(t.id);
      return {
        key: t.id,
        title: t.title,
        reqTag: t.reqTag,
        tier: t.tier,
        status: r?.status ?? t.status,
        durationMs: r?.durationMs ?? null,
        error: r?.error ?? null,
        skipReason: r?.skipReason ?? null,
        description: t.description,
        details: t.details,
        artifacts: parseArtifacts(r?.artifactsJson),
        steps: parseSteps(r?.stepsJson),
      };
    });
  }
  // Fall back to raw results when no test rows were persisted.
  return results.map((r) => ({
    key: r.id,
    title: r.testId,
    reqTag: null,
    tier: null,
    status: r.status,
    durationMs: r.durationMs,
    error: r.error,
    skipReason: r.skipReason,
    description: null,
    details: null,
    artifacts: parseArtifacts(r.artifactsJson),
    steps: parseSteps(r.stepsJson),
  }));
}

// Pending has no tile of its own — it's a transient "not yet executed" state,
// not a final outcome. Skipped IS a final outcome (see report.ts's own
// "skipped" card, which counts the same status directly from result rows),
// so it gets a tile here too. Total below still counts every row regardless
// of status, matching the report's Total exactly.
const STATUS_TILES: ReadonlyArray<{ status: TestStatus; label: string }> = [
  { status: 'passed', label: 'Passed' },
  { status: 'failed', label: 'Failed' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'flaky', label: 'Flaky' },
  { status: 'skipped', label: 'Skipped' },
];

type StatusCounts = Record<TestStatus, number>;

function summarizeStatuses(rows: JoinedRow[]): StatusCounts {
  const counts: StatusCounts = { passed: 0, failed: 0, blocked: 0, flaky: 0, skipped: 0, pending: 0 };
  for (const r of rows) {
    const status = (r.status ?? 'pending') as TestStatus;
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

// Total is always the sum of the status tiles, since it's derived from the same rows.
function TestSummary({
  summary,
  activeStatus,
  onSelect,
  totalTimeMs,
  stageDurations,
}: {
  summary: StatusCounts;
  activeStatus: TestStatus | 'all';
  onSelect: (status: TestStatus | 'all') => void;
  totalTimeMs: number | null;
  stageDurations: StageDuration[];
}) {
  // Every row counts toward Total regardless of status (including the
  // untiled 'pending' rows), so Total always matches the report's
  // outcome.results.length rather than only the sum of the visible tiles.
  const total = Object.values(summary).reduce((n, c) => n + c, 0);
  const rate = total > 0 ? Math.round((summary.passed / total) * 100) : null;

  return (
    <StatTileRow className="mt-3 sm:grid-cols-8">
      <StatTile
        label="Total"
        value={total}
        tone="default"
        active={activeStatus === 'all'}
        onClick={() => onSelect('all')}
      />
      {STATUS_TILES.map((t) => (
        <StatTile
          key={t.status}
          label={t.label}
          value={summary[t.status]}
          tone={testStatusTone(t.status)}
          active={activeStatus === t.status}
          onClick={() => onSelect(t.status)}
        />
      ))}
      {/* Non-interactive — a pass rate isn't a status you can filter Results by. */}
      <StatTile label="Rate" value={rate !== null ? `${rate}%` : '—'} />
      <StatTile
        label="Total time"
        value={formatDuration(totalTimeMs)}
        title={stageDurations.length > 0 ? formatStageBreakdown(stageDurations) : undefined}
      />
    </StatTileRow>
  );
}

function Timeline({ events }: { events: AgentEvent[] }) {
  if (events.length === 0) {
    return <EmptyHint>No events were recorded for this run.</EmptyHint>;
  }
  return (
    <ol className="flex flex-col gap-1 font-mono text-xs leading-relaxed">
      {events.map((e) => (
        <li key={e.id} className="flex gap-2">
          <span className="shrink-0 text-muted/60">{formatTime(e.createdAt)}</span>
          <span className="w-20 shrink-0 truncate text-accent/70">{e.phase}</span>
          <span className={cn('whitespace-pre-wrap break-words', eventLevelColor(e.level))}>{e.message}</span>
        </li>
      ))}
    </ol>
  );
}

function ResultsTable({
  rows,
  onShowHistory,
  setPreview,
}: {
  rows: JoinedRow[];
  onShowHistory: (row: JoinedRow) => void;
  setPreview: (p: Preview | null) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (rows.length === 0) {
    return <EmptyHint>No test results for this run.</EmptyHint>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {/* Expand/collapse toggle column (icon only). */}
          <TableHead className="w-8" />
          <TableHead>Title</TableHead>
          <TableHead>REQ</TableHead>
          <TableHead>Tier</TableHead>
          <TableHead className="text-right">Duration</TableHead>
          <TableHead className="text-right">Status</TableHead>
          {/* History column (icon only). */}
          <TableHead className="w-16" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          const isOpen = expanded.has(r.key);
          return (
            <Fragment key={r.key}>
              <TableRow
                className="cursor-pointer hover:bg-panel/30"
                onClick={() => toggle(r.key)}
                aria-expanded={isOpen}
              >
                <TableCell className="w-8 pr-0">
                  <span className="flex h-5 w-5 items-center justify-center text-muted">
                    {isOpen ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                  </span>
                </TableCell>
                <TableCell className="max-w-[18rem]">
                  <span className="block truncate text-fg" title={r.title}>
                    {r.title}
                  </span>
                  {r.error && (
                    <span className="mt-0.5 block truncate font-mono text-[11px] text-err/80" title={r.error}>
                      {r.error}
                    </span>
                  )}
                  {!r.error && r.status === 'skipped' && r.skipReason && (
                    <span
                      className="mt-0.5 block truncate font-mono text-[11px] text-warn/80"
                      title={r.skipReason}
                    >
                      Skipped: {r.skipReason}
                    </span>
                  )}
                </TableCell>
                <TableCell className="font-mono text-[11px] text-muted">{r.reqTag ?? '—'}</TableCell>
                <TableCell className="font-mono text-[11px] text-muted">{r.tier ?? '—'}</TableCell>
                <TableCell className="text-right text-xs text-muted">
                  {formatDuration(r.durationMs)}
                </TableCell>
                <TableCell className="text-right">
                  <Badge tone={testStatusTone(r.status)}>{r.status ?? 'pending'}</Badge>
                </TableCell>
                <TableCell className="w-16 pl-0 text-right">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    title="View test case history"
                    aria-label={`View history for ${r.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onShowHistory(r);
                    }}
                  >
                    <History className="h-3.5 w-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
              {isOpen && (
                <TableRow className="bg-panel/40 hover:bg-panel/40">
                  <TableCell colSpan={7} className="whitespace-normal py-3">
                    <div className="flex flex-col gap-2">
                      <p className="text-sm font-medium text-fg">{r.title}</p>
                      <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
                        <span>
                          Status: <Badge tone={testStatusTone(r.status)}>{r.status ?? 'pending'}</Badge>
                        </span>
                        <span>REQ: {r.reqTag ?? '—'}</span>
                        <span>Tier: {r.tier ?? '—'}</span>
                        <span>Duration: {formatDuration(r.durationMs)}</span>
                      </div>
                      {r.description && <p className="text-xs text-fg">{r.description}</p>}
                      {r.details && <p className="text-xs text-muted">{r.details}</p>}
                      {r.error && (
                        <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg p-3 font-mono text-[11px] leading-relaxed text-err/90">
                          {r.error}
                        </pre>
                      )}
                      {!r.error && r.status === 'skipped' && (
                        <p className="text-xs text-warn">
                          <span className="font-medium">Skip reason:</span>{' '}
                          {r.skipReason ??
                            'Not recorded (no reason given, or an older suite predating this).'}
                        </p>
                      )}
                      <TestCaseSteps steps={r.steps} />
                      <TestCaseEvidence artifacts={r.artifacts} setPreview={setPreview} />
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * Step-by-step breakdown (click, fill, navigate, assert...) for a single test
 * row's own expanded detail — present for both passed and failed tests, not
 * just failures, since seeing what a test actually DID is useful regardless
 * of outcome. Sourced from TestResult.stepsJson (see execute.ts's custom
 * Playwright reporter); absent for older suites scaffolded before it existed.
 */
function TestCaseSteps({ steps }: { steps: StepItem[] }) {
  if (steps.length === 0) {
    // Genuinely nothing ran (e.g. a config/credential check that throws
    // before any page action — auth-setup's "no test credentials configured"
    // case) as well as older suites scaffolded before the steps reporter
    // existed both land here. Say so explicitly rather than rendering
    // nothing, which reads as a bug ("why are there no steps?") rather than
    // an accurate "there were none to record".
    return <p className="text-xs text-muted/70">No steps recorded for this test.</p>;
  }
  return (
    <details className="group">
      <summary className="cursor-pointer text-xs text-muted hover:text-fg">
        {steps.length} step{steps.length === 1 ? '' : 's'}
      </summary>
      <ol className="mt-1.5 flex flex-col gap-1 border-l border-border/60 pl-3 text-xs">
        {steps.map((s, i) => (
          <StepListItem key={i} step={s} />
        ))}
      </ol>
    </details>
  );
}

/**
 * One step — a human-authored test.step(...) task gets its own nested
 * dropdown revealing the raw actions (click/fill/expect/etc.) performed
 * inside it, so the high-level task name is what you see by default, with
 * the technical blow-by-blow one click away rather than always-on noise.
 */
function StepListItem({ step }: { step: StepItem }) {
  return (
    <li className={cn('flex items-start gap-1', step.error ? 'text-err' : 'text-muted')}>
      {step.error ? (
        <X className="mt-0.5 h-3 w-3 shrink-0 text-err" aria-label="Failed" />
      ) : (
        <Check className="mt-0.5 h-3 w-3 shrink-0 text-ok" aria-label="Passed" />
      )}
      <span className="min-w-0 flex-1">
        <span className={step.error ? '' : 'text-fg'}>{step.title}</span>{' '}
        <span className="text-[11px] text-muted/70">{formatDuration(step.durationMs)}</span>
        {step.error && (
          <div className="mt-0.5 truncate font-mono text-[11px] text-err/80" title={step.error}>
            {step.error.split('\n')[0]}
          </div>
        )}
        {step.steps && step.steps.length > 0 && (
          <details className="mt-0.5">
            <summary className="cursor-pointer text-[11px] text-muted/70 hover:text-fg">
              {step.steps.length} action{step.steps.length === 1 ? '' : 's'}
            </summary>
            <ol className="mt-1 flex flex-col gap-1 border-l border-border/40 pl-2.5 text-[11px]">
              {step.steps.map((s, i) => (
                <StepListItem key={i} step={s} />
              ))}
            </ol>
          </details>
        )}
      </span>
    </li>
  );
}

/**
 * Inline evidence for a single test row's own expanded detail — screenshots,
 * video, and any other captured artifact (trace.zip, error-context.md, …),
 * sourced from this test's own TestResult.artifactsJson, present regardless
 * of outcome (passed, failed, blocked, or otherwise).
 *
 * These come straight from Playwright's own attachment list — already
 * ABSOLUTE paths — so they're used as-is, with no suiteDir join.
 */
function TestCaseEvidence({
  artifacts,
  setPreview,
}: {
  artifacts: string[];
  setPreview: (p: Preview | null) => void;
}) {
  if (artifacts.length === 0) {
    return <p className="text-xs text-muted/70">No evidence captured for this test.</p>;
  }
  const images = artifacts.filter((a) => artifactKind(a) === 'image');
  const videos = artifacts.filter((a) => artifactKind(a) === 'video');
  const other = artifacts.filter((a) => artifactKind(a) !== 'image' && artifactKind(a) !== 'video');

  return (
    <div className="flex flex-col gap-2 border-t border-border/50 pt-2">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted">Evidence</span>
      {videos.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {videos.map((abs) => (
            <video
              key={abs}
              src={artifactUrl(abs)}
              controls
              preload="metadata"
              className="w-full rounded-md border border-border bg-black"
            />
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {images.map((abs) => {
            const src = artifactUrl(abs);
            return (
              <button
                key={abs}
                type="button"
                onClick={() => setPreview({ src, name: artifactLeaf(abs), abs })}
                className="group relative overflow-hidden rounded-md border border-border bg-black transition-colors hover:border-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                title={abs}
              >
                <img
                  src={src}
                  alt={artifactLeaf(abs)}
                  loading="lazy"
                  className="aspect-video w-full object-cover object-top transition-transform duration-200 group-hover:scale-[1.02]"
                />
              </button>
            );
          })}
        </div>
      )}
      {other.length > 0 && (
        <ul className="flex flex-col gap-1">
          {other.map((abs) => (
            <li key={abs} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate font-mono text-[11px] text-muted" title={abs}>
                {artifactLeaf(abs)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={() => void window.healix.showItemInFolder(abs)}
              >
                <FolderOpen className="h-3 w-3" />
                Reveal
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TriageList({ entries }: { entries: ReportTriageEntryShape[] }) {
  if (entries.length === 0) {
    return <EmptyHint>No triage verdicts. Failures are triaged automatically when present.</EmptyHint>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {entries.map((t, i) => (
        <li key={`${t.title}-${i}`} className="rounded-lg border border-border bg-panel/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-sm text-fg" title={t.title}>
              {t.title}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <Badge tone={VERDICT_TONE[t.triage.verdict] ?? 'default'}>{t.triage.verdict}</Badge>
              <span className="text-xs text-muted">{Math.round((t.triage.confidence ?? 0) * 100)}%</span>
            </span>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">{t.triage.rationale}</p>
          {t.triage.suggestedPatch && (
            <pre className="mt-2 overflow-x-auto rounded-md bg-bg p-2 font-mono text-[11px] text-muted">
              {t.triage.suggestedPatch}
            </pre>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---- Usage --------------------------------------------------------------

interface PhaseUsage {
  phase: string;
  rows: UsageRow[];
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
}

function groupUsageByPhase(usage: UsageRow[]): PhaseUsage[] {
  const byPhase = new Map<string, UsageRow[]>();
  for (const u of usage) {
    const list = byPhase.get(u.phase) ?? [];
    list.push(u);
    byPhase.set(u.phase, list);
  }
  return [...byPhase.entries()].map(([phase, rows]) => ({
    phase,
    rows,
    inputTokens: sumNullable(rows.map((r) => r.inputTokens)),
    outputTokens: sumNullable(rows.map((r) => r.outputTokens)),
    costUsd: sumNullable(rows.map((r) => r.costUsd)),
    cacheReadInputTokens: sumNullable(rows.map((r) => r.cacheReadInputTokens)),
    cacheCreationInputTokens: sumNullable(rows.map((r) => r.cacheCreationInputTokens)),
  }));
}

/** Compact total + per-phase/task token/cost breakdown for a single run. */
function UsagePanel({ usage }: { usage: UsageRow[] }) {
  const phases = useMemo(() => groupUsageByPhase(usage), [usage]);
  const totalInput = useMemo(() => sumNullable(phases.map((p) => p.inputTokens)), [phases]);
  const totalOutput = useMemo(() => sumNullable(phases.map((p) => p.outputTokens)), [phases]);
  const totalCost = useMemo(() => sumNullable(phases.map((p) => p.costUsd)), [phases]);
  const totalTokens =
    totalInput === null && totalOutput === null ? null : (totalInput ?? 0) + (totalOutput ?? 0);

  if (usage.length === 0) {
    return (
      <EmptyHint>
        No usage recorded for this run — this run may predate usage tracking, or its provider didn't report
        token/cost data.
      </EmptyHint>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <StatTileRow className="sm:grid-cols-4">
        <StatTile label="Total tokens" value={formatTokens(totalTokens)} />
        <StatTile label="Input" value={formatTokens(totalInput)} />
        <StatTile label="Output" value={formatTokens(totalOutput)} />
        <StatTile label="Cost" value={formatCost(totalCost)} />
      </StatTileRow>

      <div className="flex flex-col gap-4">
        {phases.map((p) => (
          <section key={p.phase} className="rounded-lg border border-border bg-panel/40 p-3">
            <header className="mb-2 flex items-center justify-between gap-2">
              <span className="font-mono text-xs uppercase tracking-wide text-fg">{p.phase}</span>
              <span className="text-[11px] text-muted">
                {formatTokens(p.inputTokens)} in · {formatTokens(p.outputTokens)} out ·{' '}
                {formatCost(p.costUsd)} · {formatTokens(p.cacheReadInputTokens)} cache read
              </span>
            </header>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Task</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Input</TableHead>
                  <TableHead className="text-right">Output</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Cache read</TableHead>
                  <TableHead className="text-right">Cache create</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="max-w-[16rem] truncate" title={r.task ?? undefined}>
                      {r.task ?? '—'}
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-muted">{r.provider}</TableCell>
                    <TableCell className="font-mono text-[11px] text-muted">{r.model ?? '—'}</TableCell>
                    <TableCell className="text-right text-xs text-muted">
                      {formatTokens(r.inputTokens)}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted">
                      {formatTokens(r.outputTokens)}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted">{formatCost(r.costUsd)}</TableCell>
                    <TableCell className="text-right text-xs text-muted">
                      {formatTokens(r.cacheReadInputTokens)}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted">
                      {formatTokens(r.cacheCreationInputTokens)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        ))}
      </div>
    </div>
  );
}

interface Preview {
  src: string;
  name: string;
  abs: string;
}

/** Full-screen image preview; closes on click, ✕, or Escape. */
function Lightbox({ preview, onClose }: { preview: Preview; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-label={preview.name}
    >
      <div className="flex items-center justify-between gap-2 px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <span className="flex min-w-0 items-center gap-2 text-xs text-white/80">
          <ImageIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate font-mono">{preview.name}</span>
        </span>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="text-white/70 hover:bg-white/10 hover:text-white"
            onClick={() => void window.healix.showItemInFolder(preview.abs)}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Reveal in Finder
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-white/70 hover:bg-white/10 hover:text-white"
            onClick={onClose}
            aria-label="Close preview"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 pt-0">
        <img
          src={preview.src}
          alt={preview.name}
          className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    </div>
  );
}

function EmptyHint({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-xs text-muted">{children}</p>;
}
