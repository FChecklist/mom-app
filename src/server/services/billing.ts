// Plans and checkout. Money moves only through the central payment service of IT SERVICES BY RAJAT AGARWAL (Games pattern: order and verify both go to the central service; no Razorpay key and no Razorpay webhook here). Mock until the owner connects it.
// The server decides every price; the browser only ever names a plan.
import { isDev, nowIso, sql, type Ctx } from '../ctx.ts';
import { isPlan, PAYEE, PLANS, planStatus, TRIAL_DAYS, MAX_USERS } from '../core/plans.ts';
import { HttpError, rid } from '../util.ts';
import { newMockPaymentId } from './payments.ts';
import { requireUser, type Actor, type OrgRow } from './auth.ts';
import { audit, auditStmt, ipLimit } from './guard.ts';
import { link, sendMail } from './mail.ts';

interface OrderRow { id: string; org_id: string; plan: string; amount_paise: number; provider: string; provider_order_id: string; key_id: string | null; status: 'created' | 'paid' | 'failed'; payment_id: string | null; created_by: string }

export function billingInfo(ctx: Ctx, org: OrgRow) {
  return {
    ...planStatus(org, ctx.now()),
    planName: org.plan,
    trialDays: TRIAL_DAYS,
    maxUsers: MAX_USERS,
    payee: PAYEE,
    provider: ctx.payments.id,
    paymentMode: ctx.payments.mode,
    plans: Object.values(PLANS).map((p) => ({ id: p.id, label: p.label, amountPaise: p.amountPaise, days: p.days, maxUsers: p.maxUsers })),
  };
}

export async function billingOrders(ctx: Ctx, actor: Actor | null) {
  const { org } = requireUser(actor);
  const rows = (await sql(ctx, 'SELECT id, plan, amount_paise, status, provider, created_at, paid_at FROM orders WHERE org_id = ? ORDER BY created_at DESC LIMIT 20', org.id).all()).results;
  return { orders: rows };
}

export async function checkout(ctx: Ctx, actor: Actor | null, input: Record<string, unknown>) {
  const { user, org } = requireUser(actor);
  if (user.role !== 'owner') throw new HttpError(403, 'NOT_ALLOWED', 'Only the team owner can buy a plan.');
  if (!isPlan(input.plan)) throw new HttpError(400, 'BAD_PLAN', 'Please choose the monthly or the 12-month plan.');
  if (ctx.payments.id === 'mock' && !isDev(ctx.env)) throw new HttpError(503, 'PAYMENTS_NOT_READY', 'Payments are not switched on yet. Please check back soon; nothing was charged.');
  const plan = PLANS[input.plan];
  const frameUrl = ctx.payments.frameUrl ?? null; // the central payment frame the browser opens (null for the mock)
  // A double tap (or a retry) must not open a second provider order: reuse the same unpaid order for 24 hours (a buyer whose browser never reported a payment then meets Razorpay's "already paid" instead of paying twice).
  const recent = await sql(ctx, "SELECT * FROM orders WHERE org_id = ? AND plan = ? AND provider = ? AND status = 'created' AND created_at >= ? ORDER BY created_at DESC LIMIT 1", org.id, plan.id, ctx.payments.id, new Date(ctx.now().getTime() - 24 * 3600_000).toISOString()).first<OrderRow>();
  if (recent && recent.key_id?.startsWith('rzp_test_') && ctx.payments.mode === 'live') { /* a test order from before go-live is never reused: a new live order is opened below */ }
  else if (recent) {
    if (recent.key_id?.startsWith('rzp_live_') && ctx.payments.mode !== 'live') throw new HttpError(503, 'LIVE_PAYMENTS_DISABLED', 'Live payments are switched off until the owner approves them. Nothing was charged.');
    return { orderId: recent.id, providerOrderId: recent.provider_order_id, keyId: recent.key_id ?? null, frameUrl, provider: ctx.payments.id, mode: ctx.payments.mode, amountPaise: recent.amount_paise, currency: 'INR', label: plan.label, payee: PAYEE, reused: true };
  }
  // Each new order is a real order in the shared central ledger: a limit per device and per team keeps a loop from filling it.
  await ipLimit(ctx, 'pay-order', 20, 3600);
  const hourAgo = new Date(ctx.now().getTime() - 3600_000).toISOString();
  if (((await sql(ctx, 'SELECT COUNT(*) AS n FROM orders WHERE org_id = ? AND created_at >= ?', org.id, hourAgo).first<{ n: number }>())?.n ?? 0) >= 20) throw new HttpError(429, 'TOO_MANY_REQUESTS', 'That was a few too many payment tries. Please wait a little and try again.');
  const id = rid('ord');
  const receipt = id.slice(0, 40); // our order id is the payment reference, so the central ledger, Razorpay and this site match
  const o = await ctx.payments.createOrder({ amountPaise: plan.amountPaise, receipt, plan: plan.id, orgId: org.id });
  await ctx.db.batch([
    sql(ctx, 'INSERT INTO orders (id, org_id, plan, amount_paise, currency, provider, provider_order_id, key_id, status, created_by, created_at) VALUES (?,?,?,?, \'INR\', ?,?,?, \'created\', ?, ?)', id, org.id, plan.id, plan.amountPaise, ctx.payments.id, o.providerOrderId, o.keyId ?? null, user.email, nowIso(ctx)),
    auditStmt(ctx, user.email, 'order_created', id, { plan: plan.id, amountPaise: plan.amountPaise, provider: ctx.payments.id, mode: ctx.payments.mode }, org.id),
  ]);
  return { orderId: id, providerOrderId: o.providerOrderId, keyId: o.keyId ?? null, frameUrl, provider: ctx.payments.id, mode: ctx.payments.mode, amountPaise: plan.amountPaise, currency: 'INR', label: plan.label, payee: PAYEE };
}

