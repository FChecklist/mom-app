import { describe, expect, test } from 'bun:test';
import { makeApp, owner, prodApp, prodSignIn, seedMom, today } from './helpers.ts';

const ANN = 'ann@team.test';

describe('calendars in mock mode (no credentials)', () => {
  test('both providers are listed as mock and not connected', async () => {
    const app = makeApp();
    const ann = await owner(app);
    const r = await ann.get('/api/integrations');
    expect(r.body.providers).toEqual([
      expect.objectContaining({ id: 'google', mode: 'mock', connected: false }),
      expect.objectContaining({ id: 'microsoft', mode: 'mock', connected: false }),
    ]);
  });

  test('connect, add a point to the calendar, and disconnect - without any network call', async () => {
    const app = makeApp();
    const ann = await owner(app);
    const { pointIds: [p] } = await seedMom(app, ann);
    expect((await ann.post(`/api/points/${p}/calendar`, { provider: 'google' })).body.error.code).toBe('NOT_CONNECTED');
    expect((await ann.post('/api/integrations/google/connect')).body).toEqual({ mode: 'mock', connected: true });
    expect((await ann.get('/api/integrations')).body.providers[0]).toMatchObject({ connected: true, account: ANN });
    const add = await ann.post(`/api/points/${p}/calendar`, { provider: 'google' });
    expect(add.status).toBe(200);
    expect(add.body.externalId).toStartWith('mock_google_');
    const again = await ann.post(`/api/points/${p}/calendar`, { provider: 'google' });
    expect(again.body).toMatchObject({ already: true, externalId: add.body.externalId }); // never doubled
    expect((app.raw.query('SELECT COUNT(*) AS n FROM calendar_events').get() as any).n).toBe(1);
    await ann.del('/api/integrations/google');
    expect((await ann.get('/api/integrations')).body.providers[0].connected).toBe(false);
    expect(app.fetchCalls.length).toBe(0);
  });

  test('Microsoft works the same way; unknown providers and points without a due date are explained', async () => {
    const app = makeApp();
    const ann = await owner(app);
    const { id } = await seedMom(app, ann);
    const nodue = await ann.post(`/api/moms/${id}/points`, { title: 'No date', owners: [ANN] });
    await ann.post('/api/integrations/microsoft/connect');
    expect((await ann.post(`/api/points/${nodue.body.id}/calendar`, { provider: 'microsoft' })).body.error.code).toBe('NO_DUE_DATE');
    expect((await ann.post('/api/integrations/yahoo/connect')).status).toBe(404);
    expect((await ann.post(`/api/points/${nodue.body.id}/calendar`, { provider: 'yahoo' })).status).toBe(404);
  });

  test('only the people responsible (or the team owner) can put a point on their calendar', async () => {
    const app = makeApp();
    const ann = await owner(app);
    await ann.post('/api/team/members', { email: 'bob@team.test' });
    const { signIn } = await import('./helpers.ts');
    const bob = await signIn(app, 'bob@team.test');
    const { pointIds: [p] } = await seedMom(app, ann, { attendees: ['bob@team.test'], publish: true });
    await bob.post('/api/integrations/google/connect');
    expect((await bob.post(`/api/points/${p}/calendar`, { provider: 'google' })).status).toBe(403);
  });
});

