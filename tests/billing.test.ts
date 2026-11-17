import { describe, expect, test } from 'bun:test';
import { hmacHex } from '../src/server/util.ts';
import { makeApp, owner, prodApp, prodSignIn, signIn } from './helpers.ts';

async function pay(app: any, b: any, plan: string) {
  const c = await b.post('/api/billing/checkout', { plan });
  expect(c.status).toBe(201);
  const mp = await b.post('/api/billing/mock-pay', { orderId: c.body.orderId });
  return { c, mp, verify: () => b.post('/api/billing/verify', mp.body) };
}

describe('checkout (mock provider)', () => {
  test('prices are set by the server: Rs 499 monthly, Rs 4,999 for 12 months; the browser cannot choose an amount', async () => {
    const app = makeApp();
    const ann = await owner(app);
    const m = await ann.post('/api/billing/checkout', { plan: 'monthly', amountPaise: 1 });
    expect(m.body).toMatchObject({ amountPaise: 49900, currency: 'INR', provider: 'mock', mode: 'mock', payee: 'IT SERVICES BY RAJAT AGARWAL' });
    const y = await ann.post('/api/billing/checkout', { plan: 'yearly' });
    expect(y.body.amountPaise).toBe(499900);
    expect((await ann.post('/api/billing/checkout', { plan: 'free' })).body.error.code).toBe('BAD_PLAN');
    expect((await ann.post('/api/billing/checkout', { plan: '__proto__' })).body.error.code).toBe('BAD_PLAN');
  });

  test('a successful payment activates the plan for 30 days / 365 days and sends a receipt', async () => {
    const app = makeApp();
    const ann = await owner(app);
    const { verify } = await pay(app, ann, 'monthly');
    const r = await verify();
    expect(r.status).toBe(200);
    expect(r.body.paid).toBe(true);
    const org = (await ann.get('/api/state')).body.org;
    expect(org.plan).toBe('active');
    expect(org.planName).toBe('monthly');
    expect((Date.parse(org.until) - app.clock.t) / 86400000).toBe(30);
    expect(app.outbox('ann@team.test').some((m) => m.kind === 'receipt' && m.body.includes('IT SERVICES BY RAJAT AGARWAL'))).toBe(true);
    const y = await pay(app, ann, 'yearly');
    await y.verify();
    const org2 = (await ann.get('/api/state')).body.org;
    expect((Date.parse(org2.until) - app.clock.t) / 86400000).toBe(30 + 365); // paying early adds on top
  });

  test('verifying twice does not extend twice', async () => {
    const app = makeApp();
    const ann = await owner(app);
    const { verify } = await pay(app, ann, 'monthly');
    const a = await verify();
    const b = await verify();
    expect(a.body.extended).toBe(true);
    expect(b.body.extended).toBe(false);
    expect((Date.parse((await ann.get('/api/state')).body.org.until) - app.clock.t) / 86400000).toBe(30);
  });

  test('a forged signature is refused, nothing is activated', async () => {
    const app = makeApp();
    const ann = await owner(app);
    const c = await ann.post('/api/billing/checkout', { plan: 'monthly' });
    const bad = await ann.post('/api/billing/verify', { orderId: c.body.providerOrderId, paymentId: 'pay_fake', signature: 'deadbeef' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_SIGNATURE');
    expect((await ann.get('/api/state')).body.org.plan).toBe('trial');
    expect((app.raw.query('SELECT status FROM orders').get() as any).status).toBe('created'); // an unconfirmed payment never closes the order (the 24-hour reuse still protects a buyer who really paid)
  });

  test('only the team owner can buy; one team cannot pay for or see another team\'s order', async () => {
    const app = makeApp();
    const ann = await owner(app);
    await ann.post('/api/team/members', { email: 'bob@team.test' });
    const bob = await signIn(app, 'bob@team.test');
    expect((await bob.post('/api/billing/checkout', { plan: 'monthly' })).status).toBe(403);
    const { mp } = await pay(app, ann, 'monthly');
    const zed = await signIn(app, 'zed@other.test', 'Zed', 'Other');
    expect((await zed.post('/api/billing/verify', mp.body)).status).toBe(404);
    expect((await zed.get('/api/billing/orders')).body.orders).toEqual([]);
  });

  test('the billing screen data lists plans and the payee', async () => {
    const app = makeApp();
    const ann = await owner(app);
    const b = await ann.get('/api/billing');
    expect(b.body.plans.map((p: any) => p.amountPaise)).toEqual([49900, 499900]);
    expect(b.body).toMatchObject({ state: 'trial', maxUsers: 10, payee: 'IT SERVICES BY RAJAT AGARWAL' });
    expect((await app.browser().get('/api/billing')).status).toBe(401);
  });
});

describe('production safety', () => {
  test('the mock payment helper does not exist in production, and checkout says payments are not ready', async () => {
    const app = prodApp();
    const b = await prodSignIn(app, 'ann@team.test'); // the real flow: the code arrives through the (fake) Resend, never in the response
    expect((await b.post('/api/billing/checkout', { plan: 'monthly' })).body.error.code).toBe('PAYMENTS_NOT_READY');
    expect((await b.post('/api/billing/mock-pay', { orderId: 'x' })).status).toBe(404);
  });

  test('without the central service connected (or half set up) nothing real can be charged, and no network call is made', async () => {
    const app = makeApp({ MOM_MODE: 'production', PUBLIC_BASE_URL: undefined, SESSION_SECRET: 'prod-secret-xyz' });
    expect(app.ctx.payments.id).toBe('mock');
    const half = makeApp({ PAY_SERVICE_KEY: 'k' }); // a key without a site code
    const r = await (await owner(half)).post('/api/billing/checkout', { plan: 'monthly' });
    expect(r.status).toBe(503); expect(r.body.error.code).toBe('LIVE_PAYMENTS_DISABLED');
    const plain = makeApp({ PAY_SERVICE_KEY: 'k', PAY_SITE: 'mom.example', PAY_SERVICE_URL: 'http://central.example' }); // a key never goes over plain http to a real host
    expect((await (await owner(plain)).post('/api/billing/checkout', { plan: 'monthly' })).status).toBe(503);
    expect(half.fetchCalls.length + plain.fetchCalls.length).toBe(0);
  });
});

describe('the central payment service (Games pattern)', () => {
  const CENTRAL = 'https://itservices-rajat-agarwal.pages.dev';
  const env = { PAY_SERVICE_KEY: 'mom-site-key-for-tests', PAY_SITE: 'mom.example', PAY_LIVE_OK: 'owner-approved' };
  /** A fake central service. Options make its /verify answer wrong in one way at a time. */
  const fake = (o: { keyId?: string; paid?: boolean; amount?: number; ref?: string | null; plan?: string; down?: boolean; status?: number; rzpOrder?: string; rzpPay?: string } = {}) => {
    let ref = '';
    return (async (url: any, init?: any) => {
      expect(String(url).startsWith(CENTRAL)).toBe(true); // the only host this site ever talks to
      if (init?.redirect && !['follow', 'manual'].includes(init.redirect)) throw new TypeError('Invalid redirect value, must be one of follow or manual'); // what the Workers runtime does
      if (o.down) throw new Error('network down');
      const b = JSON.parse(init.body);
      if (String(url) === `${CENTRAL}/api/pay/order`) {
        ref = b.payment_ref;
        return new Response(JSON.stringify({ ok: true, keyId: o.keyId ?? 'rzp_live_PUBLIC', orderId: 'order_C' + b.amount_minor, amount_minor: b.amount_minor, currency: b.currency }), { status: o.status ?? 200 });
      }
      return new Response(JSON.stringify({ ok: true, paid: o.paid ?? true, amount_minor: o.amount ?? 49900, currency: 'INR', stream: 'sales', product: 'mom', plan: o.plan ?? 'monthly', payment_ref: o.ref === undefined ? ref : o.ref, razorpay_order_id: o.rzpOrder ?? b.razorpay_order_id, razorpay_payment_id: o.rzpPay ?? b.razorpay_payment_id }), { status: 200 });
    }) as any;
  };
  const verifyBody = { orderId: 'order_C49900', paymentId: 'pay_123', signature: 'sig' };

  test('the order is opened by the central service with the site key and the server price; no Razorpay call, no Razorpay key', async () => {
    const app = makeApp(env, fake());
    const ann = await owner(app);
    const c = await ann.post('/api/billing/checkout', { plan: 'monthly', amountPaise: 1 });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ provider: 'central', keyId: 'rzp_live_PUBLIC', providerOrderId: 'order_C49900', frameUrl: `${CENTRAL}/payframe/`, amountPaise: 49900 });
    expect(app.fetchCalls.length).toBe(1);
    const call = app.fetchCalls[0]! as any; const sent = JSON.parse(call.init.body);
    expect(call.url).toBe(`${CENTRAL}/api/pay/order`); expect(call.init.headers['x-site-key']).toBe('mom-site-key-for-tests');
    expect(sent).toMatchObject({ site: 'mom.example', product: 'mom', plan: 'monthly', amount_minor: 49900, currency: 'INR', payment_ref: c.body.orderId });
    expect(call.init.redirect).toBe('manual'); expect(call.init.signal).toBeDefined();
    expect(JSON.stringify(c.body)).not.toContain('mom-site-key-for-tests');
    expect((await ann.post('/api/billing/mock-pay', { orderId: c.body.orderId })).status).toBe(404); // no mock helper next to the real provider
    // a second tap opens the same order again, with the same public key id, and asks the service for nothing new
    const again = await ann.post('/api/billing/checkout', { plan: 'monthly' });
    expect(again.body).toMatchObject({ reused: true, keyId: 'rzp_live_PUBLIC', providerOrderId: 'order_C49900' }); expect(app.fetchCalls.length).toBe(1);
  });

  test('verify activates the plan only when the central service confirms every fact about THIS order', async () => {
    for (const bad of [{ paid: false }, { amount: 100 }, { ref: 'ord_someoneelse' }, { ref: null }, { plan: 'yearly' }, { rzpOrder: 'order_Other' }, { rzpPay: 'pay_Other' }]) {
      const app = makeApp(env, fake(bad));
      const ann = await owner(app);
      await ann.post('/api/billing/checkout', { plan: 'monthly' });
      const v = await ann.post('/api/billing/verify', verifyBody);
      expect(v.status).toBe(400);
      expect((await ann.get('/api/state')).body.org.plan).toBe('trial');
    }
    const app = makeApp(env, fake());
    const ann = await owner(app);
    await ann.post('/api/billing/checkout', { plan: 'monthly' });
    const v = await ann.post('/api/billing/verify', verifyBody);
    expect(v.body).toMatchObject({ paid: true, extended: true });
    expect((await ann.get('/api/state')).body.org.plan).toBe('active');
    expect((await ann.post('/api/billing/verify', verifyBody)).body.extended).toBe(false); // never twice
    expect(JSON.stringify(app.raw.query('SELECT detail FROM audit_log').all())).not.toContain('mom-site-key-for-tests');
  });

  test('the central service being down is a calm message, never a failed order; a retry then works', async () => {
    const app = makeApp(env, fake({ down: true }));
    const ann = await owner(app);
    const r = await ann.post('/api/billing/checkout', { plan: 'monthly' });
    expect(r.status).toBe(502);
    expect((app.raw.query('SELECT COUNT(*) AS n FROM orders').get() as any).n).toBe(0);
    const app2 = makeApp(env, (async (url: any, init?: any) => String(url).endsWith('/order') ? fake()(url, init) : (() => { throw new Error('down'); })()) as any);
    const a2 = await owner(app2);
    await a2.post('/api/billing/checkout', { plan: 'monthly' });
    const v = await a2.post('/api/billing/verify', verifyBody);
    expect(v.status).toBe(502);
    expect((app2.raw.query('SELECT status FROM orders').get() as any).status).toBe('created'); // an outage never marks an order failed
    expect(v.body.error.message).toContain('safe');
  });

  test('a live Razorpay key is refused unless the owner approves it; a wrong site key has its own code', async () => {
    const app = makeApp({ PAY_SERVICE_KEY: env.PAY_SERVICE_KEY, PAY_SITE: env.PAY_SITE }, fake({ keyId: 'rzp_live_ABC123' }));
    const r = await (await owner(app)).post('/api/billing/checkout', { plan: 'monthly' });
    expect(r.status).toBe(503); expect(r.body.error.code).toBe('LIVE_PAYMENTS_DISABLED');
    expect((app.raw.query('SELECT COUNT(*) AS n FROM orders').get() as any).n).toBe(0);
    const ok = makeApp({ ...env, PAY_LIVE_OK: 'owner-approved' }, fake({ keyId: 'rzp_live_ABC123' }));
    expect((await (await owner(ok)).post('/api/billing/checkout', { plan: 'monthly' })).status).toBe(201);
    const wrong = makeApp(env, fake({ status: 401 }));
    const w = await (await owner(wrong)).post('/api/billing/checkout', { plan: 'monthly' });
    expect(w.status).toBe(502); expect(w.body.error.code).toBe('PAYMENT_SERVICE_CONFIG');
    const odd = makeApp(env, fake({ keyId: 'not-a-key' }));
    expect((await (await owner(odd)).post('/api/billing/checkout', { plan: 'monthly' })).status).toBe(502);
  });

  test('there is no Razorpay webhook any more, and the code holds no Razorpay key or address', async () => {
    const app = makeApp(env, fake());
    expect((await app.browser().req('POST', '/api/billing/webhook', '{}')).status).toBeGreaterThanOrEqual(400);
    const fs = require('node:fs');
    const src = ['services/payments.ts', 'services/billing.ts', 'api.ts', 'ctx.ts'].map((f) => fs.readFileSync(`${import.meta.dir}/../src/server/${f}`, 'utf8')).join('\n') + fs.readFileSync(`${import.meta.dir}/../public/app.js`, 'utf8');
    expect(src).not.toMatch(/RAZORPAY_|api\.razorpay\.com|checkout\.razorpay\.com|new window\.Razorpay|x-razorpay-signature/);
  });
});

