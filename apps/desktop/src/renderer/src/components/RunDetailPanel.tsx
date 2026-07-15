import { useMemo, useState } from 'react';
import type { AgentEvent, TestCase, TestResult } from '@healix/core';
import { FileDown, FolderOpen, PackageOpen } from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { Tabs } from './ui/tabs';
import type { RunDetail, ReportTriageEntryShape } from '../lib/ipc-types';
import { asRunReport } from '../lib/ipc-types';
import { cn } from '../lib/utils';
import {
  artifactLeaf,
  eventLevelColor,
  formatDuration,
  formatTime,
  runStatusTone,
  testStatusTone,
} from '../lib/run-format';

type DetailTab = 'timeline' | 'results' | 'triage' | 'artifacts';

const VERDICT_TONE: Record<string, 'ok' | 'warn' | 'err' | 'muted' | 'default'> = {
  app_is_wrong: 'err',
  test_is_wrong: 'warn',
  environment: 'warn',
  flaky: 'warn',
  ambiguous: 'muted',
};

/** Full detail for a selected historical run: timeline, results, triage, artifacts. */
export function RunDetailPanel({ detail, loading }: { detail: RunDetail | null; loading: boolean }) {
  const [tab, setTab] = useState<DetailTab>('timeline');
  const [busy, setBusy] = useState<'reveal' | 'export' | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const report = useMemo(() => asRunReport(detail?.report ?? null), [detail?.report]);
  const triage = report?.triage ?? [];

  // Join results to their test rows so the table can show title / REQ / tier.
  const rows = useMemo(() => joinResults(detail?.tests ?? [], detail?.results ?? []), [detail]);

  const suiteDir = detail?.suiteDir ?? null;
  const artifacts = detail?.artifacts ?? [];

  const reveal = async (target: string): Promise<void> => {
    setBusy('reveal');
    setNote(null);
    try {
      const res = await window.healix.revealPath(target);
      if (!res.ok) setNote('Could not open the path in Finder.');
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
      const bundle = await window.healix.exportSuite({ suiteDir, zip: true, sanitize: true });
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
    { value: 'timeline', label: `Timeline (${detail.events.length})` },
    { value: 'results', label: `Results (${rows.length})` },
    { value: 'triage', label: `Triage (${triage.length})` },
    { value: 'artifacts', label: `Artifacts (${artifacts.length})` },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
        <div className="flex items-center gap-2">
          <Badge tone={runStatusTone(run.status)}>{run.status}</Badge>
          {run.mode && <span className="font-mono text-xs text-muted">{run.mode}</span>}
          <span className="font-mono text-[11px] text-muted">{run.id}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => suiteDir && void reveal(suiteDir)} disabled={!suiteDir || busy !== null}>
            <FolderOpen className="h-4 w-4" />
            Reveal suite
          </Button>
          <Button size="sm" onClick={exportSuite} disabled={!suiteDir || busy !== null}>
            <PackageOpen className="h-4 w-4" />
            {busy === 'export' ? 'Exporting…' : 'Download / Export suite'}
          </Button>
        </div>
      </div>

      {note && <p className="mt-2 break-all text-xs text-muted">{note}</p>}

      <div className="mt-3">
        <Tabs items={TABS} value={tab} onChange={setTab} />
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-auto">
        {tab === 'timeline' && <Timeline events={detail.events} />}
        {tab === 'results' && <ResultsTable rows={rows} />}
        {tab === 'triage' && <TriageList entries={triage} />}
        {tab === 'artifacts' && (
          <ArtifactsList
            artifacts={artifacts}
            suiteDir={suiteDir}
            busy={busy !== null}
            onReveal={reveal}
          />
        )}
      </div>
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

function Timeline({ events }: { events: AgentEvent[] }) {
  if (events.length === 0) {
    return <p className="text-xs text-muted">No events were recorded for this run.</p>;
  }
  return (
    <ol className="flex flex-col gap-1 font-mono text-xs leading-relaxed">
      {events.map((e) => (
        <li key={e.id} className="flex gap-2">
          <span className="shrink-0 text-muted/70">{formatTime(e.createdAt)}</span>
          <span className="w-20 shrink-0 truncate text-accent/80">{e.phase}</span>
          <span className={cn('whitespace-pre-wrap break-words', eventLevelColor(e.level))}>{e.message}</span>
        </li>
      ))}
    </ol>
  );
}

function ResultsTable({ rows }: { rows: JoinedRow[] }) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted">No test results for this run.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>REQ</TableHead>
          <TableHead>Tier</TableHead>
          <TableHead className="text-right">Duration</TableHead>
          <TableHead className="text-right">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.key}>
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
            <TableCell className="text-right text-xs text-muted">{formatDuration(r.durationMs)}</TableCell>
            <TableCell className="text-right">
              <Badge tone={testStatusTone(r.status)}>{r.status ?? 'pending'}</Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function TriageList({ entries }: { entries: ReportTriageEntryShape[] }) {
  const items = entries;
  if (items.length === 0) {
    return <p className="text-xs text-muted">No triage verdicts. Failures are triaged automatically when present.</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {items.map((t, i) => (
        <li key={`${t.title}-${i}`} className="rounded-md border border-border bg-bg/40 p-3">
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
            <pre className="mt-2 overflow-x-auto rounded bg-[#0d0d12] p-2 font-mono text-[11px] text-muted">
              {t.triage.suggestedPatch}
            </pre>
          )}
        </li>
      ))}
    </ul>
  );
}

function ArtifactsList({
  artifacts,
  suiteDir,
  busy,
  onReveal,
}: {
  artifacts: string[];
  suiteDir: string | null;
  busy: boolean;
  onReveal: (target: string) => void;
}) {
  if (artifacts.length === 0) {
    return <p className="text-xs text-muted">No artifacts were produced for this run.</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-border/50">
      {artifacts.map((rel) => {
        const abs = suiteDir ? joinPath(suiteDir, 'test-results', rel) : rel;
        return (
          <li key={rel} className="flex items-center justify-between gap-3 py-2">
            <span className="flex min-w-0 items-center gap-2">
              <FileDown className="h-3.5 w-3.5 shrink-0 text-muted" />
              <span className="min-w-0">
                <span className="block truncate text-xs text-fg" title={rel}>
                  {artifactLeaf(rel)}
                </span>
                <span className="block truncate font-mono text-[10px] text-muted" title={rel}>
                  {rel}
                </span>
              </span>
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onReveal(abs)}
              disabled={busy || !suiteDir}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              Reveal in Finder
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/** Simple POSIX-style join (renderer has no node:path). */
function joinPath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, '')))
    .join('/');
}
