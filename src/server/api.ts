// The whole HTTP API as one pure function: (Ctx, Request) -> Response.
// Cloudflare Pages Functions, the local dev server and the tests all call exactly this.
import { appHost, isDev, sql, type Ctx } from './ctx.ts';
import { MAX_USERS, PAYEE, PLANS, TRIAL_DAYS } from './core/plans.ts';
import { STATUS_META, STATUSES } from './core/status.ts';
import { HttpError, json, sha256Hex } from './util.ts';
import { authenticate, clearCookie, COOKIE, GUEST_COOKIE, GUEST_SESSION_DAYS, requireActor, requireUser, SESSION_DAYS, sessionCookie, signOut, signIn, startCode, type Actor } from './services/auth.ts';
import { billingInfo, billingOrders, checkout, mockPay, orderReceipt, requestRefund, verifyPayment } from './services/billing.ts';
import { mailBudgets, mailReady } from './services/mail.ts';
import { addPointToCalendar, callback, connect, disconnect, listIntegrations } from './services/integrations.ts';
import * as M from './services/moms.ts';
import * as T from './services/team.ts';

const MAX_BODY = 1_700_000;
type Handler = (c: Ctx, req: Request, a: Actor | null, p: string[], url: URL) => Promise<Response>;
const routes: [string, RegExp, Handler][] = [];
const on = (method: string, path: string, h: Handler) => routes.push([method, new RegExp('^' + path.replace(/:\w+/g, '([^/]+)') + '$'), h]);

async function body(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'TOO_BIG', 'That request is too large.');
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* fall through */ }
  throw new HttpError(400, 'BAD_JSON', 'The request was not valid JSON.');
}

// ---- public
on('GET', '/api/health', async (c) => json({ ok: true, mode: isDev(c.env) ? 'dev' : 'production', time: c.now().toISOString() }));
on('GET', '/api/config', async (c) =>
  json({
    host: appHost(c.env), mode: isDev(c.env) ? 'dev' : 'production', devMail: isDev(c.env),
    // Honest readiness: the screens can warn instead of pretending ("mail.ready:false" = no sign-in code can be delivered).
    mail: { provider: c.mailer.id, ready: mailReady(c), dailyBudget: mailBudgets(c.env) },
    enforcePlan: c.env.ENFORCE_PLAN === '1', shareDays: Number(c.env.SHARE_TTL_DAYS || 30),
    payments: { provider: c.payments.id, mode: c.payments.mode, ready: !c.payments.disabled && (c.payments.id !== 'mock' || isDev(c.env)) }, payee: PAYEE,
    trialDays: TRIAL_DAYS, maxUsers: MAX_USERS, plans: Object.values(PLANS).map((p) => ({ id: p.id, label: p.label, amountPaise: p.amountPaise, days: p.days })),
    statuses: STATUSES.map((s) => ({ id: s, ...STATUS_META[s] })),
  }),
);

// ---- auth
on('POST', '/api/auth/start', async (c, req) => {
  const b = await body(req);
  return json(await startCode(c, b.email, 'signin', { name: b.name, team: b.team }));
});
on('POST', '/api/auth/verify', async (c, req) => {
  const b = await body(req);
  const r = await signIn(c, b.email, b.code);
  return json({ ok: true, created: r.created, user: { email: r.user.email, name: r.user.name } }, 200, { 'set-cookie': sessionCookie(c, r.token, SESSION_DAYS) });
});
on('POST', '/api/auth/logout', async (c, req) => {
  await signOut(c, req);
  const res = json({ ok: true }, 200, { 'set-cookie': clearCookie(c, COOKIE) });
  res.headers.append('set-cookie', clearCookie(c, GUEST_COOKIE));
  return res;
});
on('GET', '/api/state', async (c, _r, a) => json(await M.snapshot(c, requireActor(a))));

// ---- team
on('POST', '/api/team/members', async (c, req, a) => json(await T.addTeamMember(c, a, await body(req))));
on('POST', '/api/team/members/remove', async (c, req, a) => json(await T.removeMember(c, a, (await body(req)).email)));
on('POST', '/api/team/owner', async (c, req, a) => json(await T.transferOwnership(c, a, (await body(req)).email)));

