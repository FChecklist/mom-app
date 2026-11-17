// Regression tests for the independent review (round 1): every blocker and major finding, each with the exact
// scenario the reviewer reproduced. Each test fails on the old code and passes on the fixed code.
import { describe, expect, test } from 'bun:test';
import { housekeeping } from '../src/server/services/guard.ts';
import { secret } from '../src/server/services/auth.ts';
import { hmacHex } from '../src/server/util.ts';
import { makeApp, owner, prodApp, prodSignIn, seedMom, sentCode, signIn, today } from './helpers.ts';

const ANN = 'ann@team.test', BOB = 'bob@team.test';
const tokenOf = (link: string) => link.split('/#/shared/')[1];

async function team(env: Record<string, string> = {}) {
  const app = makeApp(env);
  const ann = await owner(app);
  await ann.post('/api/team/members', { email: BOB });
  const bob = await signIn(app, BOB);
  return { app, ann, bob };
}
const one = (app: any, q: string, ...p: unknown[]) => app.raw.query(q).get(...p) as any;

describe('R1 e-mail fails closed instead of pretending', () => {
  test('production without a mail key: no code is "sent", the user is told so, and /api/config says mail is not ready', async () => {
    const app = prodApp({ RESEND_API_KEY: undefined });
    const b = app.browser();
    const r = await b.post('/api/auth/start', { email: 'ann@team.test', name: 'Ann', team: 'T' });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('MAIL_UNAVAILABLE');
    expect(r.body.sent).toBeUndefined();
    expect(r.body.devCode).toBeUndefined();
    expect(one(app, "SELECT status FROM outbox").status).toBe('failed');
    expect(one(app, 'SELECT used FROM auth_codes').used).toBe(2); // retired, and it does not count towards the hourly limit
    const cfg = (await b.get('/api/config')).body;
    expect(cfg.mail).toMatchObject({ provider: 'mock', ready: false });
    // a configured deployment says ready
    expect((await prodApp().browser().get('/api/config')).body.mail).toMatchObject({ provider: 'resend', ready: true });
  });

  test('when the daily code budget is used up the answer is 503, not {sent:true}', async () => {
    const app = prodApp({ MAIL_DAILY_CAP: '3', CODE_DAILY_CAP: '1' });
    expect((await app.browser().post('/api/auth/start', { email: 'a1@x.test' })).status).toBe(200);
    const r = await app.browser().post('/api/auth/start', { email: 'a2@x.test' });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('MAIL_UNAVAILABLE');
    // the failed attempt does not burn the person's hourly allowance
    expect(one(app, "SELECT COUNT(*) AS n FROM auth_codes WHERE email = 'a2@x.test' AND used != 2").n).toBe(0);
  });

  test('the same for a share code and for a share by e-mail: nothing is shared if nothing was sent', async () => {
    let up = true;
    const app = makeApp({ MOM_MODE: 'production', PUBLIC_BASE_URL: undefined, SESSION_SECRET: 's', RESEND_API_KEY: 're_test_key_1234', MAIL_FROM: 'MOM <noreply@mom.test>' }, (async () => new Response('{}', { status: up ? 200 : 500 })) as never);
    const ann = await prodSignIn(app, ANN, 'Ann', 'T');
    const { id } = await seedMom(app, ann, { publish: true });
    up = false;
    const r = await ann.post(`/api/moms/${id}/shares`, { via: 'email', to: 'priya@out.test' });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('MAIL_UNAVAILABLE');
    expect(one(app, "SELECT COUNT(*) AS n FROM events WHERE type = 'share'").n).toBe(0); // the chain log never claims a share that did not happen
    expect(one(app, 'SELECT revoked_at FROM shares').revoked_at).not.toBeNull(); // and the link is dead
    // a link share needs no mail and still works
    expect((await ann.post(`/api/moms/${id}/shares`, { via: 'link' })).status).toBe(201);
  });
});

describe('R2 paying and extending the plan is one atomic step', () => {
  test('a failure between "mark paid" and "extend plan" leaves nothing half-done, and the retry succeeds', async () => {
    const app = makeApp();
    const ann = await owner(app);
    const c = await ann.post('/api/billing/checkout', { plan: 'monthly' });
    const mp = await ann.post('/api/billing/mock-pay', { orderId: c.body.orderId });
    app.raw.exec("CREATE TRIGGER boom BEFORE UPDATE ON orgs BEGIN SELECT RAISE(ABORT, 'boom'); END");
    const first = await ann.post('/api/billing/verify', mp.body);
    expect(first.status).toBe(500);
    expect(one(app, 'SELECT status FROM orders').status).toBe('created'); // NOT 'paid'
    expect(one(app, 'SELECT plan FROM orgs').plan).toBeNull();
    app.raw.exec('DROP TRIGGER boom');
    const retry = await ann.post('/api/billing/verify', mp.body);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ paid: true, extended: true });
    expect(one(app, 'SELECT plan FROM orgs').plan).toBe('monthly');
    const until = one(app, 'SELECT plan_until FROM orgs').plan_until;
    expect((await ann.post('/api/billing/verify', mp.body)).body.extended).toBe(false); // and never twice
    expect(one(app, 'SELECT plan_until FROM orgs').plan_until).toBe(until);
  });

  test('only the team owner can confirm a payment; a member cannot flip the owner\'s order', async () => {
    const { ann, bob } = await team();
    const c = await ann.post('/api/billing/checkout', { plan: 'monthly' });
    const r = await bob.post('/api/billing/verify', { orderId: c.body.providerOrderId, paymentId: 'x', signature: 'bad' });
    expect(r.status).toBe(403);
  });

  test('a double tap on "pay" reuses the same open order instead of opening a second one', async () => {
    const app = makeApp();
    const ann = await owner(app);
    const a = await ann.post('/api/billing/checkout', { plan: 'monthly' });
    const b = await ann.post('/api/billing/checkout', { plan: 'monthly' });
    expect(b.body.orderId).toBe(a.body.orderId);
    expect(one(app, 'SELECT COUNT(*) AS n FROM orders').n).toBe(1);
  });
});

