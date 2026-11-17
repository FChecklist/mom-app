// MOMs, numbered points, versions, history, merge, delete-for-all, sharing, attachments and the read model.
// Every write builds its statements and sends them as ONE atomic batch together with its history event,
// so the history can never disagree with the data. The history is append-only (no UPDATE/DELETE on events).
import { nowIso, sql, type Ctx, type Stmt } from '../ctx.ts';
import { momPdf } from '../core/pdf.ts';
import { canContribute, canManageMom, canView, canWorkOnPoint, momRole, type MomRole } from '../core/permissions.ts';
import { MAX_USERS, planStatus } from '../core/plans.ts';
import { allowedNext, canTransition, isStatus, STATUSES, type Status } from '../core/status.ts';
import { HttpError, fmtDate, isoDateOnly, maskEmail, nameFromEmail, normEmail, randomToken, requireEmail, rid, safeUrl, sha256Hex, str } from '../util.ts';
import { guestSession, requireUser, startCode, checkCode, type Actor, type OrgRow } from './auth.ts';
import { audit, auditStmt } from './guard.ts';
import { delivered, link, sendMail } from './mail.ts';
import { assertWritable } from './plan-gate.ts';
import { planInvites, sendInvites } from './team.ts';

export { assertWritable };

export interface MomRow {
  id: string; org_id: string; title: string; date: string; venue: string; notes: string;
  status: 'draft' | 'published'; version: number; created_by: string; created_at: string; published_at: string | null;
  deleted_by: string | null; deleted_at: string | null; merged_into: string | null; merged_from: string | null;
}
export interface PointRow { id: string; mom_id: string; no: number; title: string; due: string; status: Status; todo: string; created_at: string }

export const MAX_ATTENDEES = 30;
export const MAX_FILE_BYTES = 1_000_000; // D1 rows are limited to 2 MB; base64 adds a third.
export const MERGE_WARNING = 'This will merge the MOMs into one new MOM. Participants are merged too, and a merged MOM is created. Your original MOMs stay as they are, marked "Merged into".';

type Ev = {
  momId: string; pointId?: string | null; by: string; type: 'content' | 'activity' | 'share' | 'open'; what: string; pwhat?: string | null;
  detail?: unknown; via?: string | null; to?: string | null; from?: string | null; shareId?: string | null;
  /** Shown on the point only, not in the MOM-level log (history copied in by a merge). */
  pointOnly?: boolean;
  /** Write the event only if the statement just before it in the batch really changed a row (so history never claims a change that lost a race). */
  guard?: boolean;
};

/**
 * A content event makes a new numbered version; the number is read inside the same atomic batch.
 * The text may contain {no}: it is replaced inside SQL by the point's number, so numbering is decided by the database, not by a racing read.
 */
function evStmts(ctx: Ctx, e: Ev): Stmt[] {
  const at = nowIso(ctx);
  const detail = e.detail ? JSON.stringify(e.detail) : null;
  const txt = (t: string | null | undefined) => (t != null && t.includes('{no}')
    ? { q: "REPLACE(?, '{no}', COALESCE((SELECT CAST(no AS TEXT) FROM points WHERE id = ?), ''))", p: [t, e.pointId ?? ''] }
    : { q: '?', p: [t ?? null] });
  const w = txt(e.what), pw = txt(e.pwhat);
  const content = e.type === 'content';
  const ins = sql(ctx,
    `INSERT INTO events (mom_id, point_id, at, by, type, what, pwhat, v, detail, via, to_addr, from_addr, share_id, point_only) SELECT ?,?,?,?,?,${w.q},${pw.q},${content ? '(SELECT version FROM moms WHERE id = ?)' : 'NULL'},?,?,?,?,?,?${e.guard ? ' WHERE changes() > 0' : ''}`,
    e.momId, e.pointId ?? null, at, e.by, e.type, ...w.p, ...pw.p, ...(content ? [e.momId] : []), detail, e.via ?? null, e.to ?? null, e.from ?? null, e.shareId ?? null, e.pointOnly ? 1 : 0);
  return content ? [sql(ctx, `UPDATE moms SET version = version + 1 WHERE id = ?${e.guard ? ' AND changes() > 0' : ''}`, e.momId), ins] : [ins];
}

// ---------------------------------------------------------------- lookups
async function momRow(ctx: Ctx, id: string): Promise<MomRow> {
  const m = await sql(ctx, 'SELECT * FROM moms WHERE id = ?', id).first<MomRow>();
  if (!m) throw new HttpError(404, 'NOT_FOUND', 'That MOM could not be found.');
  return m;
}
const attendeesOf = async (ctx: Ctx, momId: string) => (await sql(ctx, 'SELECT email FROM mom_attendees WHERE mom_id = ? ORDER BY rowid', momId).all<{ email: string }>()).results.map((r) => r.email);
const ownersOf = async (ctx: Ctx, pointId: string) => (await sql(ctx, 'SELECT email FROM point_owners WHERE point_id = ? ORDER BY rowid', pointId).all<{ email: string }>()).results.map((r) => r.email);

interface Access { mom: MomRow; attendees: string[]; role: MomRole }
/** Loads a MOM and the actor's role. No access looks exactly like "not found" (it does not leak that the MOM exists). */
async function access(ctx: Ctx, actor: Actor, momId: string): Promise<Access> {
  const mom = await momRow(ctx, momId);
  const attendees = await attendeesOf(ctx, momId);
  let role: MomRole = 'none';
  if (actor.kind === 'guest') role = actor.momId === momId ? 'guest' : 'none';
  else role = momRole({ email: actor.user.email, org_id: actor.user.org_id, role: actor.user.role }, { org_id: mom.org_id, created_by: mom.created_by, status: mom.status }, attendees);
  if (!canView(role)) {
    await audit(ctx, actor.kind === 'guest' ? actor.email : actor.user.email, 'access_denied', momId, undefined, actor.kind === 'user' ? actor.user.org_id : null);
    throw new HttpError(404, 'NOT_FOUND', 'That MOM could not be found.');
  }
  return { mom, attendees, role };
}
const needManage = (r: MomRole) => { if (!canManageMom(r)) throw new HttpError(403, 'NOT_ALLOWED', 'Only the person who made this MOM, or the team owner, can do that.'); };
const needContribute = (r: MomRole) => { if (!canContribute(r)) throw new HttpError(403, 'NOT_ALLOWED', 'Only people in this MOM can do that.'); };
const notDeleted = (m: MomRow) => { if (m.deleted_at) throw new HttpError(409, 'MOM_DELETED', `This MOM has been deleted by @${nameFromEmail(m.deleted_by || '')}.`); };

async function pointAccess(ctx: Ctx, actor: Actor, pointId: string) {
  const point = await sql(ctx, 'SELECT * FROM points WHERE id = ?', pointId).first<PointRow>();
  if (!point) throw new HttpError(404, 'NOT_FOUND', 'That point could not be found.');
  const a = await access(ctx, actor, point.mom_id);
  return { ...a, point, owners: await ownersOf(ctx, pointId) };
}

