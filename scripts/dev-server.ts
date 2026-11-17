// Local development server: the real API over a local SQLite file (same SQL as D1) plus the static screens.
//   bun run dev            -> http://localhost:8788
//   bun run dev -- --seed  -> also loads the invented demo team first
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { handleApi } from '../src/server/api.ts';
import { buildCtx } from '../src/server/context.ts';
import { openDb } from '../src/server/d1-sqlite.ts';
import { seedDemo } from '../src/server/seed.ts';
import type { Env } from '../src/server/ctx.ts';

const root = resolve(import.meta.dir, '..');
const pub = join(root, 'public');
const dataDir = join(root, '.dev-data');
mkdirSync(dataDir, { recursive: true });

function loadVars(): Record<string, string> {
  const f = join(root, '.dev.vars');
  const out: Record<string, string> = {};
  if (!existsSync(f)) return out;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2];
  }
  return out;
}

const { d1 } = openDb(join(dataDir, 'mom.sqlite'));
const port = Number(process.env.PORT || 8788);
const env: Env = { DB: d1, MOM_MODE: 'dev', SESSION_SECRET: 'dev-only-session-secret', ...loadVars() } as Env;
if (process.argv.includes('--seed')) {
  const r = await seedDemo(buildCtx(env, `http://localhost:${port}`));
  console.log(r.momIds.length ? `Seeded ${r.momIds.length} demo MOMs for ${r.users.length} people.` : 'Demo data already there.');
}

const server = Bun.serve({
  port,
  hostname: '127.0.0.1', // this server hands out sign-in codes in dev mode: it must never be reachable from the Wi-Fi/LAN
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return handleApi(buildCtx(env, req.url), req);
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(pub, rel));
    if (file !== pub && !file.startsWith(pub + sep)) return new Response('Not found', { status: 404 });
    const f = Bun.file(file);
    if (await f.exists()) return new Response(f, { headers: { 'cache-control': 'no-store' } });
    return new Response('Not found', { status: 404 });
  },
});
console.log(`MOM dev server on http://localhost:${server.port}  (mode: ${env.MOM_MODE}, database: .dev-data/mom.sqlite)`);
