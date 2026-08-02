const { connect, disconnect, clearAll, makeUser } = require('./setup');
const request = require('supertest');

let app, dooit;

beforeAll(async () => {
  await connect();
  app = require('./app');
});
afterAll(disconnect);

beforeEach(async () => {
  await clearAll();
  dooit = await makeUser({ userType: 'dooit', email: 'a@dooit.ai' });

  const mk = (code, status) =>
    request(app).post('/api/v1/product').set('Authorization', dooit.auth).send({
      name: code, code, category: 'Risk', unit: 'check',
      defaultUnitPrice: 1, status,
    });

  await mk('active_one', 'active');
  await mk('active_two', 'active');
  await mk('inactive_one', 'inactive');
});

const list = (qs) =>
  request(app).get('/api/v1/product' + qs).set('Authorization', dooit.auth);

// Mirrors ui/app/dashboard/client/billing/actions.js getProducts()
const buildQs = (params) => {
  const q = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== '' && v != null && v !== 'all')
  ).toString();
  return q ? '?' + q : '';
};

describe('status filtering (what the Show inactive toggle relies on)', () => {
  it('seeds 2 active + 1 inactive', async () => {
    const all = await list('?status=all');
    expect(all.body.data).toHaveLength(3);
  });

  it('status=active returns only active', async () => {
    const res = await list('?status=active');
    expect(res.body.data.map((p) => p.code).sort()).toEqual(['active_one', 'active_two']);
  });

  it('status=all returns active AND inactive', async () => {
    const res = await list('?status=all');
    expect(res.body.data).toHaveLength(3);
  });

  it('NO status param returns active AND inactive', async () => {
    const res = await list('');
    expect(res.body.data).toHaveLength(3);
  });

  // ── The exact query strings the UI builds ────────────────────────────────
  it('UI OFF state -> only active', async () => {
    const qs = buildQs({ limit: 200, sort: 'category', status: 'active' });
    console.log('   toggle OFF ->', qs);
    const res = await list(qs);
    expect(res.body.data).toHaveLength(2);
  });

  it('UI ON state -> active + inactive', async () => {
    const qs = buildQs({ limit: 200, sort: 'category', status: 'all' });
    console.log('   toggle ON  ->', qs);
    const res = await list(qs);
    expect(res.body.data).toHaveLength(3);
  });
});
