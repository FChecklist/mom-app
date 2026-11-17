import { describe, expect, test } from 'bun:test';
import { makeApp, owner, seedMom, signIn, today } from './helpers.ts';

const ANN = 'ann@team.test', BOB = 'bob@team.test', CY = 'cy@team.test';

async function team() {
  const app = makeApp();
  const ann = await owner(app);
  await ann.post('/api/team/members', { email: BOB });
  await ann.post('/api/team/members', { email: CY });
  const bob = await signIn(app, BOB);
  const cy = await signIn(app, CY);
  return { app, ann, bob, cy };
}
const momOf = async (b: any, id: string) => (await b.get('/api/state')).body.moms.find((m: any) => m.id === id);
const pointOf = async (b: any, id: string) => (await b.get('/api/state')).body.points.find((p: any) => p.id === id);

describe('creating, updating and versions', () => {
  test('a MOM starts as a draft at version 1, with the creator as a participant', async () => {
    const { app, ann } = await team();
    const r = await ann.post('/api/moms', { title: 'Committee', date: today(app), venue: 'Club', notes: 'n', attendees: [BOB] });
    expect(r.status).toBe(201);
    const m = await momOf(ann, r.body.id);
    expect(m).toMatchObject({ title: 'Committee', status: 'draft', version: 1, venue: 'Club', createdBy: ANN, role: 'owner' });
    expect(m.attendees.sort()).toEqual([ANN, BOB]);
    expect(m.events[0]).toMatchObject({ type: 'content', what: 'Created the MOM', v: 1, by: ANN });
  });

  test('required fields and sensible limits are enforced with friendly messages', async () => {
    const { app, ann } = await team();
    expect((await ann.post('/api/moms', { date: today(app) })).body.error.code).toBe('MISSING_FIELD');
    expect((await ann.post('/api/moms', { title: 'x', date: 'soon' })).body.error.code).toBe('BAD_DATE');
    expect((await ann.post('/api/moms', { title: 'x'.repeat(121), date: today(app) })).body.error.code).toBe('TOO_LONG');
    expect((await ann.post('/api/moms', { title: 'x', date: today(app), attendees: ['+919876543210'] })).body.error.code).toBe('EMAIL_ONLY');
  });

  test('every update makes the next numbered version with a before/after record', async () => {
    const { app, ann } = await team();
    const { id } = await seedMom(app, ann);
    const before = (await momOf(ann, id)).version;
    const u = await ann.patch(`/api/moms/${id}`, { venue: 'Terrace', notes: 'Changed notes' });
    expect(u.body).toMatchObject({ changed: true, version: before + 1 });
    const ev = (await momOf(ann, id)).events.at(-1);
    expect(ev).toMatchObject({ type: 'content', v: before + 1, what: 'Updated venue, notes' });
    expect(ev.detail).toEqual([{ f: 'Venue', from: 'Room 1', to: 'Terrace' }, { f: 'Notes', from: 'Some notes', to: 'Changed notes' }]);
    const same = await ann.patch(`/api/moms/${id}`, { venue: 'Terrace' });
    expect(same.body).toMatchObject({ changed: false, version: before + 1 }); // nothing changed, no new version
  });

  test('version numbers are gapless and unique across many changes', async () => {
    const { app, ann } = await team();
    const { id, pointIds } = await seedMom(app, ann);
    await ann.patch(`/api/moms/${id}`, { title: 'A' });
    await ann.post(`/api/points/${pointIds[0]}/status`, { status: 'In progress' });
    await ann.patch(`/api/points/${pointIds[0]}`, { todo: 'new' });
    const vs = (await momOf(ann, id)).events.filter((e: any) => e.type === 'content').map((e: any) => e.v);
    expect(vs).toEqual(vs.map((_: number, i: number) => i + 1));
    expect((await momOf(ann, id)).version).toBe(vs.length);
  });

  test('the history log can never be edited or removed through the API', async () => {
    const { app, ann } = await team();
    const { id } = await seedMom(app, ann);
    const n = (await momOf(ann, id)).events.length;
    for (const [m, p] of [['DELETE', `/api/moms/${id}/events`], ['PATCH', `/api/moms/${id}/events/1`], ['PUT', `/api/events/1`]] as const) expect((await ann.req(m, p, {})).status).toBe(404);
    expect((await momOf(ann, id)).events.length).toBe(n);
  });
});

