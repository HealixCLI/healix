import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { DoctorReport } from '@healix/core';
import { Activity, Cpu, Database, FolderOpen, RefreshCw } from 'lucide-react';
import { Button } from './components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card';
import { Badge, type BadgeTone } from './components/ui/badge';
import { cn } from './lib/utils';

type Provider = DoctorReport['providers'][number];

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
    tone === 'ok' ? 'bg-ok' : tone === 'warn' ? 'bg-warn' : tone === 'err' ? 'bg-err' : tone === 'muted' ? 'bg-muted' : 'bg-accent';
  return <span className={cn('inline-block h-2 w-2 rounded-full', color)} />;
}

export default function App() {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async (probe: boolean) => {
    setLoading(true);
    try {
      setReport(await window.healix.doctor({ probe }));
    } finally {
      setLoading(false);
    }
  }, []);

  // Fast, no-cost detection on launch; the live auth probe is user-triggered.
  useEffect(() => {
    void run(false);
  }, [run]);

  return (
    <div className="min-h-full bg-bg text-fg">
      {/* drag region for frameless macOS title bar */}
      <div className="drag h-8 w-full" />

      <div className="mx-auto max-w-4xl px-6 pb-16">
        {/* Header */}
        <header className="flex items-end justify-between border-b border-border pb-5">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-xl font-semibold tracking-tight">healix</span>
              <Badge tone="muted">M0</Badge>
            </div>
            <p className="mt-1 text-sm text-muted">
              Local-first, AI-led testing · Playwright-first · subscription auth (no API keys)
            </p>
          </div>
          <Button variant="outline" className="no-drag" onClick={() => run(true)} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            {loading ? 'Checking…' : 'Run health check'}
          </Button>
        </header>

        {/* Environment strip */}
        <section className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <InfoTile icon={<Cpu className="h-4 w-4" />} label="Runtime" value={report ? `Node ${report.node}` : '—'} sub={report?.platform ?? ''} />
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
            value={report ? (report.ready ? 'Provider ready' : 'No provider ready') : '—'}
            sub={report?.ready ? 'authenticated' : 'login required'}
            tone={report ? (report.ready ? 'ok' : 'warn') : 'muted'}
          />
        </section>

        {/* App data path */}
        <div className="mt-3 flex items-center gap-2 text-xs text-muted">
          <FolderOpen className="h-3.5 w-3.5" />
          <span className="font-mono">{report?.appDataDir ?? 'resolving…'}</span>
        </div>

        {/* Providers */}
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-muted">AI Providers</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(report?.providers ?? []).map((p) => {
              const tone = statusTone(p);
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
                    {(p.model || p.latencyMs) && (
                      <div className="mt-2 flex gap-3 text-xs text-muted">
                        {p.model && <span className="font-mono">{p.model}</span>}
                        {p.latencyMs ? <span>{p.latencyMs}ms</span> : null}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
            {!report && <p className="text-sm text-muted">Detecting providers…</p>}
          </div>
        </section>

        <footer className="mt-10 border-t border-border pt-4 text-xs text-muted">
          “Run health check” performs a live round-trip to verify your subscription login. Everything stays on this machine.
        </footer>
      </div>
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
