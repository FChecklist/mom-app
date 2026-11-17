import { describe, expect, test } from 'bun:test';
import { makeApp, owner, seedMom, signIn } from './helpers.ts';

const ANN = 'ann@team.test', BOB = 'bob@team.test';
const tokenOf = (link: string) => link.split('/#/shared/')[1];

async function setup() {
  const app = makeApp();
  const ann = await owner(app);
  await ann.post('/api/team/members', { email: BOB });
  const bob = await signIn(app, BOB);
  const m = await seedMom(app, ann, { title: 'Shared MOM', attendees: [BOB], points: [{ title: 'Pt', owners: [BOB] }], publish: true });
  return { app, ann, bob, ...m };
}
async function openAs(app: any, token: string, email: string) {
  const g = app.browser();
  const c = await g.post(`/api/shared/${token}/code`, { email });
  expect(c.status).toBe(200);
  const v = await g.post(`/api/shared/${token}/verify`, { email, code: c.body.devCode });
  return { g, v };
}

describe('sharing', () => {
  test('only published MOMs can be shared, by e-mail, WhatsApp or link', async () => {
    const app = makeApp();
    const ann = await owner(app);
    const { id } = await seedMom(app, ann);
    expect((await ann.post(`/api/moms/${id}/shares`, { via: 'link' })).body.error.code).toBe('NOT_PUBLISHED');
    await ann.post(`/api/moms/${id}/publish`);
    expect((await ann.post(`/api/moms/${id}/shares`, { via: 'sms' })).body.error.code).toBe('BAD_VIA');
    expect((await ann.post(`/api/moms/${id}/shares`, { via: 'email', to: '9876543210' })).body.error.code).toBe('EMAIL_ONLY');
    expect((await ann.post(`/api/moms/${id}/shares`, { via: 'email', to: 'nope' })).body.error.code).toBe('BAD_EMAIL');
  });

  test('e-mail share: a message with the link goes out and the chain records who shared with whom', async () => {
    const { app, ann, id } = await setup();
    const r = await ann.post(`/api/moms/${id}/shares`, { via: 'email', to: 'Priya@Out.test' });
    expect(r.status).toBe(201);
    const mail = app.outbox('priya@out.test');
    expect(mail.length).toBe(1);
    expect(mail[0].body).toContain(r.body.link);
    expect(mail[0].subject).toContain('Shared MOM');
    const ev = (await ann.get('/api/state')).body.moms[0].events.find((e: any) => e.type === 'share');
    expect(ev).toMatchObject({ via: 'email', to: 'priya@out.test', by: ANN, what: 'Shared by e-mail with priya@out.test' });
  });

  test('WhatsApp share returns a wa.me link carrying the text; nothing is e-mailed', async () => {
    const { app, ann, id } = await setup();
    const before = app.outbox().length;
    const r = await ann.post(`/api/moms/${id}/shares`, { via: 'whatsapp', to: 'Society chat' });
    expect(r.body.waUrl).toStartWith('https://wa.me/?text=');
    expect(decodeURIComponent(r.body.waUrl)).toContain(r.body.link);
    expect(app.outbox().length).toBe(before);
    expect((await ann.get('/api/state')).body.moms[0].events.at(-1).what).toBe('Made a WhatsApp share link for Society chat'); // we cannot know it was sent, so the log says only that a link was made
  });

  test('a participant can share too, and the chain shows who passed it on', async () => {
    const { ann, bob, id } = await setup();
    expect((await bob.post(`/api/moms/${id}/shares`, { via: 'link' })).status).toBe(201);
    const ev = (await ann.get('/api/state')).body.moms[0].events.filter((e: any) => e.type === 'share');
    expect(ev.at(-1).by).toBe(BOB);
  });

  test('the link secret is stored only as a hash', async () => {
    const { app, ann, id } = await setup();
    const r = await ann.post(`/api/moms/${id}/shares`, { via: 'link' });
    const tok = tokenOf(r.body.link);
    const row = app.raw.query('SELECT * FROM shares').get() as any;
    expect(JSON.stringify(row)).not.toContain(tok);
    expect(JSON.stringify(app.raw.query('SELECT * FROM events').all())).not.toContain(tok);
  });
});

