// UI tests: the REAL public/app.js runs in a DOM (happy-dom) and talks to the REAL API and database (in memory).
// Nothing is mocked except the network wire itself. These cover the flows a person actually taps through.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleApi } from '../src/server/api.ts';
import { makeApp, owner, seedMom, signIn, type App } from './helpers.ts';

setDefaultTimeout(30000);
const pub = join(import.meta.dir, '..', 'public');
const html = readFileSync(join(pub, 'index.html'), 'utf8');
const util = readFileSync(join(pub, 'util.js'), 'utf8');
const appJs = readFileSync(join(pub, 'app.js'), 'utf8');
const one = (app: App, q: string, ...p: unknown[]) => app.raw.query(q).get(...(p as never[])) as any;

interface Page { win: any; doc: any; app: App; jar: Map<string, string>; opened: { url: string }[]; click(act: string, filter?: (e: any) => boolean): Promise<void>; type(id: string, v: string): void; text(): string; until(f: () => boolean, what: string): Promise<void>; go(h: string): Promise<void>; close(): void }
const open: Page[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

async function openPage(app: App, hash = '#/', jar = new Map<string, string>()): Promise<Page> {
  const win: any = new Window({ url: 'http://mom.test/' + hash, width: 390, height: 800 });
  const opened: { url: string }[] = [];
  win.fetch = async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers as never);
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await handleApi(app.ctx, new Request(new URL(String(url), 'http://mom.test'), { ...init, headers }));
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(';')[0]!, i = pair.indexOf('='), name = pair.slice(0, i), v = pair.slice(i + 1);
      if (v === '') jar.delete(name); else jar.set(name, v);
    }
    return res;
  };
  win.open = () => { const w = { opener: {}, location: '' as string, close() {} }; Object.defineProperty(w, 'location', { set: (v: string) => opened.push({ url: v }), get: () => '' }); return w; };
  win.scrollTo = () => {};
  const doc = win.document;
  doc.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script')).trim();
  // happy-dom has no eval: run the two scripts as functions whose globals are this window's.
  const run = (code: string) => new Function('window', 'document', 'location', 'fetch', 'FileReader', 'URL', 'navigator', 'sessionStorage', 'history', code)(win, doc, win.location, (...a: unknown[]) => win.fetch(...a), win.FileReader, win.URL, win.navigator, win.sessionStorage, win.history);
  run(util);
  run(appJs);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const p: Page = {
    win, doc, app, jar, opened,
    text: () => doc.body.textContent.replace(/\s+/g, ' '),
    async until(f, what) { for (let i = 0; i < 400; i++) { try { if (f()) return; } catch { /* not there yet */ } await sleep(5); } throw new Error('UI never showed: ' + what + '\n--- page text ---\n' + p.text().slice(0, 600)); },
    async click(act, filter) {
      await p.until(() => [...doc.querySelectorAll(`[data-act="${act}"]`)].some((e: any) => !filter || filter(e)), 'button ' + act);
      const el = [...doc.querySelectorAll(`[data-act="${act}"]`)].find((e: any) => !filter || filter(e));
      el.click();
      await sleep(15);
      await p.until(() => !doc.querySelector('.wait'), 'request to finish');
    },
    type(id, v) { const el = doc.getElementById(id); if (!el) throw new Error('no field ' + id); el.value = v; },
    async go(h) { win.location.hash = h; await sleep(20); },
    close() { try { win.happyDOM.abort(); win.close(); } catch { /* already closed */ } },
  };
  open.push(p);
  await p.until(() => doc.getElementById('app').innerHTML.length > 50 && !p.text().includes('Loading'), 'first screen');
  return p;
}

/** A fresh page load for the same signed-in person (after something changed behind the screen's back). */
const reopen = (p: Page, hash: string) => openPage(p.app, hash, p.jar);

/** Sign in through the screens (dev mode shows the code on the page). */
async function uiSignIn(p: Page, email: string, name = 'Asha Verma', team = 'Sunrise') {
  await p.go('#/signin');
  await p.until(() => !!p.doc.getElementById('si-email'), 'sign-in form');
  p.type('si-email', email); p.type('si-name', name); p.type('si-team', team);
  await p.click('si-send');
  await p.until(() => !!p.doc.getElementById('si-code'), 'code field');
  p.type('si-code', /Your code is (\d{6})/.exec(p.text())![1]!);
  await p.click('si-verify');
  await p.until(() => p.text().includes('Namaste'), 'home screen');
}