describe('publishing', () => {
  test('a MOM needs at least one point, then publishes once and e-mails the participants', async () => {
    const { app, ann } = await team();
    const empty = await ann.post('/api/moms', { title: 'Empty', date: today(app), attendees: [BOB] });
    const no = await ann.post(`/api/moms/${empty.body.id}/publish`);
    expect(no.status).toBe(409);
    expect(no.body.error.code).toBe('NO_POINTS');
    const { id } = await seedMom(app, ann, { attendees: [BOB] });
    expect((await ann.post(`/api/moms/${id}/publish`)).status).toBe(200);
    expect((await ann.post(`/api/moms/${id}/publish`)).body.error.code).toBe('ALREADY_PUBLISHED');
    const m = await momOf(ann, id);
    expect(m.status).toBe('published');
    expect(m.events.at(-1)).toMatchObject({ what: 'Published the MOM', type: 'content' });
    const mail = app.outbox(BOB).filter((x) => x.subject.startsWith('MOM published'));
    expect(mail.length).toBe(1);
    expect(mail[0].body).toContain(`/#/mom/${id}`);
    expect(app.outbox(ANN).filter((x) => x.subject.startsWith('MOM published')).length).toBe(0); // not to the sender
  });

  test('drafts are private to the maker and the team owner; published MOMs reach participants only', async () => {
    const { app, ann, bob, cy } = await team();
    const { id } = await seedMom(app, ann, { attendees: [BOB], points: [{ title: 'P', owners: [BOB] }] });
    expect(await momOf(bob, id)).toBeUndefined(); // draft: Bob is a participant but sees nothing yet
    expect((await bob.patch(`/api/moms/${id}`, { title: 'x' })).status).toBe(404);
    await ann.post(`/api/moms/${id}/publish`);
    expect((await momOf(bob, id)).role).toBe('participant');
    expect(await momOf(cy, id)).toBeUndefined(); // Cy is on the team but not in this MOM
    expect((await cy.post(`/api/moms/${id}/shares`, { via: 'link' })).status).toBe(404); // looks exactly like "does not exist"
  });

  test('another team can never see or touch it', async () => {
    const { app, ann } = await team();
    const { id } = await seedMom(app, ann, { publish: true });
    const other = await signIn(app, 'zed@other.test', 'Zed', 'Other');
    expect((await other.get('/api/state')).body.moms).toEqual([]);
    expect((await other.get(`/api/moms/${id}/pdf`)).status).toBe(404);
    expect((await other.post(`/api/moms/${id}/delete-for-all`, { confirm: true })).status).toBe(404);
  });
});

