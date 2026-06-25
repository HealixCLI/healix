// Minimal ambient declaration for the experimental built-in (Node >= 22.5).
// Keeps tsc resolution stable regardless of @types/node coverage.
declare module 'node:sqlite' {
  export interface StatementSync {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  }
  export class DatabaseSync {
    constructor(path: string, options?: Record<string, unknown>);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
