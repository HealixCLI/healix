import { StatTile, StatTileRow } from '../components/StatTiles';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { useUsageAggregate } from '../lib/use-usage-aggregate';
import { formatCreatedAt } from '../lib/run-format';

/** Formats a token count for display; '—' when null (the provider/call reported no usage). */
function formatTokens(n: number | null): string {
  return n === null ? '—' : Math.round(n).toLocaleString();
}

/** Formats a USD cost for display; '—' when null (not every provider reports cost). */
function formatCost(n: number | null): string {
  return n === null ? '—' : `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
}

/**
 * Cross-run usage aggregation: total tokens/cost over time (one row per run,
 * newest first) plus per-phase averages across every run — the counterpart to
 * RunDetailPanel's per-run Usage tab. Reached via the sidebar's own nav entry,
 * scoped to every project (no project filter — matches Runs view's own
 * cross-project default).
 */
export function ReportsUsageView() {
  const { aggregate, loading } = useUsageAggregate();

  const perRun = aggregate?.perRun ?? [];
  const perPhase = aggregate?.perPhase ?? [];
  const grandTotalInput = perPhase.reduce((sum, p) => sum + (p.totalInputTokens ?? 0), 0);
  const grandTotalOutput = perPhase.reduce((sum, p) => sum + (p.totalOutputTokens ?? 0), 0);
  const grandTotalCost = perPhase.reduce((sum, p) => sum + (p.totalCostUsd ?? 0), 0);

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col gap-6 overflow-auto px-8 pb-8 pt-8">
      <header>
        <h1 className="text-lg font-semibold text-fg">Reports · Usage</h1>
        <p className="mt-1 text-sm text-muted">
          Token and cost usage aggregated across every run, by phase (plan / generate / triage).
        </p>
      </header>

      {loading && perRun.length === 0 ? (
        <p className="text-sm text-muted">Loading usage…</p>
      ) : perRun.length === 0 ? (
        <p className="text-sm text-muted">
          No usage recorded yet — run Healix against a project to see token/cost data here.
        </p>
      ) : (
        <>
          <section>
            <h2 className="mb-3 text-sm font-semibold text-muted">Totals across every run</h2>
            <StatTileRow className="sm:grid-cols-4">
              <StatTile label="Total tokens" value={formatTokens(grandTotalInput + grandTotalOutput)} />
              <StatTile label="Input" value={formatTokens(grandTotalInput)} />
              <StatTile label="Output" value={formatTokens(grandTotalOutput)} />
              <StatTile label="Cost" value={formatCost(grandTotalCost)} />
            </StatTileRow>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-muted">Per-phase averages</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Phase</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="text-right">Avg input</TableHead>
                  <TableHead className="text-right">Avg output</TableHead>
                  <TableHead className="text-right">Avg cost</TableHead>
                  <TableHead className="text-right">Total cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {perPhase.map((p) => (
                  <TableRow key={p.phase}>
                    <TableCell className="font-mono text-xs text-fg">{p.phase}</TableCell>
                    <TableCell className="text-right text-xs text-muted">{p.callCount}</TableCell>
                    <TableCell className="text-right text-xs text-muted">
                      {formatTokens(p.avgInputTokens)}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted">
                      {formatTokens(p.avgOutputTokens)}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted">
                      {formatCost(p.avgCostUsd)}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted">
                      {formatCost(p.totalCostUsd)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-muted">Usage over time</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead className="text-right">Input</TableHead>
                  <TableHead className="text-right">Output</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {perRun.map((r) => (
                  <TableRow key={r.runId}>
                    <TableCell>
                      <span className="text-xs text-fg">{formatCreatedAt(r.runCreatedAt)}</span>
                      <span className="ml-2 font-mono text-[11px] text-muted/70">{r.runId}</span>
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted">
                      {formatTokens(r.inputTokens)}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted">
                      {formatTokens(r.outputTokens)}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted">{formatCost(r.costUsd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        </>
      )}
    </div>
  );
}
