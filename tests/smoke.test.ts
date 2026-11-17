import { expect, test } from 'bun:test';
import { makeApp, owner, seedMom } from './helpers.ts';

test('migrations apply and the basic flow works end to end', async () => {
  const app = makeApp();
  const ann = await owner(app);
  const { id } = await seedMom(app, ann, { publish: true });
  const st = await ann.get('/api/state');
  expect(st.status).toBe(200);
  expect(st.body.moms[0].id).toBe(id);
  expect(st.body.moms[0].status).toBe('published');
});