describe('UI: sign in, create, publish', () => {
  test('a new person signs in, writes a MOM with a point, and publishes it - all through the screens, and it is saved', async () => {
    const app = makeApp();
    const p = await openPage(app);
    await uiSignIn(p, 'asha@sunrise.test');
    await p.go('#/new');
    await p.until(() => !!p.doc.getElementById('mf-title'), 'new MOM form');
    p.type('mf-title', 'Monthly committee'); p.type('mf-venue', 'Club house'); p.type('mf-notes', 'Agenda agreed');
    await p.click('save-mom');
    await p.until(() => p.text().includes('Monthly committee') && !!p.doc.getElementById('ap-title'), 'MOM page');
    p.type('ap-title', 'Call the caterer'); p.type('ap-due', '2026-12-01');
    await p.click('add-point');
    await p.until(() => p.text().includes('Call the caterer'), 'point in list');
    await p.click('publish-ask');
    await p.click('publish-do');
    await p.until(() => p.text().includes('Published'), 'published tag');
    // persisted, not just displayed
    expect(one(app, "SELECT status, venue, notes FROM moms WHERE title = 'Monthly committee'")).toEqual({ status: 'published', venue: 'Club house', notes: 'Agenda agreed' });
    expect(one(app, "SELECT title, due FROM points").title).toBe('Call the caterer');
  });
});

