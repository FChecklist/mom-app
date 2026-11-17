// E-mail. The default provider is the free Cloudflare Email Service (CF_EMAIL_TOKEN + CF_ACCOUNT_ID); the older Resend free-limit set-up (RESEND_API_KEY) still works when only that is set.
// Without either the mailer is a mock: on a laptop (MOM_MODE=dev) messages are recorded in the dev mailbox;
// in production a missing key means every send FAILS CLOSED (status 'failed'), never a silent pretend-send.
import { isDev, nowIso, sql, type Ctx, type Env } from '../ctx.ts';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  /** 'code' mails (sign-in / share codes) get a small reserve under the free limit. */
  kind: 'code' | 'notice' | 'invite' | 'share' | 'receipt';
  orgId?: string | null;
}
export interface Mailer {
  id: 'mock' | 'resend' | 'cloudflare';
  send(m: { from: string; to: string; subject: string; text: string }): Promise<void>;
}
export type MailStatus = 'recorded' | 'sent' | 'failed' | 'capped';

export const FORBIDDEN_SENDER_LOCALPARTS = ['tina'];

/** An error whose text is ours and safe to keep in the outbox. Any other error (a runtime's own message may repeat a request header) is stored as a fixed text instead. */
class MailError extends Error {}

const CF_ID = /^[0-9a-f]{32}$/i; // a Cloudflare account id is 32 hex characters; anything else counts as "not set"
const SECRET_OK = /^[\x21-\x7e]{8,}$/; // a key or token is printable ASCII with no spaces; anything else (a BOM, a smart quote, a line break) counts as "not set"
const cfToken = (env: Env): string => (env.CF_EMAIL_TOKEN ?? '').trim();
const cfRoute = (env: Env): boolean => SECRET_OK.test(cfToken(env)) && CF_ID.test((env.CF_ACCOUNT_ID ?? '').trim());
const resendKey = (env: Env): string => (env.RESEND_API_KEY ?? '').trim();

const ADDR = '[^<>\\s,;"@]+@[^<>\\s,;"@]+';
/** The sender, parsed ONCE and strictly: exactly one address, plain or as Name <address>. Anything else (several addresses, quotes, odd brackets) is not a sender. */
export function parseSender(from: string): { address: string; name: string } | null {
  const raw = (from ?? '').trim();
  let m = new RegExp('^([^<>]*?)\\s*<(' + ADDR + ')>$').exec(raw);
  if (m) return { address: m[2]!, name: m[1]!.replace(/["\u0000-\u001f\u007f\\]/g, ' ').replace(/\s+/g, ' ').trim() }; // a display name never carries quotes, backslashes or control characters
  m = new RegExp('^(' + ADDR + ')$').exec(raw);
  return m ? { address: m[1]!, name: '' } : null;
}

/** The sender as Cloudflare's REST API wants it: a plain address, or { address, name } when there is a display name. */
export function fromObject(from: string): string | { address: string; name: string } {
  const p = parseSender(from);
  if (!p) return (from ?? '').trim().replace(/[\u0000-\u001f\u007f]/g, '');
  return p.name ? { address: p.address, name: p.name } : p.address;
}

export function createMailer(env: Env, fetchFn: typeof fetch = fetch): Mailer {
  if (cfRoute(env)) {
    const account = (env.CF_ACCOUNT_ID ?? '').trim(), token = cfToken(env);
    return {
      id: 'cloudflare',
      async send(m) {
        // The token is only ever sent to api.cloudflare.com, with a short timeout and no redirects.
        const r = await fetchFn(`https://api.cloudflare.com/client/v4/accounts/${account}/email/sending/send`, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: fromObject(m.from), to: [m.to], subject: m.subject, text: m.text }),
        });
        if (!r.ok) throw new MailError(`Cloudflare Email answered ${r.status}`); // never include the token or the body of the request
        const j = (await r.json().catch(() => null)) as { success?: boolean; errors?: unknown; result?: { delivered?: unknown; queued?: unknown; permanent_bounces?: unknown } } | null;
        if (j?.success !== true || (Array.isArray(j.errors) && j.errors.length > 0)) throw new MailError('Cloudflare Email did not accept the message');
        const res = j.result; // when the answer lists who was delivered or queued, at least one must be there, and the recipient must not be listed as bounced
        if (Array.isArray(res?.delivered) && Array.isArray(res?.queued) && res.delivered.length + res.queued.length === 0) throw new MailError('Cloudflare Email delivered to nobody');
        if (Array.isArray(res?.permanent_bounces) && res.permanent_bounces.some((x) => JSON.stringify(x).toLowerCase().includes(m.to.toLowerCase()))) throw new MailError('Cloudflare Email reported a permanent bounce');
      },
    };
  }
  const key = resendKey(env);
  if (!SECRET_OK.test(key)) return { id: 'mock', async send() {} };
  return {
    id: 'resend',
    async send(m) {
      const r = await fetchFn('https://api.resend.com/emails', {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: m.from, to: [m.to], subject: m.subject, text: m.text }),
      });
      if (!r.ok) throw new MailError(`Resend answered ${r.status}`); // never include the key or the body of the request
    },
  };
}

