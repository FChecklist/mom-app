// D1-compatible wrapper over bun:sqlite. Used by tests, the seed script and the local dev server only.
// Production uses the real Cloudflare D1 binding, which has the same tiny surface (Stmt / D1Like).
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { D1Like, Stmt } from './ctx.ts';

class SqliteStmt implements Stmt {
  constructor(private db: Database, readonly q: string, readonly params: unknown[] = []) {}
  bind(...v: unknown[]): Stmt {
    return new SqliteStmt(this.db, this.q, v.map((x) => (x === undefined ? null : x)));
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return ((this.db.query(this.q).get(...(this.params as never[])) as T | null) ?? null);
  }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: this.db.query(this.q).all(...(this.params as never[])) as T[] };
  }
  async run(): Promise<{ meta: { changes: number } }> {
    const r = this.db.query(this.q).run(...(this.params as never[]));
    return { meta: { changes: r.changes } };
  }
  runSync() {
    return this.db.query(this.q).run(...(this.params as never[]));
  }
}

export function sqliteD1(db: Database): D1Like {
  db.exec('PRAGMA foreign_keys = ON');
  return {
    prepare: (q: string) => new SqliteStmt(db, q),
    // D1 batch() is atomic: either every statement lands or none does.
    async batch(stmts: Stmt[]) {
      db.exec('BEGIN');
      try {
        const out: { meta: { changes: number } }[] = [];
        for (const s of stmts) out.push({ meta: { changes: (s as SqliteStmt).runSync().changes } });
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

export function migrationFiles(dir = join(import.meta.dir, '..', '..', 'migrations')): { name: string; sql: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: f, sql: readFileSync(join(dir, f), 'utf8') }));
}

/** Open (or create) a SQLite database and apply every migration that has not been applied yet. */
export function openDb(path = ':memory:'): { raw: Database; d1: D1Like } {
  const raw = new Database(path);
  raw.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set((raw.query('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name));
  for (const m of migrationFiles()) {
    if (done.has(m.name)) continue;
    raw.exec(m.sql);
    raw.query('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(m.name, new Date().toISOString());
  }
  return { raw, d1: sqliteD1(raw) };
}
