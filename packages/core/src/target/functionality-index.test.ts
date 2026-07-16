import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { indexFunctionality } from './functionality-index.js';

const tempDirs: string[] = [];

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-functionality-index-'));
  tempDirs.push(dir);
  return dir;
}

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('indexFunctionality', () => {
  it('extracts Next.js pages-router routes and API routes', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({ dependencies: { next: '^14.0.0' } }));
    write(dir, 'pages/index.tsx', 'export default function Home() { return null; }\n');
    write(dir, 'pages/checkout.tsx', 'export default function Checkout() { return null; }\n');
    write(dir, 'pages/_app.tsx', 'export default function App() { return null; }\n');
    write(dir, 'pages/api/orders.ts', 'export default function handler(req, res) { res.end(); }\n');

    const index = await indexFunctionality(dir);
    const keys = index.units.map((u) => u.key);

    expect(keys).toContain('route:/');
    expect(keys).toContain('route:/checkout');
    expect(keys).toContain('endpoint:/api/orders');
    // _app is scaffolding, not a testable route.
    expect(keys.some((k) => k.includes('_app'))).toBe(false);
  });

  it('extracts Next.js app-router pages and route handlers', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({ dependencies: { next: '^14.0.0' } }));
    write(dir, 'app/page.tsx', 'export default function Home() { return null; }\n');
    write(dir, 'app/dashboard/page.tsx', 'export default function Dashboard() { return null; }\n');
    write(dir, 'app/api/health/route.ts', 'export function GET() { return new Response("ok"); }\n');

    const index = await indexFunctionality(dir);
    const keys = index.units.map((u) => u.key);

    expect(keys).toContain('route:/');
    expect(keys).toContain('route:/dashboard');
    expect(keys).toContain('endpoint:/api/health');
  });

  it('extracts Express-style server routes', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({ dependencies: { express: '^4.0.0' } }));
    write(
      dir,
      'src/server.ts',
      "const app = express();\napp.get('/health', (req, res) => res.send('ok'));\napp.post('/orders', (req, res) => res.send('ok'));\n",
    );

    const index = await indexFunctionality(dir);
    const keys = index.units.map((u) => u.key);

    expect(keys).toContain('endpoint:GET /health');
    expect(keys).toContain('endpoint:POST /orders');
  });

  it('extracts React Router route paths when no server framework is detected', async () => {
    const dir = makeRepo();
    write(
      dir,
      'package.json',
      JSON.stringify({ dependencies: { react: '^18.0.0', 'react-router-dom': '^6.0.0' } }),
    );
    write(
      dir,
      'src/App.tsx',
      'function App() {\n  return <Routes><Route path="/settings" element={<Settings />} /></Routes>;\n}\n',
    );

    const index = await indexFunctionality(dir);
    const keys = index.units.map((u) => u.key);

    expect(keys).toContain('route:/settings');
  });

  it('dedupes repeated units and respects the maxUnits cap with a truncated flag', async () => {
    const dir = makeRepo();
    write(dir, 'package.json', JSON.stringify({ dependencies: { express: '^4.0.0' } }));
    const lines = Array.from(
      { length: 10 },
      (_, i) => `app.get('/r${i}', (req, res) => res.send('ok'));`,
    ).join('\n');
    write(dir, 'src/server.ts', `const app = express();\n${lines}\n`);

    const index = await indexFunctionality(dir, { maxUnits: 5 });

    expect(index.units.length).toBe(5);
    expect(index.truncated).toBe(true);
  });

  it('returns an empty index (not an error) for a repo with no recognizable routes', async () => {
    const dir = makeRepo();
    write(dir, 'README.md', '# just docs\n');

    const index = await indexFunctionality(dir);

    expect(index.units).toEqual([]);
    expect(index.summary).toBe('');
  });
});
