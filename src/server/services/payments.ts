// Payments adapter. Money moves ONLY via the central payment service of IT SERVICES BY RAJAT AGARWAL (one Razorpay ledger), the "Games pattern"
// that is the owner's rule for every product: this site asks the central service to open the order (POST /api/pay/order with its own site key),
// the buyer pays inside the service's payment frame (/payframe/), and this site asks the service to verify (POST /api/pay/verify).
// This site holds NO Razorpay key and never calls Razorpay. Without PAY_SERVICE_KEY and PAY_SITE there is only the mock provider (no money moves).
import type { Env } from '../ctx.ts';
import { HttpError, hmacHex, randomToken, rid, safeEqual } from '../util.ts';

export const DEFAULT_CENTRAL = 'https://itservices-rajat-agarwal.pages.dev';
const PRODUCT = 'mom';

export interface PaymentProvider {
  id: 'mock' | 'central';
  mode: 'mock' | 'test' | 'live';
  /** The payment frame the browser opens (central only). */
  frameUrl?: string;
  createOrder(a: { amountPaise: number; receipt: string; plan: string; orgId: string }): Promise<{ providerOrderId: string; keyId?: string }>;
  /** True only when the payment is really paid and matches THIS order (amount, currency, our receipt, plan). An unreachable service throws, so a hiccup never marks an order failed. */
  /** True for the provider that refuses everything because it is half set up. */
  disabled?: boolean;
  verify(a: { orderId: string; paymentId: string; signature: string; amountPaise: number; receipt: string; plan: string }): Promise<boolean>;
  /** Mock only: produce the signature a successful test payment would carry. */
  mockSign?(orderId: string, paymentId: string): Promise<string>;
}

class Disabled implements PaymentProvider {
  id = 'central' as const;
  disabled = true;
  mode = 'test' as const;
  constructor(private why: string) {}
  async createOrder(): Promise<never> {
    throw new HttpError(503, 'LIVE_PAYMENTS_DISABLED', this.why);
  }
  async verify(): Promise<boolean> { throw new HttpError(503, 'LIVE_PAYMENTS_DISABLED', this.why); }
}

/** The central service, or null when this site is not connected to it. A key is never sent over plain http to a real host. */
export function centralOf(env: Env): { url: string; key: string; site: string } | null {
  const key = (env.PAY_SERVICE_KEY ?? '').trim(), site = (env.PAY_SITE ?? '').trim();
  if (!key || !site) return null;
  const url = (env.PAY_SERVICE_URL ?? DEFAULT_CENTRAL).trim().replace(/\/+$/, '');
  if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) return null;
  return { url, key, site };
}

export function createPaymentProvider(env: Env, fetchFn: typeof fetch = fetch): PaymentProvider {
  const c = centralOf(env);
  if (!c) {
    if (env.PAY_SERVICE_KEY || env.PAY_SITE) return new Disabled('The payment service is not set up correctly. Payments are off. Nothing was charged.');
    return mockProvider(env);
  }
  const liveOk = env.PAY_LIVE_OK === 'owner-approved'; // a live Razorpay key (seen in the order answer) is refused until the owner approves
  const call = async (path: string, body: unknown): Promise<{ ok: boolean; status: number; d: any }> => {
    try {
      // A short timeout, and redirects are not followed: the site key must never follow a redirect to another host (a 3xx answer is not ok, so it fails). Workers accepts only 'follow' or 'manual'.
      const r = await fetchFn(`${c.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-site-key': c.key }, body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(8000) });
      const d: any = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, d: d && typeof d === 'object' ? d : {} };
    } catch { return { ok: false, status: 0, d: {} }; }
  };
  return {
    id: 'central',
    mode: liveOk ? 'live' : 'test',
    frameUrl: `${c.url}/payframe/`,
    async createOrder(a) {
      const r = await call('/api/pay/order', { site: c.site, product: PRODUCT, plan: a.plan, amount_minor: a.amountPaise, currency: 'INR', payment_ref: a.receipt, extra_notes: { org: a.orgId } });
      if (r.status === 401 || r.status === 503) throw new HttpError(502, 'PAYMENT_SERVICE_CONFIG', 'The payment service could not be reached. Nothing was charged. Please try again in a little while.');
      const keyId = r.d.keyId;
      if (!r.ok || r.d.ok !== true || typeof r.d.orderId !== 'string' || !/^order_\w{1,64}$/.test(r.d.orderId) || typeof keyId !== 'string' || !/^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId) || r.d.amount_minor !== a.amountPaise || r.d.currency !== 'INR')
        throw new HttpError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment service could not be reached. Nothing was charged. Please try again in a little while.');
      if (liveOk && !keyId.startsWith('rzp_live_')) throw new HttpError(503, 'PAYMENT_KEY_MISMATCH', 'The payment service is still in test mode, so nothing was charged. Please try again once it is live.');
      if (keyId.startsWith('rzp_live_') && !liveOk) throw new HttpError(503, 'LIVE_PAYMENTS_DISABLED', 'Live payments are switched off until the owner approves them. Nothing was charged.');
      return { providerOrderId: r.d.orderId, keyId };
    },
    async verify(a) {
      if (!/^order_\w+$/.test(a.orderId) || !/^pay_\w{1,60}$/.test(a.paymentId) || !a.signature || a.signature.length > 200) return false;
      const r = await call('/api/pay/verify', { site: c.site, razorpay_order_id: a.orderId, razorpay_payment_id: a.paymentId, razorpay_signature: a.signature });
      // Anything that is not a definite answer about THIS payment (outage, wrong site key, too many calls) is an error the buyer can retry, never a failed order.
      if (r.status === 0 || r.status >= 500 || r.status === 401 || r.status === 429) throw new HttpError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment service could not be reached. If money was taken it is safe: your details are kept on this page, so please press Check my payment again in a little while.');
      // Only a clear answer about this payment counts as "not paid"; anything else (a challenge page, a redirect, an odd status) is retryable.
      if (!r.ok && ![400, 402, 404, 409, 422].includes(r.status)) throw new HttpError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment service could not be reached. If money was taken it is safe: your details are kept on this page, so please press Check my payment again in a little while.');
      const d = r.d;
      // Every fact must match THIS order: paid, the same amount and currency, our own receipt as the reference, the same plan and Razorpay ids.
      return r.ok && d.ok === true && d.paid === true && d.amount_minor === a.amountPaise && d.currency === 'INR' && d.payment_ref === a.receipt
        && d.product === PRODUCT && d.plan === a.plan && d.stream === 'sales' && d.razorpay_order_id === a.orderId && d.razorpay_payment_id === a.paymentId;
    },
  };
}

export function mockProvider(env: Env): PaymentProvider {
  const secret = env.SESSION_SECRET || '';
  return {
    id: 'mock',
    mode: 'mock',
    async createOrder() {
      return { providerOrderId: 'order_mock_' + rid('o').slice(2) };
    },
    async verify(a) {
      return !!secret && safeEqual(await hmacHex(secret, `${a.orderId}|${a.paymentId}`), a.signature);
    },
    async mockSign(orderId, paymentId) {
      return hmacHex(secret, `${orderId}|${paymentId}`);
    },
  };
}

export const newMockPaymentId = () => 'pay_mock_' + randomToken().slice(0, 14);
