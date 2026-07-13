import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { DoctorReport, HealthResult, ProviderId } from '@healix/core';
import { Activity, Cpu, Database, FolderOpen, LogIn, RefreshCw } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge, type BadgeTone } from '../components/ui/badge';
import { cn, formatRelativeTime } from '../lib/utils';

type Provider = HealthResult;

interface Override {
  health: HealthResult;
  /** When this was actually confirmed via a real (probe:true) round-trip. */
  checkedAt: number;
}

/**
 * Module-level (outside the component) so a real, user-triggered check survives
 * ProvidersView unmounting when the user navigates away and back — App.tsx renders
 * views behind a plain conditional, so every visit to Settings is a fresh mount.
 * Without this, the passive mount-time cheap check would appear to "log the user
 * out" on every revisit even though the CLI session never changed. Reset only by
 * closing/reloading the app.
 */
let cachedOverrides: Partial<Record<ProviderId, Override>> = {};

function statusTone(p: Provider): BadgeTone {
  if (p.status === 'ready' && p.authenticated) return 'ok';
  if (p.status === 'ready') return 'default';
  if (p.status === 'cli-missing') return 'muted';
  return 'warn';
}

function statusLabel(p: Provider): string {
  if (p.status === 'ready' && p.authenticated) return 'ready';
  if (p.status === 'ready') return 'detected';
  if (p.status === 'cli-missing') return 'not installed';
  if (p.status === 'not-authenticated') return 'login required';
  return 'error';
}

function Dot({ tone }: { tone: BadgeTone }) {
  const color =
    tone === 'ok'
      ? 'bg-ok'
      : tone === 'warn'
        ? 'bg-warn'
        : tone === 'err'
          ? 'bg-err'
          : tone === 'muted'
            ? 'bg-muted'
            : 'bg-accent';
  return <span className={cn('inline-block h-2 w-2 rounded-full', color)} />;
}

interface ConnectState {
  /** Whether a login terminal has been launched for this provider. */
  launched: boolean;
  detail: string | null;
}

