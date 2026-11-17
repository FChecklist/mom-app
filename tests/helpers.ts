// Test harness: a real in-memory SQLite database with every migration applied, a controllable clock,
// and a tiny "browser" (cookie jar) that calls the real API function. No network is ever used.
import { buildCtx } from '../src/server/context.ts';
import { handleApi } from '../src/server/api.ts';
import { openDb } from '../src/server/d1-sqlite.ts';
import type { Ctx, Env } from '../src/server/ctx.ts';

export interface Res { status: number; body: any; headers: Headers; raw: Response }

export interface App {
  ctx: Ctx;
  raw: ReturnType<typeof openDb>['raw'];
  clock: { t: number };
  fetchCalls: { url: string; init?: RequestInit }[];
  /** A fresh "browser" with its own cookie jar. */
  browser(): Browser;
  outbox(to?: string): { to_addr: string; subject: string; body: string; kind: string; status: string }[];
  advance(ms: number): void;
}
export interface Browser {
  req(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Res>;
  get(path: string): Promise<Res>;
  post(path: string, body?: unknown): Promise<Res>;
  patch(path: string, body?: unknown): Promise<Res>;
  del(path: string, body?: unknown): Promise<Res>;
  cookie(): string;
  cookieOf(name: string): string;
  setCookie(c: string): void;
}

export function makeApp(env: Partial<Env> = {}, fakeFetch?: typeof fetch): App {
  const { raw, d1 } = openDb(':memory:');
  const clock = { t: Date.parse('2026-11-11T06:00:00Z') };
  const fetchCalls: App['fetchCalls'] = [];
  const f: typeof fetch = fakeFetch
    ? (async (url: any, init?: any) => { fetchCalls.push({ url: String(url), init }); return fakeFetch(url, init); }) as typeof fetch
    : (async () => { throw new Error('network is not allowed in tests'); }) as unknown as typeof fetch;
  const e: Env = { DB: d1, MOM_MODE: 'dev', SESSION_SECRET: 'test-secret-1', PUBLIC_BASE_URL: 'http://mom.test', ...env };
  const ctx = buildCtx(e, 'http://mom.test/', { now: () => new Date(clock.t), fetch: f });
  const app: App = {
    ctx, raw, clock, fetchCalls,
    advance: (ms) => { clock.t += ms; },
    outbox: (to) => raw.query(to ? 'SELECT * FROM outbox WHERE to_addr = ? ORDER BY id' : 'SELECT * FROM outbox ORDER BY id').all(...(to ? [to] : [])) as never,
    browser() {
      // A real cookie jar: several cookies, set and cleared the way a browser does.
      const jar = new Map<string, string>();
      const header = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const b: Browser = {
        async req(method, path, body, headers = {}) {
          const init: RequestInit = { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(jar.size ? { cookie: header() } : {}), ...headers } };
          if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
          const raw = await handleApi(ctx, new Request('http://mom.test' + path, init));
          for (const sc of raw.headers.getSetCookie()) {
            const pair = sc.split(';')[0]; const i = pair.indexOf('=');
            const name = pair.slice(0, i), value = pair.slice(i + 1);
            if (value === '') jar.delete(name); else jar.set(name, value);
          }
          const ct = raw.headers.get('content-type') || '';
          const clone = raw.clone();
          const parsed = ct.includes('json') ? await clone.json() : null;
          return { status: raw.status, body: parsed, headers: raw.headers, raw };
        },
        get: (p) => b.req('GET', p),
        post: (p, body = {}) => b.req('POST', p, body),
        patch: (p, body = {}) => b.req('PATCH', p, body),
        del: (p, body = {}) => b.req('DELETE', p, body),
        cookie: () => header(),
        setCookie: (c) => { jar.clear(); for (const part of c.split(';')) { const t = part.trim(); const i = t.indexOf('='); if (i > 0) jar.set(t.slice(0, i), t.slice(i + 1)); } },
        cookieOf: (name) => jar.get(name) ?? '',
      };
      return b;
    },
  };
  return app;
}

/** A production-mode app: mail goes through a fake mail provider (Resend or Cloudflare Email) (nothing is kept in the outbox body), no dev codes are returned. */
export function prodApp(env: Partial<Env> = {}): App {
  return makeApp({ MOM_MODE: 'production', PUBLIC_BASE_URL: undefined, SESSION_SECRET: 'prod-test-secret', RESEND_API_KEY: 're_test_key', MAIL_FROM: 'MOM <noreply@mom.test>', ...env }, (async () => new Response('{}', { status: 200 })) as never);
}
/** The newest 6-digit code that the fake Resend was asked to deliver to this address. */
export function sentCode(app: App, to: string): string {
  for (const c of [...app.fetchCalls].reverse()) {
    const b = JSON.parse(String(c.init?.body ?? '{}'));
    if (b.to?.[0] === to) { const m = /code is (\d{6})/.exec(b.text); if (m) return m[1]; }
  }
  throw new Error('no code was sent to ' + to);
}
/** Sign in through the real flow on a production-mode app. */
export async function prodSignIn(app: App, email: string, name = 'Test Person', team = 'Test team'): Promise<Browser> {
  const b = app.browser();
  const s = await b.post('/api/auth/start', { email, name, team });
  if (s.status !== 200) throw new Error('start failed: ' + JSON.stringify(s.body));
  const v = await b.post('/api/auth/verify', { email, code: sentCode(app, email) });
  if (v.status !== 200) throw new Error('verify failed: ' + JSON.stringify(v.body));
  return b;
}

/** Sign up (or sign in) through the real e-mail-code flow. */
export async function signIn(app: App, email: string, name = 'Test Person', team = 'Test team'): Promise<Browser> {
  const b = app.browser();
  const s = await b.post('/api/auth/start', { email, name, team });
  if (s.status !== 200) throw new Error('start failed: ' + JSON.stringify(s.body));
  const v = await b.post('/api/auth/verify', { email, code: s.body.devCode });
  if (v.status !== 200) throw new Error('verify failed: ' + JSON.stringify(v.body));
  return b;
}

export const today = (app: App, plusDays = 0) => new Date(app.clock.t + plusDays * 86400000).toISOString().slice(0, 10);

/** Owner "ann" plus a signed-in browser, ready to build MOMs. */
export async function owner(app: App, email = 'ann@team.test') {
  return signIn(app, email, 'Ann Owner', 'Ann team');
}

/** Creates a MOM with points through the API. Returns ids. */
export async function seedMom(app: App, b: Browser, opts: { title?: string; attendees?: string[]; points?: { title: string; owners: string[]; status?: string; due?: string }[]; publish?: boolean; notes?: string } = {}) {
  const r = await b.post('/api/moms', { title: opts.title ?? 'Weekly meeting', date: today(app), venue: 'Room 1', notes: opts.notes ?? 'Some notes', attendees: opts.attendees ?? [] });
  if (r.status !== 201) throw new Error('create mom failed ' + JSON.stringify(r.body));
  const id = r.body.id as string;
  const pointIds: string[] = [];
  for (const p of opts.points ?? [{ title: 'First point', owners: ['ann@team.test'] }]) {
    const pr = await b.post(`/api/moms/${id}/points`, { due: today(app, 7), ...p });
    if (pr.status !== 201) throw new Error('add point failed ' + JSON.stringify(pr.body));
    pointIds.push(pr.body.id);
  }
  if (opts.publish) {
    const pub = await b.post(`/api/moms/${id}/publish`);
    if (pub.status !== 200) throw new Error('publish failed ' + JSON.stringify(pub.body));
  }
  return { id, pointIds };
}
