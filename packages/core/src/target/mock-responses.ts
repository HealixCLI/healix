import type { ProviderAdapter } from '../providers/types.js';
import type { ExternalDependency, ExternalDependencyCategory, MockResponse } from './types.js';

const MOCK_RESPONSE_TIMEOUT_MS = 60_000;

/** Plausible canned success response per category — used until/unless the AI pass overrides it. */
const STATIC_TEMPLATES: Record<ExternalDependencyCategory, MockResponse> = {
  sms: { status: 200, body: { status: 'sent', sid: 'HEALIX-MOCK-SMS-000000' } },
  otp: { status: 200, body: { status: 'pending', message: 'OTP sent (mocked by Healix)' } },
  email: { status: 202, body: { status: 'queued', id: 'healix-mock-email-000000' } },
  payment: { status: 200, body: { status: 'succeeded', id: 'healix_mock_pi_000000' } },
  auth: { status: 200, body: { success: true, token: 'healix-mock-token' } },
  backend: { status: 200, body: {} },
  other: { status: 200, body: {} },
};

/** The static, deterministic fallback response for a dependency's category. Never fails, never calls out. */
export function staticMockResponse(category: ExternalDependencyCategory): MockResponse {
  return STATIC_TEMPLATES[category] ?? STATIC_TEMPLATES.other;
}

/** Shape the model is asked to emit inside a fenced JSON block. */
interface RawMockResponse {
  id?: unknown;
  status?: unknown;
  body?: unknown;
  headers?: unknown;
}
interface RawMockResponses {
  responses?: unknown;
}

/** Composite key for an endpoint-level response entry: distinct from a plain dependency id, never collides with one. */
function endpointKey(depId: string, method: string, pathPattern: string): string {
  return `${depId}::${method}::${pathPattern}`;
}

function buildPrompt(deps: ExternalDependency[]): string {
  const lines: string[] = [];
  lines.push('You are configuring a local mock server for an offline test run. For each external dependency');
  lines.push(
    'listed below, produce a plausible SUCCESSFUL canned JSON response its real API would return, so',
  );
  lines.push('tests exercising this integration behave realistically without a real network call.');
  lines.push('');
  lines.push('Dependencies:');
  for (const d of deps) {
    const seenIn = d.file ? ` | seen in: ${d.file}` : '';
    lines.push(`- id: "${d.id}" | category: ${d.category} | label: ${d.label}${seenIn}`);
    if (d.endpoints && d.endpoints.length > 0) {
      lines.push('  Known endpoints for this dependency (produce a distinct, endpoint-appropriate response for EACH):');
      for (const e of d.endpoints) {
        lines.push(`    - key: "${endpointKey(d.id, e.method, e.pathPattern)}" | ${e.method} ${e.pathPattern}`);
      }
    }
  }
  lines.push('');
  lines.push('Respond with exactly one fenced ```json code block of the shape:');
  lines.push('```json');
  lines.push('{');
  lines.push('  "responses": [');
  lines.push(
    '    { "id": "<a dependency id, OR an endpoint key exactly as printed above>", "status": 200, "body": { "...": "realistic JSON" } }',
  );
  lines.push('  ]');
  lines.push('}');
  lines.push('```');
  lines.push(
    'Produce exactly one entry per dependency id (or, when endpoints are listed, one entry per endpoint key — ' +
      'endpoint keys take priority over a single dependency-level entry). Use realistic field names and values ' +
      'appropriate to what that specific endpoint path suggests it does — e.g. a path containing "login"/"auth" ' +
      'returns a token; "list"/plural nouns return an array; "balance"/"points"/"ledger" return numeric fields; ' +
      'a POST "redeem"/"create" returns a confirmation id.',
  );
  return lines.join('\n');
}

