import type { TestPlan } from '@healix/core';
import { Check, ShieldQuestion, X } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';

/** Plan-mode approval gate: the run is parked until the user approves or rejects. */
export function PlanGate({
  plan,
  decided,
  onApprove,
  onReject,
}: {
  plan: TestPlan;
  decided: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="rounded-lg border border-accent/40 bg-accent/5 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldQuestion className="h-4 w-4 text-accent" />
          <span className="text-sm font-semibold">Plan review required</span>
        </div>
        <Badge tone="default">{plan.items.length} tests</Badge>
      </div>

      <p className="mt-2 text-sm text-muted">{plan.summary}</p>

      <ol className="mt-3 flex flex-col gap-1.5">
        {plan.items.map((item, i) => (
          <li key={item.id} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 w-5 shrink-0 text-right font-mono text-xs text-muted">{i + 1}.</span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-fg">{item.title}</span>
                <Badge tone="muted">{item.tier}</Badge>
                {item.reqTag && <span className="font-mono text-[11px] text-muted">{item.reqTag}</span>}
              </div>
              <p className="text-xs text-muted">{item.intent}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="outline" onClick={onReject} disabled={decided}>
          <X className="h-4 w-4" />
          Reject
        </Button>
        <Button onClick={onApprove} disabled={decided}>
          <Check className="h-4 w-4" />
          Approve plan
        </Button>
      </div>
    </div>
  );
}