describe('points: numbering, many owners, statuses, history', () => {
  test('points are numbered 1, 2, 3 and may have several responsible people', async () => {
    const { app, ann } = await team();
    const { id, pointIds } = await seedMom(app, ann, { attendees: [BOB, CY], points: [{ title: 'One', owners: [BOB, CY] }, { title: 'Two', owners: [ANN] }, { title: 'Three', owners: [BOB] }] });
    const pts = (await ann.get('/api/state')).body.points.filter((p: any) => p.momId === id).sort((a: any, b: any) => a.no - b.no);
    expect(pts.map((p: any) => p.no)).toEqual([1, 2, 3]);
    expect(pts[0].resp.sort()).toEqual([BOB, CY]);
    expect(pointIds.length).toBe(3);
    expect(pts[0].status).toBe('WIP'); // default
  });

  test('a point needs at least one owner; new people are added to the team and the MOM', async () => {
    const { app, ann } = await team();
    const { id } = await seedMom(app, ann);
    const r = await ann.post(`/api/moms/${id}/points`, { title: 'No owner', owners: [] });
    expect(r.body.error.code).toBe('NEED_OWNER');
    const ok = await ann.post(`/api/moms/${id}/points`, { title: 'New person', owners: ['newbie@team.test'], due: today(app, 3) });
    expect(ok.status).toBe(201);
    const st = (await ann.get('/api/state')).body;
    expect(st.users.map((u: any) => u.email)).toContain('newbie@team.test');
    expect((await momOf(ann, id)).attendees).toContain('newbie@team.test');
    expect(st.users.find((u: any) => u.email === 'newbie@team.test').verified).toBe(false);
  });

  test('status changes follow the allowed moves and are logged on the point', async () => {
    const { app, ann } = await team();
    const { pointIds: [p] } = await seedMom(app, ann);
    expect((await ann.post(`/api/points/${p}/status`, { status: 'Done' })).body.error.code).toBe('BAD_STATUS');
    expect((await ann.post(`/api/points/${p}/status`, { status: 'In progress' })).status).toBe(200);
    expect((await ann.post(`/api/points/${p}/status`, { status: 'Complete' })).status).toBe(200);
    const bad = await ann.post(`/api/points/${p}/status`, { status: 'Discarded' });
    expect(bad.status).toBe(409);
    expect(bad.body.error.allowed).toEqual(['In progress']);
    expect((await ann.post(`/api/points/${p}/status`, { status: 'In progress' })).status).toBe(200);
    const log = (await pointOf(ann, p)).log.map((l: any) => l.what);
    expect(log).toEqual(['Created this point', 'Status: WIP → In progress', 'Status: In progress → Complete', 'Status: Complete → In progress']);
  });

  test('editing a point records exactly what changed', async () => {
    const { app, ann } = await team();
    const { id, pointIds: [p] } = await seedMom(app, ann);
    const r = await ann.patch(`/api/points/${p}`, { title: 'Renamed', todo: 'Do it' });
    expect(r.body.changed).toBe(true);
    const ev = (await momOf(ann, id)).events.at(-1);
    expect(ev.pointId).toBe(p);
    expect(ev.detail.map((d: any) => d.f)).toEqual(['Point', 'What to do']);
    expect((await ann.patch(`/api/points/${p}`, { title: 'Renamed' })).body.changed).toBe(false);
    expect((await ann.patch(`/api/points/${p}`, { title: '' })).body.error.code).toBe('MISSING_FIELD');
  });

  test('owners can be added and removed, but never to zero', async () => {
    const { app, ann } = await team();
    const { pointIds: [p] } = await seedMom(app, ann, { attendees: [BOB] });
    await ann.post(`/api/points/${p}/owners`, { add: [BOB] });
    expect((await pointOf(ann, p)).resp.sort()).toEqual([ANN, BOB]);
    await ann.post(`/api/points/${p}/owners`, { remove: [ANN] });
    expect((await pointOf(ann, p)).resp).toEqual([BOB]);
    const last = await ann.post(`/api/points/${p}/owners`, { remove: [BOB] });
    expect(last.body.error.code).toBe('NEED_OWNER');
    expect((await pointOf(ann, p)).log.at(-1).what).toContain('Removed Ann');
  });

  test('a person page: one person handling many points across MOMs', async () => {
    const { app, ann } = await team();
    await seedMom(app, ann, { title: 'A', attendees: [BOB], points: [{ title: 'a1', owners: [BOB] }, { title: 'a2', owners: [BOB, ANN] }] });
    await seedMom(app, ann, { title: 'B', attendees: [BOB], points: [{ title: 'b1', owners: [BOB] }] });
    const pts = (await ann.get('/api/state')).body.points;
    expect(pts.filter((p: any) => p.resp.includes(BOB)).length).toBe(3);
  });

  test('posting an update adds to the point history without making a new version', async () => {
    const { app, ann } = await team();
    const { id, pointIds: [p] } = await seedMom(app, ann);
    const v = (await momOf(ann, id)).version;
    expect((await ann.post(`/api/points/${p}/updates`, { text: '' })).status).toBe(400);
    expect((await ann.post(`/api/points/${p}/updates`, { text: 'Halfway there' })).status).toBe(201);
    const pt = await pointOf(ann, p);
    expect(pt.updates.at(-1)).toMatchObject({ by: ANN, text: 'Halfway there' });
    expect(pt.log.at(-1).what).toBe('Posted an update');
    expect((await momOf(ann, id)).version).toBe(v);
  });
});

