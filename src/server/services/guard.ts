// Small safety nets shared by the services: per-client rate limits, the audit log, clean-up of old rows.
import { nowIso, sql, type Ctx, type Stmt } from '../ctx.ts';
import { HttpError } from '../util.ts';

/**
 * Fixed-window counter per client address (hashed, never stored raw). Without a client key (laptop, tests) it does nothing.
 * Throws a friendly 429 once the client is over the limit.
 */
export async function ipLimit(ctx: Ctx, bucket: string, max: number, windowSec: number): Promise<void> {
  if (!ctx.clientKey) return;
  const nowSec = Math.floor(ctx.now().getTime() / 1000);
  const end = (Math.floor(nowSec / windowSec) + 1) * windowSec; // the window is identified by when it ends
  const row = await sql(ctx, 'INSERT INTO rate_limits (key, win, n) VALUES (?,?,1) ON CONFLICT(key, win) DO UPDATE SET n = n + 1 RETURNING n', `${bucket}|${ctx.clientKey}`, end).first<{ n: number }>();
  if ((row?.n ?? 0) > max) throw new HttpError(429, 'TOO_MANY_REQUESTS', 'That was a few too many tries from this device. Please wait a little and try again.');
}

/** One line in the append-only audit log. Never put secrets, codes or tokens in `detail`. */
export function auditStmt(ctx: Ctx, actor: string, action: string, target?: string | null, detail?: unknown, orgId?: string | null): Stmt {
  return sql(ctx, 'INSERT INTO audit_log (at, actor, action, target, detail, org_id) VALUES (?,?,?,?,?,?)', nowIso(ctx), actor, action, target ?? null, detail === undefined ? null : JSON.stringify(detail), orgId ?? null);
}
export async function audit(ctx: Ctx, actor: string, action: string, target?: string | null, detail?: unknown, orgId?: string | null): Promise<void> {
  try { await auditStmt(ctx, actor, action, target, detail, orgId).run(); } catch { /* the audit line must never break the request it describes */ }
}

const lastRun = new WeakMap<object, number>();
const iso = (ctx: Ctx, ms: number) => new Date(ctx.now().getTime() - ms).toISOString();
const DAY = 86400_000;

/** Removes expired sessions/codes and old mail/idempotency/OAuth/audit rows. Runs at most every 10 minutes per instance. */
export async function housekeeping(ctx: Ctx, force = false): Promise<void> {
  const now = ctx.now().getTime();
  if (!force && now - (lastRun.get(ctx.db) ?? 0) < 600_000) return;
  lastRun.set(ctx.db, now);
  try {
    await ctx.db.batch([
      sql(ctx, 'DELETE FROM sessions WHERE expires_at <= ?', nowIso(ctx)),
      sql(ctx, 'DELETE FROM auth_codes WHERE expires_at <= ?', iso(ctx, DAY)),
      sql(ctx, 'DELETE FROM outbox WHERE at < ?', iso(ctx, 30 * DAY)),
      sql(ctx, 'DELETE FROM idempotency WHERE created_at < ?', iso(ctx, DAY)),
      sql(ctx, 'DELETE FROM rate_limits WHERE win < ?', Math.floor(now / 1000) - 60),
      sql(ctx, 'DELETE FROM oauth_states WHERE created_at < ?', iso(ctx, 3600_000)),
      sql(ctx, 'DELETE FROM audit_log WHERE at < ?', iso(ctx, 400 * DAY)),
    ]);
  } catch { /* housekeeping is best-effort */ }
}
