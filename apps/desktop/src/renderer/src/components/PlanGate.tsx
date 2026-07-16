import { useEffect, useState, type ReactNode } from 'react';
import type {
  PlanItemSnapshot,
  PlanItemStatus,
  PlanScenario,
  Tier,
  TestPlan,
  TestPlanItem,
} from '@healix/core';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Loader2,
  Pencil,
  Plus,
  Sparkles,
  ShieldQuestion,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from './ui/button';
import { Badge, type BadgeTone } from './ui/badge';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select } from './ui/select';
import { Textarea } from './ui/textarea';
import { cn } from '../lib/utils';
import type { PlanBatchProgress } from '../lib/run-engine';

const TIER_OPTIONS: ReadonlyArray<{ value: Tier; label: string }> = [
  { value: 'tierA-public', label: 'Tier A — public' },
  { value: 'tierB-auth', label: 'Tier B — authenticated' },
  { value: 'tierC-api', label: 'Tier C — API' },
];

const TIER_GUIDANCE: Record<Tier, string> = {
  'tierA-public': 'Tier A — public: unauthenticated flows.',
  'tierB-auth': 'Tier B — authenticated: flows requiring a logged-in user.',
  'tierC-api': 'Tier C — API: backend/API-level checks.',
};

const SCENARIO_KIND_TONE: Record<PlanScenario['kind'], BadgeTone> = {
  positive: 'ok',
  negative: 'err',
  edge: 'warn',
};

const SCENARIO_KIND_LABEL: Record<PlanScenario['kind'], string> = {
  positive: 'Positive',
  negative: 'Negative',
  edge: 'Edge',
};

const STATUS_TONE: Record<PlanItemStatus, BadgeTone> = {
  pending: 'muted',
  approved: 'ok',
  rejected: 'err',
  edited: 'warn',
  revised: 'warn',
};

const STATUS_LABEL: Record<PlanItemStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  edited: 'Edited',
  revised: 'Revised',
};

function effectiveStatus(item: TestPlanItem): PlanItemStatus {
  return item.status ?? 'pending';
}

/** Modal shell shared by the Edit/Revise overlays — matches ConfirmDialog's pattern exactly. */
function ModalShell({
  title,
  onCancel,
  children,
}: {
  title: string;
  onCancel: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-panel p-5 shadow-xl shadow-black/40"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {children}
      </div>
    </div>
  );
}

const SCENARIO_KINDS: ReadonlyArray<PlanScenario['kind']> = ['positive', 'negative', 'edge'];

/** Local editable scenario row — carries a stable key so React doesn't remount rows on reorder/delete. */
interface EditableScenario extends PlanScenario {
  key: string;
}

let scenarioKeySeq = 0;
function toEditable(scenarios: PlanScenario[]): EditableScenario[] {
  return scenarios.map((s) => ({ ...s, key: `s${scenarioKeySeq++}` }));
}

