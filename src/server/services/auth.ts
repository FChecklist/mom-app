// Accounts, e-mail verification codes and sessions.
// E-mail is the only identity. A code proves the person owns the address; a session cookie keeps them signed in.
import { isDev, nowIso, sql, type Ctx } from '../ctx.ts';
import { TRIAL_DAYS } from '../core/plans.ts';
import { HttpError, hmacHex, nameFromEmail, randomCode, randomToken, requireEmail, rid, safeEqual, sha256Hex, str } from '../util.ts';
import { audit, auditStmt, housekeeping, ipLimit } from './guard.ts';
import { delivered, link, sendMail } from './mail.ts';

export interface UserRow {
  id: string;
  org_id: string;
  email: string;
  name: string;
  role: 'owner' | 'member';
  title: string;
  verified_at: string | null;
  invited_by: string | null;
  created_at: string;
}
export interface OrgRow {
  id: string;
  name: string;
  created_at: string;
  trial_ends_at: string;
  plan: string | null;
  plan_until: string | null;
}
export type Actor =
  | { kind: 'user'; user: UserRow; org: OrgRow }
  | { kind: 'guest'; email: string; momId: string; shareId: string };

export const CODE_TTL_MIN = 10;
export const MAX_ATTEMPTS = 5;
export const MAX_CODES_PER_HOUR = 5;
export const SESSION_DAYS = 30;
export const GUEST_SESSION_DAYS = 7;
export const COOKIE = 'mom_session';
/** Shared-link visitors get their OWN cookie, so opening a link never signs a signed-in person out. */
export const GUEST_COOKIE = 'mom_guest';

const addMs = (d: Date, ms: number) => new Date(d.getTime() + ms).toISOString();

export function secret(ctx: Ctx): string {
  const s = ctx.env.SESSION_SECRET;
  if (s) return s;
  if (isDev(ctx.env)) return 'dev-only-session-secret';
  throw new HttpError(500, 'CONFIG', 'The server is not configured yet (SESSION_SECRET is missing).');
}
const codeHash = (ctx: Ctx, email: string, scope: string, code: string) => hmacHex(secret(ctx), `${scope}|${email}|${code}`);

/** Send a 6-digit code. Never reveals whether the address already has an account. Fails closed if the mail cannot go out. */
export async function startCode(ctx: Ctx, rawEmail: unknown, scope: string, signup?: { name?: unknown; team?: unknown }): Promise<{ sent: true; devCode?: string }> {
  const email = requireEmail(rawEmail);
  await ipLimit(ctx, 'code-h', Number(ctx.env.AUTH_IP_PER_HOUR || 10), 3600);
  await ipLimit(ctx, 'code-d', Number(ctx.env.AUTH_IP_PER_HOUR || 10) * 4, 86400);
  await housekeeping(ctx);
  const since = addMs(ctx.now(), -3600_000);
  const n = await sql(ctx, 'SELECT COUNT(*) AS n FROM auth_codes WHERE email = ? AND created_at >= ? AND used != 2', email, since).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_CODES_PER_HOUR) throw new HttpError(429, 'TOO_MANY_CODES', 'We have sent a few codes already. Please wait a little and check your inbox (and spam folder).');
  let payload: string | null = null;
  if (scope === 'signin') {
    const existing = await sql(ctx, 'SELECT id FROM users WHERE email = ?', email).first();
    if (!existing) payload = JSON.stringify({ name: str(signup?.name, 80, 'your name'), team: str(signup?.team, 80, 'your team name') });
  }
  const code = randomCode();
  const at = nowIso(ctx);
  const hash = await codeHash(ctx, email, scope, code);
  await sql(ctx, 'INSERT INTO auth_codes (email, scope, code_hash, expires_at, created_at, payload) VALUES (?,?,?,?,?,?)', email, scope, hash, addMs(ctx.now(), CODE_TTL_MIN * 60_000), at, payload).run();
  const subject = scope === 'signin' ? 'Your MOM sign-in code' : 'Your code to open a shared MOM';
  const status = await sendMail(ctx, {
    to: email,
    subject,
    kind: 'code',
    text: `Your code is ${code}\n\nIt works for ${CODE_TTL_MIN} minutes. If you did not ask for it, you can safely ignore this e-mail.\n\n${link(ctx, '/')}`,
  });
  if (!delivered(status)) {
    // Never say "sent" when nothing went out: retire the code (it does not count towards the hourly limit) and tell the truth.
    await sql(ctx, 'UPDATE auth_codes SET used = 2 WHERE email = ? AND scope = ? AND code_hash = ?', email, scope, hash).run();
    throw new HttpError(503, 'MAIL_UNAVAILABLE', 'We could not send your code just now. Nothing is wrong with your account. Please try again in a little while.');
  }
  return isDev(ctx.env) ? { sent: true, devCode: code } : { sent: true };
}

