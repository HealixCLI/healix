import type { ReactNode } from 'react';
import { FolderGit2, PlayCircle, Settings } from 'lucide-react';
import { Leaf } from './Leaf';
import { cn } from '../lib/utils';

// 'project-dashboard' is a deep-link-only destination (reached from ProjectsView,
// like 'runs' can be) — it never appears in the sidebar's own nav list below.
export type ViewId = 'projects' | 'runs' | 'settings' | 'project-dashboard';

interface NavItem {
  id: ViewId;
  label: string;
  icon: ReactNode;
}

// Primary destinations. Projects is the landing screen.
const ITEMS: NavItem[] = [
  { id: 'projects', label: 'Projects', icon: <FolderGit2 className="h-4 w-4" /> },
  { id: 'runs', label: 'Runs', icon: <PlayCircle className="h-4 w-4" /> },
];

// Settings is pinned to the bottom; provider connection/auth lives inside it.
const SETTINGS_ITEM: NavItem = { id: 'settings', label: 'Settings', icon: <Settings className="h-4 w-4" /> };

/** Live run status badge shown on the Runs nav item, visible from any view. */
export interface RunStatusBadge {
  label: string;
  tone: 'live' | 'warn';
}

export function Sidebar({
  active,
  onSelect,
  runStatus,
}: {
  active: ViewId;
  onSelect: (id: ViewId) => void;
  /** Badge for the Runs nav item — null when there's nothing to show (idle, no queue). */
  runStatus?: RunStatusBadge | null;
}) {
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
        {ITEMS.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            active={item.id === active}
            onSelect={onSelect}
            badge={item.id === 'runs' ? runStatus : null}
          />
        ))}
      </nav>

      <div className="no-drag mt-auto flex flex-col gap-4 py-4">
        <nav className="flex flex-col gap-0.5 px-2">
          <NavButton item={SETTINGS_ITEM} active={SETTINGS_ITEM.id === active} onSelect={onSelect} />
        </nav>
        <div className="px-4">
          <div className="rounded-lg border border-border/60 bg-bg/40 px-3 py-2.5 text-[11px] leading-relaxed text-muted">
            <span className="mb-1 flex items-center gap-1.5 font-medium text-fg/80">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
              Local-first
            </span>
            Everything stays on this machine. Subscription auth, no API keys.
          </div>
        </div>
      </div>
    </aside>
  );
}

function NavButton({
  item,
  active,
  onSelect,
  badge,
}: {
  item: NavItem;
  active: boolean;
  onSelect: (id: ViewId) => void;
  badge?: RunStatusBadge | null;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      className={cn(
        'relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
        active ? 'bg-accent/10 text-fg' : 'text-muted hover:bg-panel hover:text-fg',
      )}
    >
      {/* active indicator bar */}
      <span
        className={cn(
          'absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full transition-colors',
          active ? 'bg-accent' : 'bg-transparent',
        )}
      />
      <span className={cn(active ? 'text-accent' : 'text-muted')}>{item.icon}</span>
      <span className="flex-1 text-left">{item.label}</span>
      {badge && (
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none',
            badge.tone === 'warn' ? 'bg-warn/15 text-warn' : 'bg-accent/15 text-accent',
          )}
        >
          {badge.tone === 'live' && (
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          )}
          {badge.label}
        </span>
      )}
    </button>
  );
}