export function ProvidersView() {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [loading, setLoading] = useState(false);
  // Per-provider live health overrides (from providerHealth re-checks / "Run health
  // check"), seeded from the module-level cache so a real check survives remounts.
  const [overrides, setOverrides] = useState<Partial<Record<ProviderId, Override>>>(() => cachedOverrides);
  const [connect, setConnect] = useState<Partial<Record<ProviderId, ConnectState>>>({});
  const [busy, setBusy] = useState<Partial<Record<ProviderId, 'login' | 'recheck'>>>({});
  const [error, setError] = useState<string | null>(null);

  const updateOverrides = useCallback(
    (updater: (prev: Partial<Record<ProviderId, Override>>) => Partial<Record<ProviderId, Override>>) => {
      setOverrides((prev) => {
        const next = updater(prev);
        cachedOverrides = next;
        return next;
      });
    },
    [],
  );

  const run = useCallback(
    async (probe: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const next = await window.healix.doctor({ probe });
        setReport(next);
        // A real (probe:true) run supersedes any prior overrides with a fresh,
        // authoritative snapshot. The passive probe:false mount check must never
        // touch overrides — it can't reflect auth state, so clearing here would
        // discard the last real result and look like the user got logged out.
        if (probe) {
          const checkedAt = Date.now();
          updateOverrides(() =>
            Object.fromEntries(next.providers.map((p) => [p.provider, { health: p, checkedAt }])),
          );
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [updateOverrides],
  );

  // Fast, no-cost detection on launch/remount; the live auth probe is user-triggered
  // (via "Run health check" or a per-provider "Re-check") and its result persists
  // across remounts — see cachedOverrides above.
  useEffect(() => {
    void run(false);
  }, [run]);

  // Ticks once every 30s purely to re-render so "checked Xm ago" labels stay current
  // between real checks — no network/CLI activity, just a local re-render trigger.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const login = useCallback(async (id: ProviderId) => {
    setBusy((b) => ({ ...b, [id]: 'login' }));
    setError(null);
    try {
      const res = await window.healix.providerLogin(id);
      setConnect((c) => ({
        ...c,
        [id]: { launched: res.launched, detail: res.detail },
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy((b) => ({ ...b, [id]: undefined }));
    }
  }, []);

  const recheck = useCallback(
    async (id: ProviderId) => {
      setBusy((b) => ({ ...b, [id]: 'recheck' }));
      setError(null);
      try {
        const health = await window.healix.providerHealth(id, true);
        updateOverrides((o) => ({ ...o, [id]: { health, checkedAt: Date.now() } }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy((b) => ({ ...b, [id]: undefined }));
      }
    },
    [updateOverrides],
  );

  // Merge any live override on top of the doctor snapshot. Only Claude is
  // surfaced in this UI — the doctor report still detects/probes every
  // provider the core package knows about, but this app targets Claude only.
  const providers: HealthResult[] = (report?.providers ?? [])
    .map((p) => overrides[p.provider]?.health ?? p)
    .filter((p) => p.provider === 'claude');
  const anyReady = providers.some((p) => p.status === 'ready' && p.authenticated);
  const checkedAts = providers
    .map((p) => overrides[p.provider]?.checkedAt)
    .filter((t): t is number => t != null);
  const lastCheckedAt = checkedAts.length > 0 ? Math.min(...checkedAts) : null;
  // Whether we've ever actually confirmed (not merely detected) that no provider is
  // authenticated — distinct from simply not having probed yet this session.
  const anyConfirmedNotReady = checkedAts.length > 0 && !anyReady;
  const statusSub = anyReady
    ? `authenticated${lastCheckedAt ? ` · checked ${formatRelativeTime(lastCheckedAt, now)}` : ''}`
    : anyConfirmedNotReady
      ? `login required · checked ${formatRelativeTime(lastCheckedAt!, now)}`
      : 'not checked yet';

  return (
    <div className="mx-auto max-w-4xl px-8 pb-16 pt-8">
      <header className="flex items-end justify-between border-b border-border pb-5">
        <div>
          <h1 className="font-mono text-xl font-semibold tracking-tight">Providers</h1>
          <p className="mt-1 text-sm text-muted">
            Local-first, AI-led testing · Playwright-first · subscription auth (no API keys)
          </p>
        </div>
        <Button variant="outline" onClick={() => run(true)} disabled={loading}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          {loading ? 'Checking…' : 'Run health check'}
        </Button>
      </header>

      {error && (
        <p className="mt-4 rounded-md border border-err/40 bg-err/10 px-3 py-2 text-sm text-err">{error}</p>
      )}

      <section className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <InfoTile
          icon={<Cpu className="h-4 w-4" />}
          label="Runtime"
          value={report ? `Node ${report.node}` : '—'}
          sub={report?.platform ?? ''}
        />
        <InfoTile
          icon={<Database className="h-4 w-4" />}
          label="Local storage"
          value={report ? (report.db.available ? 'SQLite ready' : 'unavailable') : '—'}
          sub={report ? `${report.db.driver} · v${report.db.version}` : ''}
          tone={report ? (report.db.available ? 'ok' : 'warn') : 'muted'}
        />
        <InfoTile
          icon={<Activity className="h-4 w-4" />}
          label="Status"
          value={report ? (anyReady ? 'Provider ready' : 'No provider ready') : '—'}
          sub={report ? statusSub : ''}
          tone={report ? (anyReady ? 'ok' : anyConfirmedNotReady ? 'warn' : 'muted') : 'muted'}
        />
      </section>

      <div className="mt-3 flex items-center gap-2 text-xs text-muted">
        <FolderOpen className="h-3.5 w-3.5" />
        <span className="font-mono">{report?.appDataDir ?? 'resolving…'}</span>
      </div>

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold text-muted">AI Providers</h2>
        <div className="grid max-w-md grid-cols-1 gap-3">
          {providers.map((p) => {
            const tone = statusTone(p);
            const conn = connect[p.provider];
            const isBusy = busy[p.provider];
            const ready = p.status === 'ready' && p.authenticated;
            const checkedAt = overrides[p.provider]?.checkedAt;
            return (
              <Card key={p.provider}>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <Dot tone={tone} />
                      <span className="font-mono">{p.provider}</span>
                      {p.version && <span className="text-xs font-normal text-muted">v{p.version}</span>}
                    </span>
                    <Badge tone={tone}>{statusLabel(p)}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xs leading-relaxed text-muted">{p.detail}</p>
                  <p className="mt-1 text-[11px] text-muted">
                    {checkedAt ? `Checked ${formatRelativeTime(checkedAt, now)}` : 'Not checked this session'}
                  </p>
                  {(p.model || p.latencyMs) && (
                    <div className="mt-2 flex gap-3 text-xs text-muted">
                      {p.model && <span className="font-mono">{p.model}</span>}
                      {p.latencyMs ? <span>{p.latencyMs}ms</span> : null}
                    </div>
                  )}

                  {/* Connect / re-check controls */}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {!ready && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void login(p.provider)}
                        disabled={isBusy != null}
                      >
                        <LogIn className="h-3.5 w-3.5" />
                        {isBusy === 'login' ? 'Opening…' : 'Connect / Login'}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void recheck(p.provider)}
                      disabled={isBusy != null}
                    >
                      <RefreshCw className={cn('h-3.5 w-3.5', isBusy === 'recheck' && 'animate-spin')} />
                      {isBusy === 'recheck' ? 'Checking…' : 'Re-check'}
                    </Button>
                  </div>

                  {conn && (
                    <p
                      className={cn(
                        'mt-2 rounded-md border px-2 py-1.5 text-[11px] leading-relaxed',
                        conn.launched
                          ? 'border-accent/30 bg-accent/5 text-muted'
                          : 'border-warn/30 bg-warn/5 text-warn',
                      )}
                    >
                      {conn.launched
                        ? 'Complete login in the opened terminal, then Re-check.'
                        : (conn.detail ?? 'Could not launch the login flow.')}
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })}
          {!report && <p className="text-sm text-muted">Detecting providers…</p>}
        </div>
      </section>

      <footer className="mt-10 border-t border-border pt-4 text-xs text-muted">
        “Run health check” performs a live round-trip to verify your subscription login. Everything stays on
        this machine.
      </footer>
    </div>
  );
}

function InfoTile({
  icon,
  label,
  value,
  sub,
  tone = 'default',
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  tone?: BadgeTone;
}) {
  const valueColor =
    tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'err' ? 'text-err' : 'text-fg';
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-center gap-2 text-xs text-muted">
          {icon}
          {label}
        </div>
        <div className={cn('mt-1 text-sm font-medium', valueColor)}>{value}</div>
        {sub && <div className="text-xs text-muted">{sub}</div>}
      </CardContent>
    </Card>
  );
}