/** Check a code. Returns the sign-up payload (if any). Throws friendly errors. */
export async function checkCode(ctx: Ctx, rawEmail: unknown, scope: string, rawCode: unknown): Promise<{ email: string; payload: { name?: string; team?: string } | null }> {
  const email = requireEmail(rawEmail);
  const code = String(rawCode ?? '').trim();
  const row = await sql(ctx, 'SELECT * FROM auth_codes WHERE email = ? AND scope = ? AND used = 0 ORDER BY id DESC LIMIT 1', email, scope).first<{ id: number; code_hash: string; expires_at: string; attempts: number; payload: string | null }>();
  if (!row || row.expires_at <= nowIso(ctx)) throw new HttpError(400, 'CODE_EXPIRED', 'That code has expired or was not found. Please ask for a new one.');
  if (row.attempts >= MAX_ATTEMPTS) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many wrong tries for this code. Please ask for a new one.');
  if (!/^\d{6}$/.test(code) || !safeEqual(row.code_hash, await codeHash(ctx, email, scope, code))) {
    await sql(ctx, 'UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?', row.id).run();
    await audit(ctx, email, 'code_wrong', scope.split(':')[0]);
    throw new HttpError(400, 'BAD_CODE', 'That code does not match. Please check it and try again.');
  }
  const used = await sql(ctx, 'UPDATE auth_codes SET used = 1 WHERE id = ? AND used = 0', row.id).run();
  if (used.meta.changes !== 1) throw new HttpError(400, 'BAD_CODE', 'That code was already used. Please ask for a new one.');
  return { email, payload: row.payload ? (JSON.parse(row.payload) as { name?: string; team?: string }) : null };
}

async function newSession(ctx: Ctx, s: { kind: 'user' | 'guest'; email: string; userId?: string; momId?: string; shareId?: string; days: number }): Promise<string> {
  const token = randomToken();
  await sql(ctx, 'INSERT INTO sessions (token_hash, kind, user_id, email, mom_id, share_id, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?)', await sha256Hex(token), s.kind, s.userId ?? null, s.email, s.momId ?? null, s.shareId ?? null, addMs(ctx.now(), s.days * 86400_000), nowIso(ctx)).run();
  return token;
}

/**
 * Sign in (or sign up) with an e-mail code. The very first sign-in either joins the team that invited this address
 * (the owner added it; proving the mailbox with the code is the consent) or creates a new team of its own.
 */
export async function signIn(ctx: Ctx, rawEmail: unknown, rawCode: unknown): Promise<{ token: string; user: UserRow; created: boolean }> {
  const { email, payload } = await checkCode(ctx, rawEmail, 'signin', rawCode);
  let user = await sql(ctx, 'SELECT * FROM users WHERE email = ?', email).first<UserRow>();
  let created = false;
  const at = nowIso(ctx);
  if (!user) {
    const inv = await sql(ctx, 'SELECT i.name, i.org_id, o.name AS org_name FROM invites i JOIN orgs o ON o.id = i.org_id WHERE i.email = ?', email).first<{ name: string; org_id: string; org_name: string }>();
    const name = inv?.name || payload?.name || nameFromEmail(email);
    const userId = rid('usr');
    if (inv) {
      await ctx.db.batch([
        sql(ctx, "INSERT INTO users (id, org_id, email, name, role, title, verified_at, invited_by, created_at) VALUES (?,?,?,?, 'member', 'Member', ?, (SELECT invited_by FROM invites WHERE email = ?), ?)", userId, inv.org_id, email, name, at, email, at),
        sql(ctx, 'DELETE FROM invites WHERE email = ?', email),
        auditStmt(ctx, email, 'joined_team', userId, { via: 'invite' }, inv.org_id),
      ]);
      await sendMail(ctx, { to: email, orgId: inv.org_id, kind: 'notice', subject: 'Welcome to MOM', text: `Namaste ${name},\n\nYou have joined the team "${inv.org_name}" on MOM.\n\nOpen MOM: ${link(ctx, '/')}\n` });
    } else {
      const orgId = rid('org');
      const trial = addMs(ctx.now(), TRIAL_DAYS * 86400_000);
      await ctx.db.batch([
        sql(ctx, 'INSERT INTO orgs (id, name, created_at, trial_ends_at) VALUES (?,?,?,?)', orgId, payload?.team || `${name}'s team`, at, trial),
        sql(ctx, "INSERT INTO users (id, org_id, email, name, role, title, verified_at, created_at) VALUES (?,?,?,?, 'owner', 'Team owner', ?, ?)", userId, orgId, email, name, at, at),
        auditStmt(ctx, email, 'signed_up', userId, { team: payload?.team || null }, orgId),
      ]);
      await sendMail(ctx, { to: email, orgId, kind: 'notice', subject: 'Welcome to MOM', text: `Namaste ${name},\n\nYour team "${payload?.team || name + "'s team"}" is ready, with a ${TRIAL_DAYS}-day free trial.\n\nOpen MOM: ${link(ctx, '/')}\n` });
    }
    user = await sql(ctx, 'SELECT * FROM users WHERE id = ?', userId).first<UserRow>();
    created = true;
  } else {
    if (!user.verified_at) {
      await sql(ctx, 'UPDATE users SET verified_at = ? WHERE id = ?', at, user.id).run();
      user = { ...user, verified_at: at };
    }
    await audit(ctx, email, 'signed_in', user.id, undefined, user.org_id);
  }
  const token = await newSession(ctx, { kind: 'user', email, userId: user!.id, days: SESSION_DAYS });
  return { token, user: user!, created };
}