/** Test-only helper: stands in for the Razorpay checkout window by producing the same signed payload. */
export async function mockPay(ctx: Ctx, actor: Actor | null, input: Record<string, unknown>) {
  const { org } = requireUser(actor);
  if (!isDev(ctx.env) || ctx.payments.id !== 'mock' || !ctx.payments.mockSign) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
  const o = await sql(ctx, 'SELECT * FROM orders WHERE id = ? AND org_id = ?', String(input.orderId || ''), org.id).first<OrderRow>();
  if (!o) throw new HttpError(404, 'NOT_FOUND', 'That order could not be found.');
  const paymentId = newMockPaymentId();
  return { orderId: o.provider_order_id, paymentId, signature: await ctx.payments.mockSign(o.provider_order_id, paymentId) };
}

/**
 * Marks an order paid exactly once AND extends the plan - in ONE atomic batch, so a failure half-way can never leave
 * "paid but plan not extended" behind (the first review reproduced exactly that). The plan extension is conditioned on
 * the order update having really changed a row, so two confirmations arriving together extend only once.
 */
export async function finalizeOrder(ctx: Ctx, o: OrderRow, paymentId: string): Promise<{ extended: boolean; until?: string }> {
  const plan = isPlan(o.plan) ? PLANS[o.plan] : null;
  if (!plan) return { extended: false };
  const org = await sql(ctx, 'SELECT * FROM orgs WHERE id = ?', o.org_id).first<OrgRow>();
  if (!org) return { extended: false };
  const at = nowIso(ctx);
  // The new end date is worked out by the database itself from the value it holds at that moment (paying early adds on top), so two orders confirmed together both add their days.
  const res = await ctx.db.batch([
    sql(ctx, "UPDATE orders SET status = 'paid', payment_id = ?, paid_at = ? WHERE id = ? AND status != 'paid'", paymentId, at, o.id),
    sql(ctx, "UPDATE orgs SET plan = CASE WHEN ? = 'monthly' AND plan = 'yearly' AND julianday(plan_until) > julianday(?) THEN plan ELSE ? END, plan_until = strftime('%Y-%m-%dT%H:%M:%fZ', CASE WHEN julianday(plan_until) IS NOT NULL AND julianday(plan_until) > julianday(?) THEN plan_until ELSE ? END, ?) WHERE id = ? AND changes() > 0", plan.id, at, plan.id, at, at, '+' + plan.days + ' days', org.id),
    sql(ctx, "INSERT INTO audit_log (at, actor, action, target, detail, org_id) SELECT ?,?,?,?, json_object('plan', ?, 'until', (SELECT plan_until FROM orgs WHERE id = ?)), ? WHERE changes() > 0", at, 'billing', 'plan_extended', o.id, plan.id, org.id, org.id),
  ]);
  if (res[0].meta.changes !== 1) return { extended: false }; // already paid by the other path
  const until = (await sql(ctx, 'SELECT plan_until FROM orgs WHERE id = ?', org.id).first<{ plan_until: string }>())?.plan_until ?? at;
  const owner = await sql(ctx, 'SELECT email, name FROM users WHERE email = ?', o.created_by).first<{ email: string; name: string }>();
  if (owner) await sendMail(ctx, { to: owner.email, orgId: org.id, kind: 'receipt', subject: 'Thank you - your MOM plan is active', text: `Namaste ${owner.name},\n\nWe received Rs ${(o.amount_paise / 100).toLocaleString('en-IN')} for "${plan.label}", paid to ${PAYEE}.\nYour plan runs until ${until.slice(0, 10)}. Reference: ${paymentId}.\n\n${link(ctx, '/')}\n` });
  return { extended: true, until };
}

