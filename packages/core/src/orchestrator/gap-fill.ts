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
import type { TestPlanItem } from '../modes/types.js';
import { buildRequirementTokens, hasRequirementCoverage } from '../util/requirement-tokens.js';

export type ExplorationGapKind =
  | 'unvisited-plan-route'
  | 'unvisited-observed-endpoint'
  | 'unclicked-affordance'
  | 'unmet-content-need';

export interface ExplorationGap {
  id: string;
  kind: ExplorationGapKind;
  description: string;
  relatedPlanItemId?: string;
  targetUrlGuess?: string;
  parentRouteUrl?: string;
  targetSelectorGuess?: string;
  targetName?: string;
  /** Role of `parentRouteUrl` at crawl time — drives gap-fill's priority tiering (see
   * `gapPriorityTier`) so authenticated-surface gaps (the usual high-value target) are attempted
   * before anonymous-page ones within the shared gap-fill budget. */
  parentRouteRole?: CrawledRoute['role'];
  /** Set when the candidate's accessible name reads as page furniture (logo/nav) or a
   * third-party social/OAuth entry point on an anonymous page — see `isLowValueAffordance`.
   * Such gaps skip LLM micro-agent escalation entirely (see `runGapFillingPass`) so the shared
   * budget isn't spent confirming a Facebook button reveals nothing. */
  lowValueAffordance?: boolean;
  /** Confidence tier of `targetSelectorGuess`, copied from `InteractiveElement.selectorTier` —
   * 4 means a positional nth-of-type fallback, which a fresh page reload can silently resolve to
   * a different node than the one the crawl clicked (list reordering, conditional rendering,
   * async-loaded content). Drives a text-anchored retry in `closeAffordanceGapDeterministic`. */
  targetSelectorTier?: 1 | 2 | 3 | 4;
  /** Nearest repeated ancestor's own text, copied from `InteractiveElement.repeatedRowText` —
   * a stable `:text-is()` anchor to retry with when a tier-4 `targetSelectorGuess` reveals
   * nothing on a fresh reload. */
  targetRepeatedRowText?: string;
  /** Only set for `'unmet-content-need'` gaps: the visited routes judged most likely to host this
   * item's content (matched by the item's own `unitKey` route path, falling back to every visited
   * route when that doesn't resolve to one) — seeds the micro-agent's starting point(s) so it can
   * try more than one candidate route in sequence instead of guessing from wherever the browser
   * currently sits. */
  candidateRouteUrls?: string[];
}

export interface GapFillAttempt {
  gap: ExplorationGap;
  outcome: 'closed' | 'partial' | 'failed' | 'skipped-budget';
  newRoutesCaptured: number;
  usedMicroAgent?: boolean;
  detail?: string;
}

/**
 * Runaway backstop for gaps with NO plan correlation at all (decorative nav, untargeted leftover
 * clicks on a page with dozens of unrelated buttons) — never a ceiling on real plan coverage.
 * Every gap tied to an actual plan item (`relatedPlanItemId` set — this includes `unmet-content-
 * need` gaps and any affordance/endpoint gap `correlatePlanItem` linked) gets a genuine attempt
 * regardless of how many exist; there's no principled reason to drop a real, identified content
 * need just because more than a handful happened to exist in one run. The total wall-clock cost is
 * already self-scaling via `totalBudgetMs = perGapBudgetMs * gaps.length` (see there), so more
 * real gaps just means a proportionally longer run, not a truncated one.
 */
const MAX_GAPS_PER_RUN = 10;

export interface IdentifyGapsInput {
  crawlResult: CrawlWithAuthResult;
  routing: RoutePrefixInfo;
  baseUrl: string;
  /** Narrow slice of the approved plan's items — only what's needed to spot an unvisited target
   * and (when the richer fields are supplied) an unmet content need. `intent`/`reqTag`/
   * `scenarios`/`tier` are optional so existing minimal callers/fixtures keep compiling
   * unchanged; omitting them just means `identifyUnmetContentNeeds` has nothing to check for
   * that item (see its doc comment). */
  planItems: (Pick<TestPlanItem, 'id' | 'title' | 'unitKey'> &
    Partial<Pick<TestPlanItem, 'intent' | 'reqTag' | 'scenarios' | 'tier'>>)[];
  observedEndpoints: ObservedEndpoint[];
}

