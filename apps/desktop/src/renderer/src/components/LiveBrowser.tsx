import { Monitor } from 'lucide-react';
import { Badge } from './ui/badge';

/**
 * Live browser mirror for runs against a live URL. Renders the latest JPEG
 * frame streamed over the run:frame channel; shows a calm placeholder
 * otherwise. Shown whenever the project/scope has a live browser to mirror —
 * not tied to a specific exploration mode, since both computer-use
 * exploration and Playwright test execution can feed frames here.
 */
export function LiveBrowser({ frame, active }: { frame: string | null; active: boolean }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium text-muted">Live browser</span>
        {active && frame && <Badge tone="ok">streaming</Badge>}
        {active && !frame && <Badge tone="default">waiting…</Badge>}
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-well">
        {frame ? (
          <img
            src={`data:image/jpeg;base64,${frame}`}
            alt="Live browser frame"
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <Monitor className="h-7 w-7 text-muted/60" />
            <p className="text-xs text-muted">
              {active
                ? 'Waiting for the first browser frame…'
                : 'This run doesn’t have a live browser frame yet.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
