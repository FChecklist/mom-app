// Loads the invented demo team (Sunrise Residents) into the local dev database.
//   bun run seed   -> .dev-data/mom.sqlite   (local only: never run against the production database)
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildCtx } from '../src/server/context.ts';
import { openDb } from '../src/server/d1-sqlite.ts';
import { seedDemo } from '../src/server/seed.ts';
import type { Env } from '../src/server/ctx.ts';

const dir = join(resolve(import.meta.dir, '..'), '.dev-data');
mkdirSync(dir, { recursive: true });
const { d1 } = openDb(join(dir, 'mom.sqlite'));
const env = { DB: d1, MOM_MODE: 'dev', SESSION_SECRET: 'dev-only-session-secret', PUBLIC_BASE_URL: 'http://localhost:8788' } as Env;
const r = await seedDemo(buildCtx(env));
console.log(r.momIds.length ? `Seeded ${r.momIds.length} MOMs for: ${r.users.join(', ')}` : 'Demo data was already there; nothing changed.');
