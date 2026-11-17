import { describe, expect, test } from 'bun:test';
import { makeApp, owner, prodApp, prodSignIn, sentCode, signIn } from './helpers.ts';

describe('sign up and sign in with an e-mail code', () => {
  test('a new address creates a team with a 14-day trial; the owner is verified', async () => {
    const app = makeApp();
    const b = await signIn(app, 'asha@sunrise.test', 'Asha Verma', 'Sunrise Residents');
    const st = await b.get('/api/state');
    expect(st.status).toBe(200);
    expect(st.body.me).toBe('asha@sunrise.test');
    expect(st.body.org.name).toBe('Sunrise Residents');
    expect(st.body.org.isOwner).toBe(true);
    expect(st.body.org.plan).toBe('trial');
    expect(st.body.users[0]).toMatchObject({ name: 'Asha Verma', verified: true, owner: true });
    const days = (Date.parse(st.body.org.trialEndsAt) - app.clock.t) / 86400000;
    expect(days).toBe(14);
  });

  test('the code is e-mailed (recorded), stored only as a hash, and works once', async () => {
    const app = makeApp();
    const b = app.browser();
    const s = await b.post('/api/auth/start', { email: 'Ravi@Sunrise.test' });
    expect(s.body.sent).toBe(true);
    const mail = app.outbox('ravi@sunrise.test');
    expect(mail.length).toBe(1);
    expect(mail[0].body).toContain(s.body.devCode);
    const stored = app.raw.query('SELECT code_hash FROM auth_codes').get() as { code_hash: string };
    expect(stored.code_hash).not.toContain(s.body.devCode);
    expect((await b.post('/api/auth/verify', { email: 'ravi@sunrise.test', code: s.body.devCode })).status).toBe(200);
    const again = await app.browser().post('/api/auth/verify', { email: 'ravi@sunrise.test', code: s.body.devCode });
    expect(again.status).toBe(400);
  });

  test('wrong codes are refused and five wrong tries lock that code', async () => {
    const app = makeApp();
    const b = app.browser();
    const s = await b.post('/api/auth/start', { email: 'kabir@sunrise.test' });
    const wrong = s.body.devCode === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await b.post('/api/auth/verify', { email: 'kabir@sunrise.test', code: wrong })).body.error.code).toBe('BAD_CODE');
    const locked = await b.post('/api/auth/verify', { email: 'kabir@sunrise.test', code: s.body.devCode });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });

  test('a code expires after 10 minutes', async () => {
    const app = makeApp();
    const b = app.browser();
    const s = await b.post('/api/auth/start', { email: 'meera@sunrise.test' });
    app.advance(11 * 60_000);
    const r = await b.post('/api/auth/verify', { email: 'meera@sunrise.test', code: s.body.devCode });
    expect(r.body.error.code).toBe('CODE_EXPIRED');
  });

  test('no more than 5 codes per hour per address', async () => {
    const app = makeApp();
    const b = app.browser();
    for (let i = 0; i < 5; i++) expect((await b.post('/api/auth/start', { email: 'spam@sunrise.test' })).status).toBe(200);
    const r = await b.post('/api/auth/start', { email: 'spam@sunrise.test' });
    expect(r.status).toBe(429);
    app.advance(61 * 60_000);
    expect((await b.post('/api/auth/start', { email: 'spam@sunrise.test' })).status).toBe(200);
  });

  test('mobile numbers and broken addresses are refused with a gentle message', async () => {
    const app = makeApp();
    const b = app.browser();
    const m = await b.post('/api/auth/start', { email: '+91 98765 43210' });
    expect(m.status).toBe(400);
    expect(m.body.error.code).toBe('EMAIL_ONLY');
    expect(m.body.error.message).toContain('e-mail');
    expect((await b.post('/api/auth/start', { email: 'nope' })).body.error.code).toBe('BAD_EMAIL');
  });

  test('a returning user gets the same answer (no way to find out who has an account)', async () => {
    const app = makeApp();
    await signIn(app, 'asha@sunrise.test');
    const a = await app.browser().post('/api/auth/start', { email: 'asha@sunrise.test' });
    const n = await app.browser().post('/api/auth/start', { email: 'new@sunrise.test' });
    expect(Object.keys(a.body).sort()).toEqual(Object.keys(n.body).sort());
    expect(a.status).toBe(n.status);
  });

  test('the dev code is never returned in production mode', async () => {
    const app = prodApp();
    const s = await app.browser().post('/api/auth/start', { email: 'asha@sunrise.test' });
    expect(s.status).toBe(200);
    expect(s.body.devCode).toBeUndefined();
    expect((await app.browser().get('/api/dev/outbox')).status).toBe(404);
  });

  test('production refuses to run without SESSION_SECRET', async () => {
    const app = makeApp({ MOM_MODE: 'production', SESSION_SECRET: undefined });
    const s = await app.browser().post('/api/auth/start', { email: 'asha@sunrise.test' });
    expect(s.status).toBe(500);
    expect(s.body.error.code).toBe('CONFIG');
  });
});

