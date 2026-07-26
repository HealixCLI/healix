import { useEffect, useState } from 'react';
import { Button } from './button';
import type { SheetPreview } from '../../lib/ipc-types';

interface SheetPickerDialogProps {
  fileName: string;
  sheets: SheetPreview[];
  onConfirm: (selectedNames: string[]) => void;
  onCancel: () => void;
}

/**
 * Modal checklist shown only for genuinely multi-sheet workbooks — a CSV or a
 * single-sheet .xlsx/.xls never reaches this dialog (see main/index.ts's
 * dialog:pickPrdFile branching). Mirrors ConfirmDialog's skeleton (overlay,
 * Escape/click-outside cancel, role="dialog").
 */
export function SheetPickerDialog({ fileName, sheets, onConfirm, onCancel }: SheetPickerDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(sheets.map((s) => s.name)));

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const toggle = (name: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label="Select sheets to import"
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-panel p-5 shadow-xl shadow-black/40"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold text-fg">Select sheets to import</h2>
        <p className="mt-1 text-xs text-muted">
          <span className="font-mono text-fg">{fileName}</span> has {sheets.length} sheets with data.
        </p>
        <div className="mt-4 max-h-64 space-y-1 overflow-y-auto">
          {sheets.map((sheet) => (
            <label
              key={sheet.name}
              className="flex cursor-pointer items-start gap-2 rounded-lg border border-transparent p-2 hover:border-border hover:bg-bg/50"
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={selected.has(sheet.name)}
                onChange={() => toggle(sheet.name)}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-fg">{sheet.name}</span>
                <span className="block text-[11px] text-muted">
                  {sheet.rowCount} row{sheet.rowCount === 1 ? '' : 's'}
                  {sheet.headers.length > 0 ? ` — ${sheet.headers.join(', ')}` : ''}
                </span>
              </span>
            </label>
          ))}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="outline"
            disabled={selected.size === 0}
            onClick={() => onConfirm(sheets.map((s) => s.name).filter((n) => selected.has(n)))}
            autoFocus
          >
            Use {selected.size} sheet{selected.size === 1 ? '' : 's'}
          </Button>
        </div>
      </div>
    </div>
  );
}
