// The team: invites, removal and hand-over of the owner role.
//
// Adding a person by e-mail creates an INVITE, never a user row. The invite is claimed only when that exact address
// signs in and proves the mailbox with a code. This closes three holes the first review found:
//   * squatting - nobody can park an address in their own team, because no account exists until the owner of the
//     address signs in (and an address that already has an account elsewhere is simply never claimed);
//   * the account-existence oracle - the answer is identical whether the address is registered elsewhere or not;
//   * e-mail bombing / seat burning - only the TEAM OWNER can bring new addresses in (members may pick existing
//     teammates), and every pending invite counts towards the 10-seat limit.
import { nowIso, sql, type Ctx, type Stmt } from '../ctx.ts';
import { MAX_USERS } from '../core/plans.ts';
import { HttpError, requireEmail, str } from '../util.ts';
import { requireUser, type Actor, type OrgRow, type UserRow } from './auth.ts';
import { audit, auditStmt } from './guard.ts';
import { link, sendMail } from './mail.ts';
import { assertWritable } from './plan-gate.ts';

export interface InvitePlan { stmts: Stmt[]; fresh: string[] }

/**
 * Works out which of these addresses are new to the team. Returns the statements that record the invites (to be sent
 * in the SAME atomic batch as the write that needs them, so a later validation failure leaves nothing behind) and the
 * list of fresh addresses to e-mail once the batch has succeeded.
 */
export async function planInvites(ctx: Ctx, org: OrgRow, user: UserRow, emails: readonly string[], names: Record<string, string> = {}): Promise<InvitePlan> {
  const fresh: string[] = [];
  for (const email of new Set(emails)) {
    if (await sql(ctx, 'SELECT 1 AS x FROM users WHERE email = ?', email).first()) continue; // already has an account (here or elsewhere: we never say which)
    if (await sql(ctx, 'SELECT 1 AS x FROM invites WHERE email = ?', email).first()) continue; // already invited
    fresh.push(email);
  }
  if (!fresh.length) return { stmts: [], fresh };
  if (user.role !== 'owner') {
    const owner = await sql(ctx, "SELECT name FROM users WHERE org_id = ? AND role = 'owner'", org.id).first<{ name: string }>();
    throw new HttpError(403, 'NOT_IN_TEAM', `${fresh.join(', ')} ${fresh.length === 1 ? 'is' : 'are'} not on your team yet. Please ask ${owner?.name || 'your team owner'} to add ${fresh.length === 1 ? 'them' : 'them'} first, then pick them here.`, { emails: fresh });
  }
  const used = await sql(ctx, 'SELECT (SELECT COUNT(*) FROM users WHERE org_id = ?) + (SELECT COUNT(*) FROM invites WHERE org_id = ?) AS n', org.id, org.id).first<{ n: number }>();
  if ((used?.n ?? 0) + fresh.length > MAX_USERS) throw new HttpError(409, 'TEAM_FULL', `Your team has room for ${MAX_USERS} people, including those invited. Lovely and full!`);
  const at = nowIso(ctx);
  return {
    fresh,
    stmts: [
      ...fresh.map((e) => sql(ctx, 'INSERT OR IGNORE INTO invites (email, org_id, name, invited_by, created_at) VALUES (?,?,?,?,?)', e, org.id, names[e] ?? '', user.email, at)),
      ...fresh.map((e) => auditStmt(ctx, user.email, 'member_invited', e, undefined, org.id)),
    ],
  };
}

/** Best-effort invitation e-mails (after the batch that recorded the invites succeeded). */
export async function sendInvites(ctx: Ctx, org: OrgRow, user: UserRow, fresh: readonly string[]): Promise<void> {
  for (const to of fresh) {
    await sendMail(ctx, { to, orgId: org.id, kind: 'invite', subject: 'You were invited to the team on MOM', text: `${user.name} added you to the team "${org.name}" on MOM.\nSign in with this e-mail ID (we will send you a short code):\n${link(ctx, '/')}\n` });
  }
}