describe('UI: attachments, WhatsApp, delete, merge', () => {
  async function signedIn() {
    const app = makeApp();
    const p = await openPage(app);
    await uiSignIn(p, 'asha@sunrise.test');
    return { app, p };
  }
  const apiAs = (app: App, p: Page) => { const b = app.browser(); b.setCookie([...p.jar].map(([k, v]) => `${k}=${v}`).join('; ')); return b; };

  test('a text note, a link and an image file can be attached to a point, and they are stored', async () => {
    const { app, p: p0 } = await signedIn(); let p = p0;
    const b = apiAs(app, p);
    const { id, pointIds } = await seedMom(app, b, { points: [{ title: 'Paint the hall', owners: ['asha@sunrise.test'] }] });
    p = await reopen(p, '#/point/' + pointIds[0]);
    await p.until(() => p.text().includes('Files and links'), 'point page');
    await p.click('attach-open');
    p.type('at-text', 'Colour chart is in the office');
    await p.click('attach-add');
    await p.until(() => p.text().includes('Attached') || p.text().includes('Text note'), 'text attached');
    await p.click('attach-open');
    await p.click('atype', (e) => e.getAttribute('data-k') === 'link');
    p.type('at-label', 'Quote'); p.type('at-url', 'https://example.com/quote');
    await p.click('attach-add');
    await p.until(() => p.text().includes('Quote'), 'link attached');
    // an image through the file picker
    await p.click('attach-open');
    await p.click('atype', (e) => e.getAttribute('data-k') === 'image');
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const input = p.doc.getElementById('at-file');
    Object.defineProperty(input, 'files', { value: [new p.win.File([png], 'plan.png', { type: 'image/png' })] });
    input.dispatchEvent(new p.win.Event('change', { bubbles: true }));
    await p.until(() => p.text().includes('plan.png'), 'file chosen');
    await p.click('attach-add');
    await p.until(() => p.text().includes('Image'), 'image attached');
    const rows = app.raw.query('SELECT kind, name FROM attachments WHERE point_id = ? ORDER BY kind').all(pointIds[0]) as any[];
    expect(rows.map((r) => r.kind).sort()).toEqual(['image', 'link', 'text']);
    expect(rows.find((r) => r.kind === 'image').name).toBe('plan.png');
    // and the stored bytes are exactly what the picker had
    const att = one(app, "SELECT id FROM attachments WHERE kind = 'image'");
    const dl = await apiAs(app, p).get('/api/attachments/' + att.id);
    expect(new Uint8Array(await dl.raw.arrayBuffer())).toEqual(png);
    expect(id).toBeTruthy();
  });

  test('WhatsApp share opens a ready message with a working link, and the log says a link was made', async () => {
    const { app, p: p0 } = await signedIn(); let p = p0;
    const { id } = await seedMom(app, apiAs(app, p), { publish: true, points: [{ title: 'x', owners: ['asha@sunrise.test'] }] });
    p = await reopen(p, '#/mom/' + id);
    await p.until(() => p.text().includes('Share'), 'MOM page');
    await p.click('share-open');
    await p.click('shtab', (e) => e.getAttribute('data-t') === 'whatsapp');
    p.type('sx-wa', 'Society chat');
    await p.click('share-wa');
    await p.until(() => p.opened.length === 1, 'WhatsApp window');
    expect(p.opened[0]!.url).toStartWith('https://wa.me/');
    const msg = decodeURIComponent(p.opened[0]!.url);
    expect(msg).toContain('/#/shared/');
    const token = /#\/shared\/([A-Za-z0-9_-]+)/.exec(msg)![1]!;
    expect((await app.browser().get('/api/shared/' + token)).status).toBe(200); // the link in the message really opens
    expect(one(app, "SELECT what FROM events WHERE type = 'share'").what).toBe('Made a WhatsApp share link for Society chat');
  });

  test('"delete for everyone" needs the tick box, then erases the content and shows the notice', async () => {
    const { app, p: p0 } = await signedIn(); let p = p0;
    const { id } = await seedMom(app, apiAs(app, p), { title: 'Secret MOM', notes: 'launch codes', publish: true, points: [{ title: 'p', owners: ['asha@sunrise.test'] }] });
    p = await reopen(p, '#/mom/' + id + '/details');
    await p.until(() => p.text().includes('Secret MOM'), 'details tab');
    await p.click('del-ask');
    await p.click('del-do');
    expect(one(app, 'SELECT deleted_at FROM moms WHERE id = ?', id).deleted_at).toBeNull(); // not ticked: nothing happened
    p.doc.getElementById('del-ok').checked = true;
    await p.click('del-do');
    await p.until(() => p.text().includes('has been deleted by'), 'tombstone');
    expect(one(app, 'SELECT deleted_at, notes FROM moms WHERE id = ?', id)).toMatchObject({ notes: '' });
    expect(one(app, 'SELECT deleted_at FROM moms WHERE id = ?', id).deleted_at).not.toBeNull();
    expect(one(app, 'SELECT COUNT(*) AS n FROM points WHERE mom_id = ?', id).n).toBe(0);
  });

  test('merge: pick two MOMs, review, confirm - one new draft with the points, originals marked merged; a second try is refused', async () => {
    const { app, p: p0 } = await signedIn(); let p = p0;
    const b = apiAs(app, p);
    const a = await seedMom(app, b, { title: 'Alpha', points: [{ title: 'a1', owners: ['asha@sunrise.test'] }] });
    const c = await seedMom(app, b, { title: 'Gamma', points: [{ title: 'c1', owners: ['asha@sunrise.test'] }] });
    p = await reopen(p, '#/home');
    await p.until(() => p.text().includes('Alpha') && p.text().includes('Gamma'), 'home list');
    await p.click('merge-mode');
    await p.click('sel', (e) => e.getAttribute('data-id') === a.id);
    await p.click('sel', (e) => e.getAttribute('data-id') === c.id);
    await p.click('merge-go');
    await p.until(() => !!p.doc.getElementById('mg-title'), 'merge review');
    await p.click('merge-ask');
    await p.click('merge-do');
    await p.until(() => p.text().includes('Merged: Alpha'), 'merged MOM page');
    expect(one(app, "SELECT COUNT(*) AS n FROM moms WHERE title LIKE 'Merged:%'").n).toBe(1);
    expect(one(app, "SELECT COUNT(*) AS n FROM points WHERE mom_id = (SELECT id FROM moms WHERE title LIKE 'Merged:%')").n).toBe(2);
    expect(one(app, 'SELECT merged_into FROM moms WHERE id = ?', a.id).merged_into).not.toBeNull();
    const again = await b.post('/api/moms/merge', { ids: [a.id, c.id], confirm: true });
    expect(again.body.error.code).toBe('ALREADY_MERGED');
  });
});

describe('UI: shared links', () => {
  test('a signed-in person opening someone else\'s link stays signed in; "Leave" returns to their own home', async () => {
    const app = makeApp();
    const ann = await owner(app);
    const { id } = await seedMom(app, ann, { title: 'Ann private MOM', publish: true });
    const token = (await ann.post(`/api/moms/${id}/shares`, { via: 'link' })).body.link.split('/#/shared/')[1];
    const p = await openPage(app);
    await uiSignIn(p, 'zed@other.test', 'Zed Other', 'Zed team');
    await p.go('#/shared/' + token);
    await p.until(() => !!p.doc.getElementById('sh-email'), 'link gate');
    p.type('sh-email', 'zed@other.test');
    await p.click('sh-send');
    await p.until(() => !!p.doc.getElementById('sh-code'), 'code field');
    p.type('sh-code', /Your code is (\d{6})/.exec(p.text())![1]!);
    await p.click('sh-verify');
    await p.until(() => p.text().includes('Ann private MOM') && p.text().includes('read-only'), 'guest view');
    expect(p.win.sessionStorage.getItem('mom_as_guest')).toBe('1');
    expect(p.jar.get('mom_session')).toBeTruthy(); // the real session is still there
    await p.click('leave');
    await p.until(() => p.text().includes('Namaste'), 'own home again');
    expect(p.text()).not.toContain('Ann private MOM');
    expect(p.win.sessionStorage.getItem('mom_as_guest')).toBeNull();
  });

  test('an e-mailed link shows only a masked hint of the recipient and does not prefill it', async () => {
    const app = makeApp();
    const ann = await owner(app);
    const { id } = await seedMom(app, ann, { publish: true });
    const token = (await ann.post(`/api/moms/${id}/shares`, { via: 'email', to: 'priya@out.test' })).body.link.split('/#/shared/')[1];
    const p = await openPage(app, '#/shared/' + token);
    await p.until(() => p.text().includes('p***@out.test'), 'masked hint');
    expect(p.doc.getElementById('sh-email').value).toBe('');
    expect(p.text()).not.toContain('priya@out.test');
  });
});

