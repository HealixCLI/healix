import {
  isDegenerateUrl,
  looksCrashed,
  normalizeUrl,
  reconcileStaticRoutePaths,
  revealedInputFields,
  sameOrigin,
  snapshotClean,
  STATE_REVEAL_MIN_NEW_ELEMENTS,
  STATE_REVEAL_MIN_NEW_INPUTS,
  UNSAFE_CLICK_TEXT_RE,
  type CrawledRoute,
  type CrawlWithAuthResult,
  type RoutePrefixInfo,
} from '../browser/crawler.js';
import type { BrowserSurface } from '../browser/types.js';
import type { ObservedEndpoint } from '../browser/network-capture.js';
import type { ProviderAdapter } from '../providers/types.js';
import type { UsageRecorder } from '../providers/usage.js';
import type { OrchestratorEvent } from './types.js';

export type ExplorationGapKind =
  | 'unvisited-plan-route'
  | 'unvisited-observed-endpoint'
  | 'unclicked-affordance';

export interface ExplorationGap {
  id: string;
  kind: ExplorationGapKind;
  description: string;
  relatedPlanItemId?: string;
  targetUrlGuess?: string;
  parentRouteUrl?: string;
  targetSelectorGuess?: string;
  targetName?: string;
}

export interface GapFillAttempt {
  gap: ExplorationGap;
  outcome: 'closed' | 'partial' | 'failed' | 'skipped-budget';
  newRoutesCaptured: number;
  usedMicroAgent?: boolean;
  detail?: string;
}

/** Bounds even a huge plan/inventory to a fixed worst case per run. */
const MAX_GAPS_PER_RUN = 10;

export interface IdentifyGapsInput {
  crawlResult: CrawlWithAuthResult;
  routing: RoutePrefixInfo;
  baseUrl: string;
  /** Narrow slice of the approved plan's items — only what's needed to spot an unvisited target. */
  planItems: { id: string; title: string; unitKey?: string }[];
  observedEndpoints: ObservedEndpoint[];
}

function normalizePathForMatch(path: string): string {
  return path.replace(/\/+$/, '') || '/';
}

/**
 * Diffs the (already multi-seed-enriched) crawl inventory against two independent sources of
 * truth the explore call site already has — the approved plan's own required routes, and network
 * traffic actually observed on the wire — to produce a concrete, named list of exploration gaps.
 * Also surfaces click candidates ordinary discovery found but never got around to clicking (see
 * `CrawledRoute.unattemptedClickCandidates`). Plan-linked gaps sort first (a real test scenario
 * needs them); the whole list is capped at MAX_GAPS_PER_RUN so a huge plan/inventory can't blow up
 * the bounded gap-filling pass that follows.
 */
export function identifyExplorationGaps(input: IdentifyGapsInput): ExplorationGap[] {
  const gaps: ExplorationGap[] = [];
  const visitedUrls = new Set(input.crawlResult.routes.map((r) => normalizeUrl(r.url)));

  for (const item of input.planItems) {
    if (!item.unitKey?.startsWith('route:')) continue;
    const path = item.unitKey.replace(/^route:/, '');
    const [candidateUrl] = reconcileStaticRoutePaths([path], input.routing, input.baseUrl);
    if (!candidateUrl || visitedUrls.has(normalizeUrl(candidateUrl))) continue;
    gaps.push({
      id: `route:${path}`,
      kind: 'unvisited-plan-route',
      description: `Plan item "${item.title}" targets route "${path}", which the crawl never visited.`,
      relatedPlanItemId: item.id,
      targetUrlGuess: candidateUrl,
    });
  }

  const visitedNetworkPaths = new Set<string>();
  for (const route of input.crawlResult.routes) {
    for (const ev of route.networkEvents) {
      try {
        visitedNetworkPaths.add(normalizePathForMatch(new URL(ev.url).pathname));
      } catch {
        // Malformed/relative event URL — nothing to match against, skip.
      }
    }
  }
  const seenEndpointGapKeys = new Set<string>();
  for (const ep of input.observedEndpoints) {
    const key = normalizePathForMatch(ep.pathPattern);
    if (visitedNetworkPaths.has(key) || seenEndpointGapKeys.has(key)) continue;
    seenEndpointGapKeys.add(key);
    gaps.push({
      id: `endpoint:${ep.method} ${key}`,
      kind: 'unvisited-observed-endpoint',
      description: `Observed ${ep.method} ${key} on the wire, but no visited route's own network traffic matched it — the page that triggers this call may never have been reached.`,
    });
  }

  for (const route of input.crawlResult.routes) {
    for (const candidate of route.unattemptedClickCandidates ?? []) {
      gaps.push({
        id: `click:${route.url}>>${candidate.selector}`,
        kind: 'unclicked-affordance',
        description: `"${candidate.name}" on ${route.url} survived the safety filter but was never actually clicked (probe budget ran out first).`,
        parentRouteUrl: route.url,
        targetSelectorGuess: candidate.selector,
        targetName: candidate.name,
      });
    }
  }

  // Plan-linked gaps first — Array.prototype.sort is stable, so relative order within each
  // group (plan-linked vs. not) is otherwise preserved.
  gaps.sort((a, b) => (a.relatedPlanItemId ? -1 : 0) - (b.relatedPlanItemId ? -1 : 0));

  const deduped: ExplorationGap[] = [];
  const seenIds = new Set<string>();
  for (const gap of gaps) {
    if (seenIds.has(gap.id)) continue;
    seenIds.add(gap.id);
    deduped.push(gap);
  }
  return deduped.slice(0, MAX_GAPS_PER_RUN);
}