// ---- MOMs
on('POST', '/api/moms', async (c, req, a) => json(await M.createMom(c, a, await body(req)), 201));
on('POST', '/api/moms/merge', async (c, req, a) => json(await M.mergeMoms(c, a, await body(req)), 201));
on('PATCH', '/api/moms/:id', async (c, req, a, p) => json(await M.updateMom(c, a, p[0], await body(req))));
on('POST', '/api/moms/:id/publish', async (c, _r, a, p) => json(await M.publishMom(c, a, p[0])));
on('DELETE', '/api/moms/:id', async (c, req, a, p) => json(await M.deleteMom(c, a, p[0], { forAll: false, confirm: (await body(req)).confirm })));
on('POST', '/api/moms/:id/delete-for-all', async (c, req, a, p) => json(await M.deleteMom(c, a, p[0], { forAll: true, confirm: (await body(req)).confirm })));
on('POST', '/api/moms/:id/points', async (c, req, a, p) => json(await M.addPoint(c, a, p[0], await body(req)), 201));
on('POST', '/api/moms/:id/attachments', async (c, req, a, p) => json(await M.addAttachment(c, a, { momId: p[0] }, await body(req)), 201));
on('POST', '/api/moms/:id/shares', async (c, req, a, p) => json(await M.shareMom(c, a, p[0], await body(req)), 201));
on('POST', '/api/shares/:id/cancel', async (c, _r, a, p) => json(await M.revokeShare(c, a, p[0])));
on('GET', '/api/moms/:id/pdf', async (c, _r, a, p) => {
  const f = await M.momPdfBytes(c, a, p[0]);
  return new Response(f.bytes, { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${f.name}.pdf"`, 'cache-control': 'private, no-store', ...(f.lossy ? { 'x-pdf-lossy': '1' } : {}) } });
});

// ---- points
on('PATCH', '/api/points/:id', async (c, req, a, p) => json(await M.updatePoint(c, a, p[0], await body(req))));
on('DELETE', '/api/points/:id', async (c, _r, a, p) => json(await M.deletePoint(c, a, p[0])));
on('POST', '/api/points/:id/status', async (c, req, a, p) => json(await M.setPointStatus(c, a, p[0], (await body(req)).status)));
on('POST', '/api/points/:id/owners', async (c, req, a, p) => json(await M.setPointOwners(c, a, p[0], await body(req))));
on('POST', '/api/points/:id/updates', async (c, req, a, p) => json(await M.postUpdate(c, a, p[0], (await body(req)).text), 201));
on('POST', '/api/points/:id/attachments', async (c, req, a, p) => json(await M.addAttachment(c, a, { pointId: p[0] }, await body(req)), 201));
on('POST', '/api/points/:id/calendar', async (c, req, a, p) => json(await addPointToCalendar(c, a, p[0], String((await body(req)).provider || ''))));
on('GET', '/api/attachments/:id', async (c, _r, a, p) => M.getAttachment(c, a, p[0]));

// ---- shared link gate (no account needed; e-mail code instead)
on('GET', '/api/shared/:token', async (c, _r, _a, p) => json(await M.sharePreview(c, p[0])));
on('GET', '/api/shared/:token/chain', async (c, _r, _a, p) => json(await M.shareChain(c, p[0])));
on('POST', '/api/shared/:token/code', async (c, req, _a, p) => json(await M.shareStartCode(c, p[0], (await body(req)).email)));
on('POST', '/api/shared/:token/verify', async (c, req, _a, p) => {
  const b = await body(req);
  const r = await M.shareVerify(c, p[0], b.email, b.code);
  // A separate cookie: opening a link never signs a signed-in person out.
  return json({ ok: true, momId: r.momId }, 200, { 'set-cookie': sessionCookie(c, r.token, GUEST_SESSION_DAYS, GUEST_COOKIE) });
});

// ---- integrations
on('GET', '/api/integrations', async (c, _r, a) => json(await listIntegrations(c, a)));
on('POST', '/api/integrations/:p/connect', async (c, _r, a, p) => json(await connect(c, a, p[0])));
on('DELETE', '/api/integrations/:p', async (c, _r, a, p) => json(await disconnect(c, a, p[0])));
on('GET', '/api/integrations/:p/callback', async (c, _r, a, p, url) => {
  const back = c.baseUrl + '/#/integrations';
  try {
    await callback(c, a, p[0], url.searchParams.get('code') || '', url.searchParams.get('state') || '');
    return new Response(null, { status: 302, headers: { location: back } });
  } catch (e) {
    return new Response(null, { status: 302, headers: { location: back + '?err=' + encodeURIComponent(e instanceof HttpError ? e.message : 'Could not connect') } });
  }
});

// ---- billing
on('GET', '/api/billing', async (c, _r, a) => json(billingInfo(c, requireUser(a).org)));
on('GET', '/api/billing/orders', async (c, _r, a) => json(await billingOrders(c, a)));
on('GET', '/api/billing/orders/:id/receipt', async (c, _r, a, p) => json(await orderReceipt(c, a, p[0])));
on('POST', '/api/billing/orders/:id/refund-request', async (c, req, a, p) => json(await requestRefund(c, a, p[0], await body(req)), 201));
on('POST', '/api/billing/checkout', async (c, req, a) => json(await checkout(c, a, await body(req)), 201));
on('POST', '/api/billing/mock-pay', async (c, req, a) => json(await mockPay(c, a, await body(req))));
on('POST', '/api/billing/verify', async (c, req, a) => json(await verifyPayment(c, a, await body(req))));

// ---- dev only: the "mailbox" (in production nothing is exposed)
on('GET', '/api/dev/outbox', async (c, _r, a) => {
  if (!isDev(c.env)) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
  const { user, org } = requireUser(a);
  const rows = await sql(c, 'SELECT at, to_addr, subject, body, kind, status FROM outbox WHERE org_id = ? OR to_addr = ? ORDER BY id DESC LIMIT 40', org.id, user.email).all();
  return json({ mails: rows.results });
});

const NO_ORIGIN_CHECK = new Set<string>(); // no route is exempt: there is no payment webhook here any more (the central service records payments; see payments.ts)

function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: { code: e.code, message: e.message, ...(e.extra ?? {}) } }, e.status);
  console.error('API error:', e instanceof Error ? e.message : 'unknown'); // message only: never log request bodies, cookies or keys
  return json({ error: { code: 'SERVER_ERROR', message: 'Something went wrong on our side. Please try again in a moment.' } }, 500);
}

