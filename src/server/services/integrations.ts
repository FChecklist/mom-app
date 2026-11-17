// Google / Microsoft connections (mock without credentials) and "add this point to my calendar".
import { isDev, nowIso, sql, type Ctx } from '../ctx.ts';
import { decryptText, encryptText } from '../core/crypto.ts';
import { HttpError, hmacHex, randomToken, safeEqual } from '../util.ts';
import { requireUser, secret, type Actor } from './auth.ts';
import { isProviderId, PROVIDER_IDS, type ProviderId } from './calendar-adapters.ts';
import { assertWritable } from './plan-gate.ts';

const encKey = (ctx: Ctx): string => {
  if (ctx.env.TOKEN_ENC_KEY) return ctx.env.TOKEN_ENC_KEY;
  if (isDev(ctx.env)) return 'dev-only-token-key';
  throw new HttpError(500, 'CONFIG', 'The server is not configured for live calendar connections (TOKEN_ENC_KEY is missing).');
};
const redirectUri = (ctx: Ctx, p: ProviderId) => `${ctx.baseUrl}/api/integrations/${p}/callback`;
// Fails closed outside dev (no hard-coded fallback secret in a production code path).
const stateSecret = (ctx: Ctx) => secret(ctx);

function provider(ctx: Ctx, p: string) {
  if (!isProviderId(p)) throw new HttpError(404, 'NOT_FOUND', 'Unknown provider.');
  return ctx.calendars[p];
}

export async function listIntegrations(ctx: Ctx, actor: Actor | null) {
  const { user } = requireUser(actor);
  const rows = (await sql(ctx, 'SELECT provider, mode, account, connected_at FROM integrations WHERE user_id = ?', user.id).all<{ provider: string; mode: string; account: string | null; connected_at: string }>()).results;
  return {
    providers: PROVIDER_IDS.map((id) => {
      const c = rows.find((r) => r.provider === id);
      return { id, label: ctx.calendars[id].label, mode: ctx.calendars[id].mode, connected: !!c, account: c?.account ?? null, connectedAt: c?.connected_at ?? null };
    }),
  };
}

/** Mock mode connects instantly. Live mode returns the provider's sign-in page address. */
export async function connect(ctx: Ctx, actor: Actor | null, id: string) {
  const { user, org } = requireUser(actor);
  assertWritable(ctx, org);
  const p = provider(ctx, id);
  if (p.mode === 'mock') {
    await sql(ctx, "INSERT INTO integrations (user_id, provider, mode, account, token_enc, connected_at) VALUES (?,?, 'mock', ?, NULL, ?) ON CONFLICT(user_id, provider) DO UPDATE SET mode = 'mock', account = excluded.account, token_enc = NULL, connected_at = excluded.connected_at", user.id, p.id, user.email, nowIso(ctx)).run();
    return { mode: 'mock' as const, connected: true };
  }
  const nonce = randomToken().slice(0, 16), exp = ctx.now().getTime() + 10 * 60_000;
  const body = `${user.id}.${p.id}.${nonce}.${exp}`;
  const state = body + '.' + (await hmacHex(stateSecret(ctx), body));
  await sql(ctx, 'INSERT INTO oauth_states (nonce, user_id, provider, created_at) VALUES (?,?,?,?)', nonce, user.id, p.id, nowIso(ctx)).run(); // one-time use
  return { mode: 'live' as const, connected: false, url: p.authUrl(state, redirectUri(ctx, p.id)) };
}

export async function callback(ctx: Ctx, actor: Actor | null, id: string, code: string, state: string): Promise<void> {
  const { user } = requireUser(actor);
  const p = provider(ctx, id);
  const parts = state.split('.');
  if (parts.length !== 5) throw new HttpError(400, 'BAD_STATE', 'This sign-in link is not valid. Please try connecting again.');
  const body = parts.slice(0, 4).join('.');
  if (!safeEqual(parts[4], await hmacHex(stateSecret(ctx), body)) || parts[0] !== user.id || parts[1] !== p.id || Number(parts[3]) < ctx.now().getTime()) throw new HttpError(400, 'BAD_STATE', 'This sign-in link has expired. Please try connecting again.');
  // The state value can be used exactly once: it is consumed here, so a copied callback URL cannot be replayed.
  const used = await sql(ctx, 'DELETE FROM oauth_states WHERE nonce = ? AND user_id = ? AND provider = ?', parts[2], user.id, p.id).run();
  if (used.meta.changes !== 1) throw new HttpError(400, 'BAD_STATE', 'This sign-in link was already used. Please try connecting again.');
  const t = await p.exchangeCode(code, redirectUri(ctx, p.id));
  const enc = await encryptText(encKey(ctx), t.refreshToken);
  await sql(ctx, "INSERT INTO integrations (user_id, provider, mode, account, token_enc, connected_at) VALUES (?,?, 'live', ?, ?, ?) ON CONFLICT(user_id, provider) DO UPDATE SET mode = 'live', account = excluded.account, token_enc = excluded.token_enc, connected_at = excluded.connected_at", user.id, p.id, t.account, enc, nowIso(ctx)).run();
}