export interface GapFillProvider {
  provider: ProviderAdapter;
  onUsage?: UsageRecorder;
}

export interface RunGapFillInput {
  browser: BrowserSurface;
  baseUrl: string;
  gaps: ExplorationGap[];
  emit: (phase: string, level: OrchestratorEvent['level'], message: string, data?: unknown) => void;
  /** Optional bounded LLM escalation for a gap the deterministic paths below can't close on their
   * own (e.g. a click-and-diff that reveals nothing). Absent simply means such gaps stay open. */
  gapFillProvider?: GapFillProvider;
  perGapBudgetMs?: number;
  totalBudgetMs?: number;
}

export interface GapFillResult {
  attempts: GapFillAttempt[];
  newRoutes: CrawledRoute[];
}

const DEFAULT_TOTAL_GAP_FILL_BUDGET_MS = 45_000;
/** Cheap-model, bounded ReAct loop — not a free-form agent. See providers/model-config.ts's
 * 'explore-gapfill' entry. */
const MICRO_AGENT_MAX_ACTIONS = 4;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function newAnonymousRoute(url: string, snapshot: Awaited<ReturnType<typeof snapshotClean>>): CrawledRoute {
  return {
    url,
    title: snapshot.title,
    snapshot,
    depth: 0,
    hasPasswordField: snapshot.interactiveElements.some((el) => el.inputType === 'password'),
    role: 'anonymous',
    networkEvents: [],
    crashed: looksCrashed(snapshot),
  };
}

/** Deterministic close for a gap that already names a concrete URL to visit: goto + snapshot,
 * rejecting a degenerate/crashed result rather than recording garbage as "found". */
async function closeUrlGap(
  browser: BrowserSurface,
  gap: ExplorationGap,
  targetUrl: string,
): Promise<{ attempt: GapFillAttempt; route?: CrawledRoute }> {
  try {
    await browser.goto(targetUrl);
    const snapshot = await snapshotClean(browser);
    if (isDegenerateUrl(snapshot.url) || looksCrashed(snapshot)) {
      return {
        attempt: {
          gap,
          outcome: 'failed',
          newRoutesCaptured: 0,
          detail: 'resolved URL looked degenerate or crashed',
        },
      };
    }
    return {
      attempt: { gap, outcome: 'closed', newRoutesCaptured: 1 },
      route: newAnonymousRoute(snapshot.url, snapshot),
    };
  } catch (err) {
    return { attempt: { gap, outcome: 'failed', newRoutesCaptured: 0, detail: errMsg(err) } };
  }
}

/**
 * Deterministic click-and-diff for an unclicked-affordance gap: click it once, check whether it
 * reveals a real state (same reveal test `discoverClickRoutes` uses), and always revert. Returns
 * null both when nothing was revealed AND when the click itself failed (a dead/stale selector,
 * a locator timeout) — either way the caller should fall through to the micro-agent rather than
 * hard-failing the gap, since a selector this deterministic step can't drive is exactly the case
 * escalation exists for (the model can look at the CURRENT live snapshot and pick a still-valid
 * target instead of the one `identifyExplorationGaps` originally guessed at).
 */