function normalizePathForMatch(path: string): string {
  return path.replace(/\/+$/, '') || '/';
}

/** Page furniture — logo, hamburger/nav menu — essentially never the thing a test scenario
 * actually needs, regardless of which route it lives on. */
const DECORATIVE_AFFORDANCE_NAME_RE = /\blogo\b|\bhamburger\b|^home$|^menu$/i;

/**
 * Third-party social/OAuth entry point. Deliberately gated to anonymous-role parent routes only
 * at the call site below (not baked into this regex) — the same brand tokens can legitimately
 * appear on an AUTHENTICATED feature (e.g. this app's own "Apple Wallet"/"Google Wallet" barcode
 * reveal on the dashboard), so matching brand name alone without the anonymous-page context would
 * misclassify exactly the high-value gaps this heuristic must not catch.
 */
const SOCIAL_LOGIN_AFFORDANCE_NAME_RE =
  /facebook|twitter|\bx\.com\b|linkedin|instagram|github|\bgoogle\b|\bapple\b|microsoft|\bsso\b|oauth/i;

function isLowValueAffordance(name: string, parentRole: CrawledRoute['role'] | undefined): boolean {
  if (DECORATIVE_AFFORDANCE_NAME_RE.test(name)) return true;
  return parentRole === 'anonymous' && SOCIAL_LOGIN_AFFORDANCE_NAME_RE.test(name);
}

const CORRELATION_STOPWORDS = new Set([
  'this',
  'that',
  'with',
  'your',
  'page',
  'view',
  'flow',
  'test',
  'check',
  'verify',
  'confirm',
  'ensure',
  'screen',
  'click',
  'button',
]);

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 5 && !CORRELATION_STOPWORDS.has(w)),
  );
}

/**
 * Best-effort correlation between an affordance candidate's accessible name and the approved
 * plan's own item titles — e.g. a "wallet"/"voucher" candidate name against a plan item literally
 * mentioning "wallet". Deliberately simple substring/word overlap, matching this codebase's
 * existing text-heuristic style (see `deriveRegionCodesFromText` in orchestrator/index.ts,
 * `LOGIN_TEXT_RE`/`SIGNUP_URL_HINT_RE` in browser/crawler.ts). Language-dependent: a candidate
 * name captured in the target app's own locale (e.g. Slovak "zmeniť") won't correlate against an
 * English plan title, so this is a secondary signal — `parentRouteRole` tiering below is the
 * primary, language-agnostic lever for prioritizing gaps that matter.
 */
function correlatePlanItem(
  targetName: string,
  planItems: IdentifyGapsInput['planItems'],
): string | undefined {
  const nameWords = significantWords(targetName);
  if (nameWords.size === 0) return undefined;
  for (const item of planItems) {
    const itemWords = significantWords(item.title);
    for (const w of nameWords) {
      if (itemWords.has(w)) return item.id;
    }
  }
  return undefined;
}

/**
 * For each plan item (skipping `tierC-api`, which never drives a browser page), checks whether
 * the CURRENT crawl inventory already has something relevant to that item's own requirement text
 * (title/intent/scenarios — see `buildRequirementTokens`/`hasRequirementCoverage`), on whichever
 * visited route its `unitKey` resolves to (falling back to every visited route when it doesn't).
 * When nothing relevant is found anywhere, emits a gap whose `description` is the item's own
 * scenario text verbatim — a concrete goal ("needs a form to enter current password, a new
 * password, and submit"), not a generic template — so a downstream micro-agent escalation knows
 * exactly what it's looking for instead of blindly retrying whatever affordance survived the
 * crawl budget. This is what lets gap-fill disambiguate between several visually-identical
 * triggers (e.g. this app's four "zmeniť" sections) by CONTENT rather than by a hardcoded name.
 *
 * Deliberately coarse (see `hasRequirementCoverage`'s doc comment): a false positive here just
 * costs one extra bounded gap-fill attempt that reports `partial`, not a regression.
 */
