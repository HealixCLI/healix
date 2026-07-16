import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findSpecFiles, parseOpenApiSpec, parsePostmanCollection } from './spec-parser.js';

describe('parseOpenApiSpec', () => {
  it('parses an OpenAPI 3.x YAML doc into endpoint units with schemas and provenance', () => {
    const yamlSpec = `
openapi: 3.0.0
info:
  title: Orders API
  version: 1.0.0
paths:
  /orders:
    post:
      security:
        - bearerAuth: []
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                item:
                  type: string
      responses:
        '201':
          content:
            application/json:
              schema:
                type: object
                properties:
                  id:
                    type: string
    get:
      responses:
        '200':
          content:
            application/json:
              schema:
                type: array
`;
    const units = parseOpenApiSpec(yamlSpec, 'docs/openapi.yaml');
    expect(units).toHaveLength(2);

    const post = units.find((u) => u.method === 'POST');
    expect(post?.key).toBe('endpoint:POST /orders');
    expect(post?.provenance).toBe('spec');
    expect(post?.authRequired).toBe(true);
    expect(post?.requestSchema).toEqual({ type: 'object', properties: { item: { type: 'string' } } });
    expect(post?.responseSchema).toEqual({ type: 'object', properties: { id: { type: 'string' } } });

    const get = units.find((u) => u.method === 'GET');
    expect(get?.authRequired).toBe(false);
  });

  it('parses an OpenAPI JSON doc and applies a global security requirement per-operation', () => {
    const jsonSpec = JSON.stringify({
      openapi: '3.0.0',
      security: [{ bearerAuth: [] }],
      paths: {
        '/users/{id}': {
          get: { responses: { '200': { content: { 'application/json': { schema: { type: 'object' } } } } } },
        },
      },
    });
    const units = parseOpenApiSpec(jsonSpec, 'openapi.json');
    expect(units).toHaveLength(1);
    expect(units[0].key).toBe('endpoint:GET /users/{id}');
    expect(units[0].authRequired).toBe(true);
  });

  it('returns [] for malformed content and for valid JSON/YAML with no `paths`', () => {
    expect(parseOpenApiSpec('not: [valid: yaml: at all', 'broken.yaml')).toEqual([]);
    expect(parseOpenApiSpec(JSON.stringify({ some: 'unrelated config' }), 'config.json')).toEqual([]);
  });
});

describe('parsePostmanCollection', () => {
  it('parses a flat collection (no folders), extracting method/path/schema from a raw JSON body', () => {
    const collection = JSON.stringify({
      info: { name: 'Fixture API' },
      item: [
        {
          name: 'Create order',
          request: {
            method: 'POST',
            url: { raw: '{{base_url}}/api/orders', host: ['{{base_url}}'], path: ['api', 'orders'] },
            body: { mode: 'raw', raw: JSON.stringify({ item: 'widget' }) },
          },
        },
      ],
    });
    const units = parsePostmanCollection(collection, 'Fixture.postman_collection.json');
    expect(units).toHaveLength(1);
    expect(units[0].key).toBe('endpoint:POST /api/orders');
    expect(units[0].provenance).toBe('spec');
    expect(units[0].requestSchema).toEqual({ item: 'widget' });
  });

  it('recurses into nested folders', () => {
    const collection = JSON.stringify({
      item: [
        {
          name: 'Auth',
          item: [
            {
              name: 'Login',
              request: { method: 'POST', url: { path: ['api', 'auth', 'login'] } },
            },
          ],
        },
      ],
    });
    const units = parsePostmanCollection(collection, 'c.postman_collection.json');
    expect(units.map((u) => u.key)).toEqual(['endpoint:POST /api/auth/login']);
  });

  it('applies collection-level auth as the default, overridden per-request by `noauth`', () => {
    const collection = JSON.stringify({
      auth: { type: 'bearer' },
      item: [
        { name: 'Create', request: { method: 'POST', url: { path: ['x'] } } },
        {
          name: 'Login',
          request: { method: 'POST', url: { path: ['login'] }, auth: { type: 'noauth' } },
        },
      ],
    });
    const units = parsePostmanCollection(collection, 'c.postman_collection.json');
    expect(units.find((u) => u.key === 'endpoint:POST /x')?.authRequired).toBe(true);
    expect(units.find((u) => u.key === 'endpoint:POST /login')?.authRequired).toBe(false);
  });

  it('returns [] for malformed JSON and for a doc with no `item` array', () => {
    expect(parsePostmanCollection('not json', 'c.postman_collection.json')).toEqual([]);
    expect(parsePostmanCollection(JSON.stringify({ info: {} }), 'c.postman_collection.json')).toEqual([]);
  });
});