describe('who may change what', () => {
  test('a participant works only on points they are responsible for', async () => {
    const { app, ann, bob } = await team();
    const { id, pointIds: [mine, notMine] } = await seedMom(app, ann, { attendees: [BOB], points: [{ title: 'Mine', owners: [BOB] }, { title: 'Not mine', owners: [ANN] }], publish: true });
    expect((await bob.post(`/api/points/${mine}/status`, { status: 'In progress' })).status).toBe(200);
    expect((await bob.patch(`/api/points/${mine}`, { todo: 'on it' })).status).toBe(200);
    expect((await bob.post(`/api/points/${mine}/updates`, { text: 'working' })).status).toBe(201);
    expect((await bob.post(`/api/points/${notMine}/status`, { status: 'Complete' })).status).toBe(403);
    expect((await bob.post(`/api/points/${notMine}/updates`, { text: 'hm' })).status).toBe(403);
    expect((await bob.patch(`/api/moms/${id}`, { title: 'hijack' })).status).toBe(403);
    expect((await bob.post(`/api/moms/${id}/points`, { title: 'extra', owners: [BOB] })).status).toBe(403);
    expect((await bob.post(`/api/moms/${id}/publish`)).status).toBe(403);
    expect((await bob.post(`/api/moms/${id}/delete-for-all`, { confirm: true })).status).toBe(403);
    expect((await bob.post('/api/moms/merge', { ids: [id, id], confirm: true })).status).toBe(400);
  });

  test('the team owner can manage any MOM in the team, even drafts by others', async () => {
    const { app, ann, bob } = await team();
    const { id } = await seedMom(app, bob, { title: "Bob's draft", points: [{ title: 'x', owners: [BOB] }] }).catch(() => ({ id: '' }));
    expect(id).toBeTruthy();
    expect((await ann.patch(`/api/moms/${id}`, { notes: 'Owner edit' })).status).toBe(200);
  });

  test('guests (not signed in) cannot do anything', async () => {
    const { app, ann } = await team();
    const { id } = await seedMom(app, ann, { publish: true });
    const anon = app.browser();
    for (const [m, p] of [['POST', '/api/moms'], ['PATCH', `/api/moms/${id}`], ['POST', `/api/moms/${id}/publish`], ['GET', `/api/moms/${id}/pdf`], ['GET', '/api/state']] as const) expect((await anon.req(m, p, {})).status).toBe(401);
  });
});