/** Extract a JSON object string from arbitrary model output (fenced ```json, fenced ```, or bare). */
function extractJsonObject(text: string): string | null {
  if (!text) return null;
  const fencedJson = /```json\s*([\s\S]*?)```/i.exec(text);
  if (fencedJson && fencedJson[1]) {
    const inner = sliceBalanced(fencedJson[1]);
    if (inner) return inner;
  }
  const fenced = /```\s*([\s\S]*?)```/.exec(text);
  if (fenced && fenced[1]) {
    const inner = sliceBalanced(fenced[1]);
    if (inner) return inner;
  }
  return sliceBalanced(text);
}

/** Return the first balanced {...} object substring, respecting strings/escapes. */
function sliceBalanced(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function normalizeStatus(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  return Number.isInteger(n) && n >= 100 && n < 600 ? n : 200;
}

/** Parse the model's completion into a map of dependency id -> MockResponse. Malformed entries are dropped. */
function parseMockResponses(text: string, validIds: Set<string>): Map<string, MockResponse> {
  const out = new Map<string, MockResponse>();
  const candidate = extractJsonObject(text);
  if (!candidate) return out;

  let raw: RawMockResponses;
  try {
    raw = JSON.parse(candidate) as RawMockResponses;
  } catch {
    return out;
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.responses)) return out;

  for (const entry of raw.responses as RawMockResponse[]) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id || !validIds.has(id) || out.has(id)) continue;
    const body = entry.body !== undefined ? entry.body : {};
    const headers =
      entry.headers && typeof entry.headers === 'object' && !Array.isArray(entry.headers)
        ? (entry.headers as Record<string, string>)
        : undefined;
    out.set(id, { status: normalizeStatus(entry.status), body, ...(headers ? { headers } : {}) });
  }
  return out;
}

/**
 * Resolve a canned response for every mockable dependency (mockStrategy !==
 * 'undeterminable'): starts every dependency at its static category default,
 * then makes ONE batched provider call asking for realistic content and
 * overrides whichever entries the model returns usably. A missing/invalid
 * model response for a given dependency simply keeps its static default —
 * this never blocks or fails the run on an AI hiccup. `provider` is optional
 * so callers with no ready AI provider (e.g. a quick manual `mock-launch`)
 * still get usable static responses instead of having to special-case it.
 */
export async function generateMockResponses(
  deps: ExternalDependency[],
  provider?: ProviderAdapter,
  opts?: { repoPath?: string; signal?: AbortSignal },
): Promise<Map<string, MockResponse>> {
  const mockable = deps.filter((d) => d.mockStrategy !== 'undeterminable');
  const result = new Map<string, MockResponse>();
  for (const d of mockable) {
    result.set(d.id, staticMockResponse(d.category));
    // Every detected endpoint gets a static fallback up front too, same as the
    // dependency-level entry — an AI override below replaces it when usable,
    // but a run with no ready provider still gets a (generic) response per
    // endpoint instead of falling back to the coarser dependency-wide one.
    for (const e of d.endpoints ?? []) e.response = staticMockResponse(d.category);
  }
  if (mockable.length === 0 || !provider) return result;

  try {
    const completion = await provider.complete(buildPrompt(mockable), {
      cwd: opts?.repoPath,
      timeoutMs: MOCK_RESPONSE_TIMEOUT_MS,
      readOnly: true,
      signal: opts?.signal,
    });
    if (completion.ok && completion.text) {
      const validKeys = new Set<string>();
      for (const d of mockable) {
        validKeys.add(d.id);
        for (const e of d.endpoints ?? []) validKeys.add(endpointKey(d.id, e.method, e.pathPattern));
      }
      const parsed = parseMockResponses(completion.text, validKeys);
      for (const d of mockable) {
        const depLevel = parsed.get(d.id);
        if (depLevel) result.set(d.id, depLevel);
        for (const e of d.endpoints ?? []) {
          const perEndpoint = parsed.get(endpointKey(d.id, e.method, e.pathPattern));
          if (perEndpoint) e.response = perEndpoint;
        }
      }
    }
  } catch {
    // AI content generation is best-effort; every dependency/endpoint already
    // has its static fallback set above, so a thrown/failed call changes nothing.
  }

  return result;
}
