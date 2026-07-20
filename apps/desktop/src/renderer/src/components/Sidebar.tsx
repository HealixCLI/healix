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
  { id: 'projects', label: 'Projects', icon: <FolderGit2 className="h-5 w-5" /> },
  { id: 'runs', label: 'Runs', icon: <PlayCircle className="h-5 w-5" /> },
];

// Settings is pinned to the bottom; provider connection/auth lives inside it.
const SETTINGS_ITEM: NavItem = { id: 'settings', label: 'Settings', icon: <Settings className="h-5 w-5" /> };

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
    <aside className="flex w-14 shrink-0 flex-col items-center border-r border-border bg-panel/40">
      {/* drag region aligned with the frameless title bar */}
      <div className="drag h-8 w-full" />
      <div className="no-drag flex items-center justify-center py-3" title="healix">
        <Leaf className="h-6 w-6" />
      </div>

      <nav className="no-drag flex flex-col items-center gap-1 px-2">
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

      <div className="no-drag mt-auto flex flex-col items-center gap-1 px-2 py-3">
        <NavButton item={SETTINGS_ITEM} active={SETTINGS_ITEM.id === active} onSelect={onSelect} />
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
  const title = badge ? `${item.label} — ${badge.label}` : item.label;
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      aria-label={item.label}
      title={title}
      className={cn(
        'relative flex h-11 w-11 items-center justify-center rounded-lg transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
        active ? 'bg-accent/10 text-fg' : 'text-muted hover:bg-panel hover:text-fg',
      )}
    >
      {/* active indicator bar */}
      <span
        className={cn(
          'absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full transition-colors',
          active ? 'bg-accent' : 'bg-transparent',
        )}
      />
      <span className={cn(active ? 'text-accent' : 'text-muted')}>{item.icon}</span>
      {badge && (
        <span
          className={cn(
            'absolute right-1 top-1 h-1.5 w-1.5 rounded-full',
            badge.tone === 'warn' ? 'bg-warn' : 'bg-accent',
            badge.tone === 'live' && 'animate-pulse',
          )}
        />
      )}
    </button>
  );
}
