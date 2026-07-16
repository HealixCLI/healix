import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findSpecFiles, parseOpenApiSpec } from './spec-parser.js';

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
});