async function notify(ctx: Ctx, org: OrgRow, to: string[], skip: string, subject: string, text: string, kind: 'notice' | 'invite' = 'notice') {
  for (const e of [...new Set(to)]) if (e !== skip) await sendMail(ctx, { to: e, orgId: org.id, kind, subject, text });
}
const momLink = (ctx: Ctx, id: string) => link(ctx, '/#/mom/' + id);

function emailList(v: unknown, field: string, max = MAX_ATTENDEES): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) { const e = requireEmail(x, field); if (!out.includes(e)) out.push(e); }
  if (out.length > max) throw new HttpError(400, 'TOO_MANY', `Please keep ${field} to ${max} people or fewer.`);
  return out;
}

// ---------------------------------------------------------------- MOM create / update / publish
export async function createMom(ctx: Ctx, actor: Actor | null, input: Record<string, unknown>) {
  const { user, org } = requireUser(actor);
  assertWritable(ctx, org);
  const title = str(input.title, 120, 'a title', { required: true });
  const date = isoDateOnly(input.date, 'the date', { required: true });
  const venue = str(input.venue, 120, 'the venue') || 'To be decided';
  const notes = str(input.notes, 4000, 'the notes');
  const attendees = emailList(input.attendees, 'participants');
  if (!attendees.includes(user.email)) attendees.unshift(user.email);
  const inv = await planInvites(ctx, org, user, attendees);
  const id = rid('mom');
  await ctx.db.batch([
    ...inv.stmts,
    sql(ctx, 'INSERT INTO moms (id, org_id, title, date, venue, notes, status, version, created_by, created_at) VALUES (?,?,?,?,?,?, \'draft\', 0, ?, ?)', id, org.id, title, date, venue, notes, user.email, nowIso(ctx)),
    ...attendees.map((e) => sql(ctx, 'INSERT INTO mom_attendees (mom_id, email) VALUES (?,?)', id, e)),
    ...evStmts(ctx, { momId: id, by: user.email, type: 'content', what: 'Created the MOM' }),
  ]);
  await sendInvites(ctx, org, user, inv.fresh);
  return { id };
}

export async function updateMom(ctx: Ctx, actor: Actor | null, id: string, input: Record<string, unknown>) {
  const { user, org } = requireUser(actor);
  assertWritable(ctx, org);
  const { mom, attendees, role } = await access(ctx, actor!, id);
  needManage(role); notDeleted(mom);
  const next = {
    title: input.title === undefined ? mom.title : str(input.title, 120, 'a title', { required: true }),
    date: input.date === undefined ? mom.date : isoDateOnly(input.date, 'the date', { required: true }),
    venue: input.venue === undefined ? mom.venue : str(input.venue, 120, 'the venue') || 'To be decided',
    notes: input.notes === undefined ? mom.notes : str(input.notes, 4000, 'the notes'),
  };
  const detail: { f: string; from: string; to: string }[] = [];
  (['title', 'date', 'venue', 'notes'] as const).forEach((k) => { if (next[k] !== mom[k]) detail.push({ f: { title: 'Title', date: 'Date', venue: 'Venue', notes: 'Notes' }[k], from: mom[k], to: next[k] }); });
  let newAttendees = attendees;
  let inv: { stmts: Stmt[]; fresh: string[] } = { stmts: [], fresh: [] };
  if (input.attendees !== undefined) {
    newAttendees = emailList(input.attendees, 'participants');
    if (!newAttendees.includes(mom.created_by)) newAttendees.unshift(mom.created_by);
    if ([...attendees].sort().join() !== [...newAttendees].sort().join()) {
      inv = await planInvites(ctx, org, user, newAttendees.filter((e) => !attendees.includes(e)));
      detail.push({ f: 'Participants', from: attendees.join(', '), to: newAttendees.join(', ') });
    } else newAttendees = attendees;
  }
  if (!detail.length) return { changed: false, version: mom.version };
  const stmts: Stmt[] = [...inv.stmts, sql(ctx, 'UPDATE moms SET title = ?, date = ?, venue = ?, notes = ? WHERE id = ?', next.title, next.date, next.venue, next.notes, id)];
  if (newAttendees !== attendees) {
    stmts.push(sql(ctx, 'DELETE FROM mom_attendees WHERE mom_id = ?', id), ...newAttendees.map((e) => sql(ctx, 'INSERT INTO mom_attendees (mom_id, email) VALUES (?,?)', id, e)));
  }
  stmts.push(...evStmts(ctx, { momId: id, by: user.email, type: 'content', what: 'Updated ' + detail.map((d) => d.f.toLowerCase()).join(', '), detail }));
  await ctx.db.batch(stmts);
  await sendInvites(ctx, org, user, inv.fresh);
  const v = (await momRow(ctx, id)).version;
  if (mom.status === 'published') await notify(ctx, org, newAttendees, user.email, `MOM updated: ${next.title} (v${v})`, `${user.name} updated "${next.title}" (version ${v}).\n\n${momLink(ctx, id)}\n`);
  return { changed: true, version: v };
}

export async function publishMom(ctx: Ctx, actor: Actor | null, id: string) {
  const { user, org } = requireUser(actor);
  assertWritable(ctx, org);
  const { mom, attendees, role } = await access(ctx, actor!, id);
  needManage(role); notDeleted(mom);
  if (mom.status === 'published') throw new HttpError(409, 'ALREADY_PUBLISHED', 'This MOM is already published.');
  const n = await sql(ctx, 'SELECT COUNT(*) AS n FROM points WHERE mom_id = ?', id).first<{ n: number }>();
  if (!n?.n) throw new HttpError(409, 'NO_POINTS', 'Please add at least one point before publishing, so people know what to do.');
  const res = await ctx.db.batch([
    sql(ctx, "UPDATE moms SET status = 'published', published_at = ? WHERE id = ? AND status = 'draft'", nowIso(ctx), id),
    ...evStmts(ctx, { momId: id, by: user.email, type: 'content', what: 'Published the MOM', guard: true }),
  ]);
  if (res[0].meta.changes !== 1) throw new HttpError(409, 'ALREADY_PUBLISHED', 'This MOM is already published.'); // lost a race: nothing was logged either
  await notify(ctx, org, attendees, user.email, `MOM published: ${mom.title}`, `${user.name} published "${mom.title}" (${fmtDate(mom.date)}).\nYou can see your points here:\n${momLink(ctx, id)}\n`);
  return { ok: true };
}

