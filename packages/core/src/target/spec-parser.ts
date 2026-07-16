import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { FunctionalityUnit } from './functionality-index.js';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);

interface OpenApiContentMap {
  [mediaType: string]: { schema?: unknown } | undefined;
}
interface OpenApiOperation {
  requestBody?: { content?: OpenApiContentMap };
  responses?: Record<string, { content?: OpenApiContentMap } | undefined>;
  security?: unknown[];
}
interface OpenApiDoc {
  openapi?: string;
  swagger?: string;
  paths?: Record<string, Record<string, OpenApiOperation> | undefined>;
  security?: unknown[];
}

function firstSchema(content: OpenApiContentMap | undefined): unknown {
  if (!content) return undefined;
  return Object.values(content)[0]?.schema;
}

/** Prefer the first 2xx response's schema; fall back to whatever response is listed first. */
function firstResponseSchema(responses: OpenApiOperation['responses']): unknown {
  if (!responses) return undefined;
  const entries = Object.entries(responses);
  const success = entries.find(([code]) => /^2\d\d$/.test(code));
  const chosen = (success ?? entries[0])?.[1];
  return chosen ? firstSchema(chosen.content) : undefined;
}

/**
 * Parse an OpenAPI 3.x / Swagger 2.x document (JSON or YAML text) into FunctionalityUnits tagged
 * `provenance: 'spec'` — authoritative over code-derived inference, since a spec is a contract,
 * not a guess. Request/response schemas and auth-requiredness are carried through when present.
 * Returns [] for anything that doesn't parse or isn't shaped like an OpenAPI/Swagger doc (no
 * `paths`) — this is a best-effort additive signal, never a hard failure for the caller.
 */
export function parseOpenApiSpec(content: string, file: string): FunctionalityUnit[] {
  let doc: OpenApiDoc;
  try {
    const parsed: unknown = content.trim().startsWith('{') ? JSON.parse(content) : yaml.load(content);
    if (!parsed || typeof parsed !== 'object') return [];
    doc = parsed as OpenApiDoc;
  } catch {
    return [];
  }
  if (!doc.paths || typeof doc.paths !== 'object') return [];

  const globalSecurity = Array.isArray(doc.security) && doc.security.length > 0;
  const units: FunctionalityUnit[] = [];

  for (const [routePath, methods] of Object.entries(doc.paths)) {
    if (!methods || typeof methods !== 'object') continue;
    for (const [rawMethod, op] of Object.entries(methods)) {
      const method = rawMethod.toLowerCase();
      if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;

      const methodUpper = method.toUpperCase();
      const requestSchema = firstSchema(op.requestBody?.content);
      const responseSchema = firstResponseSchema(op.responses);
      const authRequired = Array.isArray(op.security) ? op.security.length > 0 : globalSecurity;

      units.push({
        key: `endpoint:${methodUpper} ${routePath}`,
        kind: 'endpoint',
        label: `${methodUpper} ${routePath}`,
        file,
        provenance: 'spec',
        method: methodUpper,
        authRequired,
        ...(requestSchema !== undefined ? { requestSchema } : {}),
        ...(responseSchema !== undefined ? { responseSchema } : {}),
      });
    }
  }

  return units;
}

// --- Postman collection (v2.0/v2.1 schema) ---------------------------------

interface PostmanUrl {
  raw?: string;
  path?: Array<string | { value?: string }>;
}
interface PostmanAuth {
  type?: string;
}
interface PostmanRequest {
  method?: string;
  url?: PostmanUrl | string;
  auth?: PostmanAuth;
  body?: { mode?: string; raw?: string };
}
interface PostmanItem {
  name?: string;
  item?: PostmanItem[];
  request?: PostmanRequest;
}
interface PostmanCollection {
  info?: { name?: string };
  auth?: PostmanAuth;
  item?: PostmanItem[];
}

/** Postman path segments can be plain strings or `{value: string}` variable objects. */
function pathSegment(seg: string | { value?: string }): string {
  return typeof seg === 'string' ? seg : (seg.value ?? '');
}