describe('calendars in live mode (fake Google / Microsoft servers)', () => {
  const env = { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec', MS_CLIENT_ID: 'mid', MS_CLIENT_SECRET: 'msec', TOKEN_ENC_KEY: 'enc-key-1' };
  const fake = (async (url: any, init?: any) => {
    const u = String(url);
    if (u === 'https://oauth2.googleapis.com/token') {
      const p = new URLSearchParams(String(init.body));
      return Response.json(p.get('grant_type') === 'authorization_code' ? { access_token: 'ga', refresh_token: 'g-refresh-secret' } : { access_token: 'ga2' });
    }
    if (u.startsWith('https://openidconnect.googleapis.com')) return Response.json({ email: 'ann@gmail.test' });
    if (u.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events')) {
      const b = JSON.parse(init.body);
      expect(b.start).toEqual({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
      expect(init.headers.authorization).toBe('Bearer ga2');
      return Response.json({ id: 'g_evt_1' });
    }
    if (u.endsWith('/oauth2/v2.0/token')) {
      const p = new URLSearchParams(String(init.body));
      return Response.json(p.get('grant_type') === 'authorization_code' ? { access_token: 'ma', refresh_token: 'm-refresh-secret' } : { access_token: 'ma2' });
    }
    if (u === 'https://graph.microsoft.com/v1.0/me') return Response.json({ mail: 'ann@outlook.test' });
    if (u === 'https://graph.microsoft.com/v1.0/me/events') {
      const b = JSON.parse(init.body);
      expect(b.isAllDay).toBe(true);
      return Response.json({ id: 'm_evt_1' });
    }
    throw new Error('unexpected url ' + u);
  }) as any;

  test('Google: the sign-in address, the signed state, the callback, an encrypted token, and the event', async () => {
    const app = makeApp(env, fake);
    const ann = await owner(app);
    const { pointIds: [p] } = await seedMom(app, ann);
    expect((await ann.get('/api/integrations')).body.providers[0].mode).toBe('live');
    const c = await ann.post('/api/integrations/google/connect');
    expect(c.body.mode).toBe('live');
    const u = new URL(c.body.url);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('scope')).toContain('calendar.events');
    expect(u.searchParams.get('scope')).not.toContain('gmail'); // calendar only
    expect(u.searchParams.get('redirect_uri')).toBe('http://mom.test/api/integrations/google/callback');
    const state = u.searchParams.get('state')!;

    // a tampered state, or someone else's browser, is refused
    const bad = await ann.get(`/api/integrations/google/callback?code=abc&state=${encodeURIComponent(state.replace(/.$/, 'x'))}`);
    expect(bad.status).toBe(302);
    expect(bad.headers.get('location')).toContain('err=');
    expect((app.raw.query('SELECT COUNT(*) AS n FROM integrations').get() as any).n).toBe(0);

    const ok = await ann.get(`/api/integrations/google/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('http://mom.test/#/integrations');
    const row = app.raw.query('SELECT * FROM integrations').get() as any;
    expect(row).toMatchObject({ provider: 'google', mode: 'live', account: 'ann@gmail.test' });
    expect(row.token_enc).not.toContain('g-refresh-secret'); // encrypted at rest

    const add = await ann.post(`/api/points/${p}/calendar`, { provider: 'google' });
    expect(add.body).toMatchObject({ externalId: 'g_evt_1', mode: 'live' });
  });

  test('Microsoft: connect and create an all-day event', async () => {
    const app = makeApp(env, fake);
    const ann = await owner(app);
    const { pointIds: [p] } = await seedMom(app, ann);
    const c = await ann.post('/api/integrations/microsoft/connect');
    expect(new URL(c.body.url).hostname).toBe('login.microsoftonline.com');
    const state = new URL(c.body.url).searchParams.get('state')!;
    await ann.get(`/api/integrations/microsoft/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect((await ann.post(`/api/points/${p}/calendar`, { provider: 'microsoft' })).body.externalId).toBe('m_evt_1');
  });

  test('a state made for one user cannot be used by another', async () => {
    const app = makeApp(env, fake);
    const ann = await owner(app);
    const { signIn } = await import('./helpers.ts');
    await ann.post('/api/team/members', { email: 'bob@team.test' });
    const bob = await signIn(app, 'bob@team.test');
    const state = new URL((await ann.post('/api/integrations/google/connect')).body.url).searchParams.get('state')!;
    const r = await bob.get(`/api/integrations/google/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(r.headers.get('location')).toContain('err=');
    expect((app.raw.query('SELECT COUNT(*) AS n FROM integrations').get() as any).n).toBe(0);
  });

  test('an expired state is refused', async () => {
    const app = makeApp(env, fake);
    const ann = await owner(app);
    const state = new URL((await ann.post('/api/integrations/google/connect')).body.url).searchParams.get('state')!;
    app.advance(11 * 60_000);
    const r = await ann.get(`/api/integrations/google/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(r.headers.get('location')).toContain('err=');
  });

  test('live connections need an encryption key in production', async () => {
    const app = prodApp({ ...env, TOKEN_ENC_KEY: undefined });
    const b = await prodSignIn(app, ann());
    const state = new URL((await b.post('/api/integrations/google/connect')).body.url).searchParams.get('state')!;
    const r = await b.get(`/api/integrations/google/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(r.headers.get('location')).toContain('err=');
    function ann() { return 'ann@team.test'; }
  });
});

test('today helper is stable', () => {
  expect(today(makeApp())).toBe('2026-11-11');
});
