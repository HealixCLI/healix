import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractDjango, extractMultiLangEndpoints } from './multilang.js';

describe('extractMultiLangEndpoints', () => {
  it('extracts Flask @app.route decorators, defaulting to GET with no methods=', () => {
    const source = `
      @app.route("/")
      def hello():
          return "hi"

      @app.route("/add", methods=['POST', 'GET'])
      def add():
          pass
    `;
    const units = extractMultiLangEndpoints('app.py', source);
    const keys = units.map((u) => u.key);
    expect(keys).toContain('endpoint:GET /');
    expect(keys).toContain('endpoint:POST /add');
    expect(keys).toContain('endpoint:GET /add');
  });

  it('extracts FastAPI-style @app.get/@app.post shorthand decorators', () => {
    const source = `
      @app.get("/items")
      def list_items():
          pass

      @app.post("/items")
      def create_item():
          pass
    `;
    const units = extractMultiLangEndpoints('main.py', source);
    expect(units.map((u) => u.key)).toEqual(
      expect.arrayContaining(['endpoint:GET /items', 'endpoint:POST /items']),
    );
  });

  it('extracts Go net/http and gin-style router methods', () => {
    const source = `
      http.HandleFunc("/health", healthHandler)
      router.GET("/users/:id", getUser)
      router.POST("/users", createUser)
    `;
    const units = extractMultiLangEndpoints('main.go', source);
    const keys = units.map((u) => u.key);
    expect(keys).toContain('endpoint:GET /health');
    expect(keys).toContain('endpoint:GET /users/:id');
    expect(keys).toContain('endpoint:POST /users');
  });

  it('extracts Ruby Rails/Sinatra-style route declarations', () => {
    const source = `
      get '/dashboard', to: 'dashboard#index'
      post '/orders', to: 'orders#create'
    `;
    const units = extractMultiLangEndpoints('routes.rb', source);
    const keys = units.map((u) => u.key);
    expect(keys).toContain('endpoint:GET /dashboard');
    expect(keys).toContain('endpoint:POST /orders');
  });

  it('extracts PHP Laravel Route:: declarations', () => {
    const source = `Route::get('/users', [UserController::class, 'index']);`;
    const units = extractMultiLangEndpoints('web.php', source);
    expect(units.map((u) => u.key)).toContain('endpoint:GET /users');
  });

  it('returns an empty array for an unrecognized extension', () => {
    expect(extractMultiLangEndpoints('README.md', '@app.route("/x")')).toEqual([]);
  });
});

describe('extractDjango', () => {
  it('extracts path()/re_path() route declarations from urls.py', () => {
    const source = `
      urlpatterns = [
          path('orders/', views.order_list),
          re_path(r'^users/(?P<id>\\d+)/$', views.user_detail),
      ]
    `;
    const units = extractDjango('urls.py', source);
    const keys = units.map((u) => u.key);
    expect(keys).toContain('endpoint:GET /orders/');
  });
});

// --- Isolated check against a real fixture repo (Item B6) ------------------

const FLASK_APP_PY = path.join(
  'C:',
  'Users',
  'AdroyFernandes',
  'Documents',
  'TestApps',
  'Flask-CRUD-Application',
  'app.py',
);

describe.skipIf(!fs.existsSync(FLASK_APP_PY))(
  'extractMultiLangEndpoints against Flask-CRUD-Application/app.py (isolated check)',
  () => {
    it('extracts every real Flask route in the fixture, with correct methods', () => {
      const source = fs.readFileSync(FLASK_APP_PY, 'utf-8');
      const units = extractMultiLangEndpoints('app.py', source);
      const keys = units.map((u) => u.key);

      // Real routes in the fixture: "/" (GET, no methods= given), "/add" (POST+GET),
      // "/delete/<int:id>" (GET, no methods= given), "/update/<int:id>" (POST+GET).
      expect(keys).toContain('endpoint:GET /');
      expect(keys).toContain('endpoint:POST /add');
      expect(keys).toContain('endpoint:GET /add');
      expect(keys).toContain('endpoint:GET /delete/<int:id>');
      expect(keys).toContain('endpoint:POST /update/<int:id>');
      expect(keys).toContain('endpoint:GET /update/<int:id>');
    });
  },
);