describe('deleting', () => {
  test('a draft needs an explicit confirmation, then everyone gets the same notice', async () => {
    const { app, ann } = await team();
    const { id } = await seedMom(app, ann, { attendees: [BOB] });
    expect((await ann.del(`/api/moms/${id}`, {})).body.error.code).toBe('CONFIRM_REQUIRED');
    expect((await ann.del(`/api/moms/${id}`, { confirm: true })).status).toBe(200);
    const m = await momOf(ann, id);
    expect(m.deleted).toMatchObject({ by: ANN });
    expect(m.notes).toBe('');
    expect((await ann.get('/api/state')).body.points.filter((p: any) => p.momId === id)).toEqual([]);
  });

  test('a published MOM cannot be deleted by a simple delete', async () => {
    const { app, ann } = await team();
    const { id } = await seedMom(app, ann, { publish: true });
    const r = await ann.del(`/api/moms/${id}`, { confirm: true });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('PUBLISHED_LOCKED');
    expect((await momOf(ann, id)).deleted).toBeNull();
  });

  test('"delete for everyone" needs confirmation; participants and guests see the same notice, content is hidden', async () => {
    const { app, ann, bob } = await team();
    const { id } = await seedMom(app, ann, { attendees: [BOB], points: [{ title: 'Secret plan', owners: [BOB] }], publish: true });
    const sh = await ann.post(`/api/moms/${id}/shares`, { via: 'email', to: 'guest@out.test' });
    const token = sh.body.link.split('/#/shared/')[1];
    const g = app.browser();
    const c = await g.post(`/api/shared/${token}/code`, { email: 'guest@out.test' });
    await g.post(`/api/shared/${token}/verify`, { email: 'guest@out.test', code: c.body.devCode });

    expect((await ann.post(`/api/moms/${id}/delete-for-all`, {})).body.error.code).toBe('CONFIRM_REQUIRED');
    expect((await ann.post(`/api/moms/${id}/delete-for-all`, { confirm: true })).status).toBe(200);
    for (const who of [ann, bob, g]) {
      const m = await momOf(who, id);
      expect(m.deleted.by).toBe(ANN);
      expect(typeof m.deleted.at).toBe('string');
      expect(JSON.stringify((await who.get('/api/state')).body)).not.toContain('Secret plan');
    }
    expect((await ann.post(`/api/moms/${id}/delete-for-all`, { confirm: true })).body.error.code).toBe('MOM_DELETED');
    expect((await ann.patch(`/api/moms/${id}`, { title: 'revive' })).status).toBe(409);
    expect((await ann.get(`/api/moms/${id}/pdf`)).status).toBe(409);
    expect(app.outbox(BOB).some((x) => x.subject.startsWith('MOM deleted'))).toBe(true);
    // the deletion stays in the log; the CONTENT is really gone from the database (notes, points, files, old change text)
    expect((await momOf(ann, id)).events.at(-1).what).toContain('Deleted this MOM for everyone');
    expect((app.raw.query('SELECT COUNT(*) AS n FROM points WHERE mom_id = ?').get(id) as any).n).toBe(0);
    expect((app.raw.query('SELECT notes FROM moms WHERE id = ?').get(id) as any).notes).toBe('');
    expect((app.raw.query('SELECT COUNT(*) AS n FROM attachments WHERE mom_id = ?').get(id) as any).n).toBe(0);
    expect(JSON.stringify(app.raw.query('SELECT what, pwhat, detail FROM events WHERE mom_id = ?').all(id))).not.toContain('Secret plan');
  });
});