const IDEM_KEY = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Runs `work` at most once per (user, Idempotency-Key). A repeat of the same request (double tap, flaky-network retry)
 * gets the first answer back with `idempotent-replay: true` instead of creating a second MOM / share / order.
 */
async function once(ctx: Ctx, scope: string, key: string, fp: string, work: () => Promise<Response>): Promise<Response> {
  const at = ctx.now().toISOString();
  const ins = await sql(ctx, "INSERT OR IGNORE INTO idempotency (scope, key, fp, state, created_at) VALUES (?,?,?, 'running', ?)", scope, key, fp, at).run();
  if (ins.meta.changes !== 1) {
    const row = await sql(ctx, 'SELECT fp, state, status, body FROM idempotency WHERE scope = ? AND key = ?', scope, key).first<{ fp: string; state: string; status: number | null; body: string | null }>();
    if (!row) throw new HttpError(409, 'REQUEST_IN_PROGRESS', 'That request is still being handled. Please wait a moment.');
    if (row.fp !== fp) throw new HttpError(422, 'IDEMPOTENCY_KEY_REUSED', 'That request key was already used for a different request.');
    if (row.state !== 'done') throw new HttpError(409, 'REQUEST_IN_PROGRESS', 'That request is still being handled. Please wait a moment.');
    return new Response(row.body, { status: row.status ?? 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'idempotent-replay': 'true' } });
  }
  let res: Response;
  try { res = await work(); } catch (e) { res = errorResponse(e); }
  if (res.status >= 500) await sql(ctx, 'DELETE FROM idempotency WHERE scope = ? AND key = ?', scope, key).run(); // a failed attempt may be retried
  else await sql(ctx, "UPDATE idempotency SET state = 'done', status = ?, body = ? WHERE scope = ? AND key = ?", res.status, await res.clone().text(), scope, key).run();
  return res;
}

export async function handleApi(ctx0: Ctx, req: Request): Promise<Response> {
  const url = new URL(req.url);
  try {
    // The client address (Cloudflare sets CF-Connecting-IP and strips any value a visitor tries to send) feeds the rate limits; it is stored hashed.
    const ip = req.headers.get('cf-connecting-ip');
    const ctx: Ctx = ip ? { ...ctx0, clientKey: (await sha256Hex('ip|' + ip)).slice(0, 24) } : ctx0;
    const path = url.pathname.replace(/\/+$/, '') || '/';
    // CSRF guard: a browser always sends Origin on cross-site writes; it must be ours.
    if (req.method !== 'GET' && req.method !== 'HEAD' && !NO_ORIGIN_CHECK.has(path)) {
      const origin = req.headers.get('origin');
      if (origin && origin !== url.origin) throw new HttpError(403, 'BAD_ORIGIN', 'This request came from a different website and was blocked.');
    }
    for (const [method, re, h] of routes) {
      if (method !== req.method) continue;
      const m = re.exec(path);
      if (!m) continue;
      const needsActor = !path.startsWith('/api/auth/') && !path.startsWith('/api/shared/') && path !== '/api/health' && path !== '/api/config';
      const actor = needsActor ? await authenticate(ctx, req, url.searchParams.get('as') === 'guest') : null;
      const work = () => h(ctx, req, actor, m.slice(1).map(decodeURIComponent), url);
      const key = req.headers.get('idempotency-key');
      let res: Response;
      if (key && req.method !== 'GET' && req.method !== 'HEAD' && actor?.kind === 'user') {
        if (!IDEM_KEY.test(key)) throw new HttpError(400, 'BAD_IDEMPOTENCY_KEY', 'The request key must be 8-64 letters, digits, - or _.');
        res = await once(ctx, actor.user.id, key, req.method + ' ' + path, work);
      } else res = await work();
      res.headers.set('x-content-type-options', 'nosniff');
      return res;
    }
    throw new HttpError(404, 'NOT_FOUND', 'Not found.');
  } catch (e) {
    return errorResponse(e);
  }
}
