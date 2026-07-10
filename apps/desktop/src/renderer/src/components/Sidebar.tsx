import type { ReactNode } from 'react';
import { Activity, FolderGit2, PlayCircle } from 'lucide-react';
import { Leaf } from './Leaf';
import { cn } from '../lib/utils';

export type ViewId = 'providers' | 'projects' | 'runs';

interface NavItem {
  id: ViewId;
  label: string;
  icon: ReactNode;
}

const ITEMS: NavItem[] = [
  { id: 'providers', label: 'Providers', icon: <Activity className="h-4 w-4" /> },
  { id: 'projects', label: 'Projects', icon: <FolderGit2 className="h-4 w-4" /> },
  { id: 'runs', label: 'Runs', icon: <PlayCircle className="h-4 w-4" /> },
];

export function Sidebar({ active, onSelect }: { active: ViewId; onSelect: (id: ViewId) => void }) {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-panel/40">
      {/* drag region aligned with the frameless title bar */}
      <div className="drag h-8 w-full" />
      <div className="px-4 pb-5 pt-1">
        <div className="flex items-center gap-2">
          <Leaf className="h-5 w-5" />
          <span className="font-mono text-lg font-semibold tracking-tight">healix</span>
        </div>
        <p className="mt-1 text-[11px] leading-snug text-muted">AI-led, local-first testing</p>
      </div>

      <nav className="no-drag flex flex-col gap-0.5 px-2">
        {ITEMS.map((item) => {
          const isActive = item.id === active;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item.id)}
              className={cn(
                'relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                isActive ? 'bg-accent/10 text-fg' : 'text-muted hover:bg-panel hover:text-fg',
              )}
            >
              {/* active indicator bar */}
              <span
                className={cn(
                  'absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full transition-colors',
                  isActive ? 'bg-accent' : 'bg-transparent',
                )}
              />
              <span className={cn(isActive ? 'text-accent' : 'text-muted')}>{item.icon}</span>
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto px-4 py-4">
        <div className="rounded-lg border border-border/60 bg-bg/40 px-3 py-2.5 text-[11px] leading-relaxed text-muted">
          <span className="mb-1 flex items-center gap-1.5 font-medium text-fg/80">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
            Local-first
          </span>
          Everything stays on this machine. Subscription auth, no API keys.
        </div>
      </div>
    </aside>
  );
}
