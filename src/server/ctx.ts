// Request context: everything a service needs, injectable for tests.
import type { CalendarProvider } from './services/calendar-adapters.ts';
import type { Mailer } from './services/mail.ts';
import type { PaymentProvider } from './services/payments.ts';

/** The tiny slice of the D1 API we use (also implemented over bun:sqlite for tests and local dev). */
export interface Stmt {
  bind(...v: unknown[]): Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface D1Like {
  prepare(sql: string): Stmt;
  batch(stmts: Stmt[]): Promise<{ meta: { changes: number } }[]>;
}

export interface Env {
  DB: D1Like;
  MOM_MODE?: string; // 'production' (default) | 'dev' | 'test'
  APP_HOST?: string; // mom.veridian-aios.com
  PUBLIC_BASE_URL?: string; // optional full override, e.g. http://localhost:8788
  SESSION_SECRET?: string;
  TOKEN_ENC_KEY?: string;
  RESEND_API_KEY?: string;
  /** Free Cloudflare Email Service (the default mail provider): an API token allowed to send e-mail, and the 32-character account id. */
  CF_EMAIL_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  MAIL_FROM?: string;
  MAIL_DAILY_CAP?: string;
  CODE_DAILY_CAP?: string; // how many of MAIL_DAILY_CAP are for sign-in/share codes (default 55%); the rest is for notices
  AUTH_IP_PER_HOUR?: string; // code requests per client address per hour (default 10)
  SHARE_TTL_DAYS?: string; // share links expire after this many days (default 30)
  SUPPORT_EMAIL?: string; // optional: refund requests are also mailed here
  PAYEE_GSTIN?: string; // optional: shown on receipts once the owner supplies it
  ENFORCE_PLAN?: string; // '1' = block writes after the trial ends without a paid plan
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  MS_CLIENT_ID?: string;
  MS_CLIENT_SECRET?: string;
  PAY_SERVICE_KEY?: string; // secret: this site's key for the central payment service of IT SERVICES BY RAJAT AGARWAL (header x-site-key); never in the repository
  PAY_SITE?: string; // this site's registered host in the central ledger (the service looks a site up by that host)
  PAY_SERVICE_URL?: string; // default https://itservices-rajat-agarwal.pages.dev
  PAY_LIVE_OK?: string; // must be exactly 'owner-approved' before a live Razorpay key (seen in the central order answer) is accepted
}

export interface Ctx {
  env: Env;
  db: D1Like;
  now(): Date;
  mailer: Mailer;
  calendars: Record<string, CalendarProvider>;
  payments: PaymentProvider;
  baseUrl: string;
  fetch: typeof fetch;
  /** Hash of the client address (set per request from Cloudflare's CF-Connecting-IP; absent on a laptop). */
  clientKey?: string;
}

export const isDev = (env: Env) => env.MOM_MODE === 'dev' || env.MOM_MODE === 'test';
export const appHost = (env: Env) => env.APP_HOST || 'mom.veridian-aios.com';

export function baseUrlFor(env: Env, requestUrl?: string): string {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  if (isDev(env) && requestUrl) return new URL(requestUrl).origin;
  return 'https://' + appHost(env);
}

export const nowIso = (ctx: Ctx) => ctx.now().toISOString();
export const sql = (ctx: Ctx, q: string, ...params: unknown[]) => ctx.db.prepare(q).bind(...params);