/** The local part of the sender address, lower case and without a +tag, for the forbidden-sender check ('' when the sender is not valid). */
export function senderLocalPart(from: string): string {
  const p = parseSender(from);
  return p ? p.address.split('@')[0]!.toLowerCase().split('+')[0]! : '';
}

/** Can this deployment really deliver e-mail? A mock mailer is fine on a laptop and never in production. */
export function mailReady(ctx: Ctx): boolean {
  if (isDev(ctx.env)) return true;
  if (ctx.mailer.id === 'mock') return false;
  const from = ctx.env.MAIL_FROM || '';
  return !!parseSender(from) && !FORBIDDEN_SENDER_LOCALPARTS.includes(senderLocalPart(from));
}

/** Budget split of MAIL_DAILY_CAP: codes get their own share so spam to notices cannot block sign-in, and the other way round. */
export function mailBudgets(env: Env): { total: number; codes: number; notices: number } {
  const capN = Number(env.MAIL_DAILY_CAP || 90); // a value that is not a number must not switch the cap off
  const total = Math.max(0, Number.isFinite(capN) ? capN : 90);
  const codeN = env.CODE_DAILY_CAP !== undefined && env.CODE_DAILY_CAP !== '' ? Number(env.CODE_DAILY_CAP) : NaN;
  const codes = Math.min(total, Number.isFinite(codeN) ? Math.max(0, codeN) : Math.ceil(total * 0.55));
  return { total, codes, notices: total - codes };
}

/**
 * Sends (or, in dev, records) one e-mail and returns what happened. Callers that MUST NOT pretend (sign-in codes,
 * e-mail shares) check the result; best-effort notices may ignore it.
 * The outbox keeps only the delivery facts in production: the body (which holds sign-in codes and share links)
 * is stored in dev only, and rows are purged after 30 days (see housekeeping).
 */
export async function sendMail(ctx: Ctx, m: OutgoingMail): Promise<MailStatus> {
  const at = nowIso(ctx);
  const b = mailBudgets(ctx.env);
  const limit = m.kind === 'code' ? b.codes : b.notices;
  let status: MailStatus = 'recorded';
  let error: string | null = null;

  if (!isDev(ctx.env) && !mailReady(ctx)) {
    status = 'failed';
    error = ctx.mailer.id !== 'mock' ? 'MAIL_FROM is not set or not allowed' : 'E-mail is not configured (no usable mail provider keys)';
  } else if (ctx.mailer.id !== 'mock') {
    const from = ctx.env.MAIL_FROM || '';
    const dayStart = at.slice(0, 10) + 'T00:00:00.000Z';
    const kindClause = m.kind === 'code' ? "kind = 'code'" : "kind != 'code'";
    const used = await sql(ctx, `SELECT COUNT(*) AS n FROM outbox WHERE status='sent' AND at >= ? AND ${kindClause}`, dayStart).first<{ n: number }>();
    if (!from) {
      status = 'failed';
      error = 'MAIL_FROM is not set';
    } else if (!parseSender(from)) {
      status = 'failed';
      error = 'MAIL_FROM is not a single valid address';
    } else if (FORBIDDEN_SENDER_LOCALPARTS.includes(senderLocalPart(from))) {
      status = 'failed';
      error = 'This sender address is not allowed';
    } else if ((used?.n ?? 0) >= limit) {
      status = 'capped';
      error = 'Daily free-limit reached';
    } else {
      try {
        await ctx.mailer.send({ from, to: m.to, subject: m.subject, text: m.text });
        status = 'sent';
      } catch (e) {
        status = 'failed';
        error = e instanceof MailError ? e.message.slice(0, 200) : 'send failed (network, timeout or request error)'; // never a runtime's own text: it may repeat the request headers
      }
    }
  }
  await sql(
    ctx,
    'INSERT INTO outbox (at, org_id, to_addr, subject, body, kind, status, provider, error) VALUES (?,?,?,?,?,?,?,?,?)',
    at, m.orgId ?? null, m.to, m.subject, isDev(ctx.env) ? m.text : '[not kept]', m.kind, status, ctx.mailer.id, error,
  ).run();
  return status;
}

/** True when the message really went out (or, on a laptop, was recorded in the dev mailbox). */
export const delivered = (s: MailStatus) => s === 'sent' || s === 'recorded';

export const link = (ctx: Ctx, path: string) => ctx.baseUrl + path;
