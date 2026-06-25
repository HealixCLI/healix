import { useState } from 'react';
import type { RunSummary } from '@healix/core';
import { FolderOpen, PackageOpen } from 'lucide-react';
import { Button } from './ui/button';
import { Badge, type BadgeTone } from './ui/badge';
import { cn } from '../lib/utils';

const STATUS_TONE: Record<string, BadgeTone> = {
  passed: 'ok',
  failed: 'err',
  error: 'err',
  blocked: 'warn',
  flaky: 'warn',
  skipped: 'muted',
  pending: 'muted',
  cancelled: 'muted',
};

function tone(status: string): BadgeTone {
  return STATUS_TONE[status] ?? 'default';
}

/** Final results panel: outcome counts, per-test status, reveal + export actions. */
export function RunResults({ summary }: { summary: RunSummary }) {
  const { outcome, suite, status } = summary;
  const [busy, setBusy] = useState<'reveal' | 'export' | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const suiteDir = suite?.dir ?? null;

  const reveal = async (): Promise<void> => {
    if (!suiteDir) return;
    setBusy('reveal');
    setNote(null);
    try {
      const res = await window.healix.revealPath(suiteDir);
      if (!res.ok) setNote('Could not open the suite folder.');
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
      setNote(`Exported to ${bundle.zipPath ?? bundle.dir}`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-panel/40 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">Results</span>
          <Badge tone={tone(status)}>{status}</Badge>
        </div>
        {outcome && (
          <div className="flex items-center gap-2 text-xs">
            <Count label="passed" value={outcome.passed} className="text-ok" />
            <Count label="failed" value={outcome.failed} className="text-err" />
            <Count label="blocked" value={outcome.blocked} className="text-warn" />
            <Count label="flaky" value={outcome.flaky} className="text-warn" />
          </div>
        )}
      </div>

      {outcome && outcome.results.length > 0 && (
        <ul className="mt-3 flex flex-col divide-y divide-border/60">
          {outcome.results.map((r, i) => (
            <li key={`${r.title}-${i}`} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0 truncate text-fg">{r.title}</span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-muted">
                {typeof r.durationMs === 'number' && <span>{r.durationMs}ms</span>}
                <Badge tone={tone(r.status)}>{r.status}</Badge>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 text-xs text-muted">
          {suiteDir ? <span className="font-mono">{suiteDir}</span> : 'No suite was produced for this run.'}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={reveal} disabled={!suiteDir || busy !== null}>
            <FolderOpen className="h-4 w-4" />
            Reveal suite folder
          </Button>
          <Button size="sm" onClick={exportSuite} disabled={!suiteDir || busy !== null}>
            <PackageOpen className="h-4 w-4" />
            {busy === 'export' ? 'Exporting…' : 'Export suite'}
          </Button>
        </div>
      </div>

      {note && <p className="mt-2 text-xs text-muted">{note}</p>}
    </div>
  );
}

function Count({ label, value, className }: { label: string; value: number; className?: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={cn('font-semibold', className)}>{value}</span>
      <span className="text-muted">{label}</span>
    </span>
  );
}
