import path from 'node:path';
import { extractHandlerSignalsFromAst, type HandlerSignals } from './ast/handler-signals.js';
import { parseModule } from './ast/parse.js';
import { readSafe } from './functionality-index.js';
import type { SourceContext } from './source-context.js';
import type { TestPlanItem } from '../modes/types.js';

/**
 * Directed, narrow second pass over the source tree — runs AFTER Approve, scoped ONLY to the
 * files backing the approved plan's `unitKey`-resolved units, rather than the whole-repo shallow
 * walk indexSource() already did during PLAN. indexSource() is path+method only (no status codes,
 * no handler-body tracing); this extracts those deeper signals (see ast/handler-signals.ts) for
 * exactly the units GENERATE/TRIAGE are about to actually use, instead of paying that cost for
 * every unit in the repo whether or not this run touches it.
 *
 * Best-effort per file: a read/parse failure for one file is swallowed (that unit's units just
 * don't gain the new fields) rather than failing the whole enrichment pass. Returns `ctx`
 * unchanged (same reference) when there is nothing to enrich — no repoPath-relative work, no
 * plan items with a unitKey, or no matching units — so callers can unconditionally await this
 * without a branch of their own.
 */
export async function enrichSourceContextForPlan(
  repoPath: string,
  ctx: SourceContext,
  items: readonly TestPlanItem[],
): Promise<SourceContext> {
  const targetKeys = new Set(items.map((i) => i.unitKey).filter((k): k is string => Boolean(k)));
  if (targetKeys.size === 0) return ctx;

  const targetUnits = ctx.units.filter((u) => targetKeys.has(u.key));
  if (targetUnits.length === 0) return ctx;

  const filesToScan = new Set(targetUnits.map((u) => u.file));
  const signalsByFile = new Map<string, HandlerSignals>();
  for (const rel of filesToScan) {
    const source = readSafe(path.join(repoPath, rel));
    if (!source) continue;
    const ast = parseModule(source, rel);
    if (!ast) continue;
    signalsByFile.set(rel, extractHandlerSignalsFromAst(rel, ast));
  }
  if (signalsByFile.size === 0) return ctx;

  const units = ctx.units.map((u) => {
    if (!targetKeys.has(u.key)) return u;
    const signals = signalsByFile.get(u.file);
    if (!signals) return u;
    return {
      ...u,
      ...(signals.observedStatusCodes.length > 0 ? { observedStatusCodes: signals.observedStatusCodes } : {}),
      ...(signals.thrownErrorMessages.length > 0 ? { thrownErrorMessages: signals.thrownErrorMessages } : {}),
    };
  });

  return { ...ctx, units };
}
