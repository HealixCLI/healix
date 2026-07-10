import { useEffect, useRef } from 'react';
import type { ConsoleLine } from '../lib/run-engine';
import { cn } from '../lib/utils';

const LEVEL_COLOR: Record<ConsoleLine['level'], string> = {
  debug: 'text-muted',
  info: 'text-fg',
  warn: 'text-warn',
  error: 'text-err',
};

/** Streaming, auto-scrolling console for orchestrator events. */
export function ConsoleLog({ lines, emptyHint }: { lines: ConsoleLine[]; emptyHint?: string }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [lines]);

  return (
    <div className="h-full overflow-auto rounded-lg border border-border bg-well p-3 font-mono text-xs leading-relaxed">
      {lines.length === 0 ? (
        <p className="text-muted">{emptyHint ?? 'Console output will appear here.'}</p>
      ) : (
        lines.map((line) => (
          <div key={line.id} className="flex gap-2">
            <span className="shrink-0 text-muted/70">{line.ts}</span>
            <span className="w-20 shrink-0 truncate text-accent/80">{line.phase}</span>
            <span className={cn('whitespace-pre-wrap break-words', LEVEL_COLOR[line.level])}>
              {line.message}
            </span>
          </div>
        ))
      )}
      <div ref={endRef} />
    </div>
  );
}