export async function guestSession(ctx: Ctx, email: string, momId: string, shareId: string): Promise<string> {
  return newSession(ctx, { kind: 'guest', email, momId, shareId, days: GUEST_SESSION_DAYS });
}

export function readCookie(req: Request, name = COOKIE): string | null {
  const h = req.headers.get('cookie') || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookie(ctx: Ctx, token: string, days: number, name = COOKIE): string {
  const secure = ctx.baseUrl.startsWith('https://') ? '; Secure' : '';
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}${secure}`;
}
export function clearCookie(ctx: Ctx, name = COOKIE): string {
  const secure = ctx.baseUrl.startsWith('https://') ? '; Secure' : '';
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

type SessionRow = { kind: 'user' | 'guest'; user_id: string | null; email: string; mom_id: string | null; share_id: string | null; expires_at: string };

async function userActor(ctx: Ctx, token: string): Promise<Actor | null> {
  const s = await sql(ctx, "SELECT * FROM sessions WHERE token_hash = ? AND kind = 'user'", await sha256Hex(token)).first<SessionRow>();
  if (!s || s.expires_at <= nowIso(ctx)) return null;
  const user = await sql(ctx, 'SELECT * FROM users WHERE id = ?', s.user_id).first<UserRow>();
  if (!user) return null;
  const org = await sql(ctx, 'SELECT * FROM orgs WHERE id = ?', user.org_id).first<OrgRow>();
  if (!org) return null;
  return { kind: 'user', user, org };
}
async function guestActor(ctx: Ctx, token: string): Promise<Actor | null> {
  const s = await sql(ctx, "SELECT * FROM sessions WHERE token_hash = ? AND kind = 'guest'", await sha256Hex(token)).first<SessionRow>();
  if (!s || s.expires_at <= nowIso(ctx) || !s.mom_id || !s.share_id) return null;
  // A guest session lives only as long as its share link: revoked or expired links end the session at once.
  const sh = await sql(ctx, 'SELECT revoked_at, expires_at FROM shares WHERE id = ?', s.share_id).first<{ revoked_at: string | null; expires_at: string | null }>();
  if (!sh || sh.revoked_at || (sh.expires_at && sh.expires_at <= nowIso(ctx))) return null;
  return { kind: 'guest', email: s.email, momId: s.mom_id, shareId: s.share_id };
}

/**
 * Who is calling? A signed-in user wins; otherwise a shared-link guest. With `wantGuest` (?as=guest) the guest
 * session is used even when a user is signed in on the same browser (e.g. an owner opening another team's link).
 */
export async function authenticate(ctx: Ctx, req: Request, wantGuest = false): Promise<Actor | null> {
  const ut = readCookie(req), gt = readCookie(req, GUEST_COOKIE);
  if (wantGuest) return gt ? guestActor(ctx, gt) : null;
  const u = ut ? await userActor(ctx, ut) : null;
  if (u) return u;
  return gt ? guestActor(ctx, gt) : null;
}

export async function signOut(ctx: Ctx, req: Request): Promise<void> {
  for (const name of [COOKIE, GUEST_COOKIE]) {
    const token = readCookie(req, name);
    if (token) await sql(ctx, 'DELETE FROM sessions WHERE token_hash = ?', await sha256Hex(token)).run();
  }
}

export function requireUser(a: Actor | null): Extract<Actor, { kind: 'user' }> {
  if (!a) throw new HttpError(401, 'SIGN_IN_REQUIRED', 'Please sign in with your e-mail first.');
  if (a.kind !== 'user') throw new HttpError(403, 'GUEST_READ_ONLY', 'Shared links are read-only. Please sign in to make changes.');
  return a;
}
export function requireActor(a: Actor | null): Actor {
  if (!a) throw new HttpError(401, 'SIGN_IN_REQUIRED', 'Please sign in with your e-mail first.');
  return a;
}
