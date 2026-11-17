// Build for Cloudflare Pages: copy public/ to dist/ and tell Pages which paths are Functions.
// (functions/ at the project root is compiled by `wrangler pages deploy dist` itself.)
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(join(root, 'public'), dist, { recursive: true });
writeFileSync(join(dist, '_routes.json'), JSON.stringify({ version: 1, include: ['/api/*'], exclude: [] }, null, 2));
console.log('Built dist/ (static screens + _routes.json). API = functions/api/[[path]].ts');