// ---------------------------------------------------------------- delete (locked once published)
export async function deleteMom(ctx: Ctx, actor: Actor | null, id: string, o: { forAll: boolean; confirm: unknown }) {
  const { user, org } = requireUser(actor);
  const { mom, attendees, role } = await access(ctx, actor!, id);
  needManage(role);
  if (mom.deleted_at) throw new HttpError(409, 'MOM_DELETED', 'This MOM is already deleted.');
  if (mom.status === 'published' && !o.forAll) throw new HttpError(409, 'PUBLISHED_LOCKED', 'A published MOM is kept safe and cannot be deleted by a simple tap. If it really must go, use "Delete for everyone".');
  if (o.confirm !== true) throw new HttpError(400, 'CONFIRM_REQUIRED', 'This MOM will be deleted for all. Please confirm to continue.');
  const at = nowIso(ctx);
  const res = await ctx.db.batch([
    sql(ctx, 'UPDATE moms SET deleted_by = ?, deleted_at = ? WHERE id = ? AND deleted_at IS NULL', user.email, at, id),
    ...evStmts(ctx, { momId: id, by: user.email, type: 'activity', what: 'Deleted this MOM for everyone', guard: true }),
    // "Delete for everyone" really removes the content: notes, points, files and updates are erased, share links stop opening (the MOM is gone),
    // and the free text of the old history is scrubbed (who / when / what kind of change stay as the audit trail).
    sql(ctx, "UPDATE moms SET notes = '', venue = '' WHERE id = ?", id),
    sql(ctx, 'DELETE FROM attachments WHERE mom_id = ?', id),
    sql(ctx, 'DELETE FROM point_updates WHERE point_id IN (SELECT id FROM points WHERE mom_id = ?)', id),
    sql(ctx, 'DELETE FROM point_owners WHERE point_id IN (SELECT id FROM points WHERE mom_id = ?)', id),
    sql(ctx, 'DELETE FROM calendar_events WHERE point_id IN (SELECT id FROM points WHERE mom_id = ?)', id),
    sql(ctx, 'DELETE FROM points WHERE mom_id = ?', id),
    sql(ctx, "UPDATE events SET detail = NULL, pwhat = NULL, what = CASE type WHEN 'content' THEN 'A change was made (details removed after deletion)' WHEN 'activity' THEN 'Activity (details removed after deletion)' ELSE what END WHERE mom_id = ? AND what NOT LIKE 'Deleted this MOM%'", id),
    auditStmt(ctx, user.email, 'mom_deleted', id, { published: mom.status === 'published' }, org.id),
  ]);
  if (res[0].meta.changes !== 1) throw new HttpError(409, 'MOM_DELETED', 'This MOM is already deleted.');
  if (mom.status === 'published') await notify(ctx, org, attendees, user.email, `MOM deleted: ${mom.title}`, `This MOM has been deleted by @${user.name}.\n`);
  return { ok: true };
}

// ---------------------------------------------------------------- merge
export async function mergeMoms(ctx: Ctx, actor: Actor | null, input: Record<string, unknown>) {
  const { user, org } = requireUser(actor);
  assertWritable(ctx, org);
  const ids = [...new Set(Array.isArray(input.ids) ? input.ids.map(String) : [])];
  if (ids.length < 2) throw new HttpError(400, 'NEED_TWO', 'Please choose at least two MOMs to merge.');
  if (ids.length > 10) throw new HttpError(400, 'TOO_MANY', 'Please merge ten MOMs or fewer at a time.');
  const parts: Access[] = [];
  for (const id of ids) {
    const a = await access(ctx, actor!, id);
    needManage(a.role);
    if (a.mom.deleted_at) throw new HttpError(409, 'MOM_DELETED', `"${a.mom.title}" has been deleted and cannot be merged.`);
    if (a.mom.merged_into) throw new HttpError(409, 'ALREADY_MERGED', `"${a.mom.title}" has already been merged into another MOM. Please merge the new one instead.`);
    parts.push(a);
  }
  const title = str(input.title, 120, 'the merged MOM name') || 'Merged MOM';
  const att = [...new Set(parts.flatMap((p) => p.attendees))];
  const pts = (await Promise.all(parts.map(async (p) => (await sql(ctx, 'SELECT * FROM points WHERE mom_id = ? ORDER BY no', p.mom.id).all<PointRow>()).results.map((x) => ({ ...x, src: p.mom })))) ).flat();
  const preview = { titles: parts.map((p) => p.mom.title), participants: att, points: pts.length };
  if (input.confirm !== true) throw new HttpError(409, 'MERGE_NEEDS_CONFIRM', MERGE_WARNING, { preview });

  const newId = rid('mom'), at = nowIso(ctx);
  const notes = parts.map((p) => `${p.mom.title}: ${p.mom.notes}`).join('\n').slice(0, 4000);
  const stmts: Stmt[] = [
    sql(ctx, "INSERT INTO moms (id, org_id, title, date, venue, notes, status, version, created_by, created_at, merged_from) VALUES (?,?,?,?, 'Merged MOM', ?, 'draft', 0, ?, ?, ?)", newId, org.id, title, at.slice(0, 10), notes, user.email, at, JSON.stringify(ids)),
    ...att.map((e) => sql(ctx, 'INSERT INTO mom_attendees (mom_id, email) VALUES (?,?)', newId, e)),
    ...evStmts(ctx, { momId: newId, by: user.email, type: 'content', what: `Created by merging ${parts.length} MOMs`, detail: [{ f: 'Merged from', from: '', to: parts.map((p) => `${p.mom.title} (v${p.mom.version})`).join(' + ') }, { f: 'Participants', from: '', to: att.join(', ') }] }),
  ];
  // MOM-level attachments are copied (in SQL, so file data never passes through memory).
  for (const p of parts) {
    const files = (await sql(ctx, 'SELECT id FROM attachments WHERE mom_id = ? AND point_id IS NULL', p.mom.id).all<{ id: string }>()).results;
    for (const f of files) stmts.push(sql(ctx, 'INSERT INTO attachments (id, mom_id, point_id, kind, name, url, mime, size_bytes, data, by, at) SELECT ?, ?, NULL, kind, name, url, mime, size_bytes, data, by, at FROM attachments WHERE id = ?', rid('att'), newId, f.id));
  }
  let no = 0;
  for (const p of pts) {
    no++;
    const pid = rid('pt');
    stmts.push(sql(ctx, 'INSERT INTO points (id, mom_id, no, title, due, status, todo, created_at) VALUES (?,?,?,?,?,?,?,?)', pid, newId, no, p.title, p.due, p.status, p.todo, at));
    stmts.push(sql(ctx, 'INSERT INTO point_owners (point_id, email) SELECT ?, email FROM point_owners WHERE point_id = ?', pid, p.id));
    stmts.push(sql(ctx, 'INSERT INTO point_updates (point_id, at, by, text) SELECT ?, at, by, text FROM point_updates WHERE point_id = ?', pid, p.id));
    // The point's own history travels with it (shown on the point; not repeated in the MOM-level log).
    stmts.push(sql(ctx, "INSERT INTO events (mom_id, point_id, at, by, type, what, pwhat, v, detail, via, to_addr, from_addr, share_id, point_only) SELECT ?, ?, at, by, 'activity', COALESCE(pwhat, what), COALESCE(pwhat, what), NULL, NULL, NULL, NULL, NULL, NULL, 1 FROM events WHERE point_id = ? ORDER BY id", newId, pid, p.id));
    stmts.push(sql(ctx, "INSERT INTO attachments (id, mom_id, point_id, kind, name, url, mime, size_bytes, data, by, at) SELECT 'att_' || lower(hex(randomblob(8))), ?, ?, kind, name, url, mime, size_bytes, data, by, at FROM attachments WHERE point_id = ?", newId, pid, p.id));
    stmts.push(...evStmts(ctx, { momId: newId, pointId: pid, by: user.email, type: 'activity', what: `Point ${no}: copied here by merging "${p.src.title}"`, pwhat: `Copied here by merging "${p.src.title}"` }));
  }
  for (const p of parts) {
    stmts.push(sql(ctx, 'UPDATE moms SET merged_into = ? WHERE id = ?', newId, p.mom.id));
    stmts.push(...evStmts(ctx, { momId: p.mom.id, by: user.email, type: 'activity', what: `Merged into "${title}"` }));
  }
  await ctx.db.batch(stmts);
  return { id: newId };
}

