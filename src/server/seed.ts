// Demo data for local development and screenshots. It goes through the real services (so the history,
// versions and chain are genuine) with a back-dated clock. All names and addresses are invented.
import { handleApi } from './api.ts';
import type { Ctx } from './ctx.ts';
import { sql } from './ctx.ts';

export const DEMO_DOMAIN = '@sunrise-demo.example';
const U = (n: string) => n + DEMO_DOMAIN;

export async function seedDemo(base: Ctx): Promise<{ users: string[]; momIds: string[] }> {
  const existing = await sql(base, "SELECT id FROM users WHERE email = ?", U('asha')).first();
  if (existing) return { users: [], momIds: [] };
  const real = base.now().getTime();
  let t = real - 15 * 86400_000;
  const ctx: Ctx = { ...base, now: () => new Date(t) };
  const step = (hours: number) => { t = Math.min(real, t + hours * 3600_000); };
  const day = (n: number) => new Date(real + n * 86400_000).toISOString().slice(0, 10);

  // team + accounts (inserted directly: the sign-in code flow needs a mailbox)
  const at = new Date(t).toISOString();
  await ctx.db.batch([
    sql(ctx, 'INSERT INTO orgs (id, name, created_at, trial_ends_at) VALUES (?,?,?,?)', 'org_demo', 'Sunrise Residents (demo)', at, new Date(real + 14 * 86400_000).toISOString()),
    ...[['asha', 'Asha Verma', 'owner', 'Chair (team owner)'], ['ravi', 'Ravi Menon', 'member', 'Secretary'], ['meera', 'Meera Iyer', 'member', 'Treasurer'], ['kabir', 'Kabir Shah', 'member', 'Member']].map(([k, name, role, title]) =>
      sql(ctx, 'INSERT INTO users (id, org_id, email, name, role, title, verified_at, created_at) VALUES (?,?,?,?,?,?,?,?)', 'usr_' + k, 'org_demo', U(k), name, role, title, at, at)),
  ]);

  const sessions = new Map<string, string>();
  const as = async (k: string) => {
    if (!sessions.has(k)) {
      const tok = 'seed-session-' + k;
      const { sha256Hex } = await import('./util.ts');
      await sql(ctx, "INSERT INTO sessions (token_hash, kind, user_id, email, expires_at, created_at) VALUES (?, 'user', ?, ?, ?, ?)", await sha256Hex(tok), 'usr_' + k, U(k), new Date(real + 86400_000).toISOString(), at).run();
      sessions.set(k, tok);
    }
    const cookie = 'mom_session=' + sessions.get(k);
    return async (method: string, path: string, body?: unknown) => {
      const r = await handleApi(ctx, new Request(ctx.baseUrl + path, { method, headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }));
      const j = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
      if (r.status >= 400) throw new Error(`seed ${method} ${path} -> ${r.status} ${JSON.stringify(j)}`);
      return j as any;
    };
  };

  const asha = await as('asha'), ravi = await as('ravi'), meera = await as('meera'), kabir = await as('kabir');
  const all = ['asha', 'ravi', 'meera', 'kabir'].map(U);

  // 1. a published MOM with three points in different states, an edit, a share and an open
  const m1 = (await asha('POST', '/api/moms', { title: 'Monthly committee meeting', date: day(-14), venue: 'Community hall', notes: 'Budget and annual day.', attendees: all })).id;
  step(1);
  const p1 = (await asha('POST', `/api/moms/${m1}/points`, { title: 'Share the revised budget with the team', owners: [U('ravi'), U('meera')], due: day(-5), todo: 'Send the revised sheet with the three changes we agreed.' })).id;
  const p2 = (await asha('POST', `/api/moms/${m1}/points`, { title: 'Book the venue for the annual day', owners: [U('meera')], due: day(4), todo: 'Compare two halls and confirm one.' })).id;
  const p3 = (await asha('POST', `/api/moms/${m1}/points`, { title: 'Update the visitor list', owners: [U('kabir'), U('ravi')], due: day(-12), todo: 'Add the new members.' })).id;
  step(2);
  await asha('POST', `/api/moms/${m1}/publish`);
  step(4);
  await asha('POST', `/api/moms/${m1}/shares`, { via: 'email', to: 'priya@guest-demo.example' });
  step(60);
  await ravi('POST', `/api/points/${p1}/status`, { status: 'In progress' });
  step(1);
  await ravi('POST', `/api/points/${p1}/updates`, { text: 'First draft is ready; checking two numbers.' });
  step(80);
  await kabir('POST', `/api/points/${p3}/status`, { status: 'In progress' });
  step(2);
  await kabir('POST', `/api/points/${p3}/status`, { status: 'Complete' });
  step(30);
  await asha('PATCH', `/api/moms/${m1}`, { venue: 'Club house', notes: 'Budget, annual day and the visitor list.' });
  step(2);
  await meera('POST', `/api/moms/${m1}/attachments`, { kind: 'url', url: 'https://example.com/annual-day-ideas' });
  void p2;

  // 2. a vendor MOM with a discarded point
  step(40);
  const m2 = (await asha('POST', '/api/moms', { title: 'Vendor review', date: day(-6), venue: 'Online', notes: 'Signboard and delivery issues.', attendees: [U('ravi'), U('kabir')] })).id;
  const q1 = (await asha('POST', `/api/moms/${m2}/points`, { title: 'Collect quotes for the new signboard', owners: [U('kabir')], due: day(0), status: 'In progress' })).id;
  const q3 = (await asha('POST', `/api/moms/${m2}/points`, { title: 'Cancel the old courier contract', owners: [U('ravi')], due: day(-1) })).id;
  await asha('POST', `/api/moms/${m2}/points`, { title: 'Reply to the vendor about the delayed deliveries', owners: [U('asha'), U('kabir')], due: day(2) });
  await asha('POST', `/api/moms/${m2}/publish`);
  step(20);
  await ravi('POST', `/api/points/${q3}/status`, { status: 'Discarded' });
  void q1;

  // 3. a draft in progress
  step(2);
  const m3 = (await asha('POST', '/api/moms', { title: 'Annual day planning', date: day(1), venue: 'Terrace garden', notes: 'Draft agenda for the annual day.', attendees: [U('meera'), U('ravi')] })).id;
  await asha('POST', `/api/moms/${m3}/points`, { title: 'Choose the chief guest', owners: [U('asha'), U('meera')], due: day(6), todo: 'Two names, one backup.' });
  await asha('POST', `/api/moms/${m3}/points`, { title: 'Print the invitation cards', owners: [U('ravi')], due: day(8) });

  // 4. a deleted MOM, so the notice can be seen
  const m4 = (await ravi('POST', '/api/moms', { title: 'Old garden plan', date: day(-30), venue: 'Garden', attendees: [U('asha')] })).id;
  await ravi('POST', `/api/moms/${m4}/points`, { title: 'Replant the lawn', owners: [U('ravi')] });
  await ravi('POST', `/api/moms/${m4}/publish`);
  await ravi('POST', `/api/moms/${m4}/delete-for-all`, { confirm: true });

  return { users: all, momIds: [m1, m2, m3, m4] };
}
