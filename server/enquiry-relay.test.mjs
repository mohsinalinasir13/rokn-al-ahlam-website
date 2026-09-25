import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelay, signWebhook, referenceFromProspectId, MAX_BODY_BYTES } from './enquiry-relay.mjs';

const SECRET = 'unit-test-secret';
const ENV = { COMPANY_OS_INTAKE_URL: 'https://os.example.test/api/v1/leads/website', COMPANY_OS_WEBHOOK_SECRET: SECRET, ALLOWED_ORIGINS: 'https://roknalahlam.com', RATE_LIMIT_PER_MIN: '10' };
const PROSPECT = 'a1b2c3d4-0000-4000-8000-000000000001';
const ID = '3f2b8a52-7c1e-4d6a-9c1f-0a1b2c3d4e5f';
const COMMON = { name: 'Test Person', phone: '+971500000000', email: 'test.person@example.com' };
const VALID = {
  'owner-management': { service: 'Property Management', ptype: 'Villa', emirate: 'Dubai', area: 'Jumeirah' },
  'property-search': { intent: 'Rent', ptype: 'Apartment', emirate: 'Dubai', area: 'Marina' },
  'staff-accommodation': { company: 'Acme Contracting LLC', count: '40', emirate: 'Sharjah', area: 'Industrial Area' },
  'vacation-home': { location: 'Downtown Dubai' },
};
const body = (type, over = {}, top = {}) => JSON.stringify({ id: ID, enquiryType: type, consent: true, page: '/contact', referrer: '', utm: { utm_source: 'test', bogus: 'x' }, submittedAt: '2026-09-25T00:00:00.000Z', fields: { ...COMMON, ...VALID[type], ...over }, ...top });
const post = (b, o = {}) => ({ method: 'POST', path: '/api/enquiry', headers: { 'content-type': 'application/json', origin: 'https://roknalahlam.com' }, body: b, ip: '1.1.1.1', ...o });
const okFetch = (calls) => async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ id: PROSPECT }) }; };
const mk = (fetchImpl, env = ENV, logger = { info() {} }) => createRelay({ env, fetchImpl, logger });
const json = (r) => JSON.parse(r.body);

test('signature matches the Python (Company OS) HMAC implementation', () => {
  assert.equal(signWebhook(SECRET, '1700000000', '{"a":1,"b":"x"}'), '84f7259be00963db44b67f2fd5759b09b76bf0d46410077b6870eb7dd17ed8ca');
});

test('reference derives from the stored prospect id', () => assert.equal(referenceFromProspectId(PROSPECT), 'RA-A1B2C3D4'));

for (const type of Object.keys(VALID)) {
  test(`valid ${type} enquiry is forwarded signed and returns a reference`, async () => {
    const calls = [];
    const r = await mk(okFetch(calls)).handle(post(body(type)));
    assert.equal(r.status, 200);
    assert.deepEqual(json(r), { ok: true, reference: 'RA-A1B2C3D4' });
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, ENV.COMPANY_OS_INTAKE_URL);
    assert.equal(init.headers['x-webhook-signature'], signWebhook(SECRET, init.headers['x-webhook-timestamp'], init.body));
    const lead = JSON.parse(init.body);
    assert.equal(lead.id, ID);
    assert.equal(lead.source, 'roknalahlam.com');
    assert.equal(lead.metadata.enquiryType, type);
    assert.deepEqual(lead.metadata.utm, { utm_source: 'test' });
    assert.equal(lead.contact_name, 'Test Person');
    assert.equal(lead.company_name, type === 'staff-accommodation' ? 'Acme Contracting LLC' : 'Test Person');
    assert.match(lead.message, /Enquiry type:/);
  });
}

test('missing required fields are rejected before anything is forwarded', async () => {
  const calls = [];
  const r = await mk(okFetch(calls)).handle(post(body('owner-management', { area: '', email: '' })));
  assert.equal(r.status, 400);
  assert.equal(json(r).code, 'validation');
  assert.ok(json(r).errors.area && json(r).errors.email);
  assert.equal(calls.length, 0);
});

test('consent is required and select values are enforced', async () => {
  const calls = [];
  const relay = mk(okFetch(calls));
  assert.equal((await relay.handle(post(body('owner-management', {}, { consent: false })))).status, 400);
  assert.equal((await relay.handle(post(body('owner-management', { emirate: 'Mars' })))).status, 400);
  assert.equal((await relay.handle(post(body('property-search', { intent: 'Buy' })))).status, 400);
  assert.equal((await relay.handle(post(body('nonsense')))).status, 400);
  assert.equal(calls.length, 0);
});

test('honeypot submissions are rejected and never forwarded', async () => {
  const calls = [];
  const r = await mk(okFetch(calls)).handle(post(body('owner-management', {}, { hp: 'http://spam' })));
  assert.equal(r.status, 400);
  assert.equal(json(r).ok, false);
  assert.equal(calls.length, 0);
});