// ---------------------------------------------------------------- points
function pointInput(input: Record<string, unknown>, partial: boolean) {
  const out: { title?: string; due?: string; todo?: string; status?: Status } = {};
  if (!partial || input.title !== undefined) out.title = str(input.title, 200, 'what needs doing', { required: true });
  if (!partial || input.due !== undefined) out.due = isoDateOnly(input.due, 'the due date');
  if (!partial || input.todo !== undefined) out.todo = str(input.todo, 2000, 'the details');
  if (input.status !== undefined || !partial) {
    const s = input.status === undefined ? 'WIP' : input.status;
    if (!isStatus(s)) throw new HttpError(400, 'BAD_STATUS', `Status must be one of: ${STATUSES.join(', ')}.`);
    out.status = s;
  }
  return out;
}

export async function addPoint(ctx: Ctx, actor: Actor | null, momId: string, input: Record<string, unknown>) {
  const { user, org } = requireUser(actor);
  assertWritable(ctx, org);
  const { mom, attendees, role } = await access(ctx, actor!, momId);
  needManage(role); notDeleted(mom);
  const f = pointInput(input, false);
  const owners = emailList(input.owners, 'responsible people', 10);
  if (!owners.length) throw new HttpError(400, 'NEED_OWNER', 'Please choose at least one responsible person.');
  const inv = await planInvites(ctx, org, user, owners);
  const id = rid('pt');
  const stmts: Stmt[] = [
    ...inv.stmts,
    // The number comes from the database inside the same statement that inserts the row, so two taps can never collide.
    sql(ctx, 'INSERT INTO points (id, mom_id, no, title, due, status, todo, created_at) VALUES (?,?, (SELECT COALESCE(MAX(no), 0) + 1 FROM points WHERE mom_id = ?), ?,?,?,?,?)', id, momId, momId, f.title, f.due ?? '', f.status, f.todo ?? '', nowIso(ctx)),
    ...owners.map((e) => sql(ctx, 'INSERT INTO point_owners (point_id, email) VALUES (?,?)', id, e)),
    ...owners.filter((e) => !attendees.includes(e)).map((e) => sql(ctx, 'INSERT INTO mom_attendees (mom_id, email) VALUES (?,?)', momId, e)),
    ...evStmts(ctx, { momId, pointId: id, by: user.email, type: 'content', what: `Added point {no}: ${f.title}`, pwhat: 'Created this point' }),
  ];
  await ctx.db.batch(stmts);
  await sendInvites(ctx, org, user, inv.fresh);
  const no = (await sql(ctx, 'SELECT no FROM points WHERE id = ?', id).first<{ no: number }>())!.no;
  if (mom.status === 'published') await notify(ctx, org, owners, user.email, `You were given a point: ${f.title}`, `${user.name} gave you point ${no} in "${mom.title}":\n${f.title}\n\n${momLink(ctx, momId)}\n`);
  return { id, no };
}

/** Removing a point is only possible while the MOM is still a draft; afterwards a point can be marked Discarded instead. */
export async function deletePoint(ctx: Ctx, actor: Actor | null, pointId: string) {
  const { user, org } = requireUser(actor);
  assertWritable(ctx, org);
  const { mom, point, role } = await pointAccess(ctx, actor!, pointId);
  needManage(role); notDeleted(mom);
  if (mom.status === 'published') throw new HttpError(409, 'PUBLISHED_LOCKED', 'A published MOM keeps all its points. If a point is no longer needed, mark it Discarded - it stays on record, crossed out.');
  await ctx.db.batch([
    sql(ctx, 'DELETE FROM point_owners WHERE point_id = ?', pointId),
    sql(ctx, 'DELETE FROM point_updates WHERE point_id = ?', pointId),
    sql(ctx, 'DELETE FROM attachments WHERE point_id = ?', pointId),
    sql(ctx, 'DELETE FROM calendar_events WHERE point_id = ?', pointId),
    sql(ctx, 'DELETE FROM points WHERE id = ?', pointId),
    // close the gap (two steps because (mom_id, no) must stay unique while rows move)
    sql(ctx, 'UPDATE points SET no = -no WHERE mom_id = ? AND no > ?', mom.id, point.no),
    sql(ctx, 'UPDATE points SET no = -no - 1 WHERE mom_id = ? AND no < 0', mom.id),
    ...evStmts(ctx, { momId: mom.id, by: user.email, type: 'content', what: `Removed point ${point.no}: ${point.title}`, detail: [{ f: 'Point removed', from: point.title, to: '' }] }),
  ]);
  return { ok: true };
}

export async function updatePoint(ctx: Ctx, actor: Actor | null, pointId: string, input: Record<string, unknown>) {
  const { user, org } = requireUser(actor);
  assertWritable(ctx, org);
  const { mom, point, role, owners } = await pointAccess(ctx, actor!, pointId);
  notDeleted(mom);
  if (!canWorkOnPoint(role, user.email, owners)) throw new HttpError(403, 'NOT_ALLOWED', 'Only the people responsible for this point, or the MOM owner, can change it.');
  const f = pointInput(input, true);
  const detail: { f: string; from: string; to: string }[] = [];
  if (f.title !== undefined && f.title !== point.title) detail.push({ f: 'Point', from: point.title, to: f.title });
  if (f.due !== undefined && f.due !== point.due) detail.push({ f: 'Due date', from: fmtDate(point.due), to: fmtDate(f.due) });
  if (f.todo !== undefined && f.todo !== point.todo) detail.push({ f: 'What to do', from: point.todo, to: f.todo });
  if (!detail.length) return { changed: false };
  const what = 'Updated ' + detail.map((d) => d.f.toLowerCase()).join(', ');
  await ctx.db.batch([
    sql(ctx, 'UPDATE points SET title = ?, due = ?, todo = ? WHERE id = ?', f.title ?? point.title, f.due ?? point.due, f.todo ?? point.todo, pointId),
    ...evStmts(ctx, { momId: mom.id, pointId, by: user.email, type: 'content', what: `Point ${point.no}: ${what}`, pwhat: what, detail }),
  ]);
  return { changed: true };
}

