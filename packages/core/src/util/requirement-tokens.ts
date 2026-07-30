import type { CrawledRoute } from '../browser/crawler.js';
import type { InteractiveElement } from '../browser/types.js';

/**
 * Structural subset of a plan item's requirement text — deliberately NOT `TestPlanItem` itself,
 * so this module has no dependency on `modes/types.ts` (this lives below `modes/` and
 * `orchestrator/` in the import graph; both import from here, not the other way around).
 */
export interface RequirementTextSource {
  title: string;
  intent?: string;
  unitKey?: string;
  scenarios?: { description: string }[];
}

/**
 * Roles the DOM doesn't natively expose as `link`/`button` even though the element is
 * clickable (e.g. a `<div>` with a click handler and no `role` attribute) — the single
 * biggest source of `getByRole('link'/'button', ...)` hallucination in production.
 */
export const NON_SEMANTIC_ROLES = new Set(['generic']);

/** Words too common/generic to carry any relevance signal on their own. */
const STOPWORD_TOKENS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'to',
  'of',
  'in',
  'on',
  'for',
  'is',
  'are',
  'with',
  'that',
  'this',
  'it',
  'be',
  'as',
  'by',
  'at',
  'from',
  'renders',
  'page',
]);

/** Lowercase, split on non-alphanumeric runs, drop stopwords and single characters. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORD_TOKENS.has(t));
}

/**
 * Tokenizes a plan item's requirement text (title, intent, every scenario description, unitKey)
 * into a lowercased/stopword-stripped token set — used to rank DOM elements by relevance to THIS
 * item (see `rankRouteElements`) and to detect whether an item's content need is already met by
 * the current exploration inventory (see `hasRequirementCoverage`).
 */
export function buildRequirementTokens(item?: RequirementTextSource): Set<string> {
  const tokens = new Set<string>();
  if (!item) return tokens;
  const parts = [
    item.title,
    item.intent ?? '',
    item.unitKey ?? '',
    ...(item.scenarios ?? []).map((s) => s.description),
  ];
  for (const part of parts) {
    for (const t of tokenize(part)) tokens.add(t);
  }
  return tokens;
}

/**
 * Action-verb requirement token -> element predicate. When the requirement text names an action
 * (e.g. "submit", "upload") and an element's role/type matches what that action implies, the
 * element is very likely the one the scenario means to target, even if its accessible name shares
 * no literal words with the requirement text.
 */
export const ACTION_VERB_BONUSES: Record<string, (el: InteractiveElement) => boolean> = {
  submit: (el) => el.role === 'button',
  login: (el) => el.role === 'button',
  signin: (el) => el.role === 'button',
  register: (el) => el.role === 'button',
  signup: (el) => el.role === 'button',
  save: (el) => el.role === 'button',
  delete: (el) => el.role === 'button',
  select: (el) => el.role === 'combobox',
  choose: (el) => el.role === 'combobox',
  upload: (el) => el.inputType === 'file',
  search: (el) => el.role === 'searchbox',
};

/**
 * Weighted relevance score for one crawled element against a plan item's requirement tokens:
 * keyword overlap with the accessible name, an action-verb -> role/type bonus, a penalty for
 * non-semantic roles (NON_SEMANTIC_ROLES — the single biggest hallucination source), a route-role
 * match bonus, and a stability bonus/penalty from the element's locator tier (selectors.ts's
 * selectorFor tiering) so a fragile positional selector must clear a higher relevance bar than a
 * stable testid to make the cut. Higher is more relevant.
 */
export function scoreElement(
  el: InteractiveElement,
  route: CrawledRoute,
  reqTokens: Set<string>,
  preferredRole: string,
): number {
  let score = 0;
  for (const t of tokenize(el.name)) {
    if (reqTokens.has(t)) score += 2;
  }
  for (const [verb, matches] of Object.entries(ACTION_VERB_BONUSES)) {
    if (reqTokens.has(verb) && matches(el)) score += 3;
  }
  if (NON_SEMANTIC_ROLES.has(el.role)) score -= 2;
  if (route.role === preferredRole) score += 1;
  const tierBonus: Record<1 | 2 | 3 | 4, number> = { 1: 2, 2: 1, 3: 0, 4: -2 };
  if (el.selectorTier !== undefined) score += tierBonus[el.selectorTier];
  return score;
}

/**
 * Ranks one route's interactive elements by relevance (see scoreElement), applying a small
 * proximity bonus for an element sitting next to another keyword-matching element (form fields
 * cluster near their submit button, table cells near a matching header) and a duplicate-suppression
 * penalty for a (role, name) pair repeated later in the same route (the first occurrence keeps its
 * full score; a later, redundant duplicate is de-prioritized in favor of something new). Ties break
 * on the ORIGINAL DOM-order index, ascending — required so a uniform-score fixture (no keyword
 * signal at all) degrades to exactly today's first-K-by-DOM-order behavior.
 */
export function rankRouteElements(
  route: CrawledRoute,
  reqTokens: Set<string>,
  preferredRole: string,
): InteractiveElement[] {
  const elements = route.snapshot.interactiveElements;
  const matchedKeyword = elements.map((el) => tokenize(el.name).some((t) => reqTokens.has(t)));
  const seenRoleName = new Map<string, number>();
  const scored = elements.map((el, index) => {
    let score = scoreElement(el, route, reqTokens, preferredRole);
    if (!matchedKeyword[index] && (matchedKeyword[index - 1] || matchedKeyword[index + 1])) {
      score += 0.5;
    }
    if (el.name) {
      const key = `${el.role} ${el.name}`;
      const priorCount = seenRoleName.get(key) ?? 0;
      seenRoleName.set(key, priorCount + 1);
      if (priorCount > 0) score -= 1.5;
    }
    return { el, index, score };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.el);
}

/**
 * Coarse, false-negative-tolerant presence check: does this route already have SOMETHING
 * relevant to the given requirement tokens, via either a keyword-matching accessible name or an
 * action-verb match (see ACTION_VERB_BONUSES)? Deliberately a boolean OR-of-two-signals rather
 * than a tuned numeric threshold on `scoreElement`'s output — that score mixes in tier/role
 * bonuses meant for prompt-ranking (ordering what's already known-relevant), not for deciding
 * presence/absence of relevance in the first place. A false positive here (an app's own locale
 * happening to share a token, or an unrelated action-verb match) just means one extra bounded
 * gap-fill attempt that finds nothing new and reports `partial` — the same cost as any other gap
 * that turns out to already be covered, not a regression.
 */
export function hasRequirementCoverage(route: CrawledRoute, reqTokens: Set<string>): boolean {
  if (reqTokens.size === 0) return true;
  for (const el of route.snapshot.interactiveElements) {
    if (tokenize(el.name).some((t) => reqTokens.has(t))) return true;
    for (const [verb, matches] of Object.entries(ACTION_VERB_BONUSES)) {
      if (reqTokens.has(verb) && matches(el)) return true;
    }
  }
  return false;
}