export async function addTeamMember(ctx: Ctx, actor: Actor | null, input: Record<string, unknown>) {
  const { user, org } = requireUser(actor);
  assertWritable(ctx, org);
  if (user.role !== 'owner') throw new HttpError(403, 'NOT_ALLOWED', 'Only the team owner can add teammates.');
  const email = requireEmail(input.email);
  const name = str(input.name, 80, 'the name');
  if (await sql(ctx, 'SELECT 1 AS x FROM users WHERE org_id = ? AND email = ?', org.id, email).first()) throw new HttpError(409, 'ALREADY_MEMBER', 'They are on your team already.');
  if (await sql(ctx, 'SELECT 1 AS x FROM invites WHERE org_id = ? AND email = ?', org.id, email).first()) throw new HttpError(409, 'ALREADY_MEMBER', 'They are invited already. They join the moment they sign in.');
  const plan = await planInvites(ctx, org, user, [email], name ? { [email]: name } : {});
  if (plan.fresh.length) await ctx.db.batch(plan.stmts);
  await sendInvites(ctx, org, user, [email]);
  return { ok: true };
}

/** Owner only. Removes a pending invite or a member. Their past work and history stay; their access ends now. */
export async function removeMember(ctx: Ctx, actor: Actor | null, rawEmail: unknown) {
  const { user, org } = requireUser(actor);
  if (user.role !== 'owner') throw new HttpError(403, 'NOT_ALLOWED', 'Only the team owner can remove people.');
  const email = requireEmail(rawEmail);
  if (email === user.email) throw new HttpError(409, 'CANNOT_REMOVE_SELF', 'You are the team owner. Hand the owner role to someone else first, then you can leave.');
  const inv = await sql(ctx, 'DELETE FROM invites WHERE org_id = ? AND email = ?', org.id, email).run();
  if (inv.meta.changes > 0) { await audit(ctx, user.email, 'invite_removed', email, undefined, org.id); return { ok: true, removed: 'invite' as const }; }
  const m = await sql(ctx, 'SELECT id FROM users WHERE org_id = ? AND email = ?', org.id, email).first<{ id: string }>();
  if (!m) throw new HttpError(404, 'NOT_FOUND', 'That person is not on your team.');
  await ctx.db.batch([
    sql(ctx, 'DELETE FROM sessions WHERE user_id = ?', m.id),
    sql(ctx, 'DELETE FROM calendar_events WHERE user_id = ?', m.id),
    sql(ctx, 'DELETE FROM integrations WHERE user_id = ?', m.id),
    sql(ctx, 'DELETE FROM oauth_states WHERE user_id = ?', m.id),
    sql(ctx, 'DELETE FROM users WHERE id = ?', m.id),
    auditStmt(ctx, user.email, 'member_removed', email, undefined, org.id),
  ]);
  return { ok: true, removed: 'member' as const };
}

/** Owner only. Hands the owner role (and the right to buy a plan, add people and see every MOM) to a verified teammate. */
export async function transferOwnership(ctx: Ctx, actor: Actor | null, rawEmail: unknown) {
  const { user, org } = requireUser(actor);
  if (user.role !== 'owner') throw new HttpError(403, 'NOT_ALLOWED', 'Only the team owner can hand over the owner role.');
  const email = requireEmail(rawEmail);
  if (email === user.email) throw new HttpError(409, 'ALREADY_OWNER', 'You are the owner already.');
  const t = await sql(ctx, 'SELECT id, verified_at FROM users WHERE org_id = ? AND email = ?', org.id, email).first<{ id: string; verified_at: string | null }>();
  if (!t) throw new HttpError(404, 'NOT_FOUND', 'That person is not on your team.');
  if (!t.verified_at) throw new HttpError(409, 'NOT_VERIFIED', 'They have not signed in yet. Please wait until they have.');
  await ctx.db.batch([
    sql(ctx, "UPDATE users SET role = 'member', title = 'Member' WHERE id = ? AND role = 'owner'", user.id),
    sql(ctx, "UPDATE users SET role = 'owner', title = 'Team owner' WHERE id = ? AND (SELECT COUNT(*) FROM users WHERE org_id = ? AND role = 'owner') = 0", t.id, org.id),
    auditStmt(ctx, user.email, 'owner_transferred', email, undefined, org.id),
  ]);
  const owners = await sql(ctx, "SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND role = 'owner'", org.id).first<{ n: number }>();
  if (owners?.n !== 1) throw new HttpError(500, 'OWNER_INVARIANT', 'Something went wrong with the hand-over. Please try again.');
  await sendMail(ctx, { to: email, orgId: org.id, kind: 'notice', subject: 'You are now the owner of the team on MOM', text: `${user.name} handed you the owner role of "${org.name}" on MOM.\n\n${link(ctx, '/')}\n` });
  return { ok: true };
}