function identifyUnmetContentNeeds(
  crawlResult: CrawlWithAuthResult,
  planItems: IdentifyGapsInput['planItems'],
  routing: RoutePrefixInfo,
  baseUrl: string,
): ExplorationGap[] {
  const gaps: ExplorationGap[] = [];
  for (const item of planItems) {
    if (item.tier === 'tierC-api') continue;
    if (!item.intent && (!item.scenarios || item.scenarios.length === 0)) continue; // nothing to check against
    const reqTokens = buildRequirementTokens(item);
    if (reqTokens.size === 0) continue;

    let candidates = crawlResult.routes;
    if (item.unitKey?.startsWith('route:')) {
      const path = item.unitKey.replace(/^route:/, '');
      const [resolvedUrl] = reconcileStaticRoutePaths([path], routing, baseUrl);
      const matched = resolvedUrl
        ? crawlResult.routes.filter(
            (r) => normalizeUrl(r.url) === normalizeUrl(resolvedUrl) || r.url.includes(path),
          )
        : crawlResult.routes.filter((r) => r.url.includes(path));
      if (matched.length > 0) candidates = matched;
    }
    if (candidates.length === 0) continue; // nothing crawled at all yet — the unvisited-route gap already covers this

    // Many real projects never populate unitKey at all (no functionality-index units to ground
    // the plan on), leaving `candidates` as literally every visited route in crawl order —
    // arbitrarily anonymous-first. Re-order (same convention as generate.ts's
    // selectInventoryElements) so a tierB-auth item's candidates/parentRouteRole reflect the
    // authenticated surface it actually needs, not whichever route the crawl happened to visit
    // first.
    const preferredRole = item.tier === 'tierB-auth' ? 'authenticated' : 'anonymous';
    candidates = [...candidates].sort(
      (a, b) => Number(b.role === preferredRole) - Number(a.role === preferredRole),
    );

    const covered = candidates.some((route) => hasRequirementCoverage(route, reqTokens));
    if (covered) continue;

    const scenarioText = (item.scenarios ?? []).map((s) => `- ${s.description}`).join('\n');
    gaps.push({
      id: `content:${item.id}`,
      kind: 'unmet-content-need',
      description: [
        `Plan item "${item.title}"${item.intent ? ` (${item.intent})` : ''} needs content the exploration crawl never found:`,
        scenarioText,
      ]
        .filter(Boolean)
        .join('\n'),
      relatedPlanItemId: item.id,
      candidateRouteUrls: candidates.slice(0, 5).map((r) => r.url),
      parentRouteRole: candidates[0]?.role,
    });
  }
  return gaps;
}

/**
 * Priority tier for gap-fill ordering (lower = attempted first). An `unmet-content-need` gap
 * leads everything else: it's plan-linked BY CONSTRUCTION (derived directly from the item's own
 * requirement text), not via `correlatePlanItem`'s looser word-overlap guess, so it's a stronger
 * signal than any other tier here. Next, other plan-linked gaps (route and affordance alike) lead
 * the rest, since a real test scenario needs them; among affordance gaps, an authenticated-surface
 * candidate outranks an anonymous one (the dashboard-behind-login surface is consistently the
 * higher-value target — see GAP-060's measured evidence), and a decorative/social-nav candidate
 * sinks to the bottom regardless of role. `unvisited-observed-endpoint` gaps keep their historical
 * position (just behind plan-linked) since they're already a concrete, named signal of a real
 * missed flow.
 */