describe('R3 the mail log does not keep secrets', () => {
  test('production keeps no sign-in code and no share token in the outbox, and old rows are purged', async () => {
    const app = prodApp();
    const ann = await prodSignIn(app, ANN, 'Ann', 'T');
    const code = sentCode(app, ANN);
    const { id } = await seedMom(app, ann, { publish: true });
    const sh = await ann.post(`/api/moms/${id}/shares`, { via: 'email', to: 'priya@out.test' });
    const token = tokenOf(sh.body.link);
    const dump = JSON.stringify(app.raw.query('SELECT * FROM outbox').all());
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(token);
    expect(app.raw.query("SELECT DISTINCT body FROM outbox").all()).toEqual([{ body: '[not kept]' }]);
    // 30-day retention for the delivery facts themselves
    app.advance(31 * 86400_000);
    await housekeeping(app.ctx, true);
    expect(one(app, 'SELECT COUNT(*) AS n FROM outbox').n).toBe(0);
  });

  test('the laptop dev mailbox still shows the full text (that is its whole point)', async () => {
    const app = makeApp();
    await owner(app);
    expect(app.outbox(ANN).some((m) => m.body.includes('Your team'))).toBe(true);
  });

  test('expired sessions, old codes, idempotency rows and counters are cleaned up', async () => {
    const app = makeApp();
    const ann = await owner(app);
    await ann.req('POST', '/api/moms', { title: 'x', date: today(app) }, { 'idempotency-key': 'clean-up-key-1' });
    expect(one(app, 'SELECT COUNT(*) AS n FROM idempotency').n).toBe(1);
    app.advance(40 * 86400_000);
    await housekeeping(app.ctx, true);
    for (const t of ['sessions', 'auth_codes', 'idempotency']) expect(one(app, `SELECT COUNT(*) AS n FROM ${t}`).n).toBe(0);
  });
});

describe('R4 a shared link never signs a signed-in person out', () => {
  test('an owner opens another team\'s link: their own session survives; the guest view is asked for explicitly', async () => {
    const app = makeApp();
    const ann = await owner(app);
    const { id } = await seedMom(app, ann, { title: 'Ann private MOM', publish: true });
    const token = tokenOf((await ann.post(`/api/moms/${id}/shares`, { via: 'link' })).body.link);
    const zed = await signIn(app, 'zed@other.test', 'Zed', 'Zed team');
    const c = await zed.post(`/api/shared/${token}/code`, { email: 'zed@other.test' });
    expect((await zed.post(`/api/shared/${token}/verify`, { email: 'zed@other.test', code: c.body.devCode })).status).toBe(200);
    expect(zed.cookieOf('mom_session')).not.toBe('');
    expect(zed.cookieOf('mom_guest')).not.toBe('');
    const mine = (await zed.get('/api/state')).body;
    expect(mine.me).toBe('zed@other.test'); // still signed in as himself
    expect(mine.org.name).toBe('Zed team');
    const asGuest = (await zed.get('/api/state?as=guest')).body;
    expect(asGuest).toMatchObject({ me: null, guest: 'zed@other.test', guestMom: id });
    expect(asGuest.moms.map((m: any) => m.title)).toEqual(['Ann private MOM']);
    // signing out ends both
    await zed.post('/api/auth/logout');
    expect((await zed.get('/api/state')).status).toBe(401);
    expect((await zed.get('/api/state?as=guest')).status).toBe(401);
  });
});