describe('the central payment service: round 1 fixes', () => {
  const CENTRAL = 'https://itservices-rajat-agarwal.pages.dev';
  const env = { PAY_SERVICE_KEY: 'mom-site-key-for-tests', PAY_SITE: 'mom.example', PAY_LIVE_OK: 'owner-approved' };
  const answer = (verifyStatus: number, verifyBody: object = {}) => (async (url: any, init?: any) => {
    const b = JSON.parse(init.body);
    if (String(url) === `${CENTRAL}/api/pay/order`) return new Response(JSON.stringify({ ok: true, keyId: 'rzp_live_PUBLIC', orderId: 'order_C' + b.amount_minor, amount_minor: b.amount_minor, currency: 'INR' }), { status: 200 });
    return new Response(JSON.stringify(verifyBody), { status: verifyStatus });
  }) as any;
  const verifyBody = { orderId: 'order_C49900', paymentId: 'pay_123', signature: 'sig' };

  test('a busy or refusing service (401, 429, 500) is an error the buyer can retry; the order is never marked failed', async () => {
    for (const st of [401, 429, 500, 503]) {
      const app = makeApp(env, answer(st));
      const ann = await owner(app);
      await ann.post('/api/billing/checkout', { plan: 'monthly' });
      const v = await ann.post('/api/billing/verify', verifyBody);
      expect(v.status).toBe(502); expect(v.body.error.message).toContain('Check my payment');
      expect((app.raw.query('SELECT status FROM orders').get() as any).status).toBe('created');
    }
    // a definite "no" from the service is a refusal for now, but the order stays open so a later good answer can still finish it
    const app = makeApp(env, answer(409, { error: 'payment does not match the order' }));
    const ann = await owner(app);
    await ann.post('/api/billing/checkout', { plan: 'monthly' });
    expect((await ann.post('/api/billing/verify', verifyBody)).status).toBe(400);
    expect((app.raw.query('SELECT status FROM orders').get() as any).status).toBe('created');
  });

  test('an order is only confirmed by the provider that opened it', async () => {
    const app = makeApp(env, answer(200, { ok: true, paid: true, amount_minor: 49900, currency: 'INR', stream: 'sales', product: 'mom', plan: 'monthly' }));
    const ann = await owner(app);
    const c = await ann.post('/api/billing/checkout', { plan: 'monthly' });
    app.raw.exec("UPDATE orders SET provider = 'mock'"); // as if the central keys were removed and the mock took over
    expect((await ann.post('/api/billing/verify', { ...verifyBody, orderId: c.body.providerOrderId })).status).toBe(404);
  });

  test('a team cannot open more than 20 orders an hour, and a reused order shows its own amount', async () => {
    const app = makeApp(env, answer(200));
    const ann = await owner(app);
    const c = await ann.post('/api/billing/checkout', { plan: 'monthly' });
    const orgId = (app.raw.query('SELECT org_id FROM orders').get() as any).org_id;
    for (let i = 0; i < 19; i++) app.raw.query("INSERT INTO orders (id, org_id, plan, amount_paise, currency, provider, provider_order_id, status, created_by, created_at) VALUES (?,?,?,?, 'INR', 'central', ?, 'failed', 'x', ?)").run('ordx' + i, orgId, 'yearly', 1, 'order_x' + i, new Date(app.clock.t).toISOString());
    expect((await ann.post('/api/billing/checkout', { plan: 'yearly' })).status).toBe(429);
    app.raw.exec("UPDATE orders SET amount_paise = 12300 WHERE id = '" + c.body.orderId + "'");
    expect((await ann.post('/api/billing/checkout', { plan: 'monthly' })).body.amountPaise).toBe(12300);
  });

  test('a half-set-up service reports not ready', async () => {
    const half = makeApp({ PAY_SERVICE_KEY: 'k' });
    expect((await half.browser().req('GET', '/api/config')).body.payments.ready).toBe(false);
  });
});