function gapPriorityTier(gap: ExplorationGap): number {
  if (gap.kind === 'unmet-content-need') return 0;
  // Checked BEFORE relatedPlanItemId for affordance gaps deliberately: `correlatePlanItem`'s
  // word-overlap heuristic can spuriously match a decorative/social candidate against an
  // UNRELATED plan item that happens to mention the same brand/word (confirmed live — a
  // "Facebook" OAuth-button gap correlated against a plan item titled "...Google, Facebook via
  // Cognito" that's actually about a completely different scenario). `lowValueAffordance`'s
  // curated classification is a stronger, more deliberate signal than that loose overlap, so it
  // must win the tie rather than let a coincidental keyword match promote a decorative gap to
  // the front of the queue.
  if (gap.kind === 'unclicked-affordance' && gap.lowValueAffordance) return 5;
  if (gap.relatedPlanItemId) return 1;
  if (gap.kind !== 'unclicked-affordance') return 2;
  if (gap.parentRouteRole === 'authenticated') return 3;
  return 4;
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
  const routeRoleByUrl = new Map<string, CrawledRoute['role']>();
  for (const route of input.crawlResult.routes) routeRoleByUrl.set(normalizeUrl(route.url), route.role);

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
      const parentRouteRole = routeRoleByUrl.get(normalizeUrl(route.url)) ?? route.role;
      gaps.push({
        id: `click:${route.url}>>${candidate.selector}`,
        kind: 'unclicked-affordance',
        description: `"${candidate.name}" on ${route.url} survived the safety filter but was never actually clicked (probe budget ran out first).`,
        parentRouteUrl: route.url,
        targetSelectorGuess: candidate.selector,
        targetName: candidate.name,
        parentRouteRole,
        lowValueAffordance: isLowValueAffordance(candidate.name, parentRouteRole),
        relatedPlanItemId: correlatePlanItem(candidate.name, input.planItems),
        targetSelectorTier: candidate.selectorTier,
        targetRepeatedRowText: candidate.repeatedRowText,
      });
    }
  }

  gaps.push(...identifyUnmetContentNeeds(input.crawlResult, input.planItems, input.routing, input.baseUrl));

  // Priority-tiered, not just plan-linked-first — see `gapPriorityTier`'s doc comment.
  // Array.prototype.sort is stable, so relative order within each tier is otherwise preserved.
  gaps.sort((a, b) => gapPriorityTier(a) - gapPriorityTier(b));

  const deduped: ExplorationGap[] = [];
  const seenIds = new Set<string>();
  for (const gap of gaps) {
    if (seenIds.has(gap.id)) continue;
    seenIds.add(gap.id);
    deduped.push(gap);
  }

  // Plan-linked gaps (real, identified content needs) are never truncated — only gaps with no
  // plan correlation at all compete for the fixed backstop. See MAX_GAPS_PER_RUN's doc comment.
  const planLinked = deduped.filter((g) => g.relatedPlanItemId);
  const unlinked = deduped.filter((g) => !g.relatedPlanItemId);
  return [...planLinked, ...unlinked.slice(0, MAX_GAPS_PER_RUN)];
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
  /** Defaults to `perGapBudgetMs * gaps.length` when unset — see `DEFAULT_PER_GAP_BUDGET_MS`'s
   * doc comment for why the total scales with gap count rather than being a fixed pool. */
  totalBudgetMs?: number;
}

export interface GapFillResult {
  attempts: GapFillAttempt[];
  newRoutes: CrawledRoute[];
}

/**
 * Cheap-model, bounded ReAct loop — not a free-form agent. See providers/model-config.ts's
 * 'explore-gapfill' entry. Bumped from 5: the content-goal-driven path (`unmet-content-need`
 * gaps, and multi-route chaining in `runGapFillingPass`) can genuinely need more turns than a
 * simple affordance click-and-diff — navigate a candidate route, look around, then act — so it
 * gets more room to actually converge on its goal before giving up.
 */
const MICRO_AGENT_MAX_ACTIONS = 10;
/** Measured live against the real Claude CLI (not a mocked provider): a single micro-agent turn —
 * subprocess spin-up + a cheap/low-effort completion — took ~8-9s round-trip, so 10s/turn is a
 * realistic per-step allowance, not an arbitrary number. */
const MICRO_AGENT_SECONDS_PER_ACTION = 10;
/**
 * Ceiling on a SINGLE gap's micro-agent escalation, derived from the two constants above rather
 * than set independently — keeps "how many turns it gets" and "how long each turn is allotted"
 * tied together by construction so they can't silently drift out of sync.
 *
 * This used to be clamped against a FIXED shared total budget (45s), which meant this floor
 * wasn't actually guaranteed: measured live, two 20s-capped wallet gaps alone consumed nearly
 * the whole fixed total, pushing a THIRD, equally-important gap (the dashboard's change-password
 * trigger) to `skipped-budget` with zero attempt — a higher per-gap floor was making things worse
 * for gaps queued behind the first couple, not better. `runGapFillingPass`'s total budget now
 * scales with the number of gaps (`perGapBudgetMs * gaps.length`, see there) specifically so this
 * floor is a real per-gap guarantee, not a best-effort share of a pool sized independently of how
 * many gaps exist. Trade-off: total gap-fill wall-clock now scales with gap count too — and, since
 * `MAX_GAPS_PER_RUN` no longer caps plan-linked gaps (see its own doc comment), a plan with many
 * genuinely uncovered items can make a run take proportionally longer, by design.
 */
