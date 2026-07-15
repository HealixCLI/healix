import { useMemo, useState } from 'react';
import type { Project } from '@healix/core';
import { ArrowLeft, Play } from 'lucide-react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Tabs } from '../components/ui/tabs';
import { StatTile, StatTileRow } from '../components/StatTiles';
import { FailureTrendChart } from '../components/FailureTrendChart';
import { RunHistory } from '../components/RunHistory';
import { RunDetailPanel } from '../components/RunDetailPanel';
import { useRuns } from '../lib/use-runs';
import { useRunDetail } from '../lib/use-run-detail';
import { useProjectMetrics } from '../lib/use-project-metrics';
import { useSuiteDiff } from '../lib/use-suite-diff';
import type { ProjectMetrics } from '../lib/ipc-types';
import { formatCreatedAt } from '../lib/run-format';
import { cn } from '../lib/utils';

type DashboardTab = 'overview' | 'history';

/**
 * Project-scoped dashboard: metrics overview and full run history (a scoped
 * composition of RunHistory + RunDetailPanel, not a fork of RunsView's live
 * "Start a run" machinery — reports live inside Run History via each run's
 * own Report/Reveal/Export actions, so there's no separate Reports tab).
 * Reached via a deep link from ProjectsView — see App.tsx's dashboardProject state.
 */
export function ProjectDashboardView({
  project,
  onBack,
  onRunProject,
}: {
  project: Project;
  onBack: () => void;
  onRunProject?: (project: Project) => void;
}) {
  const [tab, setTab] = useState<DashboardTab>('overview');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [historyCollapsed, setHistoryCollapsed] = useState(false);

  const { runs, loading: runsLoading, error: runsError, refresh: refreshRuns } = useRuns(project.id);
  const { detail, loading: detailLoading } = useRunDetail(selectedRunId);
  const { metrics } = useProjectMetrics(project.id);
  const { diff: latestDiff } = useSuiteDiff(runs[0]?.id ?? null);

  const projectsById = useMemo(() => new Map([[project.id, project]]), [project]);

  const openRun = (runId: string): void => {
    setSelectedRunId(runId);
    setTab('history');
  };

  const TABS: ReadonlyArray<{ value: DashboardTab; label: string }> = [
    { value: 'overview', label: 'Overview' },
    { value: 'history', label: `Run History · ${runs.length}` },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col px-8 pb-6 pt-8">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-5">
        <div className="flex items-center gap-3">
          <Button size="icon" variant="ghost" onClick={onBack} aria-label="Back to projects">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-mono text-xl font-semibold tracking-tight">{project.name}</h1>
              <Badge tone="muted">{project.mode}</Badge>
              {project.archivedAt && <Badge tone="muted">archived</Badge>}
            </div>
            <p className="mt-1 text-sm text-muted">
              {project.baseUrl ?? project.repoPath ?? 'No target configured'}
            </p>
          </div>
        </div>
        {onRunProject && (
          <Button onClick={() => onRunProject(project)}>
            <Play className="h-4 w-4" />
            Run
          </Button>
        )}
      </header>

      <div className="mt-4 shrink-0">
        <Tabs items={TABS} value={tab} onChange={setTab} />
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-auto">
        {tab === 'overview' && <OverviewTab metrics={metrics} diff={latestDiff} onSelectRun={openRun} />}

        {tab === 'history' && (
          <div className="flex h-full min-h-0 gap-4">
            <div className={cn('flex shrink-0 flex-col', historyCollapsed ? 'w-12' : 'w-64')}>
              <RunHistory
                runs={runs}
                loading={runsLoading}
                error={runsError}
                selectedRunId={selectedRunId}
                onSelect={setSelectedRunId}
                onRefresh={() => void refreshRuns()}
                projectsById={projectsById}
                collapsed={historyCollapsed}
                onToggleCollapse={() => setHistoryCollapsed((v) => !v)}
              />
            </div>
            <div className="min-h-0 flex-1">
              <RunDetailPanel detail={detail} loading={detailLoading} onSelectRun={setSelectedRunId} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function OverviewTab({
  metrics,
  diff,
  onSelectRun,
}: {
  metrics: ProjectMetrics | null;
  diff: { addedCount: number; carriedCount: number; removedCount: number } | null;
  onSelectRun: (runId: string) => void;
}) {
  const passRatePct = metrics?.passRate != null ? Math.round(metrics.passRate * 100) : null;
  const passRateTone =
    passRatePct == null ? 'muted' : passRatePct >= 90 ? 'ok' : passRatePct >= 70 ? 'warn' : 'err';

  return (
    <div className="flex flex-col gap-6">
      <StatTileRow className="grid-cols-2 sm:grid-cols-4">
        <StatTile label="Total Runs" value={metrics?.totalRuns ?? '—'} />
        <StatTile label="Current Suite Size" value={metrics?.latestRunTestCount ?? '—'} />
        <StatTile
          label="Pass Rate"
          value={passRatePct != null ? `${passRatePct}%` : '—'}
          tone={passRateTone}
        />
        <StatTile label="Last Run" value={metrics?.lastRunAt ? formatCreatedAt(metrics.lastRunAt) : '—'} />
      </StatTileRow>

      {diff && (
        <StatTileRow className="grid-cols-3">
          <StatTile label="New (latest run)" value={diff.addedCount} tone="ok" />
          <StatTile label="Carried Forward" value={diff.carriedCount} tone="default" />
          <StatTile label="Removed" value={diff.removedCount} tone="muted" />
        </StatTileRow>
      )}

      <div>
        <h2 className="mb-2 text-sm font-semibold text-fg">Failure trend</h2>
        <FailureTrendChart points={metrics?.failureTrend ?? []} onSelectRun={onSelectRun} />
      </div>
    </div>
  );
}