describe('UI: honest messages', () => {
  test('when e-mail is not switched on, sign-in says so instead of pretending a code was sent', async () => {
    const app = makeApp({ MOM_MODE: 'production', PUBLIC_BASE_URL: undefined, SESSION_SECRET: 's', RESEND_API_KEY: undefined });
    const p = await openPage(app, '#/signin');
    await p.until(() => p.text().includes('E-mail is not switched on yet'), 'warning');
    p.type('si-email', 'a@b.test');
    await p.click('si-send');
    await p.until(() => p.doc.getElementById('toast').textContent.length > 5, 'error toast');
    expect(p.doc.getElementById('si-code')).toBeNull(); // never moved on to the "enter your code" step
  });

  test('pricing no longer promises a cancellation that does not exist', async () => {
    const p = await openPage(makeApp(), '#/pricing');
    await p.until(() => p.text().includes('Simple pricing'), 'pricing');
    expect(p.text()).not.toContain('Cancel whenever');
    expect(p.text()).toContain('never renew');
  });

  test('a double tap or a dropped connection cannot create a MOM twice (every change carries a one-time key)', async () => {
    const app = makeApp();
    const p = await openPage(app);
    await uiSignIn(p, 'asha@sunrise.test');
    // drop the first answer after the server has already done the work, as a flaky mobile network does
    const real = p.win.fetch; let dropped = false;
    p.win.fetch = async (u: string, i: RequestInit) => { const r = await real(u, i); if (!dropped && i.method === 'POST' && String(u) === '/api/moms') { dropped = true; throw new TypeError('network'); } return r; };
    await p.go('#/new');
    await p.until(() => !!p.doc.getElementById('mf-title'), 'form');
    p.type('mf-title', 'Only once');
    await p.click('save-mom');
    await p.until(() => p.text().includes('Only once') && !!p.doc.getElementById('ap-title'), 'MOM page');
    expect(dropped).toBe(true);
    expect(one(app, "SELECT COUNT(*) AS n FROM moms WHERE title = 'Only once'").n).toBe(1);
  });
});