describe('merging', () => {
  async function two() {
    const t = await team();
    const a = await seedMom(t.app, t.ann, { title: 'Alpha', attendees: [BOB], points: [{ title: 'a1', owners: [BOB] }, { title: 'a2', owners: [ANN] }], publish: true });
    const b = await seedMom(t.app, t.ann, { title: 'Beta', attendees: [CY], points: [{ title: 'b1', owners: [CY], status: 'In progress' }] });
    return { ...t, a, b };
  }

  test('without confirmation the server answers with the warning and a preview, and changes nothing', async () => {
    const { ann, a, b } = await two();
    const before = (await ann.get('/api/state')).body.moms.length;
    const r = await ann.post('/api/moms/merge', { ids: [a.id, b.id], title: 'Together' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('MERGE_NEEDS_CONFIRM');
    expect(r.body.error.message).toContain('merge the MOMs into one new MOM');
    expect(r.body.error.preview).toMatchObject({ titles: ['Alpha', 'Beta'], points: 3 });
    expect(r.body.error.preview.participants.sort()).toEqual([ANN, BOB, CY]);
    expect((await ann.get('/api/state')).body.moms.length).toBe(before);
  });

  test('confirming creates one new draft with everyone, renumbered points and a trail; originals are marked', async () => {
    const { ann, a, b } = await two();
    const r = await ann.post('/api/moms/merge', { ids: [a.id, b.id], title: 'Together', confirm: true });
    expect(r.status).toBe(201);
    const st = (await ann.get('/api/state')).body;
    const merged = st.moms.find((m: any) => m.id === r.body.id);
    expect(merged).toMatchObject({ title: 'Together', status: 'draft', mergedFrom: [a.id, b.id] });
    expect(merged.attendees.sort()).toEqual([ANN, BOB, CY]);
    const pts = st.points.filter((p: any) => p.momId === merged.id).sort((x: any, y: any) => x.no - y.no);
    expect(pts.map((p: any) => [p.no, p.title, p.status])).toEqual([[1, 'a1', 'WIP'], [2, 'a2', 'WIP'], [3, 'b1', 'In progress']]);
    expect(pts[2].resp).toEqual([CY]);
    expect(pts[0].log.at(-1).what).toContain('Copied here by merging "Alpha"');
    for (const id of [a.id, b.id]) {
      const src = st.moms.find((m: any) => m.id === id);
      expect(src.mergedInto).toBe(merged.id);
      expect(src.events.at(-1).what).toBe('Merged into "Together"');
    }
    expect(st.points.filter((p: any) => p.momId === a.id).length).toBe(2); // originals keep their points
  });

  test('attachments travel with the merge, including file data', async () => {
    const { ann, a, b } = await two();
    const pdf = btoa('%PDF-1.4\n% tiny test file\n%%EOF');
    await ann.post(`/api/moms/${a.id}/attachments`, { kind: 'pdf', name: 'budget.pdf', dataBase64: pdf });
    await ann.post(`/api/points/${a.pointIds[0]}/attachments`, { kind: 'link', name: 'Recording', url: 'https://example.com/rec' });
    const r = await ann.post('/api/moms/merge', { ids: [a.id, b.id], confirm: true });
    const st = (await ann.get('/api/state')).body;
    const merged = st.moms.find((m: any) => m.id === r.body.id);
    expect(merged.attachments.map((x: any) => x.name)).toEqual(['budget.pdf']);
    expect(st.points.find((p: any) => p.momId === merged.id && p.no === 1).attachments.map((x: any) => x.name)).toEqual(['Recording']);
    const dl = await ann.get(`/api/attachments/${merged.attachments[0].id}`);
    expect(dl.status).toBe(200);
    expect(await dl.raw.text()).toContain('tiny test file');
  });

  test('merging twice does not collide (fresh ids every time)', async () => {
    const { app, ann, a, b } = await two();
    await ann.post(`/api/points/${a.pointIds[0]}/attachments`, { kind: 'text', text: 'note' });
    const first = await ann.post('/api/moms/merge', { ids: [a.id, b.id], confirm: true });
    expect(first.status).toBe(201);
    // the originals are now "Merged into ..." and cannot be merged a second time (that would duplicate every point)
    const again = await ann.post('/api/moms/merge', { ids: [a.id, b.id], confirm: true });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_MERGED');
    // but the merged MOM itself can be merged onwards, with fresh ids
    const c = await seedMom(app, ann, { title: 'Gamma', points: [{ title: 'c1', owners: [ANN] }] });
    expect((await ann.post('/api/moms/merge', { ids: [first.body.id, c.id], confirm: true })).status).toBe(201);
  });

  test('needs two or more, only the owner, and never a deleted MOM', async () => {
    const { ann, bob, a, b } = await two();
    expect((await ann.post('/api/moms/merge', { ids: [a.id], confirm: true })).body.error.code).toBe('NEED_TWO');
    expect((await bob.post('/api/moms/merge', { ids: [a.id, b.id], confirm: true })).status).toBe(403); // Bob sees Alpha but may not manage it
    await ann.del(`/api/moms/${b.id}`, { confirm: true });
    expect((await ann.post('/api/moms/merge', { ids: [a.id, b.id], confirm: true })).body.error.code).toBe('MOM_DELETED');
  });
});

describe('attachments', () => {
  test('text, web address, link, PDF and image can be attached to a MOM or a point', async () => {
    const { app, ann } = await team();
    const { id, pointIds: [p] } = await seedMom(app, ann);
    const png = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0));
    const pdf = btoa('%PDF-1.4 hello');
    const adds = [
      ann.post(`/api/moms/${id}/attachments`, { kind: 'text', text: 'A short note' }),
      ann.post(`/api/moms/${id}/attachments`, { kind: 'url', url: 'https://example.com/a' }),
      ann.post(`/api/moms/${id}/attachments`, { kind: 'link', name: 'Drive folder', url: 'https://drive.example.com/x' }),
      ann.post(`/api/moms/${id}/attachments`, { kind: 'pdf', name: 'a.pdf', dataBase64: pdf }),
      ann.post(`/api/points/${p}/attachments`, { kind: 'image', name: 'p.png', dataBase64: png }),
    ];
    for (const r of await Promise.all(adds)) expect(r.status).toBe(201);
    const st = (await ann.get('/api/state')).body;
    expect(st.moms.find((m: any) => m.id === id).attachments.map((a: any) => a.kind)).toEqual(['text', 'url', 'link', 'pdf']);
    expect(st.points.find((x: any) => x.id === p).attachments.map((a: any) => a.kind)).toEqual(['image']);
    expect(st.points.find((x: any) => x.id === p).log.at(-1).what).toBe('Attached image');
  });

  test('unsafe addresses, fake files and oversize files are refused', async () => {
    const { app, ann } = await team();
    const { id } = await seedMom(app, ann);
    const a = (b: object) => ann.post(`/api/moms/${id}/attachments`, b);
    expect((await a({ kind: 'url', url: 'javascript:alert(1)' })).body.error.code).toBe('BAD_URL');
    expect((await a({ kind: 'link', name: 'x', url: 'ftp://x.test/y' })).body.error.code).toBe('BAD_URL');
    expect((await a({ kind: 'pdf', name: 'evil.pdf', dataBase64: btoa('<html><script>alert(1)</script>') })).body.error.code).toBe('BAD_FILE');
    expect((await a({ kind: 'image', name: 'x.png', dataBase64: btoa('%PDF-1.4 not an image') })).body.error.code).toBe('BAD_FILE');
    expect((await a({ kind: 'pdf', name: 'x.pdf', dataBase64: '###' })).body.error.code).toBe('BAD_FILE');
    expect((await a({ kind: 'pdf', name: 'x.pdf' })).body.error.code).toBe('MISSING_FIELD');
    const big = btoa('%PDF-1.4' + 'a'.repeat(1_000_000));
    expect((await a({ kind: 'pdf', name: 'big.pdf', dataBase64: big })).status).toBe(413);
    expect((await a({ kind: 'exe' })).body.error.code).toBe('BAD_KIND');
  });

  test('downloads are forced to "attachment", with the real type sniffed and nosniff set', async () => {
    const { app, ann, bob } = await team();
    const { id } = await seedMom(app, ann, { attendees: [BOB], publish: true });
    const r = await ann.post(`/api/moms/${id}/attachments`, { kind: 'pdf', name: 'we"ird name.pdf', dataBase64: btoa('%PDF-1.4 x') });
    const f = await bob.get(`/api/attachments/${r.body.id}`);
    expect(f.headers.get('content-type')).toBe('application/pdf');
    expect(f.headers.get('content-disposition')).toStartWith('attachment;');
    expect(f.headers.get('content-disposition')).not.toContain('"we"');
    expect(f.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await app.browser().get(`/api/attachments/${r.body.id}`)).status).toBe(401);
    expect((await signIn(app, 'zed@other.test').then((z) => z.get(`/api/attachments/${r.body.id}`))).status).toBe(404);
  });
});

