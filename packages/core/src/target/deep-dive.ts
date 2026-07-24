import path from 'node:path';
import type { File } from '@babel/types';
import { extractHandlerSignalsFromAst } from './ast/handler-signals.js';
import { parseModule } from './ast/parse.js';
import { readSafe, type FunctionalityUnit } from './functionality-index.js';
import type { SourceContext } from './source-context.js';
import type { TestPlanItem } from '../modes/types.js';

/** Parses a unit's `endpoint:METHOD /path` key into its parts, for handing to findRouteHandlerPath (via extractHandlerSignalsFromAst) so the deeper scan can be scoped to the ONE handler that unit refers to instead of the whole file. Returns null for a non-endpoint unit, or a key shape this pass doesn't recognize — callers fall back to a whole-file scan in that case, same as having no match at all. */
function parseEndpointUnit(u: FunctionalityUnit): { method: string; fullPath: string } | null {
  if (u.kind !== 'endpoint') return null;
  const rest = u.key.replace(/^endpoint:/, '');
  const spaceIdx = rest.indexOf(' ');
  if (spaceIdx <= 0) return null;
  return { method: rest.slice(0, spaceIdx), fullPath: rest.slice(spaceIdx + 1) };
}

/**
 * Directed, narrow second pass over the source tree — runs AFTER Approve, scoped ONLY to the
 * files backing the approved plan's `unitKey`-resolved units, rather than the whole-repo shallow
 * walk indexSource() already did during PLAN. indexSource() is path+method only (no status codes,
 * no handler-body tracing); this extracts those deeper signals (see ast/handler-signals.ts) for
 * exactly the units GENERATE/TRIAGE are about to actually use, instead of paying that cost for
 * every unit in the repo whether or not this run touches it.
 *
 * Scans PER UNIT, not per file: a file backing several distinct endpoint units (e.g. GET and
 * DELETE on the same resource) gets its handler-signal extraction scoped separately for each one
 * (see extractHandlerSignalsFromAst's method/fullPath params) so one handler's status codes/
 * errors never leak onto a sibling unit mapped to the same file. Each file's AST is still only
 * ever parsed ONCE and shared across every unit backed by it — only the (cheap) traversal/match
 * step repeats per unit, not the parse.
 *
 * Best-effort per file: a read/parse failure for one file is swallowed (that file's units just
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

  const astByFile = new Map<string, File | null>();
  const getAst = (rel: string): File | null => {
    if (astByFile.has(rel)) return astByFile.get(rel) ?? null;
    const source = readSafe(path.join(repoPath, rel));
    const ast = source ? parseModule(source, rel) : null;
    astByFile.set(rel, ast);
    return ast;
  };

  let enrichedAny = false;
  const units = ctx.units.map((u) => {
    if (!targetKeys.has(u.key)) return u;
    const ast = getAst(u.file);
    if (!ast) return u;

    const endpoint = parseEndpointUnit(u);
    const signals = extractHandlerSignalsFromAst(u.file, ast, endpoint?.method, endpoint?.fullPath);
    if (signals.observedStatusCodes.length === 0 && signals.thrownErrorMessages.length === 0) return u;

    enrichedAny = true;
    return {
      ...u,
      ...(signals.observedStatusCodes.length > 0 ? { observedStatusCodes: signals.observedStatusCodes } : {}),
      ...(signals.thrownErrorMessages.length > 0 ? { thrownErrorMessages: signals.thrownErrorMessages } : {}),
    };
  });

  return enrichedAny ? { ...ctx, units } : ctx;
}