describe('R5 nobody can drop addresses into a team they do not own', () => {
  test('a member cannot invent new people (no squatting, no oracle, no seat burning, no mail to strangers)', async () => {
    const { app, ann, bob } = await team();
    const before = app.outbox().length;
    const r = await bob.post('/api/moms', { title: 'x', date: today(app), attendees: ['victim@elsewhere.test'] });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('NOT_IN_TEAM');
    expect(one(app, 'SELECT COUNT(*) AS n FROM invites').n).toBe(0);
    expect(one(app, "SELECT COUNT(*) AS n FROM users WHERE email = 'victim@elsewhere.test'").n).toBe(0);
    expect(app.outbox().length).toBe(before); // nothing mailed to the stranger
    // the same on points
    const { id } = await seedMom(app, ann, { attendees: [BOB], points: [{ title: 'p', owners: [BOB] }], publish: true });
    const pt = (await ann.get('/api/state')).body.points[0];
    expect((await bob.post(`/api/points/${pt.id}/owners`, { add: ['victim@elsewhere.test'] })).body.error.code).toBe('NOT_IN_TEAM');
    // the victim, signing up later, is simply a new owner of their own team - not a member of anyone else's
    const v = await signIn(app, 'victim@elsewhere.test', 'Vic', 'Vic team');
    const st = (await v.get('/api/state')).body;
    expect(st.org.isOwner).toBe(true);
    expect(st.org.name).toBe('Vic team');
    expect(id).toBeTruthy();
  });

  test('the owner can bring new people in: it makes an invite, not an account, and the person joins by proving the mailbox', async () => {
    const { app, ann } = await team();
    const m = await ann.post('/api/moms', { title: 'x', date: today(app), attendees: ['newbie@team.test'] });
    expect(m.status).toBe(201);
    expect(one(app, "SELECT COUNT(*) AS n FROM users WHERE email = 'newbie@team.test'").n).toBe(0);
    expect(one(app, "SELECT COUNT(*) AS n FROM invites WHERE email = 'newbie@team.test'").n).toBe(1);
    expect(app.outbox('newbie@team.test').some((x) => x.subject.includes('invited'))).toBe(true);
    const nb = await signIn(app, 'newbie@team.test');
    expect((await nb.get('/api/state')).body.org.name).toBe('Ann team');
    expect(one(app, 'SELECT COUNT(*) AS n FROM invites').n).toBe(0);
  });

  test('an invited address that already has an account elsewhere is never moved - and the owner is told nothing about that', async () => {
    const { app, ann } = await team();
    await signIn(app, 'zed@other.test', 'Zed', 'Other team');
    const r = await ann.post('/api/moms', { title: 'x', date: today(app), attendees: ['zed@other.test'] });
    expect(r.status).toBe(201);
    const zed = await signIn(app, 'zed@other.test');
    expect((await zed.get('/api/state')).body.org.name).toBe('Other team');
  });

  test('a failed write leaves no orphan invites behind', async () => {
    const { app, ann } = await team();
    const bad = await ann.post('/api/moms', { title: '', date: today(app), attendees: ['ghost@team.test'] });
    expect(bad.status).toBe(400);
    expect(one(app, 'SELECT COUNT(*) AS n FROM invites').n).toBe(0);
    // and a too-large guest list is refused before anything is written
    const many = Array.from({ length: 12 }, (_, i) => `g${i}@team.test`);
    const full = await ann.post('/api/moms', { title: 'x', date: today(app), attendees: many });
    expect(full.body.error.code).toBe('TEAM_FULL');
    expect(one(app, 'SELECT COUNT(*) AS n FROM invites').n).toBe(0);
    expect(one(app, "SELECT COUNT(*) AS n FROM moms WHERE title = 'x'").n).toBe(0);
  });

  test('pending invites count towards the 10-seat limit', async () => {
    const { app, ann } = await team();
    for (let i = 3; i <= 10; i++) expect((await ann.post('/api/team/members', { email: `u${i}@team.test` })).status).toBe(200);
    expect(one(app, 'SELECT COUNT(*) AS n FROM invites').n).toBe(8);
    expect((await ann.post('/api/team/members', { email: 'u11@team.test' })).body.error.code).toBe('TEAM_FULL');
    expect((await ann.get('/api/state')).body.org.users).toBe(10);
  });
});