async function closeAffordanceGapDeterministic(
  browser: BrowserSurface,
  gap: ExplorationGap,
): Promise<{ attempt: GapFillAttempt; route?: CrawledRoute } | null> {
  if (!gap.parentRouteUrl || !gap.targetSelectorGuess) return null;

  try {
    await browser.goto(gap.parentRouteUrl);
    const before = await snapshotClean(browser);
    await browser.click(gap.targetSelectorGuess);
    const after = await snapshotClean(browser);
    const revealed =
      after.interactiveElements.length - before.interactiveElements.length >= STATE_REVEAL_MIN_NEW_ELEMENTS ||
      revealedInputFields(before, after) >= STATE_REVEAL_MIN_NEW_INPUTS;

    if (!revealed) return null;
    const route: CrawledRoute = {
      ...newAnonymousRoute(gap.parentRouteUrl, after),
      stateKey: `${gap.parentRouteUrl}>>${gap.targetSelectorGuess}`,
    };
    return { attempt: { gap, outcome: 'closed', newRoutesCaptured: 1 }, route };
  } catch {
    return null;
  } finally {
    await browser.pressKey('Escape').catch(() => undefined);
    await browser.goto(gap.parentRouteUrl).catch(() => undefined);
  }
}

const MICRO_AGENT_ACTION_HEAD_RE = /^(click|type|presskey|done)\(/i;

/**
 * Scans every line for one matching the fixed action vocabulary and takes the LAST match, rather
 * than assuming line 1 is the answer — a live run against the real CLI-wrapped model showed it
 * can prepend a boilerplate sentence (e.g. "This is a single bounded browser action...") before
 * its actual `click(...)` line despite the prompt asking for exactly one line; treating a
 * genuinely valid trailing action as unparseable would silently stop the whole gap-fill attempt
 * after one turn for no real reason.
 *
 * Deliberately does NOT match the argument with a `[^)]*` character class up to the FIRST `)` —
 * a live run against a real tier-4 positional selector (`div:nth-of-type(2) > ...`) showed that
 * silently fails to parse at all, since the selector itself contains parentheses the naive regex
 * mistook for the call's own closing paren. Instead takes the LAST `)` on the line as the actual
 * closing paren, which is correct as long as the model doesn't append trailing text after the
 * call (checked explicitly below).
 */
function parseMicroAgentAction(
  text: string,
): { kind: 'click' | 'type' | 'presskey' | 'done'; args: string[] } | null {
  const lines = text
    .trim()
    .split('\n')
    .map((l) => l.trim().replace(/^`+|`+$/g, ''));

  let lastMatch: { kind: 'click' | 'type' | 'presskey' | 'done'; argsRaw: string } | null = null;
  for (const line of lines) {
    const head = MICRO_AGENT_ACTION_HEAD_RE.exec(line);
    if (!head) continue;
    const lastParen = line.lastIndexOf(')');
    if (lastParen < head[0].length) continue; // no closing paren after the opening one
    if (line.slice(lastParen + 1).trim().length > 0) continue; // trailing junk after the call
    lastMatch = {
      kind: head[1].toLowerCase() as 'click' | 'type' | 'presskey' | 'done',
      argsRaw: line.slice(head[0].length, lastParen),
    };
  }
  if (!lastMatch) return null;

  const strip = (s: string): string => s.trim().replace(/^['"]|['"]$/g, '');
  if (lastMatch.argsRaw.length === 0) return { kind: lastMatch.kind, args: [] };
  if (lastMatch.kind === 'type') {
    // Only the FIRST comma separates selector from value — the selector itself may legitimately
    // contain commas (e.g. a compound/comma-combinator selector), so a value split isn't safe
    // beyond the first one.
    const commaIndex = lastMatch.argsRaw.indexOf(',');
    if (commaIndex === -1) return { kind: 'type', args: [strip(lastMatch.argsRaw)] };
    return {
      kind: 'type',
      args: [strip(lastMatch.argsRaw.slice(0, commaIndex)), strip(lastMatch.argsRaw.slice(commaIndex + 1))],
    };
  }
  // click(selector) / pressKey(key): exactly one argument, taken as-is (never comma-split — a
  // selector is very often itself a single string containing no meaningful comma boundary here).
  return { kind: lastMatch.kind, args: [strip(lastMatch.argsRaw)] };
}

function buildMicroAgentPrompt(
  goalDescription: string,
  snapshot: Awaited<ReturnType<typeof snapshotClean>>,
  history: string[],
): string {
  const elementsSummary =
    snapshot.interactiveElements
      .slice(0, 40)
      .map((el) => `- ${el.role} "${el.name}" selector=${el.selector}`)
      .join('\n') || '(no interactive elements captured)';
  return [
    'You are directing a single bounded browser action to help close an exploration gap found while automatically crawling a web app for test generation.',
    `Goal: ${goalDescription}`,
    `Current page elements (partial):\n${elementsSummary}`,
    history.length > 0 ? `Actions already taken this attempt:\n${history.join('\n')}` : '',
    'Reply with EXACTLY ONE line and NOTHING ELSE — no explanation, no preamble, no commentary before or after it. One of:',
    'click(<selector>)',
    'type(<selector>, <value>)',
    'pressKey(<key>)',
    'done()',
    'Never choose an action that deletes, removes, submits, logs out, pays, or otherwise mutates real data. Reply with done() if nothing safe and useful remains to try.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Bounded, cheap-model ReAct loop for a gap the deterministic paths couldn't close on their own.
 * Every model-proposed action is re-validated against the SAME safety filter ordinary click-
 * probing uses (`UNSAFE_CLICK_TEXT_RE`) and a same-origin check before it's ever executed — the
 * model's own text is never trusted directly. Capped at MICRO_AGENT_MAX_ACTIONS turns.
 */
async function runMicroAgent(
  browser: BrowserSurface,
  goalDescription: string,
  origin: string,
  gapFillProvider: GapFillProvider,
  emit: RunGapFillInput['emit'],
): Promise<{ newRoute?: CrawledRoute }> {
  const history: string[] = [];
  let before = await snapshotClean(browser);
  const beforeCount = before.interactiveElements.length;

  for (let turn = 0; turn < MICRO_AGENT_MAX_ACTIONS; turn += 1) {
    const prompt = buildMicroAgentPrompt(goalDescription, before, history);
    let completion: Awaited<ReturnType<GapFillProvider['provider']['complete']>>;
    try {
      completion = await gapFillProvider.provider.complete(prompt, {
        mode: 'default',
        readOnly: true,
        taskType: 'explore-gapfill',
      });
    } catch (err) {
      emit('explore', 'debug', `Gap-fill micro-agent call failed (stopping this gap): ${errMsg(err)}`);
      break;
    }
    gapFillProvider.onUsage?.('explore', 'gap-fill', gapFillProvider.provider.id, completion.raw);
    if (!completion.ok || !completion.text) break;

    const action = parseMicroAgentAction(completion.text);
    if (!action || action.kind === 'done') break;

    if (action.kind === 'click') {
      const selector = action.args[0];
      const candidate = selector
        ? before.interactiveElements.find((el) => el.selector === selector)
        : undefined;
      if (!candidate || candidate.disabled || UNSAFE_CLICK_TEXT_RE.test(candidate.name)) {
        emit('explore', 'debug', 'Gap-fill micro-agent proposed an unsafe/unknown click target — refused.');
        break;
      }
      history.push(`click(${selector})`);
      await browser.click(selector as string).catch(() => undefined);
    } else if (action.kind === 'type') {
      const [selector, value] = action.args;
      const candidate = selector
        ? before.interactiveElements.find((el) => el.selector === selector)
        : undefined;
      if (!candidate || candidate.inputType === 'password' || candidate.disabled) {
        emit('explore', 'debug', 'Gap-fill micro-agent proposed an unsafe/unknown type target — refused.');
        break;
      }
      history.push(`type(${selector}, ...)`);
      await browser.type(selector as string, value ?? '').catch(() => undefined);
    } else {
      const key = action.args[0];
      if (!key) break;
      history.push(`pressKey(${key})`);
      await browser.pressKey(key).catch(() => undefined);
    }

    const after = await snapshotClean(browser);
    if (!sameOrigin(after.url, origin)) {
      emit('explore', 'debug', 'Gap-fill micro-agent navigated off-origin — stopping.');
      break;
    }
    if (
      after.interactiveElements.length - beforeCount >= STATE_REVEAL_MIN_NEW_ELEMENTS ||
      revealedInputFields(before, after) >= STATE_REVEAL_MIN_NEW_INPUTS
    ) {
      return {
        newRoute: {
          ...newAnonymousRoute(after.url, after),
          stateKey: `gapfill>>${history.join('>>')}`,
        },
      };
    }
    before = after;
  }

  return {};
}

/**
 * Attempts to close every identified gap, in order, within a shared total time budget — a single
 * failing gap never aborts the rest. Deterministic paths (a direct `goto`, or a click-and-diff)
 * are always tried first; the bounded LLM micro-agent only runs for a gap they couldn't close AND
 * when `gapFillProvider` is configured.
 */
export async function runGapFillingPass(input: RunGapFillInput): Promise<GapFillResult> {
  const attempts: GapFillAttempt[] = [];
  const newRoutes: CrawledRoute[] = [];
  const deadline = Date.now() + (input.totalBudgetMs ?? DEFAULT_TOTAL_GAP_FILL_BUDGET_MS);
  let origin: string;
  try {
    origin = new URL(input.baseUrl).origin;
  } catch {
    origin = input.baseUrl;
  }

  for (const gap of input.gaps) {
    if (Date.now() >= deadline) {
      attempts.push({ gap, outcome: 'skipped-budget', newRoutesCaptured: 0 });
      continue;
    }

    try {
      if (gap.kind === 'unvisited-plan-route' && gap.targetUrlGuess) {
        const result = await closeUrlGap(input.browser, gap, gap.targetUrlGuess);
        attempts.push(result.attempt);
        if (result.route) newRoutes.push(result.route);
        continue;
      }

      if (gap.kind === 'unvisited-observed-endpoint') {
        const pathOnly = gap.id.replace(/^endpoint:\S+\s+/, '');
        let guessUrl: string | undefined;
        try {
          guessUrl = new URL(pathOnly, input.baseUrl).toString();
        } catch {
          guessUrl = undefined;
        }
        const deterministic = guessUrl ? await closeUrlGap(input.browser, gap, guessUrl) : undefined;
        if (deterministic?.attempt.outcome === 'closed') {
          attempts.push(deterministic.attempt);
          if (deterministic.route) newRoutes.push(deterministic.route);
          continue;
        }
        if (input.gapFillProvider) {
          const micro = await runMicroAgent(
            input.browser,
            gap.description,
            origin,
            input.gapFillProvider,
            input.emit,
          );
          attempts.push({
            gap,
            outcome: micro.newRoute ? 'closed' : 'partial',
            newRoutesCaptured: micro.newRoute ? 1 : 0,
            usedMicroAgent: true,
          });
          if (micro.newRoute) newRoutes.push(micro.newRoute);
        } else {
          attempts.push({
            gap,
            outcome: 'failed',
            newRoutesCaptured: 0,
            detail: 'no resolvable page URL for this endpoint, and no gap-fill provider configured',
          });
        }
        continue;
      }

      // unclicked-affordance
      const deterministic = await closeAffordanceGapDeterministic(input.browser, gap);
      if (deterministic) {
        attempts.push(deterministic.attempt);
        if (deterministic.route) newRoutes.push(deterministic.route);
        continue;
      }
      if (input.gapFillProvider && gap.parentRouteUrl) {
        await input.browser.goto(gap.parentRouteUrl).catch(() => undefined);
        const micro = await runMicroAgent(
          input.browser,
          gap.description,
          origin,
          input.gapFillProvider,
          input.emit,
        );
        attempts.push({
          gap,
          outcome: micro.newRoute ? 'closed' : 'partial',
          newRoutesCaptured: micro.newRoute ? 1 : 0,
          usedMicroAgent: true,
        });
        if (micro.newRoute) newRoutes.push(micro.newRoute);
      } else {
        attempts.push({
          gap,
          outcome: 'partial',
          newRoutesCaptured: 0,
          detail: 'deterministic click-and-diff revealed nothing, and no gap-fill provider configured',
        });
      }
    } catch (err) {
      attempts.push({ gap, outcome: 'failed', newRoutesCaptured: 0, detail: errMsg(err) });
    }
  }

  return { attempts, newRoutes };
}
