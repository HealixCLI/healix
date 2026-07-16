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