export async function setPointStatus(ctx: Ctx, actor: Actor | null, pointId: string, status: unknown) {
  const { user, org } = requireUser(actor);
  assertWritable(ctx, org);
  const { mom, point, role, owners } = await pointAccess(ctx, actor!, pointId);
  notDeleted(mom);
  if (!canWorkOnPoint(role, user.email, owners)) throw new HttpError(403, 'NOT_ALLOWED', 'Only the people responsible for this point, or the MOM owner, can change its status.');
  if (!isStatus(status)) throw new HttpError(400, 'BAD_STATUS', `Status must be one of: ${STATUSES.join(', ')}.`);
  if (!canTransition(point.status, status)) throw new HttpError(409, 'BAD_TRANSITION', `A ${point.status} point can only move to: ${allowedNext(point.status).join(', ')}.`, { allowed: allowedNext(point.status) });
  const what = `Status: ${point.status} → ${status}`;
  const res = await ctx.db.batch([
    sql(ctx, 'UPDATE points SET status = ? WHERE id = ? AND status = ?', status, pointId, point.status),
    ...evStmts(ctx, { momId: mom.id, pointId, by: user.email, type: 'content', what: `Point ${point.no}: ${what}`, pwhat: what, detail: [{ f: 'Status', from: point.status, to: status }], guard: true }),
  ]);
  if (res[0].meta.changes !== 1) throw new HttpError(409, 'CHANGED_MEANWHILE', 'Someone changed this point a moment ago. Please look again and retry.'); // nothing was logged
  return { status };
}

export async function setPointOwners(ctx: Ctx, actor: Actor | null, pointId: string, input: Record<string, unknown>) {
  const { user, org } = requireUser(actor);
  assertWritable(ctx, org);
  const { mom, point, role, owners, attendees } = await pointAccess(ctx, actor!, pointId);
  notDeleted(mom);
  if (!canWorkOnPoint(role, user.email, owners)) throw new HttpError(403, 'NOT_ALLOWED', 'Only the people responsible for this point, or the MOM owner, can change who is responsible.');
  const add = emailList(input.add, 'people to add', 10).filter((e) => !owners.includes(e));
  const remove = emailList(input.remove, 'people to remove', 10).filter((e) => owners.includes(e));
  if (!add.length && !remove.length) return { owners };
  const result = [...owners.filter((e) => !remove.includes(e)), ...add];
  if (!result.length) throw new HttpError(409, 'NEED_OWNER', 'A point needs at least one responsible person.');
  const inv = await planInvites(ctx, org, user, add);
  const nm = (e: string) => nameFromEmail(e);
  const parts = [add.length ? `Added ${add.map(nm).join(', ')} as responsible` : '', remove.length ? `Removed ${remove.map(nm).join(', ')} from responsible people` : ''].filter(Boolean);
  const what = parts.join('; ');
  await ctx.db.batch([
    ...inv.stmts,
    ...remove.map((e) => sql(ctx, 'DELETE FROM point_owners WHERE point_id = ? AND email = ?', pointId, e)),
    ...add.map((e) => sql(ctx, 'INSERT INTO point_owners (point_id, email) VALUES (?,?)', pointId, e)),
    ...add.filter((e) => !attendees.includes(e)).map((e) => sql(ctx, 'INSERT INTO mom_attendees (mom_id, email) VALUES (?,?)', mom.id, e)),
    ...evStmts(ctx, { momId: mom.id, pointId, by: user.email, type: 'content', what: `Point ${point.no}: ${what}`, pwhat: what, detail: [{ f: 'Responsible', from: owners.join(', '), to: result.join(', ') }] }),
  ]);
  await sendInvites(ctx, org, user, inv.fresh);
  if (mom.status === 'published') await notify(ctx, org, add, user.email, `You were given a point: ${point.title}`, `${user.name} gave you point ${point.no} in "${mom.title}":\n${point.title}\n\n${momLink(ctx, mom.id)}\n`);
  return { owners: result };
}

export async function postUpdate(ctx: Ctx, actor: Actor | null, pointId: string, text: unknown) {
  const { user, org } = requireUser(actor);
  assertWritable(ctx, org);
  const { mom, point, role, owners } = await pointAccess(ctx, actor!, pointId);
  notDeleted(mom);
  if (!canWorkOnPoint(role, user.email, owners)) throw new HttpError(403, 'NOT_ALLOWED', 'Only the people responsible for this point, or the MOM owner, can post updates.');
  const t = str(text, 2000, 'your update', { required: true });
  await ctx.db.batch([
    sql(ctx, 'INSERT INTO point_updates (point_id, at, by, text) VALUES (?,?,?,?)', pointId, nowIso(ctx), user.email, t),
    ...evStmts(ctx, { momId: mom.id, pointId, by: user.email, type: 'activity', what: `Point ${point.no}: Posted an update`, pwhat: 'Posted an update' }),
  ]);
  return { ok: true };
}

// ---------------------------------------------------------------- attachments
const sniff = (b: Uint8Array): string | null => {
  const s = (i: number, str: string) => str.split('').every((c, k) => b[i + k] === c.charCodeAt(0));
  if (s(0, '%PDF-')) return 'application/pdf';
  if (b[0] === 0x89 && s(1, 'PNG')) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (s(0, 'GIF8')) return 'image/gif';
  if (s(0, 'RIFF') && s(8, 'WEBP')) return 'image/webp';
  return null;
};

export async function addAttachment(ctx: Ctx, actor: Actor | null, target: { momId?: string; pointId?: string }, input: Record<string, unknown>) {
  const { user, org } = requireUser(actor);
  assertWritable(ctx, org);
  let momId = target.momId || '', pointId: string | null = null, point: PointRow | null = null;
  if (target.pointId) { const pa = await pointAccess(ctx, actor!, target.pointId); momId = pa.mom.id; pointId = pa.point.id; point = pa.point; }
  const { mom, role } = await access(ctx, actor!, momId);
  needContribute(role); notDeleted(mom);
  const kind = String(input.kind || '');
  let name = '', url: string | null = null, mime: string | null = null, size: number | null = null, data: string | null = null;
  if (kind === 'text') { name = str(input.text ?? input.name, 2000, 'your note', { required: true }); }
  else if (kind === 'url' || kind === 'link') {
    url = safeUrl(str(input.url ?? input.name, 1000, 'the web address', { required: true }));
    if (!url) throw new HttpError(400, 'BAD_URL', 'Please type a full web address starting with https://');
    name = kind === 'link' ? str(input.name, 120, 'the link name') || url : url;
  } else if (kind === 'pdf' || kind === 'image') {
    name = str(input.name, 120, 'the file name', { required: true });
    const b64 = String(input.dataBase64 || '');
    if (!b64) throw new HttpError(400, 'MISSING_FIELD', 'Please choose a file to attach.');
    let bytes: Uint8Array;
    try { const bin = atob(b64); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); } catch { throw new HttpError(400, 'BAD_FILE', 'That file could not be read.'); }
    if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, 'FILE_TOO_BIG', 'Please keep files under 1 MB.');
    const real = sniff(bytes);
    if (!real || (kind === 'pdf') !== (real === 'application/pdf')) throw new HttpError(400, 'BAD_FILE', kind === 'pdf' ? 'That does not look like a PDF file.' : 'That does not look like a picture (PNG, JPG, GIF or WebP).');
    mime = real; size = bytes.length; data = b64;
  } else throw new HttpError(400, 'BAD_KIND', 'Attach a text note, web address, link, PDF or image.');
  const id = rid('att');
  const label = { text: 'text note', url: 'web address', link: 'link', pdf: 'PDF', image: 'image' }[kind]!;
  await ctx.db.batch([
    sql(ctx, 'INSERT INTO attachments (id, mom_id, point_id, kind, name, url, mime, size_bytes, data, by, at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', id, momId, pointId, kind, name, url, mime, size, data, user.email, nowIso(ctx)),
    ...evStmts(ctx, { momId, pointId, by: user.email, type: 'activity', what: `Attached ${label} "${name.length > 40 ? name.slice(0, 40) + '...' : name}"${point ? ` to point ${point.no}` : ''}`, pwhat: point ? `Attached ${label}` : null }),
  ]);
  return { id };
}

