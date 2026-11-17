// Cheap consistency checks on the browser scripts (no browser needed):
// every data-act used in app.js has a handler, the file parses, and the status table matches the server's.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATUSES, allowedNext } from '../src/server/core/status.ts';

const pub = join(import.meta.dir, '..', 'public');
const app = readFileSync(join(pub, 'app.js'), 'utf8');
const util = readFileSync(join(pub, 'util.js'), 'utf8');

describe('client scripts', () => {
  test('app.js and util.js parse', () => {
    expect(() => new Function(app)).not.toThrow();
    expect(() => new Function(util)).not.toThrow();
  });

  test('every data-act in app.js has a handler A[...]', () => {
    const used = new Set<string>();
    for (const m of app.matchAll(/data-act="([a-z-]+)"/g)) used.add(m[1]);
    for (const m of app.matchAll(/'data-act', '([a-z-]+)'/g)) used.add(m[1]);
    const handled = new Set<string>();
    for (const m of app.matchAll(/A\['([a-z-]+)'\]\s*=/g)) handled.add(m[1]);
    for (const m of app.matchAll(/\bA\.([a-z]+)\s*=/g)) handled.add(m[1]);
    const missing = [...used].filter((u) => !handled.has(u));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(30);
  });

  test('every API path the client calls exists on the server', () => {
    const paths = new Set<string>();
    for (const m of app.matchAll(/api\('(?:GET|POST|PATCH|DELETE)', '(\/api\/[a-z/-]*)/g)) paths.add(m[1].replace(/\/$/, ''));
    expect(paths.size).toBeGreaterThan(10);
    const server = readFileSync(join(import.meta.dir, '..', 'src', 'server', 'api.ts'), 'utf8');
    for (const p of paths) {
      const seg = p.split('/').filter(Boolean).slice(1, 2)[0]; // first segment after /api
      expect(server.includes(seg!)).toBe(true);
    }
  });

  test('client status moves equal the server table', () => {
    const body = /var NEXT = (\{[^}]*\})/.exec(util)![1]!;
    const client = new Function('return ' + body)() as Record<string, string[]>;
    const server: Record<string, string[]> = {};
    for (const k of STATUSES) server[k] = [...allowedNext(k)];
    for (const k of Object.keys(server)) expect([...client[k]!].sort()).toEqual([...server[k]!].sort());
  });

  test('app.js keeps the 30% claim as an aim with a footnote', () => {
    expect(app).toContain('Aim to increase');
    expect(app).toContain('*Target, results vary.');
  });
});
