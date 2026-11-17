// Small shared helpers. Only Web APIs (works in Cloudflare Workers, Bun and browsers).

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string, public extra?: Record<string, unknown>) {
    super(message ?? code);
  }
}

export function bytesToB64url(buf: Uint8Array): string {
  let s = '';
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

const B32 = 'abcdefghijkmnpqrstuvwxyz23456789';
export function rid(prefix: string): string {
  const b = randomBytes(12);
  let s = '';
  for (let i = 0; i < b.length; i++) s += B32[b[i] % 32];
  return prefix + '_' + s;
}

export function randomToken(): string {
  return bytesToB64url(randomBytes(32));
}

/** 6-digit code, uniform (rejection sampling). */
export function randomCode(): string {
  for (;;) {
    const n = new DataView(randomBytes(4).buffer).getUint32(0);
    if (n < 4_294_000_000) return String(n % 1_000_000).padStart(6, '0');
  }
}

const enc = new TextEncoder();

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function normEmail(e: unknown): string {
  return String(e ?? '').trim().toLowerCase();
}
export function validEmail(e: string): boolean {
  return e.length <= 254 && /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]{2,}$/.test(e);
}
export function looksMobile(e: string): boolean {
  return /^\+?[\d\s-]{7,}$/.test(e);
}
/** Throws a friendly 400 unless e is a plain e-mail. E-mail is the only identity here. */
export function requireEmail(raw: unknown, field = 'email'): string {
  const e = normEmail(raw);
  if (looksMobile(e)) throw new HttpError(400, 'EMAIL_ONLY', 'Please use an e-mail ID. E-mail keeps things simple and safe.', { field });
  if (!validEmail(e)) throw new HttpError(400, 'BAD_EMAIL', 'That e-mail ID does not look complete. Please check it.', { field });
  return e;
}

/** a***@example.com : enough for the owner of the address to recognise it, not enough to harvest it. */
export function maskEmail(e: string): string {
  const [l, d] = String(e).split('@');
  if (!d) return '***';
  return (l.slice(0, 1) || '*') + '***@' + d;
}

export function nameFromEmail(e: string): string {
  return e.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function str(v: unknown, max: number, field: string, opts: { required?: boolean } = {}): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (opts.required && !s) throw new HttpError(400, 'MISSING_FIELD', `Please fill in ${field}.`, { field });
  if (s.length > max) throw new HttpError(400, 'TOO_LONG', `${field} is too long (max ${max} characters).`, { field });
  return s;
}

export function isoDateOnly(v: unknown, field: string, opts: { required?: boolean } = {}): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) {
    if (opts.required) throw new HttpError(400, 'MISSING_FIELD', `Please choose ${field}.`, { field });
    return '';
  }
  // Round-trip check: 2026-02-31 would silently roll over to 3 March, so it is refused.
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(s + 'T00:00:00Z') : NaN;
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) {
    throw new HttpError(400, 'BAD_DATE', `${field} must look like 2026-12-31.`, { field });
  }
  return s;
}

export function safeUrl(u: string): string {
  return /^https?:\/\/[^\s]+$/i.test(u) ? u : '';
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00Z' : iso);
  // IST (UTC+5:30) display for timestamps; plain dates stay as typed.
  const t = iso.length === 10 ? d : new Date(d.getTime() + 330 * 60000);
  return `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
}
export function fmtTime(iso: string): string {
  const t = new Date(new Date(iso).getTime() + 330 * 60000);
  let h = t.getUTCHours();
  const m = t.getUTCMinutes();
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}
export function fmtDateTime(iso: string): string {
  return `${fmtDate(iso)} at ${fmtTime(iso)}`;
}