function EditItemDialog({
  item,
  onSave,
  onCancel,
}: {
  item: TestPlanItem;
  onSave: (patch: PlanItemSnapshot) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [reqTag, setReqTag] = useState(item.reqTag ?? '');
  const [tier, setTier] = useState<Tier>(item.tier);
  const [intent, setIntent] = useState(item.intent);
  const [scenarios, setScenarios] = useState<EditableScenario[]>(() => toEditable(item.scenarios));

  const canSave =
    title.trim().length > 0 &&
    intent.trim().length > 0 &&
    scenarios.some((s) => s.description.trim().length > 0);

  const updateScenario = (key: string, patch: Partial<PlanScenario>): void =>
    setScenarios((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeScenario = (key: string): void => setScenarios((rows) => rows.filter((r) => r.key !== key));
  const addScenario = (): void =>
    setScenarios((rows) => [...rows, { key: `s${scenarioKeySeq++}`, kind: 'positive', description: '' }]);

  return (
    <ModalShell title="Edit test item" onCancel={onCancel}>
      <div className="mt-3 flex flex-col gap-3">
        <div>
          <Label htmlFor="edit-title">Title</Label>
          <Input id="edit-title" className="mt-1" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <Label htmlFor="edit-tier">Tier</Label>
            <Select
              id="edit-tier"
              className="mt-1"
              value={tier}
              onChange={(e) => setTier(e.target.value as Tier)}
            >
              {TIER_OPTIONS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex-1">
            <Label htmlFor="edit-reqtag">Req tag</Label>
            <Input
              id="edit-reqtag"
              className="mt-1"
              value={reqTag}
              onChange={(e) => setReqTag(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Label htmlFor="edit-intent">Intent</Label>
          <Textarea
            id="edit-intent"
            className="mt-1"
            rows={2}
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
          />
        </div>
        <div>
          <div className="flex items-center justify-between">
            <Label>Scenarios</Label>
            <button
              type="button"
              onClick={addScenario}
              className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
            >
              <Plus className="h-3 w-3" /> Add scenario
            </button>
          </div>
          <div className="mt-1 flex flex-col gap-2">
            {scenarios.map((s) => (
              <div key={s.key} className="flex items-start gap-2">
                <Select
                  className="w-32 shrink-0"
                  value={s.kind}
                  onChange={(e) => updateScenario(s.key, { kind: e.target.value as PlanScenario['kind'] })}
                >
                  {SCENARIO_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {SCENARIO_KIND_LABEL[k]}
                    </option>
                  ))}
                </Select>
                <Input
                  className="flex-1"
                  value={s.description}
                  placeholder="Describe this test case"
                  onChange={(e) => updateScenario(s.key, { description: e.target.value })}
                />
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Remove scenario"
                  onClick={() => removeScenario(s.key)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            {scenarios.length === 0 && (
              <p className="text-xs text-muted">At least one scenario is required.</p>
            )}
          </div>
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={!canSave}
          onClick={() =>
            onSave({
              title: title.trim(),
              reqTag: reqTag.trim() || undefined,
              tier,
              intent: intent.trim(),
              scenarios: scenarios
                .filter((s) => s.description.trim().length > 0)
                .map(({ kind, description }) => ({ kind, description: description.trim() })),
            })
          }
        >
          Save
        </Button>
      </div>
    </ModalShell>
  );
}

function ReviseItemDialog({
  item,
  revising,
  error,
  onSubmit,
  onCancel,
}: {
  item: TestPlanItem;
  revising: boolean;
  error?: string;
  onSubmit: (suggestion: string) => void;
  onCancel: () => void;
}) {
  const [suggestion, setSuggestion] = useState('');

  return (
    <ModalShell title="Revise with feedback" onCancel={onCancel}>
      <div className="mt-3 rounded-md border border-border bg-bg p-3">
        <div className="text-sm font-medium text-fg">{item.title}</div>
        <p className="mt-1 text-xs text-muted">{item.intent}</p>
      </div>
      <div className="mt-3">
        <Label htmlFor="revise-suggestion">What should change?</Label>
        <Textarea
          id="revise-suggestion"
          className="mt-1"
          rows={3}
          placeholder="e.g. also verify the error toast appears when the request fails"
          value={suggestion}
          onChange={(e) => setSuggestion(e.target.value)}
          disabled={revising}
          autoFocus
        />
      </div>
      {error && <p className="mt-2 text-xs text-err">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={revising}>
          Cancel
        </Button>
        <Button
          disabled={revising || suggestion.trim().length === 0}
          onClick={() => onSubmit(suggestion.trim())}
        >
          {revising ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {revising ? 'Revising…' : 'Revise with AI'}
        </Button>
      </div>
    </ModalShell>
  );
}

function PlanItemRow({
  item,
  index,
  decided,
  revising,
  reviseError,
  onApprove,
  onReject,
  onEdit,
  onRevise,
}: {
  item: TestPlanItem;
  index: number;
  decided: boolean;
  revising: boolean;
  reviseError?: string;
  onApprove: () => void;
  onReject: () => void;
  onEdit: () => void;
  onRevise: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = effectiveStatus(item);
  const historyCount = (item.edits?.length ?? 0) + (item.revisions?.length ?? 0);

  return (
    <li className={cn('rounded-md border border-border/60 px-3 py-2', status === 'rejected' && 'opacity-60')}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 w-5 shrink-0 text-right font-mono text-xs text-muted">{index + 1}.</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('text-sm text-fg', status === 'rejected' && 'line-through')}>
              {item.title}
            </span>
            <Badge tone="muted">{item.tier}</Badge>
            {item.reqTag && <span className="font-mono text-[11px] text-muted">{item.reqTag}</span>}
            {item.scenarios.map((s, i) => (
              <Badge key={i} tone={SCENARIO_KIND_TONE[s.kind]}>
                {SCENARIO_KIND_LABEL[s.kind]}
              </Badge>
            ))}
            <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="inline-flex items-center gap-0.5 text-[11px] text-muted hover:text-fg"
            >
              {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {historyCount > 0 ? `${historyCount} change(s)` : 'details'}
            </button>
            {reviseError && !expanded && (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="text-[11px] text-err underline decoration-dotted"
              >
                Revise failed — details
              </button>
            )}
          </div>
          {expanded && (
            <div className="mt-1.5 rounded-md bg-bg/60 p-2 text-xs text-muted">
              <p>{item.intent}</p>
              <p className="mt-1 italic">{TIER_GUIDANCE[item.tier]}</p>
              {item.scenarios.length > 0 && (
                <div className="mt-2">
                  <div className="font-medium text-fg">Scenarios (one test each, same spec file)</div>
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {item.scenarios.map((s, i) => (
                      <li key={i} className="flex items-start gap-1.5">
                        <Badge tone={SCENARIO_KIND_TONE[s.kind]}>{SCENARIO_KIND_LABEL[s.kind]}</Badge>
                        <span>{s.description}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {item.edits && item.edits.length > 0 && (
                <div className="mt-2">
                  <div className="font-medium text-fg">Edits</div>
                  {item.edits.map((e, i) => (
                    <p key={i}>
                      "{e.before.title}" → "{e.after.title}"
                    </p>
                  ))}
                </div>
              )}
              {item.revisions && item.revisions.length > 0 && (
                <div className="mt-2">
                  <div className="font-medium text-fg">Revisions</div>
                  {item.revisions.map((r, i) => (
                    <p key={i}>
                      Feedback: "{r.suggestion}" — "{r.before.title}" → "{r.after.title}"
                    </p>
                  ))}
                </div>
              )}
              {reviseError && <p className="mt-2 text-err">Last revise failed: {reviseError}</p>}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            aria-label="Approve item"
            title="Approve item"
            disabled={decided || revising}
            onClick={onApprove}
          >
            <Check className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Reject item"
            title="Reject item"
            disabled={decided || revising}
            onClick={onReject}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Edit item"
            title="Edit item"
            disabled={decided || revising}
            onClick={onEdit}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Revise item with AI"
            title="Revise item with AI"
            disabled={decided || revising}
            onClick={onRevise}
          >
            {revising ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>
    </li>
  );
}

/** Per-item plan approval gate: the run is parked until the reviewer finalizes each item and continues. */
export function PlanGate({
  plan,
  decided,
  streaming = false,
  batchProgress = null,
  revisingItemIds,
  reviseErrors,
  onApproveItem,
  onRejectItem,
  onEditItem,
  onReviseItem,
  onApproveAndContinue,
  onRejectAll,
}: {
  plan: TestPlan;
  decided: boolean;
  /** True while more batches are still being generated — locks the overall
   *  Approve/Reject actions but leaves per-item review available. */
  streaming?: boolean;
  batchProgress?: PlanBatchProgress | null;
  revisingItemIds: Set<string>;
  reviseErrors: Record<string, string>;
  onApproveItem: (itemId: string) => void;
  onRejectItem: (itemId: string) => void;
  onEditItem: (itemId: string, patch: PlanItemSnapshot) => void;
  onReviseItem: (itemId: string, suggestion: string) => void;
  onApproveAndContinue: () => void;
  onRejectAll: () => void;
}) {
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [revisingDialogItemId, setRevisingDialogItemId] = useState<string | null>(null);

  const editingItem = editingItemId ? plan.items.find((it) => it.id === editingItemId) : undefined;
  const revisingDialogItem = revisingDialogItemId
    ? plan.items.find((it) => it.id === revisingDialogItemId)
    : undefined;

  return (
    <div className="rounded-lg border border-accent/40 bg-accent/5 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {streaming ? (
            <Loader2 className="h-4 w-4 animate-spin text-accent" />
          ) : (
            <ShieldQuestion className="h-4 w-4 text-accent" />
          )}
          <span className="text-sm font-semibold">
            {streaming ? 'Generating test plan…' : 'Plan review required'}
          </span>
        </div>
        <Badge tone="default">
          {plan.items.length} spec {plan.items.length === 1 ? 'file' : 'files'}
        </Badge>
      </div>

      {streaming && batchProgress && (
        <p className="mt-1 text-xs text-muted">
          Batch {batchProgress.batchIndex + 1}/{batchProgress.totalBatches} · {batchProgress.receivedItems} item
          {batchProgress.receivedItems === 1 ? '' : 's'} so far — you can start reviewing below; new items keep
          appearing as they're generated.
        </p>
      )}
      {batchProgress && batchProgress.failedNotes.length > 0 && (
        <div className="mt-2 rounded-md border border-warn/40 bg-warn/10 p-2 text-xs text-warn">
          {batchProgress.failedNotes.map((note, i) => (
            <p key={i}>{note}</p>
          ))}
        </div>
      )}

      <p className="mt-2 text-sm text-muted">{plan.summary}</p>

      <ol className="mt-3 flex flex-col gap-1.5">
        {plan.items.map((item, i) => (
          <PlanItemRow
            key={item.id}
            item={item}
            index={i}
            decided={decided}
            revising={revisingItemIds.has(item.id)}
            reviseError={reviseErrors[item.id]}
            onApprove={() => onApproveItem(item.id)}
            onReject={() => onRejectItem(item.id)}
            onEdit={() => setEditingItemId(item.id)}
            onRevise={() => setRevisingDialogItemId(item.id)}
          />
        ))}
      </ol>

      <div className="mt-4 flex items-center justify-between gap-2">
        <p className="text-xs text-muted">
          {streaming
            ? 'Waiting for remaining batches to finish generating before you can approve or reject all.'
            : 'Unreviewed items will be approved as-is.'}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={onRejectAll} disabled={decided || streaming}>
            <X className="h-4 w-4" />
            Reject All
          </Button>
          <Button onClick={onApproveAndContinue} disabled={decided || streaming}>
            <Check className="h-4 w-4" />
            Approve &amp; Continue
          </Button>
        </div>
      </div>

      {editingItem && (
        <EditItemDialog
          item={editingItem}
          onCancel={() => setEditingItemId(null)}
          onSave={(patch) => {
            onEditItem(editingItem.id, patch);
            setEditingItemId(null);
          }}
        />
      )}

      {revisingDialogItem && (
        <ReviseItemDialog
          item={revisingDialogItem}
          revising={revisingItemIds.has(revisingDialogItem.id)}
          error={reviseErrors[revisingDialogItem.id]}
          onCancel={() => setRevisingDialogItemId(null)}
          onSubmit={(suggestion) => {
            onReviseItem(revisingDialogItem.id, suggestion);
            setRevisingDialogItemId(null);
          }}
        />
      )}
    </div>
  );
}