describe('findSpecFiles', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-spec-parser-'));
    tempDirs.push(dir);
    return dir;
  }

  it('finds OpenAPI/Swagger/Postman/GraphQL files under conventional directories', () => {
    const dir = makeRepo();
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'openapi.yaml'), 'openapi: 3.0.0');
    fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'api', 'MyApi.postman_collection.json'), '{}');
    fs.mkdirSync(path.join(dir, 'src', 'graphql'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'graphql', 'schema.graphql'), 'type Query { hello: String }');
    // Not a spec file — must not be picked up.
    fs.writeFileSync(path.join(dir, 'docs', 'README.md'), '# docs');

    const found = findSpecFiles(dir).map((f) => path.relative(dir, f).split(path.sep).join('/'));
    expect(found).toContain('docs/openapi.yaml');
    expect(found).toContain('api/MyApi.postman_collection.json');
    expect(found).toContain('src/graphql/schema.graphql');
    expect(found).not.toContain('docs/README.md');
  });

  it('returns [] when none of the conventional directories exist', () => {
    const dir = makeRepo();
    expect(findSpecFiles(dir)).toEqual([]);
  });

  it('finds a Postman collection dropped at the repo root (not inside any conventional dir)', () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'MyApi.postman_collection.json'), '{}');
    const found = findSpecFiles(dir).map((f) => path.relative(dir, f));
    expect(found).toContain('MyApi.postman_collection.json');
  });
});

// --- Isolated check against real fixture Postman collections (Item C2) -----

const FIXTURES_ROOT = path.join('C:', 'Users', 'AdroyFernandes', 'Documents', 'TestApps');
const RBAC_COLLECTION = path.join(
  FIXTURES_ROOT,
  'Role-Based-Access-Control-RBAC-',
  'RBAC-API.postman_collection.json',
);
const HERFY_COLLECTION = path.join(
  FIXTURES_ROOT,
  'psv-ui-herfy-development',
  'HerfyToken.postman_collection.json',
);

describe.skipIf(!fs.existsSync(RBAC_COLLECTION))(
  'parsePostmanCollection against the real RBAC-API.postman_collection.json (isolated check)',
  () => {
    it('recurses through real nested folders and applies collection-level bearer auth as the default', () => {
      const content = fs.readFileSync(RBAC_COLLECTION, 'utf-8');
      const units = parsePostmanCollection(content, 'RBAC-API.postman_collection.json');
      const keys = units.map((u) => u.key);

      expect(keys).toContain('endpoint:POST /api/auth/login');
      expect(keys).toContain('endpoint:POST /api/users');
      expect(keys).toContain('endpoint:GET /api/roles');

      // Real fixture: Login requests explicitly override with auth: {type: 'noauth'}; other
      // requests inherit the collection-level bearer auth and require it.
      const login = units.find((u) => u.key === 'endpoint:POST /api/auth/login');
      expect(login?.authRequired).toBe(false);
      const createUser = units.find((u) => u.key === 'endpoint:POST /api/users');
      expect(createUser?.authRequired).toBe(true);
    });
  },
);

describe.skipIf(!fs.existsSync(HERFY_COLLECTION))(
  'parsePostmanCollection against the real HerfyToken.postman_collection.json (isolated check)',
  () => {
    it('extracts real flat (non-folder) requests with an absolute-URL host', () => {
      const content = fs.readFileSync(HERFY_COLLECTION, 'utf-8');
      const units = parsePostmanCollection(content, 'HerfyToken.postman_collection.json');
      expect(units.length).toBeGreaterThan(0);
      expect(units.map((u) => u.key)).toContain('endpoint:POST /v3/oauth/token/generate');
    });
  },
);
