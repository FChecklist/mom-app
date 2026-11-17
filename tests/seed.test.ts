import { expect, test } from 'bun:test';
import { seedDemo } from '../src/server/seed.ts';
import { makeApp } from './helpers.ts';

test('the demo seed goes through the real services and produces a coherent team', async () => {
  const app = makeApp();
  const r = await seedDemo(app.ctx);
  expect(r.momIds.length).toBe(4);
  const asha = app.browser();
  const s = await asha.post('/api/auth/start', { email: 'asha@sunrise-demo.example' });
  await asha.post('/api/auth/verify', { email: 'asha@sunrise-demo.example', code: s.body.devCode });
  const st = (await asha.get('/api/state')).body;
  expect(st.org.name).toContain('Sunrise');
  expect(st.moms.map((m: any) => m.title).sort()).toEqual(['Annual day planning', 'Monthly committee meeting', 'Old garden plan', 'Vendor review']);
  const m1 = st.moms.find((m: any) => m.title === 'Monthly committee meeting');
  expect(m1.status).toBe('published');
  expect(m1.venue).toBe('Club house');
  const statuses = new Set(st.points.map((p: any) => p.status));
  expect([...statuses].sort()).toEqual(['Complete', 'Discarded', 'In progress', 'WIP']);
  expect(st.moms.find((m: any) => m.title === 'Old garden plan').deleted).not.toBeNull();
  // versions are gapless even though the seed back-dated its clock
  const vs = m1.events.filter((e: any) => e.type === 'content').map((e: any) => e.v);
  expect(vs).toEqual(vs.map((_: number, i: number) => i + 1));
  expect(m1.events.some((e: any) => e.type === 'share')).toBe(true);
  // running it twice does nothing
  expect((await seedDemo(app.ctx)).momIds).toEqual([]);
});