describe('the opener confirms their e-mail first', () => {
  test('before the code, a visitor learns only who sent it - not the content', async () => {
    const { app, ann, id } = await setup();
    const t = tokenOf((await ann.post(`/api/moms/${id}/shares`, { via: 'email', to: 'priya@out.test' })).body.link);
    const anon = app.browser();
    const pre = await anon.get(`/api/shared/${t}`);
    expect(pre.body.from.email).toBe(ANN);
    expect(pre.body.forEmail).toBe('p***@out.test'); // a hint for the real recipient, not the address itself
    expect(JSON.stringify(pre.body)).not.toContain('priya@out.test');
    expect(JSON.stringify(pre.body)).not.toContain('Shared MOM');
    expect((await anon.get('/api/state')).status).toBe(401);
    expect((await anon.get(`/api/moms/${id}/pdf`)).status).toBe(401);
    expect((await anon.get('/api/shared/bogus-token')).status).toBe(404);
  });

  test('wrong code or wrong e-mail does not open it; the right one does, read-only, for that one MOM', async () => {
    const { app, ann, id } = await setup();
    await seedMom(app, ann, { title: 'Another MOM', publish: true });
    const t = tokenOf((await ann.post(`/api/moms/${id}/shares`, { via: 'email', to: 'priya@out.test' })).body.link);
    const g = app.browser();
    const c = await g.post(`/api/shared/${t}/code`, { email: 'priya@out.test' });
    expect((await g.post(`/api/shared/${t}/verify`, { email: 'priya@out.test', code: '000000' })).status).toBe(400);
    const wrong = await g.post(`/api/shared/${t}/verify`, { email: 'someone@else.test', code: c.body.devCode });
    expect(wrong.status).toBe(403); // an e-mailed link opens for the address it was e-mailed to, and nobody else
    expect(wrong.body.error.code).toBe('WRONG_RECIPIENT');
    expect((await g.get('/api/state')).status).toBe(401);
    expect((await g.post(`/api/shared/${t}/verify`, { email: 'priya@out.test', code: c.body.devCode })).status).toBe(200);
    const st = await g.get('/api/state');
    expect(st.body.guest).toBe('priya@out.test');
    expect(st.body.moms.map((m: any) => m.title)).toEqual(['Shared MOM']);
    expect(st.body.org).toBeNull();
    // read-only
    expect((await g.post(`/api/moms/${id}/shares`, { via: 'link' })).status).toBe(403);
    expect((await g.patch(`/api/moms/${id}`, { title: 'x' })).body.error.code).toBe('GUEST_READ_ONLY');
    expect((await g.post(`/api/points/${st.body.points[0].id}/status`, { status: 'Complete' })).status).toBe(403);
    expect((await g.post('/api/moms', { title: 'x', date: '2026-11-11' })).status).toBe(403);
    // allowed: download the PDF of that one MOM
    expect((await g.get(`/api/moms/${id}/pdf`)).status).toBe(200);
  });

  test('a guest cannot see other MOMs, even by guessing ids', async () => {
    const { app, ann, id } = await setup();
    const other = await seedMom(app, ann, { title: 'Hidden', publish: true });
    const { g } = await openAs(app, tokenOf((await ann.post(`/api/moms/${id}/shares`, { via: 'link' })).body.link), 'priya@out.test');
    expect((await g.get(`/api/moms/${other.id}/pdf`)).status).toBe(404);
    expect(JSON.stringify((await g.get('/api/state')).body)).not.toContain('Hidden');
  });

  test('the guest only learns the names of people in that MOM', async () => {
    const { app, ann, id } = await setup();
    await ann.post('/api/team/members', { email: 'secret.teammate@team.test' });
    const { g } = await openAs(app, tokenOf((await ann.post(`/api/moms/${id}/shares`, { via: 'link' })).body.link), 'priya@out.test');
    const emails = (await g.get('/api/state')).body.users.map((u: any) => u.email);
    expect(emails).not.toContain('secret.teammate@team.test');
    expect(emails).toContain(ANN);
  });

  test('chain: the open is logged once per person, linked to the share, with who it came from', async () => {
    const { app, ann, id } = await setup();
    const t = tokenOf((await ann.post(`/api/moms/${id}/shares`, { via: 'email', to: 'priya@out.test' })).body.link);
    await openAs(app, t, 'priya@out.test');
    await openAs(app, t, 'priya@out.test'); // opens it again later
    // forwarded e-mail: the friend cannot get a code for it (the link is bound to Priya's address)
    const fw = app.browser();
    expect((await fw.post(`/api/shared/${t}/code`, { email: 'friend@out.test' })).body.error.code).toBe('WRONG_RECIPIENT');
    // a WhatsApp/plain link is a bearer link: anyone who holds it may open it after confirming THEIR e-mail, and the chain shows who did
    const t2 = tokenOf((await ann.post(`/api/moms/${id}/shares`, { via: 'link' })).body.link);
    const friend = await openAs(app, t2, 'friend@out.test');
    expect(friend.v.status).toBe(200);
    const evs = (await ann.get('/api/state')).body.moms[0].events;
    const shares = evs.filter((e: any) => e.type === 'share');
    const opens = evs.filter((e: any) => e.type === 'open');
    expect(opens.map((o: any) => o.by)).toEqual(['priya@out.test', 'friend@out.test']);
    expect(opens.every((o: any) => o.from === ANN)).toBe(true);
    expect(opens[0].shareId).toBe(shares[0].shareId);
    expect(opens[1].shareId).toBe(shares[1].shareId);
    expect(opens[0].what).toBe('Opened the shared link (e-mail confirmed)');
  });

  test('a guest session lasts 7 days', async () => {
    const { app, ann, id } = await setup();
    const { g } = await openAs(app, tokenOf((await ann.post(`/api/moms/${id}/shares`, { via: 'link' })).body.link), 'priya@out.test');
    app.advance(6 * 86400000);
    expect((await g.get('/api/state')).status).toBe(200);
    app.advance(2 * 86400000);
    expect((await g.get('/api/state')).status).toBe(401);
  });
});

describe('the public log', () => {
  test('everyone in a MOM sees the same complete log, including opens and attachments', async () => {
    const { app, ann, bob, id } = await setup();
    await ann.post(`/api/moms/${id}/attachments`, { kind: 'text', text: 'hello' });
    const t = tokenOf((await ann.post(`/api/moms/${id}/shares`, { via: 'link' })).body.link);
    const { g } = await openAs(app, t, 'priya@out.test');
    const logs = await Promise.all([ann, bob, g].map(async (b) => (await b.get('/api/state')).body.moms[0].events.map((e: any) => e.what)));
    expect(logs[1]).toEqual(logs[0]);
    expect(logs[2]).toEqual(logs[0]);
    expect(logs[0]).toContain('Opened the shared link (e-mail confirmed)');
    expect(logs[0].some((w: string) => w.startsWith('Attached text note'))).toBe(true);
  });
});