test('upstream failures never produce a success response', async () => {
  const cases = [
    [async () => ({ ok: false, status: 401, json: async () => ({ detail: 'invalid_signature' }) }), 502, 'upstream_rejected'],
    [async () => ({ ok: false, status: 503, json: async () => ({}) }), 502, 'upstream_rejected'],
    [async () => ({ ok: false, status: 500, json: async () => ({}) }), 502, 'upstream_error'],
    [async () => ({ ok: false, status: 429, json: async () => ({}) }), 503, 'upstream_busy'],
    [async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) }), 502, 'upstream_bad_response'],
    [async () => { throw new TypeError('fetch failed'); }, 502, 'upstream_unreachable'],
    [async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }, 504, 'upstream_timeout'],
  ];
  for (const [f, status, code] of cases) {
    const r = await mk(f).handle(post(body('owner-management'), { ip: '9.9.9.' + status + code.length }));
    assert.equal(r.status, status, code);
    assert.equal(json(r).ok, false, code);
    assert.equal(json(r).code, code);
    assert.equal(json(r).reference, undefined);
  }
});

test('the same client id is forwarded so retries are idempotent; a missing id is generated', async () => {
  const calls = [];
  const relay = mk(okFetch(calls));
  await relay.handle(post(body('owner-management')));
  await relay.handle(post(body('owner-management')));
  assert.equal(JSON.parse(calls[0].init.body).id, ID);
  assert.equal(JSON.parse(calls[1].init.body).id, ID);
  await relay.handle(post(body('owner-management', {}, { id: 'not-a-uuid' })));
  assert.match(JSON.parse(calls[2].init.body).id, /^[0-9a-f-]{36}$/);
  assert.notEqual(JSON.parse(calls[2].init.body).id, 'not-a-uuid');
});

test('origin allow-list, CORS headers and preflight', async () => {
  const relay = mk(okFetch([]));
  const bad = await relay.handle(post(body('owner-management'), { headers: { 'content-type': 'application/json', origin: 'https://evil.example' } }));
  assert.equal(bad.status, 403);
  assert.equal(bad.headers['access-control-allow-origin'], undefined);
  const pre = await relay.handle({ method: 'OPTIONS', path: '/api/enquiry', headers: { origin: 'https://roknalahlam.com' }, body: '', ip: '2.2.2.2' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers['access-control-allow-origin'], 'https://roknalahlam.com');
  const ok = await relay.handle(post(body('owner-management'), { ip: '2.2.2.3' }));
  assert.equal(ok.headers['access-control-allow-origin'], 'https://roknalahlam.com');
});

test('per-IP rate limit', async () => {
  const relay = mk(okFetch([]));
  let last;
  for (let i = 0; i < 11; i++) last = await relay.handle(post(body('owner-management'), { ip: '3.3.3.3' }));
  assert.equal(last.status, 429);
  assert.equal(json(last).code, 'rate_limited');
  assert.equal((await relay.handle(post(body('owner-management'), { ip: '4.4.4.4' }))).status, 200);
});

test('transport hygiene: size, content-type, invalid JSON, method, not configured', async () => {
  const relay = mk(okFetch([]));
  assert.equal((await relay.handle(post('x'.repeat(MAX_BODY_BYTES + 1), { ip: '5.5.5.1' }))).status, 413);
  assert.equal((await relay.handle(post(body('owner-management'), { ip: '5.5.5.2', headers: { 'content-type': 'text/plain', origin: 'https://roknalahlam.com' } }))).status, 415);
  assert.equal((await relay.handle(post('{not json', { ip: '5.5.5.3' }))).status, 400);
  assert.equal((await relay.handle({ method: 'GET', path: '/api/enquiry', headers: {}, body: '', ip: '5.5.5.4' })).status, 405);
  assert.equal((await relay.handle({ method: 'GET', path: '/nope', headers: {}, body: '', ip: '5.5.5.5' })).status, 404);
  const unconfigured = mk(okFetch([]), { ALLOWED_ORIGINS: 'https://roknalahlam.com' });
  const r = await unconfigured.handle(post(body('owner-management'), { ip: '5.5.5.6' }));
  assert.equal(r.status, 503);
  assert.equal(json(r).ok, false);
  assert.equal(json(await unconfigured.handle({ method: 'GET', path: '/api/health', headers: {}, body: '', ip: 'h' })).configured, false);
});

test('logs never contain enquiry contents (no PII)', async () => {
  const lines = [];
  const logger = { info: (s) => lines.push(s) };
  const relay = mk(okFetch([]), ENV, logger);
  await relay.handle(post(body('owner-management'), { ip: '6.6.6.1' }));
  await relay.handle(post(body('owner-management', {}, { hp: 'x' }), { ip: '6.6.6.2' }));
  await mk(async () => { throw new TypeError('boom'); }, ENV, logger).handle(post(body('owner-management'), { ip: '6.6.6.3' }));
  const all = lines.join('\n');
  assert.ok(lines.length >= 3);
  for (const pii of ['Test Person', 'test.person@example.com', '+971500000000', 'Jumeirah', SECRET]) assert.equal(all.includes(pii), false, pii);
});