describe('sessions', () => {
  test('no cookie means 401; the cookie is HttpOnly and SameSite; logout ends the session', async () => {
    const app = makeApp();
    expect((await app.browser().get('/api/state')).status).toBe(401);
    const b = app.browser();
    const s = await b.post('/api/auth/start', { email: 'asha@sunrise.test' });
    const v = await b.post('/api/auth/verify', { email: 'asha@sunrise.test', code: s.body.devCode });
    const sc = v.headers.get('set-cookie')!;
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('SameSite=Lax');
    expect(sc).not.toContain('Secure'); // http base URL in tests
    const token = b.cookie().split('=')[1];
    const row = app.raw.query('SELECT token_hash FROM sessions').get() as { token_hash: string };
    expect(row.token_hash).not.toBe(token); // only a hash is stored
    expect((await b.get('/api/state')).status).toBe(200);
    const saved = b.cookie();
    await b.post('/api/auth/logout');
    const old = app.browser();
    old.setCookie(saved);
    expect((await old.get('/api/state')).status).toBe(401);
  });

  test('over https the cookie is Secure', async () => {
    const app = makeApp({ PUBLIC_BASE_URL: 'https://mom.veridian-aios.com' });
    const b = app.browser();
    const s = await b.post('/api/auth/start', { email: 'asha@sunrise.test' });
    const v = await b.post('/api/auth/verify', { email: 'asha@sunrise.test', code: s.body.devCode });
    expect(v.headers.get('set-cookie')).toContain('Secure');
  });

  test('a session expires after 30 days', async () => {
    const app = makeApp();
    const b = await owner(app);
    app.advance(29 * 86400000);
    expect((await b.get('/api/state')).status).toBe(200);
    app.advance(2 * 86400000);
    expect((await b.get('/api/state')).status).toBe(401);
  });

  test('a forged or garbage cookie is simply "not signed in"', async () => {
    const app = makeApp();
    const b = app.browser();
    b.setCookie('mom_session=not-a-real-token');
    expect((await b.get('/api/state')).status).toBe(401);
  });

  test('writes from another website are blocked (Origin check)', async () => {
    const app = makeApp();
    const b = await owner(app);
    const r = await b.req('POST', '/api/moms', { title: 'x', date: '2026-11-11' }, { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('BAD_ORIGIN');
    const ok = await b.req('POST', '/api/moms', { title: 'x', date: '2026-11-11' }, { origin: 'http://mom.test' });
    expect(ok.status).toBe(201);
  });
});

describe('teams', () => {
  test('an invited teammate signs in with their own code and lands in the same team', async () => {
    const app = makeApp();
    const ann = await owner(app);
    expect((await ann.post('/api/team/members', { email: 'bob@team.test', name: 'Bob B' })).status).toBe(200);
    expect(app.outbox('bob@team.test')[0].subject).toContain('invited');
    expect((await ann.get('/api/state')).body.users.find((u: any) => u.email === 'bob@team.test')).toMatchObject({ verified: false, role: 'Invited' }); // an invite, not an account
    expect(app.raw.query("SELECT COUNT(*) AS n FROM users WHERE email = 'bob@team.test'").get()).toEqual({ n: 0 });
    const bob = await signIn(app, 'bob@team.test');
    const st = await bob.get('/api/state');
    expect(st.body.org.name).toBe('Ann team');
    expect(st.body.org.isOwner).toBe(false);
    expect(st.body.users.map((u: any) => u.email).sort()).toEqual(['ann@team.test', 'bob@team.test']);
    expect(st.body.users.find((u: any) => u.email === 'bob@team.test').name).toBe('Bob B');
  });

  test('only the owner can add teammates; duplicates and a full team are explained', async () => {
    const app = makeApp();
    const ann = await owner(app);
    await ann.post('/api/team/members', { email: 'bob@team.test' });
    const bob = await signIn(app, 'bob@team.test');
    expect((await bob.post('/api/team/members', { email: 'cy@team.test' })).status).toBe(403);
    expect((await ann.post('/api/team/members', { email: 'bob@team.test' })).body.error.code).toBe('ALREADY_MEMBER');
    for (let i = 3; i <= 10; i++) expect((await ann.post('/api/team/members', { email: `u${i}@team.test` })).status).toBe(200);
    const full = await ann.post('/api/team/members', { email: 'eleven@team.test' });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('TEAM_FULL');
  });

  test('an address that already belongs to another team cannot be added', async () => {
    const app = makeApp();
    const ann = await owner(app);
    await signIn(app, 'zed@other.test', 'Zed', 'Other team');
    // The answer is exactly the same as for a brand-new address: no way to find out who has an account elsewhere.
    const r = await ann.post('/api/team/members', { email: 'zed@other.test' });
    const fresh = await ann.post('/api/team/members', { email: 'new@other.test' });
    expect(r.status).toBe(fresh.status);
    expect(r.body).toEqual(fresh.body);
    // ... and Zed is not moved or squatted: he is still alone in his own team and can still use it.
    const zed = await signIn(app, 'zed@other.test');
    const st = await zed.get('/api/state');
    expect(st.body.org.name).toBe('Other team');
    expect(st.body.org.isOwner).toBe(true);
    expect(st.body.users.map((u: any) => u.email)).toEqual(['zed@other.test']);
  });
});