describe('UI: the payment window is the central payment frame', () => {
  test('buying opens the frame, sends the order only after "ready", confirms through the server, and Cancel closes it', async () => {
    const CENTRAL = 'https://itservices-rajat-agarwal.pages.dev';
    const fake = (async (url: any, init?: any) => {
      const b = JSON.parse(init.body);
      if (String(url).endsWith('/api/pay/order')) return new Response(JSON.stringify({ ok: true, keyId: 'rzp_live_PUBLIC', orderId: 'order_C49900', amount_minor: b.amount_minor, currency: 'INR' }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, paid: true, amount_minor: 49900, currency: 'INR', stream: 'sales', product: 'mom', plan: 'monthly', payment_ref: (one(app, 'SELECT id FROM orders') as any).id, razorpay_order_id: b.razorpay_order_id, razorpay_payment_id: b.razorpay_payment_id }), { status: 200 });
    }) as any;
    const app = makeApp({ PAY_SERVICE_KEY: 'k', PAY_SITE: 'mom.example', PAY_LIVE_OK: 'owner-approved' }, fake);
    const p = await openPage(app);
    await uiSignIn(p, 'asha@sunrise.test');
    await p.go('#/pricing');
    await p.until(() => p.text().includes('Simple pricing'), 'pricing');
    const buy = async () => { await p.until(() => !!p.doc.querySelector('[data-act="buy"][data-p="monthly"]'), 'buy button'); p.doc.querySelector('[data-act="buy"][data-p="monthly"]').click(); }; // the action only ends when the frame does
    const posted: any[] = [];
    await buy();
    await p.until(() => !!p.doc.querySelector('iframe'), 'the payment frame');
    const f = p.doc.querySelector('iframe');
    expect(f.getAttribute('src')).toBe(`${CENTRAL}/payframe/`);
    expect(p.doc.body.textContent).toContain('Cancel');
    // a message from somewhere else is ignored; only the frame itself, from the central origin, is believed
    const fw: any = { postMessage: (m: any, o: string) => { posted.push({ m, o }); } }; Object.defineProperty(f, 'contentWindow', { value: fw }); // happy-dom does not load the frame, so stand in for it
    p.win.dispatchEvent(Object.assign(new p.win.Event('message'), { data: { t: 'ready' }, origin: 'https://evil.example', source: fw }));
    expect(posted.length).toBe(0);
    p.win.dispatchEvent(Object.assign(new p.win.Event('message'), { data: { t: 'ready' }, origin: CENTRAL, source: fw }));
    expect(posted.length).toBe(1); expect(posted[0].o).toBe(CENTRAL);
    expect(posted[0].m.opts).toMatchObject({ key: 'rzp_live_PUBLIC', order_id: 'order_C49900', amount: 49900, currency: 'INR' });
    p.win.dispatchEvent(Object.assign(new p.win.Event('message'), { data: { t: 'paid', resp: { razorpay_order_id: 'order_C49900', razorpay_payment_id: 'pay_9', razorpay_signature: 'sig' } }, origin: CENTRAL, source: fw }));
    await p.until(() => !p.doc.querySelector('iframe') && one(app, 'SELECT status FROM orders').status === 'paid', 'the order confirmed by the server');
    expect(one(app, 'SELECT plan FROM orgs').plan).toBe('monthly');
  });
});

describe('UI: a payment that could not be confirmed yet stays recoverable', () => {
  test('after a busy payment service the "Check my payment" banner stays on the screens, and pressing it finishes the job', async () => {
    const CENTRAL = 'https://itservices-rajat-agarwal.pages.dev';
    let busy = true;
    const fake = (async (url: any, init?: any) => {
      const b = JSON.parse(init.body);
      if (String(url).endsWith('/api/pay/order')) return new Response(JSON.stringify({ ok: true, keyId: 'rzp_live_PUBLIC', orderId: 'order_C49900', amount_minor: b.amount_minor, currency: 'INR' }), { status: 200 });
      if (busy) return new Response('busy', { status: 503 });
      return new Response(JSON.stringify({ ok: true, paid: true, amount_minor: 49900, currency: 'INR', stream: 'sales', product: 'mom', plan: 'monthly', payment_ref: (one(app, 'SELECT id FROM orders') as any).id, razorpay_order_id: b.razorpay_order_id, razorpay_payment_id: b.razorpay_payment_id }), { status: 200 });
    }) as any;
    const app = makeApp({ PAY_SERVICE_KEY: 'k', PAY_SITE: 'mom.example', PAY_LIVE_OK: 'owner-approved' }, fake);
    const p = await openPage(app);
    await uiSignIn(p, 'asha@sunrise.test');
    await p.go('#/pricing');
    await p.until(() => !!p.doc.querySelector('[data-act="buy"][data-p="monthly"]'), 'buy button');
    p.doc.querySelector('[data-act="buy"][data-p="monthly"]').click();
    await p.until(() => !!p.doc.querySelector('iframe'), 'the payment frame');
    const f = p.doc.querySelector('iframe'); const fw: any = { postMessage: () => {} }; Object.defineProperty(f, 'contentWindow', { value: fw });
    p.win.dispatchEvent(Object.assign(new p.win.Event('message'), { data: { t: 'paid', resp: { razorpay_order_id: 'order_C49900', razorpay_payment_id: 'pay_9', razorpay_signature: 'sig' } }, origin: CENTRAL, source: fw }));
    await p.until(() => p.text().includes('We are checking your payment'), 'the check screen');
    expect(one(app, 'SELECT status FROM orders').status).toBe('created');
    await p.click('close');
    await p.go('#/home'); await p.go('#/pricing');
    await p.until(() => p.text().includes('Check my payment'), 'the banner stays after closing and moving on');
    busy = false;
    await p.click('recheck-pay');
    await p.until(() => one(app, 'SELECT status FROM orders').status === 'paid' && !p.text().includes('Check my payment'), 'paid and the banner gone');
    expect(one(app, 'SELECT plan FROM orgs').plan).toBe('monthly');
  });
});