describe('PDF export', () => {
  test('a participant can download a valid PDF, and the download is logged', async () => {
    const { app, ann, bob } = await team();
    const { id } = await seedMom(app, ann, { title: 'PDF test', attendees: [BOB], publish: true });
    const r = await bob.get(`/api/moms/${id}/pdf`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    const s = new TextDecoder('latin1').decode(await r.raw.arrayBuffer());
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s).toContain('PDF test');
    expect((await momOf(ann, id)).events.at(-1).what).toBe('Downloaded a PDF copy');
  });
});

describe('plan limits', () => {
  test('after the trial, writes are blocked with a kind message until a plan is bought; reading still works', async () => {
    const app = makeApp({ ENFORCE_PLAN: '1' });
    const ann = await owner(app);
    const { id } = await seedMom(app, ann);
    app.advance(15 * 86400000);
    const st = await ann.get('/api/state');
    expect(st.status).toBe(200); // the session lasts 30 days, so reading still works
    expect(st.body.org.plan).toBe('expired');
    const r = await ann.patch(`/api/moms/${id}`, { title: 'late edit' });
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('PLAN_EXPIRED');
    expect((await ann.post('/api/moms', { title: 'new', date: today(app) })).status).toBe(402);
    expect((await ann.get(`/api/moms/${id}/pdf`)).status).toBe(200);
  });
});
