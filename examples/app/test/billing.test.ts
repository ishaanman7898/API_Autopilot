import { charge } from '../src/billing';

test('charge returns an id', async () => {
  const res = await charge(500);
  expect(res.id).toBeDefined();
});
