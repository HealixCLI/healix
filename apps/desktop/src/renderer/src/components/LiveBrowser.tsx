import { Monitor } from 'lucide-react';
import { Badge } from './ui/badge';

/**
 * Live browser mirror for computer-use runs. Renders the latest PNG frame
 * streamed over the run:frame channel; shows a calm placeholder otherwise.
 */
export function LiveBrowser({
  frame,
  active,
  mode,
}: {
  frame: string | null;
  active: boolean;
  mode: 'codegen' | 'computer-use';
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium text-muted">Live browser</span>
        {active && mode === 'computer-use' && frame && <Badge tone="ok">streaming</Badge>}
        {active && mode === 'computer-use' && !frame && <Badge tone="default">waiting…</Badge>}
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-[#0d0d12]">
        {frame ? (
          <img
            src={`data:image/png;base64,${frame}`}
            alt="Live browser frame"
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <Monitor className="h-7 w-7 text-muted/60" />
            <p className="text-xs text-muted">
              {mode === 'computer-use'
                ? active
                  ? 'Waiting for the first browser frame…'
                  : 'Computer-use runs mirror the live browser here.'
                : 'Codegen runs do not drive a live browser.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