export async function verifyPayment(ctx: Ctx, actor: Actor | null, input: Record<string, unknown>) {
  const { user, org } = requireUser(actor);
  if (user.role !== 'owner') throw new HttpError(403, 'NOT_ALLOWED', 'Only the team owner can confirm a payment.');
  const providerOrderId = String(input.orderId || ''), paymentId = String(input.paymentId || ''), signature = String(input.signature || '');
  const o = await sql(ctx, 'SELECT * FROM orders WHERE provider_order_id = ? AND org_id = ?', providerOrderId, org.id).first<OrderRow>();
  if (!o || o.provider !== ctx.payments.id) throw new HttpError(404, 'NOT_FOUND', 'That order could not be found.'); // an order is only ever confirmed by the provider that opened it
  await ipLimit(ctx, 'pay-verify', 40, 3600);
  // The same payment confirmed again (a lost answer, a second tap) is simply "already paid": no new call to the payment service, nothing extended twice.
  if (o.status === 'paid' && o.payment_id === paymentId) { const fresh0 = await sql(ctx, 'SELECT * FROM orgs WHERE id = ?', org.id).first<OrgRow>(); return { paid: true, extended: false, already: true, billing: billingInfo(ctx, fresh0!) }; }
  // Not confirmed: the order stays open (never "failed"), so the 24-hour reuse still protects a buyer who really paid from paying twice.
  if (!paymentId || !signature || !(await ctx.payments.verify({ orderId: providerOrderId, paymentId, signature, amountPaise: o.amount_paise, receipt: o.id, plan: o.plan }))) {
    await audit(ctx, user.email, 'payment_not_confirmed', o.id, undefined, org.id);
    throw new HttpError(400, 'BAD_SIGNATURE', `The payment could not be confirmed here. If money was taken, please contact support with your order number ${o.id}; it is safe in the payment ledger and will be matched by hand.`);
  }
  // A payment made with a Razorpay TEST key (a test card is public) never buys a plan, whatever else is configured.
  if (ctx.payments.id === 'central' && !o.key_id?.startsWith('rzp_live_')) {
    await audit(ctx, user.email, 'test_payment_verified', o.id, undefined, org.id);
    throw new HttpError(409, 'TEST_PAYMENT', 'The test payment went through, but test payments never activate a plan. Nothing was charged.');
  }
  const r = await finalizeOrder(ctx, o, paymentId);
  const fresh = await sql(ctx, 'SELECT * FROM orgs WHERE id = ?', org.id).first<OrgRow>();
  return { paid: true, ...r, billing: billingInfo(ctx, fresh!) };
}

/** A printable receipt for a paid order. It becomes a GST tax invoice only when the payee's GSTIN is configured (PAYEE_GSTIN). */
export async function orderReceipt(ctx: Ctx, actor: Actor | null, id: string) {
  const { org } = requireUser(actor);
  const o = await sql(ctx, "SELECT * FROM orders WHERE id = ? AND org_id = ?", id, org.id).first<OrderRow & { paid_at: string | null; created_at: string }>();
  if (!o) throw new HttpError(404, 'NOT_FOUND', 'That order could not be found.');
  if (o.status !== 'paid') throw new HttpError(409, 'NOT_PAID', 'A receipt is available once the payment is confirmed.');
  const plan = isPlan(o.plan) ? PLANS[o.plan] : null;
  return {
    receiptNo: o.id, paidAt: o.paid_at, payee: PAYEE, gstin: ctx.env.PAYEE_GSTIN || null, teamName: org.name,
    item: plan ? plan.label : o.plan, amountPaise: o.amount_paise, currency: 'INR', paymentId: o.payment_id, provider: o.provider,
    note: ctx.env.PAYEE_GSTIN ? 'Amounts include applicable taxes.' : 'This is a payment receipt. A GST tax invoice is issued once the payee\'s GST details are on file.',
  };
}

/**
 * Plans are prepaid for a fixed period and never renew by themselves, so there is nothing to "cancel". A refund can be
 * asked for; it is recorded and reviewed by the payee, who alone moves money (no refund is ever automatic).
 */
export async function requestRefund(ctx: Ctx, actor: Actor | null, orderId: string, input: Record<string, unknown>) {
  const { user, org } = requireUser(actor);
  if (user.role !== 'owner') throw new HttpError(403, 'NOT_ALLOWED', 'Only the team owner can ask for a refund.');
  const o = await sql(ctx, 'SELECT * FROM orders WHERE id = ? AND org_id = ?', orderId, org.id).first<OrderRow>();
  if (!o) throw new HttpError(404, 'NOT_FOUND', 'That order could not be found.');
  if (o.status !== 'paid') throw new HttpError(409, 'NOT_PAID', 'Only a confirmed payment can be refunded.');
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
  const rid2 = rid('rf');
  const r = await sql(ctx, 'INSERT OR IGNORE INTO refund_requests (id, order_id, org_id, reason, created_by, created_at) VALUES (?,?,?,?,?,?)', rid2, o.id, org.id, reason, user.email, nowIso(ctx)).run();
  if (r.meta.changes !== 1) throw new HttpError(409, 'ALREADY_REQUESTED', 'A refund request for this payment is already with us. We will get back to you by e-mail.');
  await audit(ctx, user.email, 'refund_requested', o.id, undefined, org.id);
  if (ctx.env.SUPPORT_EMAIL) await sendMail(ctx, { to: ctx.env.SUPPORT_EMAIL, orgId: org.id, kind: 'notice', subject: `Refund request: ${o.id}`, text: `${user.email} (${org.name}) asked for a refund of order ${o.id} (Rs ${(o.amount_paise / 100).toLocaleString('en-IN')}).\nReason: ${reason || '-'}\n` });
  return { ok: true, id: rid2 };
}
