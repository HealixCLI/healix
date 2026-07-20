import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentEvent, TestCase, TestResult, TestStatus } from '@healix/core';
import {
  Camera,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderOpen,
  History,
  Image as ImageIcon,
  PackageOpen,
  X,
} from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { StatTile, StatTileRow } from './StatTiles';
import { TestCaseHistoryDrawer } from './TestCaseHistoryDrawer';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { Tabs } from './ui/tabs';
import type { RunDetail, ReportTriageEntryShape } from '../lib/ipc-types';
import { asRunReport, reportDegradationNotes } from '../lib/ipc-types';
import { cn } from '../lib/utils';
import {
  artifactLeaf,
  artifactUrl,
  computeStageDurations,
  computeTotalDurationMs,
  eventLevelColor,
  formatDuration,
  formatStageBreakdown,
  formatTime,
  groupArtifacts,
  runStatusTone,
  slugMatches,
  testStatusTone,
} from '../lib/run-format';
import type { StageDuration } from '../lib/run-format';

type DetailTab = 'timeline' | 'results' | 'triage' | 'artifacts';

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
}: {
  detail: RunDetail | null;
  loading: boolean;
  /** Jump to a different run (e.g. from the Test Case History drawer). Omit to disable those jumps. */
  onSelectRun?: (runId: string) => void;
}) {
  const [tab, setTab] = useState<DetailTab>('timeline');
  const [busy, setBusy] = useState<'reveal' | 'export' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<TestStatus | 'all'>('all');
  const [historyCaseKey, setHistoryCaseKey] = useState<{ reqTag: string | null; title: string } | null>(null);

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
  const artifacts = useMemo(() => detail?.artifacts ?? [], [detail?.artifacts]);
  const groups = useMemo(() => groupArtifacts(artifacts), [artifacts]);
  const mediaCount = useMemo(
    () => groups.reduce((n, g) => n + g.images.length + g.videos.length, 0),
    [groups],
  );
  // Folders (per-test) that actually contain screenshots/recordings — the
  // targets a results row can jump to.
  const mediaFolders = useMemo(
    () => groups.filter((g) => g.images.length + g.videos.length > 0).map((g) => g.folder),
    [groups],
  );
  // Media group the artifacts tab should scroll to (set by a results-row jump).
  const [focusFolder, setFocusFolder] = useState<string | null>(null);

  /**
   * Jump from a results row to the Media tab. The row→folder match is a
   * best-effort slug heuristic (Playwright slugifies test titles into folder
   * names); when nothing matches we still switch tabs, landing at the top.
   */
  const showMedia = (title: string): void => {
    setFocusFolder(mediaFolders.find((f) => slugMatches(title, f)) ?? null);
    setTab('artifacts');
  };

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

  const TABS: ReadonlyArray<{ value: DetailTab; label: string }> = [
    { value: 'timeline', label: `Timeline · ${detail.events.length}` },
    { value: 'results', label: `Results · ${rows.length}` },
    { value: 'triage', label: `Triage · ${triage.length}` },
    { value: 'artifacts', label: `Media · ${mediaCount}` },
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
        <Tabs
          items={TABS}
          value={tab}
          onChange={(t) => {
            // A manual tab switch drops any pending row→media scroll target.
            setFocusFolder(null);
            setTab(t);
          }}
        />
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
                mediaFolders={mediaFolders}
                onShowMedia={showMedia}
                onShowHistory={(row) => setHistoryCaseKey({ reqTag: row.reqTag, title: row.title })}
              />
            </div>
          </div>
        )}
        {tab === 'triage' && (
          <div className="min-h-0 flex-1 overflow-auto">
            <TriageList entries={triage} />
          </div>
        )}
        {tab === 'artifacts' && (
          <div className="min-h-0 flex-1 overflow-auto">
            <ArtifactsGallery
              artifacts={artifacts}
              suiteDir={suiteDir}
              runStatus={run.status}
              focusFolder={focusFolder}
            />
          </div>
        )}
      </div>

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
  }));
}