describe('R5b team: remove people and hand over the owner role', () => {
  test('the owner can remove an invite and a member; removed people lose access at once but their history stays', async () => {
    const { app, ann, bob } = await team();
    const { id } = await seedMom(app, ann, { attendees: [BOB], points: [{ title: 'p', owners: [BOB] }], publish: true });
    await ann.post('/api/team/members', { email: 'pending@team.test' });
    expect((await ann.post('/api/team/members/remove', { email: 'pending@team.test' })).body.removed).toBe('invite');
    expect((await bob.post('/api/team/members/remove', { email: ANN })).status).toBe(403);
    expect((await ann.post('/api/team/members/remove', { email: ANN })).body.error.code).toBe('CANNOT_REMOVE_SELF');
    expect((await ann.post('/api/team/members/remove', { email: BOB })).body.removed).toBe('member');
    expect((await bob.get('/api/state')).status).toBe(401);
    expect((await ann.post('/api/team/members/remove', { email: 'nobody@team.test' })).status).toBe(404);
    expect(one(app, 'SELECT COUNT(*) AS n FROM points WHERE mom_id = ?', id).n).toBe(1); // the work stays
    expect(one(app, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'member_removed'").n).toBe(1);
    // the removed address is free: signing in again starts a team of their own
    const again = await signIn(app, BOB, 'Bob', 'Bob team');
    expect((await again.get('/api/state')).body.org.name).toBe('Bob team');
  });

  test('ownership moves to a verified teammate, there is always exactly one owner, and the old owner loses owner rights', async () => {
    const { app, ann, bob } = await team();
    expect((await bob.post('/api/team/owner', { email: BOB })).status).toBe(403);
    expect((await ann.post('/api/team/owner', { email: ANN })).body.error.code).toBe('ALREADY_OWNER');
    await ann.post('/api/team/members', { email: 'later@team.test' });
    expect((await ann.post('/api/team/owner', { email: 'later@team.test' })).status).toBe(404); // an invite is not a teammate yet
    expect((await ann.post('/api/team/owner', { email: BOB })).status).toBe(200);
    expect(one(app, "SELECT COUNT(*) AS n FROM users WHERE role = 'owner'").n).toBe(1);
    expect((await bob.get('/api/state')).body.org.isOwner).toBe(true);
    expect((await ann.get('/api/state')).body.org.isOwner).toBe(false);
    expect((await ann.post('/api/team/members', { email: 'x@team.test' })).status).toBe(403);
    expect((await bob.post('/api/team/members', { email: 'x@team.test' })).status).toBe(200);
  });
});

describe('R6 unauthenticated mail endpoints are limited per client address', () => {
  test('the 11th code request from one address in an hour is refused; another address is unaffected; the raw address is never stored', async () => {
    const app = makeApp();
    const req = (i: number, ip: string) => app.browser().req('POST', '/api/auth/start', { email: `u${i}@x.test` }, { 'cf-connecting-ip': ip });
    for (let i = 0; i < 10; i++) expect((await req(i, '203.0.113.7')).status).toBe(200);
    const r = await req(10, '203.0.113.7');
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect((await req(11, '198.51.100.9')).status).toBe(200);
    expect(JSON.stringify(app.raw.query('SELECT * FROM rate_limits').all())).not.toContain('203.0.113.7');
    // the window moves on
    app.advance(3601_000);
    expect((await req(12, '203.0.113.7')).status).toBe(200);
  });

  test('the limit also covers the share-code endpoint', async () => {
    const { app, ann } = await team();
    const { id } = await seedMom(app, ann, { publish: true });
    const t = tokenOf((await ann.post(`/api/moms/${id}/shares`, { via: 'link' })).body.link);
    let last = 200;
    for (let i = 0; i < 11; i++) last = (await app.browser().req('POST', `/api/shared/${t}/code`, { email: `g${i}@out.test` }, { 'cf-connecting-ip': '192.0.2.1' })).status;
    expect(last).toBe(429);
  });
});

describe('R7 share links expire, can be cancelled, and e-mail links belong to their recipient', () => {
  async function setup(env: Record<string, string> = {}) {
    const t = await team(env);
    const m = await seedMom(t.app, t.ann, { title: 'Shared MOM', attendees: [BOB], points: [{ title: 'Pt', owners: [BOB] }], publish: true });
    return { ...t, ...m };
  }
  async function openAs(app: any, token: string, email: string) {
    const g = app.browser();
    const c = await g.post(`/api/shared/${token}/code`, { email });
    const v = await g.post(`/api/shared/${token}/verify`, { email, code: c.body.devCode });
    return { g, v };
  }

  test('a link stops working after SHARE_TTL_DAYS - the preview, the code and an open guest session', async () => {
    const { app, ann, id } = await setup({ SHARE_TTL_DAYS: '2' });
    const r = await ann.post(`/api/moms/${id}/shares`, { via: 'link' });
    expect(new Date(r.body.expiresAt).getTime() - app.clock.t).toBe(2 * 86400_000);
    const t = tokenOf(r.body.link);
    const { g, v } = await openAs(app, t, 'priya@out.test');
    expect(v.status).toBe(200);
    expect((await g.get('/api/state')).status).toBe(200);
    app.advance(3 * 86400_000);
    expect((await app.browser().get(`/api/shared/${t}`)).status).toBe(404);
    expect((await app.browser().post(`/api/shared/${t}/code`, { email: 'x@out.test' })).status).toBe(404);
    expect((await g.get('/api/state')).status).toBe(401); // the session ended with the link
  });

  test('cancelling a link kills it at once - including people already inside - and says so in the log', async () => {
    const { app, ann, bob, id } = await setup();
    const sh = await ann.post(`/api/moms/${id}/shares`, { via: 'link' });
    const t = tokenOf(sh.body.link);
    const { g } = await openAs(app, t, 'priya@out.test');
    const st = (await ann.get('/api/state')).body.moms[0];
    expect(st.shares[0]).toMatchObject({ id: sh.body.id, via: 'link', cancelled: false, canCancel: true });
    // a participant who did not make the link (and is not the MOM owner) cannot cancel it
    expect((await bob.post(`/api/shares/${sh.body.id}/cancel`)).status).toBe(403);
    expect((await ann.post(`/api/shares/${sh.body.id}/cancel`)).status).toBe(200);
    expect((await ann.post(`/api/shares/${sh.body.id}/cancel`)).body.error.code).toBe('ALREADY_CANCELLED');
    expect((await app.browser().get(`/api/shared/${t}`)).status).toBe(404);
    expect((await g.get('/api/state')).status).toBe(401);
    expect((await ann.get('/api/state')).body.moms[0].events.at(-1).what).toBe('Cancelled a share link');
    // the MOM owner can cancel a link a participant made
    const bobs = await bob.post(`/api/moms/${id}/shares`, { via: 'link' });
    expect((await ann.post(`/api/shares/${bobs.body.id}/cancel`)).status).toBe(200);
  });

  test('an e-mailed link opens only for the address it was sent to', async () => {
    const { app, ann, id } = await setup();
    const t = tokenOf((await ann.post(`/api/moms/${id}/shares`, { via: 'email', to: 'priya@out.test' })).body.link);
    const attacker = app.browser();
    const r = await attacker.post(`/api/shared/${t}/code`, { email: 'attacker@evil.test' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('WRONG_RECIPIENT');
    expect(app.outbox('attacker@evil.test').length).toBe(0); // no code is even mailed
    const ok = await openAs(app, t, 'Priya@Out.test'); // case does not matter
    expect(ok.v.status).toBe(200);
  });

  test('a deleted MOM\'s links stop opening and no longer reveal the sender', async () => {
    const { app, ann, id } = await setup();
    const t = tokenOf((await ann.post(`/api/moms/${id}/shares`, { via: 'link' })).body.link);
    expect((await app.browser().get(`/api/shared/${t}`)).status).toBe(200);
    await ann.post(`/api/moms/${id}/delete-for-all`, { confirm: true });
    expect((await app.browser().get(`/api/shared/${t}`)).status).toBe(404);
  });

  test('the public chain log: anyone with a valid link sees who passed it on and who opened it, with outside addresses masked, and none of the MOM', async () => {
    const { app, ann, id } = await setup();
    const t = tokenOf((await ann.post(`/api/moms/${id}/shares`, { via: 'email', to: 'priya@out.test' })).body.link);
    await ann.post(`/api/moms/${id}/shares`, { via: 'whatsapp', to: 'Society chat' });
    await openAs(app, t, 'priya@out.test');
    const anon = app.browser();
    const r = await anon.get(`/api/shared/${t}/chain`);
    expect(r.status).toBe(200);
    expect(r.body.chain.map((c: any) => c.type)).toEqual(['share', 'share', 'open']);
    expect(r.body.chain[0]).toMatchObject({ by: 'Ann Owner', via: 'email', to: 'p***@out.test' });
    expect(r.body.chain[1]).toMatchObject({ via: 'whatsapp', to: 'Society chat' });
    expect(r.body.chain[2]).toMatchObject({ by: 'p***@out.test', from: 'Ann Owner' });
    const text = JSON.stringify(r.body);
    for (const secret of ['priya@out.test', 'Shared MOM', 'Pt', ANN]) expect(text).not.toContain(secret);
    expect((await anon.get('/api/shared/not-a-token/chain')).status).toBe(404);
  });

  test('the WhatsApp/link wording in the log says a link was made, because we cannot know it was sent', async () => {
    const { ann, id } = await setup();
    await ann.post(`/api/moms/${id}/shares`, { via: 'whatsapp', to: 'Chat' });
    const evs = (await ann.get('/api/state')).body.moms[0].events.filter((e: any) => e.type === 'share');
    expect(evs.at(-1).what).toBe('Made a WhatsApp share link for Chat');
  });
});

describe('R8 writes are safe to repeat and safe to race', () => {
  test('the same Idempotency-Key gives the first answer back and creates nothing twice', async () => {
    const app = makeApp();
    const ann = await owner(app);
    const body = { title: 'Once only', date: today(app) };
    const r1 = await ann.req('POST', '/api/moms', body, { 'idempotency-key': 'tap-0001-abcdef' });
    const r2 = await ann.req('POST', '/api/moms', body, { 'idempotency-key': 'tap-0001-abcdef' });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body.id).toBe(r1.body.id);
    expect(r2.headers.get('idempotent-replay')).toBe('true');
    expect(one(app, "SELECT COUNT(*) AS n FROM moms WHERE title = 'Once only'").n).toBe(1);
    // a key cannot be reused for a different request, and a malformed key is refused
    expect((await ann.req('POST', '/api/moms/merge', {}, { 'idempotency-key': 'tap-0001-abcdef' })).body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await ann.req('POST', '/api/moms', body, { 'idempotency-key': 'x' })).body.error.code).toBe('BAD_IDEMPOTENCY_KEY');
  });

  test('two identical requests at the very same moment still make one MOM', async () => {
    const app = makeApp();
    const ann = await owner(app);
    const go = () => ann.req('POST', '/api/moms', { title: 'Race', date: today(app) }, { 'idempotency-key': 'race-key-12345' });
    const [a, b] = await Promise.all([go(), go()]);
    expect([a.status, b.status].sort()).toEqual([201, a.status === 409 || b.status === 409 ? 409 : 201]);
    expect(one(app, "SELECT COUNT(*) AS n FROM moms WHERE title = 'Race'").n).toBe(1);
  });

  test('five points added at once get five different numbers and never a 500', async () => {
    const app = makeApp();
    const ann = await owner(app);
    const { id } = await seedMom(app, ann, { points: [] });
    const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => ann.post(`/api/moms/${id}/points`, { title: 'P' + i, owners: [ANN], due: today(app, 3) })));
    expect(rs.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(app.raw.query('SELECT no FROM points WHERE mom_id = ? ORDER BY no').all(id)).toEqual([1, 2, 3, 4, 5].map((no) => ({ no })));
    // the log says the same numbers as the data
    const added = app.raw.query("SELECT what FROM events WHERE mom_id = ? AND what LIKE 'Added point%'").all(id) as { what: string }[];
    expect(added.map((e) => Number(/point (\d+):/.exec(e.what)![1])).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  test('two people changing the same point at once: one change, one history line (the log never claims a change that lost)', async () => {
    const { app, ann } = await team();
    const { id, pointIds: [p] } = await seedMom(app, ann, { points: [{ title: 'p', owners: [ANN] }] });
    const [a, b] = await Promise.all([ann.post(`/api/points/${p}/status`, { status: 'Complete' }), ann.post(`/api/points/${p}/status`, { status: 'Complete' })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(one(app, 'SELECT status FROM points WHERE id = ?', p).status).toBe('Complete');
    expect(one(app, "SELECT COUNT(*) AS n FROM events WHERE point_id = ? AND what LIKE '%Status:%'", p).n).toBe(1);
    // a point-level change is not a new MOM version
    expect(one(app, 'SELECT version FROM moms WHERE id = ?', id).version).toBe(3);
  });

  test('adding the same point to the calendar twice at once makes one external event', async () => {
    const app = makeApp();
    const ann = await owner(app);
    const { pointIds: [p] } = await seedMom(app, ann);
    await ann.post('/api/integrations/google/connect');
    const rs = await Promise.all([1, 2, 3].map(() => ann.post(`/api/points/${p}/calendar`, { provider: 'google' })));
    expect(rs.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect(rs.some((r) => r.status === 200 && r.body.already === false)).toBe(true);
    expect(rs.filter((r) => r.status === 200 && r.body.already === false).length).toBe(1);
    expect(one(app, 'SELECT COUNT(*) AS n FROM calendar_events').n).toBe(1);
    expect(one(app, 'SELECT external_id FROM calendar_events').external_id).toStartWith('mock_google_');
  });
});

describe('R9 the history and the audit log are tamper-proof, and deletion really deletes', () => {
  test('MOM history can never be edited or removed; the audit log can never be edited', async () => {
    const app = makeApp();
    const ann = await owner(app);
    const { id } = await seedMom(app, ann, { publish: true });
    expect(() => app.raw.exec("UPDATE events SET what = 'rewritten'")).toThrow(/append-only/);
    expect(() => app.raw.exec('DELETE FROM events')).toThrow(/append-only/);
    expect(() => app.raw.exec("UPDATE audit_log SET actor = 'someone else'")).toThrow(/append-only/);
    expect(one(app, 'SELECT COUNT(*) AS n FROM events WHERE mom_id = ?', id).n).toBeGreaterThan(0);
    // even after deletion only the free text may be scrubbed - never who/when/what kind
    await ann.post(`/api/moms/${id}/delete-for-all`, { confirm: true });
    expect(() => app.raw.exec("UPDATE events SET at = '2000-01-01'")).toThrow(/append-only/);
    expect(() => app.raw.exec("UPDATE events SET by = 'x'")).toThrow(/append-only/);
    expect(() => app.raw.exec('DELETE FROM events')).toThrow(/append-only/);
  });

  test('"delete for everyone" removes the notes, points, files, updates and the old change text', async () => {
    const { app, ann } = await team();
    const { id, pointIds: [p] } = await seedMom(app, ann, { title: 'Doomed', attendees: [BOB], points: [{ title: 'Launch codes', owners: [BOB] }], publish: true });
    await ann.patch(`/api/moms/${id}`, { notes: 'Top secret notes' });
    await ann.post(`/api/points/${p}/updates`, { text: 'private update' });
    await ann.post(`/api/points/${p}/attachments`, { kind: 'text', text: 'private attachment' });
    await ann.post(`/api/moms/${id}/delete-for-all`, { confirm: true });
    const all = JSON.stringify([
      app.raw.query('SELECT * FROM moms WHERE id = ?').all(id), app.raw.query('SELECT * FROM points').all(), app.raw.query('SELECT * FROM point_updates').all(),
      app.raw.query('SELECT * FROM attachments').all(), app.raw.query('SELECT * FROM events WHERE mom_id = ?').all(id), app.raw.query('SELECT * FROM point_owners').all(),
    ]);
    for (const s of ['Top secret', 'Launch codes', 'private update', 'private attachment']) expect(all).not.toContain(s);
    // the audit trail (who, when, what kind) is still there
    expect(one(app, "SELECT COUNT(*) AS n FROM events WHERE mom_id = ? AND type = 'content'", id).n).toBeGreaterThan(0);
    expect(one(app, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'mom_deleted'").n).toBe(1);
  });
});

describe('R10 merge, dates, point removal', () => {
  test('a merge carries each point\'s own history along (shown on the point, not repeated in the MOM log)', async () => {
    const { app, ann } = await team();
    const a = await seedMom(app, ann, { title: 'A', points: [{ title: 'a1', owners: [ANN] }] });
    const b = await seedMom(app, ann, { title: 'B', points: [{ title: 'b1', owners: [ANN] }] });
    await ann.post(`/api/points/${a.pointIds[0]}/status`, { status: 'In progress' });
    await ann.post(`/api/points/${a.pointIds[0]}/updates`, { text: 'working on it' });
    const m = await ann.post('/api/moms/merge', { ids: [a.id, b.id], confirm: true });
    const st = (await ann.get('/api/state')).body;
    const pt = st.points.find((p: any) => p.momId === m.body.id && p.title === 'a1');
    const log = pt.log.map((l: any) => l.what);
    expect(log).toContain('Status: WIP → In progress'); // the history did not restart
    expect(log).toContain('Posted an update');
    expect(log.some((w: string) => w.startsWith('Copied here by merging'))).toBe(true);
    const mom = st.moms.find((x: any) => x.id === m.body.id);
    expect(mom.events.some((e: any) => String(e.what).includes('Status:'))).toBe(false); // not repeated in the MOM-level log
  });

  test('impossible calendar dates are refused (31 February), real ones including 29 Feb of a leap year are fine', async () => {
    const app = makeApp();
    const ann = await owner(app);
    const bad = await ann.post('/api/moms', { title: 'x', date: '2026-02-31' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_DATE');
    expect((await ann.post('/api/moms', { title: 'x', date: '2026-02-29' })).status).toBe(400); // 2026 is not a leap year
    expect((await ann.post('/api/moms', { title: 'x', date: '2028-02-29' })).status).toBe(201);
    const { id } = await seedMom(app, ann);
    expect((await ann.post(`/api/moms/${id}/points`, { title: 'p', owners: [ANN], due: '2026-04-31' })).status).toBe(400);
  });

  test('a point can be removed while the MOM is a draft (numbers close up); once published it can only be Discarded', async () => {
    const app = makeApp();
    const ann = await owner(app);
    const { id, pointIds } = await seedMom(app, ann, { points: [{ title: 'one', owners: [ANN] }, { title: 'two', owners: [ANN] }, { title: 'three', owners: [ANN] }] });
    expect((await ann.del(`/api/points/${pointIds[1]}`)).status).toBe(200);
    const pts = (await ann.get('/api/state')).body.points.sort((a: any, b: any) => a.no - b.no);
    expect(pts.map((p: any) => [p.no, p.title])).toEqual([[1, 'one'], [2, 'three']]);
    expect((await ann.get('/api/state')).body.moms[0].events.at(-1).what).toBe('Removed point 2: two');
    const next = await ann.post(`/api/moms/${id}/points`, { title: 'four', owners: [ANN] });
    expect(next.body.no).toBe(3);
    await ann.post(`/api/moms/${id}/publish`);
    const locked = await ann.del(`/api/points/${pointIds[0]}`);
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('PUBLISHED_LOCKED');
  });
});

describe('R11 PDF honesty and the print route', () => {
  test('the PDF file says when it cannot draw the MOM\'s letters (e.g. Devanagari), so the screen can offer the print view', async () => {
    const app = makeApp();
    const ann = await owner(app);
    const hindi = await seedMom(app, ann, { title: 'साप्ताहिक बैठक' });
    const r = await ann.get(`/api/moms/${hindi.id}/pdf`);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-pdf-lossy')).toBe('1');
    const plain = await seedMom(app, ann, { title: 'Weekly meeting' });
    expect((await ann.get(`/api/moms/${plain.id}/pdf`)).headers.get('x-pdf-lossy')).toBeNull();
  });
});

describe('R12 billing paperwork', () => {
  async function paid(env: Record<string, string> = {}) {
    const t = await team(env);
    const c = await t.ann.post('/api/billing/checkout', { plan: 'monthly' });
    const mp = await t.ann.post('/api/billing/mock-pay', { orderId: c.body.orderId });
    return { ...t, orderId: c.body.orderId as string, verify: () => t.ann.post('/api/billing/verify', mp.body) };
  }

  test('a receipt exists only for a paid order and names the payee; the GSTIN appears once the owner supplies it', async () => {
    const { ann, orderId, verify } = await paid({ PAYEE_GSTIN: '27ABCDE1234F1Z5' });
    expect((await ann.get(`/api/billing/orders/${orderId}/receipt`)).body.error.code).toBe('NOT_PAID');
    await verify();
    const r = (await ann.get(`/api/billing/orders/${orderId}/receipt`)).body;
    expect(r).toMatchObject({ payee: 'IT SERVICES BY RAJAT AGARWAL', amountPaise: 49900, item: 'Rs 499 per month', gstin: '27ABCDE1234F1Z5' });
    expect((await ann.get('/api/billing/orders/nope/receipt')).status).toBe(404);
  });

  test('without a GSTIN it is honestly a payment receipt, not a tax invoice', async () => {
    const { ann, orderId, verify } = await paid();
    await verify();
    const r = (await ann.get(`/api/billing/orders/${orderId}/receipt`)).body;
    expect(r.gstin).toBeNull();
    expect(r.note).toContain('payment receipt');
  });

  test('a refund can be asked for once per paid order, by the owner only; nothing is refunded automatically', async () => {
    const { app, ann, bob, orderId, verify } = await paid({ SUPPORT_EMAIL: 'support@mom.test' });
    expect((await ann.post(`/api/billing/orders/${orderId}/refund-request`, { reason: 'too early' })).body.error.code).toBe('NOT_PAID');
    await verify();
    expect((await bob.post(`/api/billing/orders/${orderId}/refund-request`, {})).status).toBe(403);
    expect((await ann.post(`/api/billing/orders/${orderId}/refund-request`, { reason: 'bought by mistake' })).status).toBe(201);
    expect((await ann.post(`/api/billing/orders/${orderId}/refund-request`, {})).body.error.code).toBe('ALREADY_REQUESTED');
    expect(one(app, 'SELECT status, reason FROM refund_requests')).toEqual({ status: 'requested', reason: 'bought by mistake' });
    expect(one(app, 'SELECT status FROM orders').status).toBe('paid'); // still paid: the payee decides
    expect(app.outbox('support@mom.test').length).toBe(1);
  });
});

describe('R13 audit trail covers sign-in, billing, roles and denied access', () => {
  test('the interesting events are recorded, with no codes or tokens in them', async () => {
    const { app, ann, bob } = await team();
    const other = await signIn(app, 'zed@other.test', 'Zed', 'Z');
    const { id } = await seedMom(app, ann, { title: 'Private' });
    expect((await other.get('/api/state')).status).toBe(200);
    await other.post(`/api/moms/${id}/publish`); // not allowed: looks like "not found" and is audited
    await app.browser().post('/api/auth/start', { email: 'w@x.test' }).then(async (s) => app.browser().post('/api/auth/verify', { email: 'w@x.test', code: '000000' }).then(() => s));
    const c = await ann.post('/api/billing/checkout', { plan: 'monthly' });
    await ann.post('/api/billing/verify', (await ann.post('/api/billing/mock-pay', { orderId: c.body.orderId })).body);
    await ann.post('/api/team/owner', { email: BOB });
    const actions = (app.raw.query('SELECT action FROM audit_log').all() as { action: string }[]).map((r) => r.action);
    for (const a of ['signed_up', 'joined_team', 'access_denied', 'code_wrong', 'order_created', 'plan_extended', 'owner_transferred', 'member_invited']) expect(actions).toContain(a);
    const dump = JSON.stringify(app.raw.query('SELECT * FROM audit_log').all());
    expect(dump).not.toMatch(/\b\d{6}\b.*code is/);
    expect(bob).toBeTruthy();
  });
});

describe('R14 the live calendar paths', () => {
  const env = { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec', TOKEN_ENC_KEY: 'enc-key-1' };
  const okFetch = (userinfoOk = true) => (async (url: any, init?: any) => {
    const u = String(url);
    if (u === 'https://oauth2.googleapis.com/token') return Response.json(new URLSearchParams(String(init.body)).get('grant_type') === 'authorization_code' ? { access_token: 'ga', refresh_token: 'r' } : { access_token: 'ga2' });
    if (u.startsWith('https://openidconnect.googleapis.com')) return userinfoOk ? Response.json({ email: 'ann@gmail.test' }) : new Response('nope', { status: 500 });
    throw new Error('unexpected ' + u);
  }) as never;

  test('the OAuth state can be used exactly once (a copied callback URL cannot be replayed)', async () => {
    const app = makeApp(env, okFetch());
    const ann = await owner(app);
    const state = new URL((await ann.post('/api/integrations/google/connect')).body.url).searchParams.get('state')!;
    const cb = () => ann.get(`/api/integrations/google/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect((await cb()).headers.get('location')).toBe('http://mom.test/#/integrations');
    expect((await cb()).headers.get('location')).toContain('err=');
    expect(one(app, 'SELECT COUNT(*) AS n FROM integrations').n).toBe(1);
  });

  test('a failing userinfo answer is an error, not a connection to "google account"', async () => {
    const app = makeApp(env, okFetch(false));
    const ann = await owner(app);
    const state = new URL((await ann.post('/api/integrations/google/connect')).body.url).searchParams.get('state')!;
    const r = await ann.get(`/api/integrations/google/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(r.headers.get('location')).toContain('err=');
    expect(one(app, 'SELECT COUNT(*) AS n FROM integrations').n).toBe(0);
  });

  test('there is no hard-coded fallback secret outside dev', () => {
    expect(() => secret({ env: { MOM_MODE: 'production' } } as never)).toThrow();
    expect(secret({ env: { MOM_MODE: 'dev' } } as never)).toBeTruthy();
    expect(secret({ env: { MOM_MODE: 'production', SESSION_SECRET: 'abc' } } as never)).toBe('abc');
  });
});

describe('R15 honest copy and safe defaults', () => {
  test('the dev server listens on localhost only', async () => {
    const src = await Bun.file(new URL('../scripts/dev-server.ts', import.meta.url)).text();
    expect(src).toContain("hostname: '127.0.0.1'");
  });

  test('/api/config tells the screens whether a plan is enforced and how long a share link lives', async () => {
    const off = (await makeApp().browser().get('/api/config')).body;
    expect(off).toMatchObject({ enforcePlan: false, shareDays: 30 });
    expect((await makeApp({ ENFORCE_PLAN: '1', SHARE_TTL_DAYS: '7' }).browser().get('/api/config')).body).toMatchObject({ enforcePlan: true, shareDays: 7 });
  });
});