const DEFAULT_PER_GAP_BUDGET_MS = MICRO_AGENT_MAX_ACTIONS * MICRO_AGENT_SECONDS_PER_ACTION * 1000;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Named for the common case (a freshly-discovered URL has no prior role to inherit), but a gap
 * closed against an EXISTING route (e.g. an affordance revealed on an already-crawled
 * authenticated dashboard page) should carry that route's real role through instead of always
 * mislabeling the new state as anonymous — see the `role` param's call sites below. */
function newAnonymousRoute(
  url: string,
  snapshot: Awaited<ReturnType<typeof snapshotClean>>,
  role: CrawledRoute['role'] = 'anonymous',
): CrawledRoute {
  return {
    url,
    title: snapshot.title,
    snapshot,
    depth: 0,
    hasPasswordField: snapshot.interactiveElements.some((el) => el.inputType === 'password'),
    role,
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
 *
 * A tier-4 (positional nth-of-type) `targetSelectorGuess` is exactly the kind that can silently
 * resolve to a different node on a fresh reload than the one the crawl clicked — conditional
 * rendering, async-loaded content, or list reordering all shift the index, and `.locator().first()`
 * has no way to signal "this isn't the node you meant." When the primary selector reveals
 * nothing, retry once with a stable text anchor before falling through to the micro-agent —
 * preferring `targetRepeatedRowText` (the nearest repeated ancestor's own text, e.g. "Heslo
 * ******** zmeniť") over the bare `targetName` (e.g. "zmeniť") when both are available: several
 * distinct triggers can share an identical accessible name (this app has one "zmeniť" per
 * profile-edit section — name, email, password, DOB), so anchoring on the name alone is exactly
 * as ambiguous as the original positional selector — `:text-is(name).first()` just picks
 * whichever same-named node happens to resolve first, arbitrarily (confirmed live: this
 * previously closed the name-edit section while leaving change-password/email-change gaps
 * unresolved). Scoping the click to the row identified by its own distinguishing text, THEN
 * finding the actual clickable node inside it by name, disambiguates correctly.
 */
async function closeAffordanceGapDeterministic(
  browser: BrowserSurface,
  gap: ExplorationGap,
): Promise<{ attempt: GapFillAttempt; route?: CrawledRoute } | null> {
  if (!gap.parentRouteUrl || !gap.targetSelectorGuess) return null;

  const primary = await attemptAffordanceClick(browser, gap, gap.targetSelectorGuess);
  if (primary) return primary;

  const textAnchor = gap.targetRepeatedRowText ?? gap.targetName;
  if (gap.targetSelectorTier === 4 && textAnchor) {
    const selector =
      gap.targetRepeatedRowText && gap.targetName
        ? `:has-text(${JSON.stringify(gap.targetRepeatedRowText)}) >> :text-is(${JSON.stringify(gap.targetName)})`
        : `:text-is(${JSON.stringify(textAnchor)})`;
    return attemptAffordanceClick(browser, gap, selector);
  }
  return null;
}

async function attemptAffordanceClick(
  browser: BrowserSurface,
  gap: ExplorationGap,
  selector: string,
): Promise<{ attempt: GapFillAttempt; route?: CrawledRoute } | null> {
  if (!gap.parentRouteUrl) return null;

  try {
    await browser.goto(gap.parentRouteUrl);
    const before = await snapshotClean(browser);
    await browser.click(selector);
    const after = await snapshotClean(browser);
    const revealed =
      after.interactiveElements.length - before.interactiveElements.length >= STATE_REVEAL_MIN_NEW_ELEMENTS ||
      revealedInputFields(before, after) >= STATE_REVEAL_MIN_NEW_INPUTS;

    if (!revealed) return null;
    const route: CrawledRoute = {
      ...newAnonymousRoute(gap.parentRouteUrl, after, gap.parentRouteRole ?? 'anonymous'),
      stateKey: `${gap.parentRouteUrl}>>${selector}`,
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
    'When two elements share the same name, prefer the one whose page context (nearby text, section heading) matches the goal above.',
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
  perGapDeadline: number,
  /** Role to label a newly-revealed state with — see `newAnonymousRoute`'s doc comment. Defaults
   * to 'anonymous', correct for the endpoint-gap call site where there's no existing route to
   * inherit a role from; the affordance-gap call site passes the parent route's real role. */
  role: CrawledRoute['role'] = 'anonymous',
): Promise<{ newRoute?: CrawledRoute }> {
  const history: string[] = [];
  let before = await snapshotClean(browser);
  const beforeCount = before.interactiveElements.length;

  for (let turn = 0; turn < MICRO_AGENT_MAX_ACTIONS; turn += 1) {
    if (Date.now() >= perGapDeadline) {
      emit('explore', 'debug', 'Gap-fill micro-agent per-gap budget elapsed — stopping this gap early.');
      break;
    }
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
          ...newAnonymousRoute(after.url, after, role),
          stateKey: `gapfill>>${history.join('>>')}`,
        },
      };
    }
    before = after;
  }

  return {};
}

/**
 * Attempts to close every identified gap, in order, within a total time budget that scales with
 * how many gaps there are (`perGapBudgetMs * gaps.length` by default) — a single failing gap
 * never aborts the rest, and (unlike a fixed-size pool) a gap sorted further down the
 * priority-ordered list is still guaranteed its own `perGapBudgetMs` rather than whatever happens
 * to be left over after the gaps ahead of it. Deterministic paths (a direct `goto`, or a
 * click-and-diff) are always tried first; the bounded LLM micro-agent only runs for a gap they
 * couldn't close AND when `gapFillProvider` is configured.
 */
export async function runGapFillingPass(input: RunGapFillInput): Promise<GapFillResult> {
  const attempts: GapFillAttempt[] = [];
  const newRoutes: CrawledRoute[] = [];
  const perGapBudgetMs = input.perGapBudgetMs ?? DEFAULT_PER_GAP_BUDGET_MS;
  const deadline = Date.now() + (input.totalBudgetMs ?? perGapBudgetMs * input.gaps.length);
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
    // Clamped against the total deadline so a gap late in the list never gets MORE runway than
    // what's actually left — this only ever shortens, never extends, a gap's effective budget.
    const perGapDeadline = Math.min(deadline, Date.now() + perGapBudgetMs);

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
            perGapDeadline,
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

      if (gap.kind === 'unmet-content-need') {
        if (!input.gapFillProvider) {
          attempts.push({
            gap,
            outcome: 'partial',
            newRoutesCaptured: 0,
            detail: 'no gap-fill provider configured',
          });
          continue;
        }
        // Try each candidate route in turn — a plan item's content may live on any one of
        // several visited routes (or none yet crawled at all) — stopping at the first that
        // reveals something. All candidates share this one gap's own deadline; runMicroAgent's
        // multi-turn ReAct loop (click/type/pressKey/done, up to MICRO_AGENT_MAX_ACTIONS) already
        // gives it room to navigate/look-around/act within a single candidate route.
        const routesToTry = gap.candidateRouteUrls?.length ? gap.candidateRouteUrls : [input.baseUrl];
        let micro: { newRoute?: CrawledRoute } = {};
        for (const url of routesToTry) {
          if (Date.now() >= perGapDeadline) break;
          await input.browser.goto(url).catch(() => undefined);
          micro = await runMicroAgent(
            input.browser,
            gap.description,
            origin,
            input.gapFillProvider,
            input.emit,
            perGapDeadline,
            gap.parentRouteRole ?? 'anonymous',
          );
          if (micro.newRoute) break;
        }
        attempts.push({
          gap,
          outcome: micro.newRoute ? 'closed' : 'partial',
          newRoutesCaptured: micro.newRoute ? 1 : 0,
          usedMicroAgent: true,
        });
        if (micro.newRoute) newRoutes.push(micro.newRoute);
        continue;
      }

      // unclicked-affordance
      const deterministic = await closeAffordanceGapDeterministic(input.browser, gap);
      if (deterministic) {
        attempts.push(deterministic.attempt);
        if (deterministic.route) newRoutes.push(deterministic.route);
        continue;
      }
      if (gap.lowValueAffordance) {
        // Decorative/social-nav affordance that already failed the cheap deterministic
        // click-and-diff above — not worth a full multi-turn LLM escalation. Conserves the
        // shared budget for gaps further down the (now value-ordered) list.
        attempts.push({
          gap,
          outcome: 'partial',
          newRoutesCaptured: 0,
          detail:
            'decorative/social-nav affordance — skipped LLM escalation to conserve shared gap-fill budget',
        });
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
          perGapDeadline,
          gap.parentRouteRole ?? 'anonymous',
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