export async function getAttachment(ctx: Ctx, actor: Actor | null, id: string): Promise<Response> {
  if (!actor) throw new HttpError(401, 'SIGN_IN_REQUIRED', 'Please sign in with your e-mail first.');
  const a = await sql(ctx, 'SELECT * FROM attachments WHERE id = ?', id).first<{ mom_id: string; kind: string; name: string; mime: string | null; data: string | null }>();
  if (!a || !a.data) throw new HttpError(404, 'NOT_FOUND', 'That file could not be found.');
  const { mom } = await access(ctx, actor, a.mom_id);
  notDeleted(mom);
  const bin = atob(a.data), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const safeName = a.name.replace(/[^\w.\- ]+/g, '_');
  return new Response(bytes, { headers: { 'content-type': a.mime || 'application/octet-stream', 'content-disposition': `attachment; filename="${safeName}"`, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' } });
}

// ---------------------------------------------------------------- sharing and the guest gate
const shareTtlDays = (ctx: Ctx) => Math.max(1, Number(ctx.env.SHARE_TTL_DAYS || 30));

/**
 * Creates a share link (valid SHARE_TTL_DAYS, default 30; the sharer or the MOM owner can cancel it any time).
 * An e-mail share is bound to the address it was sent to: only that address can open it. WhatsApp and plain links
 * are "bearer" links - whoever holds one can open it after confirming ANY e-mail - so the chain log records who did.
 * The log only says "Shared by e-mail" once the mail has really gone out; for WhatsApp/link it says a link was MADE
 * (we cannot know whether it was sent), and every open is logged separately.
 */
export async function shareMom(ctx: Ctx, actor: Actor | null, momId: string, input: Record<string, unknown>) {
  const { user, org } = requireUser(actor);
  assertWritable(ctx, org);
  const { mom, role } = await access(ctx, actor!, momId);
  needContribute(role); notDeleted(mom);
  if (mom.status !== 'published') throw new HttpError(409, 'NOT_PUBLISHED', 'Please publish the MOM first, then share it.');
  const via = String(input.via || '');
  if (via !== 'email' && via !== 'whatsapp' && via !== 'link') throw new HttpError(400, 'BAD_VIA', 'Share by e-mail, WhatsApp or link.');
  let to: string | null = null;
  if (via === 'email') to = requireEmail(input.to, 'to');
  else if (via === 'whatsapp') to = (str(input.to, 60, 'the chat name') || 'WhatsApp') + ' (WhatsApp)';
  else to = 'link';
  const token = randomToken(), id = rid('sh');
  const url = link(ctx, '/#/shared/' + token);
  const at = nowIso(ctx), expiresAt = new Date(ctx.now().getTime() + shareTtlDays(ctx) * 86400_000).toISOString();
  const wa = (to || '').replace(' (WhatsApp)', '');
  const what = via === 'email' ? `Shared by e-mail with ${to}` : via === 'whatsapp' ? `Made a WhatsApp share link for ${wa}` : 'Created a share link';
  const insert = sql(ctx, 'INSERT INTO shares (id, mom_id, token_hash, via, to_addr, by, at, expires_at) VALUES (?,?,?,?,?,?,?,?)', id, momId, await sha256Hex(token), via, to, user.email, at, expiresAt);
  const text = `Namaste! ${user.name} shared the MOM "${mom.title}" with you.\nTo keep it safe, please confirm your e-mail ID first:\n${url}\n\nThe link works until ${fmtDate(expiresAt)}.\n`;
  let mail: string | undefined;
  if (via === 'email') {
    await insert.run();
    const status = await sendMail(ctx, { to: to!, orgId: org.id, kind: 'share', subject: `${user.name} shared a MOM with you: ${mom.title}`, text });
    mail = status;
    if (!delivered(status)) {
      // Nothing went out, so nothing was shared: cancel the link and tell the truth.
      await sql(ctx, 'UPDATE shares SET revoked_at = ?, revoked_by = ? WHERE id = ?', at, user.email, id).run();
      throw new HttpError(503, 'MAIL_UNAVAILABLE', 'The e-mail could not be sent just now, so nothing was shared. Please try again in a little while, or share by link.');
    }
    await ctx.db.batch(evStmts(ctx, { momId, by: user.email, type: 'share', what, via, to, shareId: id }));
  } else {
    await ctx.db.batch([insert, ...evStmts(ctx, { momId, by: user.email, type: 'share', what, via, to, shareId: id })]);
  }
  return { id, link: url, expiresAt, ...(mail ? { mail } : {}), ...(via === 'whatsapp' ? { waUrl: 'https://wa.me/?text=' + encodeURIComponent(text) } : {}) };
}

export async function revokeShare(ctx: Ctx, actor: Actor | null, shareId: string) {
  const { user } = requireUser(actor);
  const sh = await sql(ctx, 'SELECT * FROM shares WHERE id = ?', shareId).first<ShareRow>();
  if (!sh) throw new HttpError(404, 'NOT_FOUND', 'That share link could not be found.');
  const { mom, role } = await access(ctx, actor!, sh.mom_id);
  if (!(canManageMom(role) || sh.by === user.email)) throw new HttpError(403, 'NOT_ALLOWED', 'Only the person who shared it, or the MOM owner, can cancel a link.');
  if (sh.revoked_at) throw new HttpError(409, 'ALREADY_CANCELLED', 'That link was cancelled already.');
  notDeleted(mom);
  const label = sh.via === 'email' ? `the e-mail share to ${sh.to_addr}` : sh.via === 'whatsapp' ? `the WhatsApp link for ${(sh.to_addr || '').replace(' (WhatsApp)', '')}` : 'a share link';
  await ctx.db.batch([
    sql(ctx, 'UPDATE shares SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL', nowIso(ctx), user.email, shareId),
    sql(ctx, 'DELETE FROM sessions WHERE share_id = ?', shareId), // anyone already inside is out at once
    ...evStmts(ctx, { momId: mom.id, by: user.email, type: 'activity', what: `Cancelled ${label}`, shareId }),
    auditStmt(ctx, user.email, 'share_cancelled', shareId, undefined, mom.org_id),
  ]);
  return { ok: true };
}

interface ShareRow { id: string; mom_id: string; via: string; to_addr: string | null; by: string; at: string; expires_at: string | null; revoked_at: string | null; deleted_at?: string | null }
/** A link works only while it is not cancelled, not expired and its MOM still exists. */
async function shareByToken(ctx: Ctx, token: string): Promise<ShareRow> {
  const s = await sql(ctx, 'SELECT sh.*, m.deleted_at FROM shares sh JOIN moms m ON m.id = sh.mom_id WHERE sh.token_hash = ?', await sha256Hex(token)).first<ShareRow>();
  if (!s || s.revoked_at || s.deleted_at || (s.expires_at && s.expires_at <= nowIso(ctx))) throw new HttpError(404, 'NOT_FOUND', 'This link is not valid any more. Please ask the sender for a new one.');
  return s;
}
/** What a not-yet-verified visitor may see: who sent it (and, for an e-mail share, a masked hint of the address it is for). Nothing about the content. */
export async function sharePreview(ctx: Ctx, token: string) {
  const s = await shareByToken(ctx, token);
  const from = await sql(ctx, 'SELECT name, email FROM users WHERE email = ?', s.by).first<{ name: string; email: string }>();
  return { from: from ? { name: from.name, email: from.email } : { name: nameFromEmail(s.by), email: s.by }, via: s.via, forEmail: s.via === 'email' ? maskEmail(s.to_addr || '') : null, expiresAt: s.expires_at };
}
function assertRecipient(s: ShareRow, rawEmail: unknown) {
  if (s.via === 'email' && s.to_addr && normEmail(rawEmail) !== s.to_addr) throw new HttpError(403, 'WRONG_RECIPIENT', `This link was e-mailed to ${maskEmail(s.to_addr)}. Please use that e-mail ID to open it.`);
}
export async function shareStartCode(ctx: Ctx, token: string, email: unknown) {
  const s = await shareByToken(ctx, token);
  assertRecipient(s, email);
  return startCode(ctx, email, 'share:' + s.id);
}
export async function shareVerify(ctx: Ctx, token: string, rawEmail: unknown, rawCode: unknown) {
  const s = await shareByToken(ctx, token);
  assertRecipient(s, rawEmail);
  const { email } = await checkCode(ctx, rawEmail, 'share:' + s.id, rawCode);
  const seen = await sql(ctx, "SELECT id FROM events WHERE share_id = ? AND type = 'open' AND by = ?", s.id, email).first();
  if (!seen) await ctx.db.batch(evStmts(ctx, { momId: s.mom_id, by: email, type: 'open', what: 'Opened the shared link (e-mail confirmed)', from: s.by, shareId: s.id }));
  const session = await guestSession(ctx, email, s.mom_id, s.id);
  return { token: session, momId: s.mom_id };
}

/**
 * The public chain log: anyone holding a valid link can see who passed the MOM on and who opened it - with outside
 * e-mail addresses masked - without confirming an e-mail and without seeing a word of the MOM itself.
 */
export async function shareChain(ctx: Ctx, token: string) {
  const s = await shareByToken(ctx, token);
  const rows = (await sql(ctx, "SELECT type, at, by, via, to_addr, from_addr FROM events WHERE mom_id = ? AND type IN ('share','open') ORDER BY id", s.mom_id).all<{ type: string; at: string; by: string; via: string | null; to_addr: string | null; from_addr: string | null }>()).results;
  const users = (await sql(ctx, 'SELECT email, name FROM users WHERE org_id = (SELECT org_id FROM moms WHERE id = ?)', s.mom_id).all<{ email: string; name: string }>()).results;
  const who = (e: string) => users.find((u) => u.email === e)?.name ?? maskEmail(e);
  return {
    chain: rows.map((r) => r.type === 'share'
      ? { type: 'share', at: r.at, by: who(r.by), via: r.via, to: r.via === 'email' ? maskEmail(r.to_addr || '') : r.via === 'whatsapp' ? (r.to_addr || '').replace(' (WhatsApp)', '') : null }
      : { type: 'open', at: r.at, by: who(r.by), from: r.from_addr ? who(r.from_addr) : null }),
  };
}

// ---------------------------------------------------------------- PDF
/** The built-in PDF font covers Western (Latin-1) letters only. True when any text of this MOM has other letters (e.g. Devanagari). */
export const needsUnicode = (texts: readonly string[]) => texts.some((t) => /[^\u0000-\u00ff\u2192]/.test(t));

export async function momPdfBytes(ctx: Ctx, actor: Actor | null, id: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; name: string; lossy: boolean }> {
  if (!actor) throw new HttpError(401, 'SIGN_IN_REQUIRED', 'Please sign in with your e-mail first.');
  const { mom, attendees } = await access(ctx, actor, id);
  notDeleted(mom);
  const users = (await sql(ctx, 'SELECT email, name FROM users WHERE org_id = ?', mom.org_id).all<{ email: string; name: string }>()).results;
  const nm = (e: string) => users.find((u) => u.email === e)?.name || nameFromEmail(e);
  const pts = (await sql(ctx, 'SELECT * FROM points WHERE mom_id = ? ORDER BY no', id).all<PointRow>()).results;
  const owners = (await sql(ctx, 'SELECT po.point_id, po.email FROM point_owners po JOIN points p ON p.id = po.point_id WHERE p.mom_id = ? ORDER BY po.rowid', id).all<{ point_id: string; email: string }>()).results;
  const hist = (await sql(ctx, "SELECT v, what, by, at FROM events WHERE mom_id = ? AND type = 'content' ORDER BY id", id).all<{ v: number; what: string; by: string; at: string }>()).results;
  const bytes = momPdf({
    title: mom.title, date: mom.date, venue: mom.venue, status: mom.status, version: mom.version, notes: mom.notes,
    attendeeNames: attendees.map(nm),
    points: pts.map((p) => ({ no: p.no, title: p.title, status: p.status, due: p.due, ownerNames: owners.filter((o) => o.point_id === p.id).map((o) => nm(o.email)) })),
    history: hist.map((h) => ({ v: h.v, what: h.what, byName: nm(h.by), at: h.at })),
    host: ctx.baseUrl.replace(/^https?:\/\//, ''),
  });
  await ctx.db.batch(evStmts(ctx, { momId: id, by: actor.kind === 'user' ? actor.user.email : actor.email, type: 'activity', what: 'Downloaded a PDF copy' }));
  const lossy = needsUnicode([mom.title, mom.venue, mom.notes, ...users.map((u) => u.name), ...pts.map((p) => p.title), ...hist.map((h) => h.what)]);
  return { bytes, name: mom.title.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') || 'MOM', lossy };
}

// ---------------------------------------------------------------- read model for the screens
interface EvRow { id: number; mom_id: string; point_id: string | null; at: string; by: string; type: string; what: string; pwhat: string | null; v: number | null; detail: string | null; via: string | null; to_addr: string | null; from_addr: string | null; share_id: string | null; point_only: number }

interface ShareOut { id: string; via: string; to: string | null; by: string; at: string; expiresAt: string | null; cancelled: boolean; expired: boolean; canCancel: boolean }

export async function snapshot(ctx: Ctx, actor: Actor) {
  const guest = actor.kind === 'guest';
  const orgId = guest ? (await momRow(ctx, actor.momId)).org_id : actor.user.org_id;
  const where = guest ? 'm.id = ?' : 'm.org_id = ?';
  const key = guest ? actor.momId : orgId;
  const q = <T>(select: string, from: string) => sql(ctx, `${select} ${from} WHERE ${where}`, key).all<T>().then((r) => r.results);
  const [moms, att, pts, own, evs, files, ups, users, invites, shareRows] = await Promise.all([
    q<MomRow>('SELECT m.*', 'FROM moms m'),
    q<{ mom_id: string; email: string }>('SELECT a.mom_id, a.email', 'FROM mom_attendees a JOIN moms m ON m.id = a.mom_id'),
    q<PointRow>('SELECT p.*', 'FROM points p JOIN moms m ON m.id = p.mom_id'),
    q<{ point_id: string; email: string }>('SELECT o.point_id, o.email', 'FROM point_owners o JOIN points p ON p.id = o.point_id JOIN moms m ON m.id = p.mom_id'),
    q<EvRow>('SELECT e.*', 'FROM events e JOIN moms m ON m.id = e.mom_id'),
    q<{ id: string; mom_id: string; point_id: string | null; kind: string; name: string; url: string | null; mime: string | null; size_bytes: number | null; by: string; at: string; has_data: number }>('SELECT t.id, t.mom_id, t.point_id, t.kind, t.name, t.url, t.mime, t.size_bytes, t.by, t.at, (t.data IS NOT NULL) AS has_data', 'FROM attachments t JOIN moms m ON m.id = t.mom_id'),
    q<{ point_id: string; at: string; by: string; text: string }>('SELECT u.point_id, u.at, u.by, u.text', 'FROM point_updates u JOIN points p ON p.id = u.point_id JOIN moms m ON m.id = p.mom_id'),
    sql(ctx, 'SELECT email, name, role, title, verified_at FROM users WHERE org_id = ? ORDER BY created_at, rowid', orgId).all<{ email: string; name: string; role: string; title: string; verified_at: string | null }>().then((r) => r.results),
    sql(ctx, 'SELECT email, name FROM invites WHERE org_id = ? ORDER BY created_at, rowid', orgId).all<{ email: string; name: string }>().then((r) => r.results),
    guest ? Promise.resolve([] as ShareRow[]) : q<ShareRow>('SELECT s.*', 'FROM shares s JOIN moms m ON m.id = s.mom_id'),
  ]);

  const attOf = new Map<string, string[]>();
  for (const a of att) (attOf.get(a.mom_id) ?? attOf.set(a.mom_id, []).get(a.mom_id)!).push(a.email);
  const ownOf = new Map<string, string[]>();
  for (const o of own) (ownOf.get(o.point_id) ?? ownOf.set(o.point_id, []).get(o.point_id)!).push(o.email);

  const visible: { mom: MomRow; role: MomRole }[] = [];
  for (const mom of moms) {
    const attendees = attOf.get(mom.id) ?? [];
    const role: MomRole = guest ? 'guest' : momRole({ email: actor.user.email, org_id: actor.user.org_id, role: actor.user.role }, { org_id: mom.org_id, created_by: mom.created_by, status: mom.status }, attendees);
    if (canView(role)) visible.push({ mom, role });
  }
  const vis = new Set(visible.map((v) => v.mom.id));
  const attachOut = (r: (typeof files)[number]) => ({ id: r.id, kind: r.kind, name: r.name, url: r.url, mime: r.mime, size: r.size_bytes ? (r.size_bytes >= 1024 ? Math.round(r.size_bytes / 1024) + ' KB' : r.size_bytes + ' B') : null, downloadable: !!r.has_data, by: r.by, at: r.at });

  const outMoms = visible.map(({ mom, role }) => {
    const base = { id: mom.id, title: mom.title, date: mom.date, venue: mom.venue, status: mom.status, version: mom.version, createdBy: mom.created_by, role, mergedInto: mom.merged_into, mergedFrom: mom.merged_from ? (JSON.parse(mom.merged_from) as string[]) : null, deleted: mom.deleted_at ? { by: mom.deleted_by!, at: mom.deleted_at } : null };
    const events = evs.filter((e) => e.mom_id === mom.id && !e.point_only).map((e) => ({ id: e.id, at: e.at, by: e.by, type: e.type, what: e.what, pointId: e.point_id, pwhat: e.pwhat, v: e.v, detail: e.detail ? JSON.parse(e.detail) : null, via: e.via, to: e.to_addr, from: e.from_addr, shareId: e.share_id }));
    if (mom.deleted_at) return { ...base, notes: '', attendees: attOf.get(mom.id) ?? [], events: events.filter((e) => e.what.startsWith('Deleted this MOM')), attachments: [], shares: [] as ShareOut[] };
    const mine = shareRows.filter((x) => x.mom_id === mom.id && canContribute(role)).map((x): ShareOut => ({ id: x.id, via: x.via, to: x.via === 'email' ? x.to_addr : x.via === 'whatsapp' ? (x.to_addr || '').replace(' (WhatsApp)', '') : null, by: x.by, at: x.at, expiresAt: x.expires_at, cancelled: !!x.revoked_at, expired: !x.revoked_at && !!x.expires_at && x.expires_at <= nowIso(ctx), canCancel: role === 'owner' || x.by === (actor.kind === 'user' ? actor.user.email : '') }));
    return { ...base, notes: mom.notes, attendees: attOf.get(mom.id) ?? [], events, attachments: files.filter((f) => f.mom_id === mom.id && !f.point_id).map(attachOut), shares: mine };
  });
  const liveIds = new Set(visible.filter((v) => !v.mom.deleted_at).map((v) => v.mom.id));
  const outPts = pts.filter((p) => vis.has(p.mom_id) && liveIds.has(p.mom_id)).map((p) => ({
    id: p.id, momId: p.mom_id, no: p.no, title: p.title, due: p.due, status: p.status, todo: p.todo, resp: ownOf.get(p.id) ?? [],
    attachments: files.filter((f) => f.point_id === p.id).map(attachOut),
    updates: ups.filter((u) => u.point_id === p.id).map((u) => ({ at: u.at, by: u.by, text: u.text })),
    log: evs.filter((e) => e.point_id === p.id).map((e) => ({ at: e.at, by: e.by, what: e.pwhat || e.what })),
  }));

  let outUsers = [
    ...users.map((u) => ({ email: u.email, name: u.name, role: u.title, owner: u.role === 'owner', verified: !!u.verified_at })),
    ...invites.map((u) => ({ email: u.email, name: u.name || nameFromEmail(u.email), role: 'Invited', owner: false, verified: false })),
  ];
  if (guest) {
    const refs = new Set<string>();
    for (const m of outMoms) { m.attendees.forEach((e) => refs.add(e)); refs.add(m.createdBy); m.events.forEach((e) => { refs.add(e.by); if (e.from) refs.add(e.from); }); if (m.deleted) refs.add(m.deleted.by); }
    outPts.forEach((p) => p.resp.forEach((e) => refs.add(e)));
    outUsers = outUsers.filter((u) => refs.has(u.email));
  }
  const base = { users: outUsers, moms: outMoms, points: outPts };
  if (guest) return { ...base, me: null, guest: actor.email, guestMom: actor.momId, org: null };
  const ps = planStatus(actor.org, ctx.now());
  return { ...base, me: actor.user.email, guest: null, guestMom: null, org: { id: actor.org.id, name: actor.org.name, isOwner: actor.user.role === 'owner', plan: ps.state, planName: actor.org.plan, until: ps.until, trialEndsAt: actor.org.trial_ends_at, users: users.length + invites.length, maxUsers: MAX_USERS, enforcePlan: ctx.env.ENFORCE_PLAN === '1' } };
}
