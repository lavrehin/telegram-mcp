/**
 * Just enough of D1's API over bun:sqlite to run the store against a real
 * SQLite engine in tests: prepare/bind/first/all/run and transactional batch.
 * Like D1, it refuses `undefined` bindings — the bug that would only show up
 * in production otherwise.
 */

import { Database } from "bun:sqlite";

type Value = string | number | bigint | boolean | null | Uint8Array;

function returnsRows(sql: string): boolean {
  return /^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql);
}

class Statement {
  constructor(
    private readonly db: Database,
    readonly sql: string,
    readonly values: Value[] = [],
  ) {}

  bind(...values: unknown[]): Statement {
    for (const [index, value] of values.entries()) {
      if (value === undefined) {
        throw new Error(`D1_TYPE_ERROR: undefined bound at position ${index + 1} in: ${this.sql}`);
      }
    }
    return new Statement(this.db, this.sql, values as Value[]);
  }

  execute(): { results: unknown[]; meta: { changes: number } } {
    const query = this.db.query(this.sql);
    if (returnsRows(this.sql)) {
      const results = query.all(...this.values);
      const changes = (this.db.query("SELECT changes() AS n").get() as { n: number }).n;
      return { results, meta: { changes: /^\s*select/i.test(this.sql) ? 0 : changes } };
    }
    const { changes } = query.run(...this.values);
    return { results: [], meta: { changes } };
  }

  // Async, like D1: a bad statement rejects rather than throwing synchronously.
  async first<T>(): Promise<T | null> {
    await Promise.resolve();
    return (this.execute().results[0] as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[]; meta: { changes: number } }> {
    await Promise.resolve();
    const { results, meta } = this.execute();
    return { results: results as T[], meta };
  }

  async run(): Promise<{ results: unknown[]; meta: { changes: number } }> {
    await Promise.resolve();
    return this.execute();
  }
}

export class SqliteD1 {
  readonly raw = new Database(":memory:");

  prepare(sql: string): Statement {
    return new Statement(this.raw, sql);
  }

  async batch(
    statements: Statement[],
  ): Promise<{ results: unknown[]; meta: { changes: number } }[]> {
    await Promise.resolve();
    const run = this.raw.transaction(() => statements.map((statement) => statement.execute()));
    return run();
  }

  exec(sql: string): Promise<void> {
    this.raw.exec(sql);
    return Promise.resolve();
  }

  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}
