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

  it('extracts Java Spring Boot REST controllers: class-level @RequestMapping + method-level mapping annotations', () => {
    const source = `
      @RestController
      @RequestMapping("/api/todos")
      public class TodoController {

          @GetMapping
          public List<TodoResponse> listTodos(Authentication authentication) { }

          @PostMapping
          public ResponseEntity<TodoResponse> createTodo(@RequestBody TodoRequest request) { }

          @DeleteMapping("/{id}")
          public ResponseEntity<Void> deleteTodo(@PathVariable Long id) { }
      }
    `;
    const units = extractMultiLangEndpoints('TodoController.java', source);
    const keys = units.map((u) => u.key);
    // Bare @GetMapping/@PostMapping (no path) map to the class's own base path.
    expect(keys).toContain('endpoint:GET /api/todos');
    expect(keys).toContain('endpoint:POST /api/todos');
    expect(keys).toContain('endpoint:DELETE /api/todos/{id}');
  });

  it('extracts Java Spring Boot method-level @RequestMapping(method = RequestMethod.X, ...)', () => {
    const source = `
      @RestController
      @RequestMapping("/api/legacy")
      public class LegacyController {

          @RequestMapping(value = "/ping", method = RequestMethod.GET)
          public String ping() { return "pong"; }
      }
    `;
    const units = extractMultiLangEndpoints('LegacyController.java', source);
    expect(units.map((u) => u.key)).toContain('endpoint:GET /api/legacy/ping');
  });

  it('returns an empty array for a Java file with no @RestController/@Controller (a DTO/model/repository)', () => {
    const source = `
      public class TodoRequest {
          private String title;
          public String getTitle() { return title; }
      }
    `;
    expect(extractMultiLangEndpoints('TodoRequest.java', source)).toEqual([]);
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

// Root-cause regression for a real gap found via manual coverage-loop testing: a Java/Spring Boot
// backend (TODOAPP) produced ZERO functionality units, permanently disabling the coverage loop for
// it regardless of the configured target — `.java` had no extractor at all until this fix.
const TODOAPP_AUTH_CONTROLLER = path.join(
  'C:',
  'Users',
  'GarimaKhatiyan',
  'OneDrive - ZapCom Solutions Pvt. ltd',
  'Desktop',
  'TODOAPP',
  'backend',
  'src',
  'main',
  'java',
  'com',
  'healixtest',
  'todoapp',
  'controller',
  'AuthController.java',
);
const TODOAPP_TODO_CONTROLLER = path.join(path.dirname(TODOAPP_AUTH_CONTROLLER), 'TodoController.java');

describe.skipIf(!fs.existsSync(TODOAPP_AUTH_CONTROLLER))(
  'extractMultiLangEndpoints against TODOAPP/backend (isolated check, real Spring Boot fixture)',
  () => {
    it('extracts every real endpoint from AuthController.java and TodoController.java', () => {
      const authUnits = extractMultiLangEndpoints(
        'AuthController.java',
        fs.readFileSync(TODOAPP_AUTH_CONTROLLER, 'utf-8'),
      );
      const todoUnits = extractMultiLangEndpoints(
        'TodoController.java',
        fs.readFileSync(TODOAPP_TODO_CONTROLLER, 'utf-8'),
      );
      const keys = [...authUnits, ...todoUnits].map((u) => u.key);

      expect(keys).toContain('endpoint:POST /api/auth/register');
      expect(keys).toContain('endpoint:POST /api/auth/login');
      expect(keys).toContain('endpoint:GET /api/todos');
      expect(keys).toContain('endpoint:POST /api/todos');
      expect(keys).toContain('endpoint:DELETE /api/todos/{id}');
    });
  },
);