describe('the central payment service: round 4 fixes', () => {
  const CENTRAL = 'https://itservices-rajat-agarwal.pages.dev';
  const env = { PAY_SERVICE_KEY: 'mom-site-key-for-tests', PAY_SITE: 'mom.example' };
  const central = (keyId: string, paid = true) => (async (url: any, init?: any) => {
    const b = JSON.parse(init.body);
    if (String(url) === `${CENTRAL}/api/pay/order`) return new Response(JSON.stringify({ ok: true, keyId, orderId: 'order_C' + b.amount_minor, amount_minor: b.amount_minor, currency: 'INR' }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, paid, amount_minor: 49900, currency: 'INR', stream: 'sales', product: 'mom', plan: 'monthly', payment_ref: (JSON.parse(JSON.stringify(app0.raw.query('SELECT id FROM orders').get())) as any).id, razorpay_order_id: b.razorpay_order_id, razorpay_payment_id: b.razorpay_payment_id }), { status: 200 });
  }) as any;
  let app0: any;
  const body = { orderId: 'order_C49900', paymentId: 'pay_1', signature: 's' };

  test('when live is approved a test key is refused at checkout', async () => {
    app0 = makeApp({ ...env, PAY_LIVE_OK: 'owner-approved' }, central('rzp_test_PUB'));
    const r = await (await owner(app0)).post('/api/billing/checkout', { plan: 'monthly' });
    expect(r.status).toBe(503); expect(r.body.error.code).toBe('PAYMENT_KEY_MISMATCH');
    expect((app0.raw.query('SELECT COUNT(*) AS n FROM orders').get() as any).n).toBe(0);
  });

  test('a payment made with a test key never buys a plan, whatever ENFORCE_PLAN says; the order stays open and the proof is in the audit log', async () => {
    for (const enforce of ['0', '1']) {
      app0 = makeApp({ ...env, ENFORCE_PLAN: enforce }, central('rzp_test_PUB'));
      const ann = await owner(app0);
      await ann.post('/api/billing/checkout', { plan: 'monthly' });
      const v = await ann.post('/api/billing/verify', body);
      expect(v.status).toBe(409); expect(v.body.error.code).toBe('TEST_PAYMENT');
      expect((await ann.get('/api/state')).body.org.plan).toBe('trial');
      expect((app0.raw.query('SELECT status FROM orders').get() as any).status).toBe('created');
      expect((app0.raw.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'test_payment_verified'").get() as any).n).toBe(1);
    }
  });

  test('an unpaid test order from before go-live is not reused once the site is live', async () => {
    app0 = makeApp({ ...env, PAY_LIVE_OK: 'owner-approved' }, central('rzp_live_PUB'));
    const ann = await owner(app0);
    const a = await ann.post('/api/billing/checkout', { plan: 'monthly' });
    app0.raw.exec("UPDATE orders SET key_id = 'rzp_test_OLD', provider_order_id = 'order_OLDX'");
    const b = await ann.post('/api/billing/checkout', { plan: 'monthly' });
    expect(b.status).toBe(201); expect(b.body.orderId).not.toBe(a.body.orderId); expect(b.body.keyId).toBe('rzp_live_PUB');
  });

  test('the new end date is worked out by the database: a live monthly payment ends exactly 30 days after payment', async () => {
    app0 = makeApp({ ...env, PAY_LIVE_OK: 'owner-approved' }, central('rzp_live_PUB'));
    const ann = await owner(app0);
    const m = await ann.post('/api/billing/checkout', { plan: 'monthly' });
    const r1 = await ann.post('/api/billing/verify', { orderId: m.body.providerOrderId, paymentId: 'pay_1', signature: 's' });
    expect(r1.body.paid).toBe(true);
    const until = Date.parse((await ann.get('/api/state')).body.org.until);
    expect((until - app0.clock.t) / 86400000).toBe(30);
  });

  test('paying monthly on top of a running yearly plan adds 30 days and keeps the yearly label; an unreadable stored date counts as "now"', async () => {
    app0 = makeApp({ ...env, PAY_LIVE_OK: 'owner-approved' }, central('rzp_live_PUB'));
    const ann = await owner(app0);
    const end = new Date(app0.clock.t + 100 * 86400000).toISOString();
    app0.raw.exec("UPDATE orgs SET plan = 'yearly', plan_until = '" + end + "'");
    const m = await ann.post('/api/billing/checkout', { plan: 'monthly' });
    expect((await ann.post('/api/billing/verify', { orderId: m.body.providerOrderId, paymentId: 'pay_1', signature: 's' })).body.paid).toBe(true);
    const row = app0.raw.query('SELECT plan, plan_until FROM orgs').get() as any;
    expect(row.plan).toBe('yearly'); expect((Date.parse(row.plan_until) - Date.parse(end)) / 86400000).toBe(30);
    // a hand-typed date nobody can read never wipes the purchase
    app0 = makeApp({ ...env, PAY_LIVE_OK: 'owner-approved' }, central('rzp_live_PUB'));
    const bob = await owner(app0);
    app0.raw.exec("UPDATE orgs SET plan_until = '01/01/2027'");
    const m2 = await bob.post('/api/billing/checkout', { plan: 'monthly' });
    await bob.post('/api/billing/verify', { orderId: m2.body.providerOrderId, paymentId: 'pay_2', signature: 's' });
    expect(((Date.parse((app0.raw.query('SELECT plan_until FROM orgs').get() as any).plan_until)) - app0.clock.t) / 86400000).toBe(30);
  });

  test('a central order with no live key on file never buys a plan', async () => {
    app0 = makeApp({ ...env, PAY_LIVE_OK: 'owner-approved' }, central('rzp_live_PUB'));
    const ann = await owner(app0);
    const m = await ann.post('/api/billing/checkout', { plan: 'monthly' });
    app0.raw.exec("UPDATE orders SET key_id = NULL");
    const v = await ann.post('/api/billing/verify', { orderId: m.body.providerOrderId, paymentId: 'pay_1', signature: 's' });
    expect(v.status).toBe(409); expect(v.body.error.code).toBe('TEST_PAYMENT');
    expect((await ann.get('/api/state')).body.org.plan).toBe('trial');
  });

  test('the browser sends no one-time key with a payment confirmation, so a retry always reaches the real answer', () => {
    const js = require('node:fs').readFileSync('public/app.js', 'utf8');
    expect(js).toContain("path !== '/api/billing/verify'");
    expect(js).toContain("e.code === 'TEST_PAYMENT'");
    expect(js).not.toMatch(/e\.status === 409\)\) clearPaid/);
  });

  test('the same payment confirmed again is "already paid": no second call to the payment service, nothing extended twice', async () => {
    app0 = makeApp({ ...env, PAY_LIVE_OK: 'owner-approved' }, central('rzp_live_PUB'));
    const ann = await owner(app0);
    const m = await ann.post('/api/billing/checkout', { plan: 'monthly' });
    const vb = { orderId: m.body.providerOrderId, paymentId: 'pay_1', signature: 's' };
    expect((await ann.post('/api/billing/verify', vb)).body.extended).toBe(true);
    const until1 = (app0.raw.query('SELECT plan_until FROM orgs').get() as any).plan_until;
    const calls = app0.fetchCalls.length;
    const again = await ann.post('/api/billing/verify', vb);
    expect(again.status).toBe(200); expect(again.body.paid).toBe(true); expect(again.body.already).toBe(true);
    expect(app0.fetchCalls.length).toBe(calls);
    expect((app0.raw.query('SELECT plan_until FROM orgs').get() as any).plan_until).toBe(until1);
    // a different payment id on a paid order is NOT waved through: it goes to the service, which refuses it
    const other = await ann.post('/api/billing/verify', { ...vb, paymentId: 'pay_2' });
    expect(other.body.already).toBeUndefined();
  });

  test('the pay banner belongs to the person who paid: S.me is an e-mail string and the banner compares against it', () => {
    const js = require('node:fs').readFileSync('public/app.js', 'utf8');
    expect(js).toContain("payPending && S.me && payPending.email === S.me");
    expect(js).toContain("p.email = S.me || '';");
    expect(js).not.toContain('S.me.email');
  });

  test('an unpaid order is reused for 24 hours, so a buyer whose browser never reported the payment is not sent to pay twice', async () => {
    app0 = makeApp(env, central('rzp_test_PUB'));
    const ann = await owner(app0);
    const a = await ann.post('/api/billing/checkout', { plan: 'monthly' });
    app0.advance(23 * 3600_000);
    const b = await ann.post('/api/billing/checkout', { plan: 'monthly' });
    expect(b.body.orderId).toBe(a.body.orderId); expect(b.body.reused).toBe(true);
    app0.advance(2 * 3600_000);
    expect((await ann.post('/api/billing/checkout', { plan: 'monthly' })).body.orderId).not.toBe(a.body.orderId);
  });
});

describe('the central payment service: 24-hour reuse ends cleanly', () => {
  test('after 24 hours a new central order is opened and the old one is left alone', async () => {
    let n = 0;
    const f = (async (_u: any, init?: any) => { const b = JSON.parse(init.body); return new Response(JSON.stringify({ ok: true, keyId: 'rzp_test_PUB', orderId: 'order_N' + ++n, amount_minor: b.amount_minor, currency: 'INR' }), { status: 200 }); }) as any;
    const app = makeApp({ PAY_SERVICE_KEY: 'k', PAY_SITE: 'mom.example' }, f);
    const ann = await owner(app);
    const a = await ann.post('/api/billing/checkout', { plan: 'monthly' });
    app.advance(25 * 3600_000);
    const c = await ann.post('/api/billing/checkout', { plan: 'monthly' });
    expect(c.status).toBe(201); expect(c.body.orderId).not.toBe(a.body.orderId); expect(c.body.providerOrderId).toBe('order_N2');
  });
});