// Skipped/pending have no tile — the exported report.html doesn't break them
// out either (its Total is just outcome.results.length), so a dedicated tile
// here would show a number the report can't corroborate. Total below still
// counts every row regardless of status, matching the report's Total exactly.
const STATUS_TILES: ReadonlyArray<{ status: TestStatus; label: string }> = [
  { status: 'passed', label: 'Passed' },
  { status: 'failed', label: 'Failed' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'flaky', label: 'Flaky' },
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
  // untiled skipped/pending), so Total always matches the report's
  // outcome.results.length rather than only the sum of the visible tiles.
  const total = Object.values(summary).reduce((n, c) => n + c, 0);
  const rate = total > 0 ? Math.round((summary.passed / total) * 100) : null;

  return (
    <StatTileRow className="mt-3 sm:grid-cols-7">
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
  mediaFolders,
  onShowMedia,
  onShowHistory,
}: {
  rows: JoinedRow[];
  /** Artifact folders that contain media; drives the per-row camera button. */
  mediaFolders: string[];
  onShowMedia: (title: string) => void;
  onShowHistory: (row: JoinedRow) => void;
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
          {/* Row → media jump / history columns (icon only). */}
          <TableHead className="w-16" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          // Best-effort: does any media folder look like this test's slug?
          const hasMedia = mediaFolders.some((f) => slugMatches(r.title, f));
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
                  {hasMedia && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      title="View screenshots / recordings"
                      aria-label={`View media for ${r.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onShowMedia(r.title);
                      }}
                    >
                      <Camera className="h-3.5 w-3.5" />
                    </Button>
                  )}
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
                      {r.error && (
                        <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg p-3 font-mono text-[11px] leading-relaxed text-err/90">
                          {r.error}
                        </pre>
                      )}
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

// ---- Artifacts gallery -------------------------------------------------------

interface Preview {
  src: string;
  name: string;
  abs: string;
}

/**
 * Screenshots and recordings captured by the suite, grouped per test.
 * Images open in a lightbox; videos play inline; everything can be revealed
 * in the file manager. When `focusFolder` is set (a results-row jump), the
 * matching group is scrolled into view on mount.
 */
function ArtifactsGallery({
  artifacts,
  suiteDir,
  runStatus,
  focusFolder = null,
}: {
  artifacts: string[];
  suiteDir: string | null;
  runStatus: string;
  focusFolder?: string | null;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const groups = useMemo(() => groupArtifacts(artifacts), [artifacts]);

  // Scroll the focused group into view (once per focus change / mount).
  const focusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    focusRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [focusFolder]);

  if (artifacts.length === 0) {
    const running = !['passed', 'failed', 'blocked', 'error', 'cancelled'].includes(runStatus);
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 py-10 text-center">
        <Camera className="h-7 w-7 text-muted/50" />
        <p className="text-sm text-muted">
          {running
            ? 'Screenshots and recordings will appear here once tests execute.'
            : 'No screenshots or recordings were captured for this run.'}
        </p>
        {!running && (
          <p className="max-w-sm text-xs text-muted/70">
            Runs started before capture-on-success was enabled only kept media for failures. Start a new run
            to record every test.
          </p>
        )}
      </div>
    );
  }

  const absOf = (rel: string): string | null => (suiteDir ? `${suiteDir}/test-results/${rel}` : null);

  return (
    <>
      <div className="flex flex-col gap-4">
        {groups.map((g) => {
          const hasMedia = g.images.length + g.videos.length > 0;
          const focused = focusFolder !== null && g.folder === focusFolder;
          return (
            <section
              key={g.folder || '(root)'}
              ref={
                focused
                  ? (el) => {
                      focusRef.current = el;
                    }
                  : undefined
              }
              className={cn('rounded-lg border border-border bg-panel/40 p-3', focused && 'border-accent/50')}
            >
              <header className="mb-2 flex items-center justify-between gap-2">
                <span
                  className="min-w-0 truncate font-mono text-xs text-fg"
                  title={g.folder || 'Suite output'}
                >
                  {g.folder || 'Suite output'}
                </span>
                {hasMedia && (
                  <span className="shrink-0 text-[11px] text-muted">
                    {g.images.length > 0 && `${g.images.length} screenshot${g.images.length > 1 ? 's' : ''}`}
                    {g.images.length > 0 && g.videos.length > 0 && ' · '}
                    {g.videos.length > 0 && `${g.videos.length} recording${g.videos.length > 1 ? 's' : ''}`}
                  </span>
                )}
              </header>

              {g.videos.length > 0 && (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {g.videos.map((rel) => {
                    const abs = absOf(rel);
                    return abs ? (
                      <video
                        key={rel}
                        src={artifactUrl(abs)}
                        controls
                        preload="metadata"
                        className="w-full rounded-md border border-border bg-black"
                      />
                    ) : null;
                  })}
                </div>
              )}

              {g.images.length > 0 && (
                <div className={cn('grid grid-cols-2 gap-2 sm:grid-cols-3', g.videos.length > 0 && 'mt-2')}>
                  {g.images.map((rel) => {
                    const abs = absOf(rel);
                    if (!abs) return null;
                    const src = artifactUrl(abs);
                    return (
                      <button
                        key={rel}
                        type="button"
                        onClick={() => setPreview({ src, name: artifactLeaf(rel), abs })}
                        className="group relative overflow-hidden rounded-md border border-border bg-black transition-colors hover:border-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                        title={rel}
                      >
                        <img
                          src={src}
                          alt={artifactLeaf(rel)}
                          loading="lazy"
                          className="aspect-video w-full object-cover object-top transition-transform duration-200 group-hover:scale-[1.02]"
                        />
                        <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-2 pb-1 pt-4 text-left text-[10px] text-white/80">
                          {artifactLeaf(rel)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {g.other.length > 0 && (
                <ul className={cn('flex flex-col', hasMedia && 'mt-2 border-t border-border/50 pt-1')}>
                  {g.other.map((rel) => {
                    const abs = absOf(rel);
                    return (
                      <li key={rel} className="flex items-center justify-between gap-3 py-1">
                        <span className="min-w-0 truncate font-mono text-[11px] text-muted" title={rel}>
                          {artifactLeaf(rel)}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[11px]"
                          onClick={() => abs && void window.healix.showItemInFolder(abs)}
                          disabled={!abs}
                        >
                          <FolderOpen className="h-3 w-3" />
                          Reveal
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      {preview && <Lightbox preview={preview} onClose={() => setPreview(null)} />}
    </>
  );
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