/** Build a route path from a Postman request's `url`, preferring the parsed `path` segments over the raw string (which still carries the `{{host}}` template variable). */
function postmanRoutePath(url: PostmanUrl | string | undefined): string | null {
  if (!url) return null;
  if (typeof url === 'string') {
    // No parsed segments available — strip a leading scheme/variable host if present.
    const stripped = url.replace(/^[a-z]+:\/\//i, '').replace(/^\{\{[^}]+\}\}/, '');
    const slashIdx = stripped.indexOf('/');
    return slashIdx === -1 ? '/' : stripped.slice(slashIdx);
  }
  if (url.path && url.path.length > 0) {
    return `/${url.path.map(pathSegment).join('/')}`;
  }
  return postmanRoutePath(url.raw);
}

/** Best-effort JSON.parse of a raw request body — an example payload, not a strict schema, but the same "authoritative shape" concept as an OpenAPI requestSchema. */
function parseRawBody(body: PostmanRequest['body']): unknown {
  if (!body || body.mode !== 'raw' || !body.raw) return undefined;
  try {
    return JSON.parse(body.raw);
  } catch {
    return undefined;
  }
}

function walkPostmanItems(
  items: PostmanItem[] | undefined,
  file: string,
  collectionAuth: PostmanAuth | undefined,
  out: FunctionalityUnit[],
): void {
  for (const item of items ?? []) {
    if (item.item) {
      walkPostmanItems(item.item, file, collectionAuth, out);
      continue;
    }
    const req = item.request;
    if (!req?.method) continue;
    const routePath = postmanRoutePath(req.url);
    if (!routePath) continue;

    const method = req.method.toUpperCase();
    const authType = req.auth?.type ?? collectionAuth?.type;
    const authRequired = authType !== undefined && authType !== 'noauth';
    const requestSchema = parseRawBody(req.body);

    out.push({
      key: `endpoint:${method} ${routePath}`,
      kind: 'endpoint',
      label: `${method} ${routePath}`,
      file,
      provenance: 'spec',
      method,
      authRequired,
      ...(requestSchema !== undefined ? { requestSchema } : {}),
    });
  }
}

/**
 * Parse a Postman v2.0/v2.1 collection export into FunctionalityUnits, recursing through
 * arbitrarily nested folders (a collection's `item` array holds either a folder — itself another
 * `item` array — or a leaf request). Path is taken from the request's parsed `url.path` segments
 * when available (avoiding the `{{base_url}}` template variable that the raw URL string carries),
 * falling back to stripping a scheme/variable prefix off the raw string otherwise. Per-request
 * `auth: {type: 'noauth'}` overrides the collection-level default. Returns [] for anything that
 * doesn't parse as JSON or has no top-level `item` array.
 */
export function parsePostmanCollection(content: string, file: string): FunctionalityUnit[] {
  let doc: PostmanCollection;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return [];
    doc = parsed as PostmanCollection;
  } catch {
    return [];
  }
  if (!Array.isArray(doc.item)) return [];

  const units: FunctionalityUnit[] = [];
  walkPostmanItems(doc.item, file, doc.auth, units);
  return units;
}

const SPEC_DIRS = ['docs', 'api', 'spec', 'openapi', 'swagger', 'src'];
const SPEC_FILE_RE = /(openapi|swagger).*\.(json|ya?ml)$|\.postman_collection\.json$|\.(graphql|gql)$/i;
/** Directories never descended into while looking for spec files, matching the rest of target/*.ts. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'coverage']);
const MAX_SPEC_FILES = 25;
const MAX_DEPTH = 4;

/**
 * Find likely OpenAPI/Swagger/Postman/GraphQL spec files by scanning a bounded set of
 * conventional directories (docs/api/spec/openapi/swagger/src) up to MAX_DEPTH deep, capped at
 * MAX_SPEC_FILES. This is a targeted scan, not a full repo walk — spec files are expected to live
 * in one of these directories in practice, so scanning the whole tree would be wasted work.
 */
export function findSpecFiles(repoPath: string): string[] {
  const root = path.resolve(repoPath);
  const found: string[] = [];

  function walk(dir: string, depth: number): void {
    if (found.length >= MAX_SPEC_FILES || depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_SPEC_FILES) return;
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(abs, depth + 1);
      } else if (entry.isFile() && SPEC_FILE_RE.test(entry.name)) {
        found.push(abs);
      }
    }
  }

  for (const dir of SPEC_DIRS) {
    const abs = path.join(root, dir);
    if (fs.existsSync(abs)) walk(abs, 0);
  }

  return found;
}