export async function disconnect(ctx: Ctx, actor: Actor | null, id: string) {
  const { user } = requireUser(actor);
  const p = provider(ctx, id);
  await sql(ctx, 'DELETE FROM integrations WHERE user_id = ? AND provider = ?', user.id, p.id).run();
  return { connected: false };
}

export async function addPointToCalendar(ctx: Ctx, actor: Actor | null, pointId: string, id: string) {
  const { user, org } = requireUser(actor);
  assertWritable(ctx, org);
  const p = provider(ctx, id);
  const row = await sql(ctx, 'SELECT p.id, p.no, p.title, p.due, p.todo, m.title AS mom_title, m.org_id, m.deleted_at FROM points p JOIN moms m ON m.id = p.mom_id WHERE p.id = ?', pointId).first<{ id: string; no: number; title: string; due: string; todo: string; mom_title: string; org_id: string; deleted_at: string | null }>();
  if (!row || row.org_id !== org.id || row.deleted_at) throw new HttpError(404, 'NOT_FOUND', 'That point could not be found.');
  const mine = await sql(ctx, 'SELECT 1 AS x FROM point_owners WHERE point_id = ? AND email = ?', pointId, user.email).first();
  if (!mine && user.role !== 'owner') throw new HttpError(403, 'NOT_ALLOWED', 'You can add a point to your calendar when you are one of the responsible people.');
  if (!row.due) throw new HttpError(409, 'NO_DUE_DATE', 'This point has no due date yet. Please set one first.');
  const conn = await sql(ctx, 'SELECT mode, token_enc FROM integrations WHERE user_id = ? AND provider = ?', user.id, p.id).first<{ mode: string; token_enc: string | null }>();
  if (!conn) throw new HttpError(409, 'NOT_CONNECTED', `Please connect ${p.label} first.`);
  // Reserve the slot FIRST (primary key = point + user + provider), so a double click can never create two external events.
  const reserved = await sql(ctx, "INSERT OR IGNORE INTO calendar_events (point_id, user_id, provider, external_id, created_at) VALUES (?,?,?, 'pending', ?)", pointId, user.id, p.id, nowIso(ctx)).run();
  if (reserved.meta.changes !== 1) {
    const existing = await sql(ctx, 'SELECT external_id FROM calendar_events WHERE point_id = ? AND user_id = ? AND provider = ?', pointId, user.id, p.id).first<{ external_id: string }>();
    if (existing?.external_id === 'pending') throw new HttpError(409, 'IN_PROGRESS', 'This is being added to your calendar right now. Please wait a moment.');
    return { externalId: existing?.external_id ?? '', already: true, mode: conn.mode };
  }
  try {
    const token = conn.token_enc ? await decryptText(encKey(ctx), conn.token_enc) : null;
    const ev = await p.createEvent(token, { title: `Point ${row.no}: ${row.title}`, date: row.due, description: `From the MOM "${row.mom_title}".\n${row.todo}`.trim() });
    await sql(ctx, 'UPDATE calendar_events SET external_id = ? WHERE point_id = ? AND user_id = ? AND provider = ?', ev.externalId, pointId, user.id, p.id).run();
    return { externalId: ev.externalId, already: false, mode: conn.mode };
  } catch (e) {
    await sql(ctx, "DELETE FROM calendar_events WHERE point_id = ? AND user_id = ? AND provider = ? AND external_id = 'pending'", pointId, user.id, p.id).run(); // let them try again
    throw e;
  }
}
