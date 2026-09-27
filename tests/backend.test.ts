import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Json } from '../src/db.js';
import { seed, sampleEvent } from '../src/seed.js';
import { buildApi } from '../src/api.js';
import { demoCredentials } from '../src/config.js';
import { consume } from '../src/patients.js';
import { save, submitCharges } from '../src/charges.js';
import { saveCharge, type Principal } from '../src/contracts.js';
import { BillingWorker, type BillingTransport } from '../src/billing.js';
import { buildMock } from '../src/mock-billing.js';

const p: Principal = demoCredentials['demo-provider-one']!;
const draft = (identifier = 'charge-1', serviceCode = '99213', expectedVersion = 0, operationId = `op-${identifier}-${expectedVersion}`) => saveCharge.parse({
  chargeId: identifier, operationId, expectedVersion,
  charge: { visitId: 'VISIT-001', serviceCode, quantity: 1, dateOfService: '2026-01-15', notes: 'Synthetic clinical note' },
});
function setup() { const store = new Store(); seed(store, 'http://billing/api/v1'); return store; }
function queue(store: Store, identifier = 'charge-1') {
  save(store, p, draft(identifier));
  return submitCharges(store, p, { clientSubmissionId: `submit-${identifier}`, chargeIds: [identifier] }).submissionId as string;
}
function ack(payload: Json, status = 'ACCEPTED') {
  return { submissionId: payload.submissionId, status, billingReference: 'BILL-123',
    acceptedCharges: payload.charges.map((c: Json) => ({ chargeId: c.chargeId, status: 'ACCEPTED' })), rejectedCharges: [] };
}
function transport(override: Partial<BillingTransport> = {}): BillingTransport {
  return { submit: async (_url, _hospital, payload) => ({ status: 200, body: ack(payload) }), lookup: async () => ({ status: 404, body: {} }), ...override };
}

test('all six patient event types, clinical data, duplicate and conflicting message IDs', () => {
  const s = setup();
  assert.deepEqual(s.entity(p.hospital, 'patient', 'PAT-456')!.allergies, ['Penicillin']);
  assert.equal(consume(s, p.hospital, sampleEvent()).duplicate, true);
  assert.throws(() => consume(s, p.hospital, { ...sampleEvent(), source: 'Changed' }), /MESSAGE_ID_REUSED/);
  const base = { ...sampleEvent(), timestamp: '2026-01-16T12:00:00Z' };
  consume(s, p.hospital, { ...base, messageId: 'update', eventType: 'PATIENT_UPDATE', payload: { patientId: 'PAT-456', changes: { phone: { new: '555-0100' }, medications: { new: ['Synthetic medication'] } }, updatedAt: base.timestamp } });
  assert.equal(s.entity(p.hospital, 'patient', 'PAT-456')!.phone, '555-0100');
  consume(s, p.hospital, { ...base, messageId: 'location', eventType: 'VISIT_LOCATION_CHANGE', payload: { patientId: 'PAT-456', visitId: 'VISIT-001', newLocation: { room: '401', bed: '2', unit: 'ICU' }, changedAt: base.timestamp } });
  consume(s, p.hospital, { ...base, messageId: 'discharge', eventType: 'VISIT_DISCHARGE', payload: { patientId: 'PAT-456', visitId: 'VISIT-001', dischargeDate: base.timestamp, dischargeStatus: 'HOME' } });
  assert.equal(s.entity(p.hospital, 'visit', 'VISIT-001')!.status, 'DISCHARGED');
  assert.equal(s.entity(p.hospital, 'visit', 'VISIT-001')!.room, '401');
  consume(s, p.hospital, { ...base, messageId: 'unassign', eventType: 'PATIENT_UNASSIGNMENT', payload: { assignmentId: 'ASSIGN-123', patientId: 'PAT-456', providerId: 'PROV-789', visitId: 'VISIT-001', unassignedAt: base.timestamp } });
  assert.equal(s.entity(p.hospital, 'assignment', 'ASSIGN-123')!.active, false);
  consume(s, p.hospital, { ...base, messageId: 'admit', eventType: 'VISIT_ADMISSION', payload: { patient: base.payload.patient, visit: { ...base.payload.visit, id: 'VISIT-002' } } });
  assert.equal(s.entity(p.hospital, 'visit', 'VISIT-002')!.patientId, 'PAT-456');
  s.close();
});

test('late events preserve newer fields and unassignment tombstones', () => {
  const s = setup(); const base = sampleEvent();
  const change = (messageId: string, timestamp: string, changes: Json) => consume(s, p.hospital, { ...base, messageId, timestamp, eventType: 'PATIENT_UPDATE', payload: { patientId: 'PAT-456', changes, updatedAt: timestamp } });
  change('new', '2026-01-18T00:00:00Z', { phone: { new: 'new' } });
  change('old', '2026-01-17T00:00:00Z', { phone: { new: 'old' }, allergies: { new: ['Late allergy field'] } });
  assert.equal(s.entity(p.hospital, 'patient', 'PAT-456')!.phone, 'new');
  assert.deepEqual(s.entity(p.hospital, 'patient', 'PAT-456')!.allergies, ['Late allergy field']);
  consume(s, p.hospital, { ...base, messageId: 'unassign-before', timestamp: '2026-01-19T00:00:00Z', eventType: 'PATIENT_UNASSIGNMENT', payload: { assignmentId: 'ASSIGN-LATE', patientId: 'PAT-456', providerId: 'PROV-789', visitId: 'VISIT-001', unassignedAt: '2026-01-19T00:00:00Z' } });
  consume(s, p.hospital, { ...base, messageId: 'assign-late', payload: { ...base.payload, assignmentId: 'ASSIGN-LATE' } });
  assert.equal(s.entity(p.hospital, 'assignment', 'ASSIGN-LATE')!.active, false);
  s.close();
});

test('missing dependencies wait durably; admission automatically replays them', () => {
  const s = setup(); const base = sampleEvent();
  const e = { ...base, messageId: 'early-move', timestamp: '2026-01-17T00:00:00Z', eventType: 'VISIT_LOCATION_CHANGE', payload: { patientId: 'PAT-456', visitId: 'VISIT-LATE', newLocation: { room: '900', bed: '1', unit: 'ICU' }, changedAt: '2026-01-17T00:00:00Z' } };
  assert.equal(consume(s, p.hospital, e).status, 'WAITING');
  consume(s, p.hospital, { ...base, messageId: 'late-admit', eventType: 'VISIT_ADMISSION', payload: { patient: base.payload.patient, visit: { ...base.payload.visit, id: 'VISIT-LATE' } } });
  assert.equal(s.entity(p.hospital, 'visit', 'VISIT-LATE')!.room, '900');
  assert.equal(s.get('SELECT status FROM inbox WHERE id=?', 'early-move')!.status, 'APPLIED');
  s.close();
});

test('invalid/future schemas quarantine without partial entity writes', () => {
  const s = setup(); const base = sampleEvent();
  assert.equal(consume(s, p.hospital, { ...base, messageId: 'future', version: '2.0' }).status, 'QUARANTINED');
  assert.equal(consume(s, p.hospital, { ...base, messageId: 'unknown', eventType: 'NEW_EVENT' }).status, 'QUARANTINED');
  assert.equal(consume(s, p.hospital, { ...base, messageId: 'bad', payload: {} }).status, 'QUARANTINED');
  assert.equal(consume(s, p.hospital, { ...base, messageId: 'bad-link', payload: { ...base.payload, patient: { ...base.payload.patient, id: 'WRONG' } } }).status, 'QUARANTINED');
  assert.equal(s.entity(p.hospital, 'patient', 'WRONG'), undefined);
  s.close();
});

test('database failure rolls back inbox, projection, and audit; redelivery succeeds', () => {
  const s = setup(); const e = { ...sampleEvent(), messageId: 'rollback' };
  s.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'injected'); END;");
  assert.throws(() => consume(s, p.hospital, e), /injected/);
  assert.equal(s.get('SELECT id FROM inbox WHERE id=?', e.messageId), undefined);
  s.db.exec('DROP TRIGGER fail_audit');
  assert.equal(consume(s, p.hospital, e).status, 'APPLIED'); s.close();
});

test('draft retries are idempotent, changed keys conflict, stale writers get current version', () => {
  const s = setup(); const d = draft();
  assert.equal(save(s, p, d).version, 1); assert.equal(save(s, p, d).version, 1);
  assert.throws(() => save(s, p, { ...d, charge: { ...d.charge, quantity: 2 } }), /OPERATION_ID_REUSED/);
  assert.throws(() => save(s, p, { ...d, operationId: 'other-device' }), /VERSION_CONFLICT/);
  assert.equal(save(s, p, draft('charge-1', '99213', 1)).version, 2); s.close();
});

test('submission duplicates cannot queue the same charge, and failed batches rollback', () => {
  const s = setup(); const submissionId = queue(s);
  assert.equal(submitCharges(s, p, { clientSubmissionId: 'submit-charge-1', chargeIds: ['charge-1'] }).submissionId, submissionId);
  assert.throws(() => submitCharges(s, p, { clientSubmissionId: 'another-key', chargeIds: ['charge-1'] }), /CHARGE_NOT_DRAFT/);
  assert.throws(() => submitCharges(s, p, { clientSubmissionId: 'submit-charge-1', chargeIds: ['other'] }), /SUBMISSION_KEY_REUSED/);
  save(s, p, draft('new'));
  assert.throws(() => submitCharges(s, p, { clientSubmissionId: 'bad-batch', chargeIds: ['new', 'missing'] }), /CHARGE_NOT_FOUND/);
  assert.equal(s.get('SELECT status FROM charges WHERE id=?', 'new')!.status, 'DRAFT');
  assert.equal(s.get('SELECT COUNT(*) AS n FROM submissions')!.n, 1); s.close();
});

test('post-discharge submission permits service during stay only', () => {
  const s = setup();
  consume(s, p.hospital, { ...sampleEvent(), messageId: 'discharged', timestamp: '2026-01-16T12:00:00Z', eventType: 'VISIT_DISCHARGE', payload: { patientId: 'PAT-456', visitId: 'VISIT-001', dischargeDate: '2026-01-16T12:00:00Z', dischargeStatus: 'HOME' } });
  queue(s);
  const d = draft('late'); d.charge.dateOfService = '2026-01-17';
  assert.throws(() => save(s, p, d), /SERVICE_AFTER_DISCHARGE/);
  d.charge.dateOfService = '2026-01-13'; assert.throws(() => save(s, p, d), /SERVICE_BEFORE_ADMISSION/); s.close();
});

test('billing outage uses backoff and durable retry, eventually accepted', async () => {
  const s = setup(); const identifier = queue(s); let time = 100_000; let calls = 0;
  const worker = new BillingWorker(s, transport({ submit: async (_u, _h, payload) => ++calls === 1 ? { status: 503, body: {} } : { status: 200, body: ack(payload) } }), () => time, () => 0);
  await worker.tick(); assert.equal(s.get('SELECT status FROM submissions WHERE id=?', identifier)!.status, 'RETRY');
  assert.equal(await worker.tick(), false); time += 1000; await worker.tick();
  assert.equal(s.get('SELECT status FROM charges WHERE id=?', 'charge-1')!.status, 'ACCEPTED'); assert.equal(calls, 2); s.close();
});

test('lost acknowledgment reconciles without resending accepted charges', async () => {
  const s = setup(); queue(s); let receipt: Json = {}; let count = 0; let time = 100_000;
  const worker = new BillingWorker(s, transport({ submit: async (_u, _h, payload) => { count++; receipt = ack(payload); throw new Error('timeout after commit'); }, lookup: async () => ({ status: 200, body: receipt }) }), () => time, () => 0);
  await worker.tick(); time += 1000; await worker.tick();
  assert.equal(count, 1); assert.equal(s.get('SELECT status FROM charges')!.status, 'ACCEPTED'); s.close();
});

test('expired external idempotency window stops blind retries even after lookup 404', async () => {
  const s = setup(); queue(s); let time = 100_000; let count = 0;
  const worker = new BillingWorker(s, transport({ submit: async () => { count++; throw new Error('timeout'); } }), () => time, () => 0);
  await worker.tick(); time += 24 * 60 * 60 * 1000; await worker.tick();
  assert.equal(count, 1); assert.equal(s.get('SELECT status,error FROM submissions')!.status, 'REVIEW');
  assert.equal(s.get('SELECT error FROM submissions')!.error, 'IDEMPOTENCY_WINDOW_EXPIRED'); s.close();
});

test('Retry-After is honored and permanent 400 does not retry', async () => {
  const s = setup(); queue(s); let time = 100_000; let count = 0;
  const worker = new BillingWorker(s, transport({ submit: async () => ++count === 1 ? { status: 429, body: {}, retryAfter: 60_000 } : { status: 400, body: {} } }), () => time, () => 0);
  await worker.tick(); time += 30_000; assert.equal(await worker.tick(), false); time += 30_000; await worker.tick();
  assert.equal(s.get('SELECT status FROM submissions')!.status, 'FAILED'); assert.equal(await worker.tick(), false); s.close();
});

test('partial acceptance retries only corrected rejected items in a new submission', async () => {
  const s = setup(); const mockStore = new Store(); const mock = buildMock(mockStore, 'secret');
  const t: BillingTransport = {
    submit: async (_u, h, payload) => { const r = await mock.inject({ method: 'POST', url: '/api/v1/charges/submit', headers: { authorization: 'Bearer secret', 'x-hospital-id': h }, payload }); return { status: r.statusCode, body: r.json() }; },
    lookup: async (_u, h, identifier) => { const r = await mock.inject({ url: `/api/v1/charges/submissions/${identifier}`, headers: { authorization: 'Bearer secret', 'x-hospital-id': h } }); return { status: r.statusCode, body: r.json() }; },
  };
  save(s, p, draft('good')); save(s, p, draft('bad', '99999'));
  const sub = submitCharges(s, p, { clientSubmissionId: 'partial', chargeIds: ['good', 'bad'] });
  const worker = new BillingWorker(s, t); await worker.tick();
  const result = s.get('SELECT * FROM submissions WHERE id=?', sub.submissionId)!;
  assert.equal(result.status, 'PARTIAL'); assert.ok(JSON.parse(result.response).billingReference);
  assert.equal(s.get('SELECT status FROM charges WHERE id=?', 'good')!.status, 'ACCEPTED');
  assert.equal(s.get('SELECT status FROM charges WHERE id=?', 'bad')!.status, 'REJECTED');
  assert.throws(() => save(s, p, draft('good', '99213', 3)), /CHARGE_LOCKED/);
  save(s, p, draft('bad', '36415', 3));
  submitCharges(s, p, { clientSubmissionId: 'fixed', chargeIds: ['bad'] }); await worker.tick();
  assert.equal(s.get('SELECT status FROM charges WHERE id=?', 'bad')!.status, 'ACCEPTED');
  assert.equal(mockStore.get('SELECT COUNT(*) AS n FROM mock_results')!.n, 2);
  await mock.close(); s.close(); mockStore.close();
});

test('malformed acknowledgment leaves every charge locked for reconciliation', async () => {
  const s = setup(); queue(s);
  await new BillingWorker(s, transport({ submit: async (_u, _h, payload) => ({ status: 200, body: { ...ack(payload), acceptedCharges: [] } }) })).tick();
  assert.equal(s.get('SELECT status FROM submissions')!.status, 'RETRY'); assert.equal(s.get('SELECT status FROM charges')!.status, 'QUEUED'); s.close();
});

test('competing workers claim once and fence stale worker after lease expiry', async () => {
  const s = setup(); queue(s); let time = 100_000;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const slow = new BillingWorker(s, transport({ submit: async (_u, _h, payload) => { await gate; return { status: 200, body: ack(payload) }; } }), () => time);
  const pending = slow.tick();
  const fast = new BillingWorker(s, transport({ submit: async () => ({ status: 400, body: {} }) }), () => time);
  assert.equal(await fast.tick(), false);
  time += 60_001; assert.equal(await fast.tick(), true); release(); await pending;
  assert.equal(s.get('SELECT status FROM submissions')!.status, 'FAILED'); s.close();
});

test('queued work and deduplication survive closing and reopening the database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rounding-test-')); const path = join(directory, 'db.sqlite');
  try {
    let s = new Store(path); seed(s, 'http://billing'); const identifier = queue(s); s.close();
    s = new Store(path); assert.equal(consume(s, p.hospital, sampleEvent()).duplicate, true);
    await new BillingWorker(s, transport()).tick(); assert.equal(s.get('SELECT status FROM submissions WHERE id=?', identifier)!.status, 'ACCEPTED'); s.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('HTTP authentication, roles, tenant isolation and PHI read auditing', async () => {
  const s = setup(); const app = buildApi(s, demoCredentials);
  assert.equal((await app.inject('/v1/patients')).statusCode, 401);
  const one = { authorization: 'Bearer demo-provider-one' }; const two = { authorization: 'Bearer demo-provider-two' };
  assert.equal((await app.inject({ method: 'POST', url: '/v1/integrations/patient-events', headers: one, payload: sampleEvent() })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/integrations/patient-events', headers: { authorization: 'Bearer demo-integration-two' }, payload: sampleEvent() })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/charges', headers: one, payload: draft() })).statusCode, 200);
  assert.equal((await app.inject({ url: '/v1/charges/charge-1', headers: two })).statusCode, 404);
  const list = await app.inject({ url: '/v1/patients', headers: two });
  assert.equal(list.json().items[0].mrn, 'SYNTHETIC-HOSP-002'); assert.equal(list.headers['cache-control'], 'no-store');
  assert.ok(s.get("SELECT sequence FROM audit WHERE hospital='HOSP-002' AND action='PATIENT_LIST_READ'"));
  assert.throws(() => s.run('DELETE FROM audit'), /append-only/); await app.close(); s.close();
});

test('offline sync returns independent results and stale conflict data', async () => {
  const s = setup(); const app = buildApi(s, demoCredentials); const headers = { authorization: 'Bearer demo-provider-one' };
  save(s, p, draft());
  const response = await app.inject({ method: 'POST', url: '/v1/sync', headers, payload: { operations: [draft('new'), draft('charge-1', '99213', 0, 'different-op')] } });
  assert.equal(response.statusCode, 207);
  assert.equal(response.json().results[0].status, 200); assert.equal(response.json().results[1].status, 409);
  assert.equal(response.json().results[1].error.details.current.version, 1);
  await app.close(); s.close();
});

test('input validation, bounded batch, and rate limit protect ingress', async () => {
  const s = setup(); const app = buildApi(s, demoCredentials, { rateLimit: 2 }); const headers = { authorization: 'Bearer demo-provider-one' };
  const bad = draft(); (bad.charge as Json).quantity = -1;
  assert.equal((await app.inject({ method: 'POST', url: '/v1/charges', headers, payload: bad })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/sync', headers, payload: { operations: Array(101).fill(draft()) } })).statusCode, 400);
  const r = await app.inject({ url: '/v1/patients', headers }); assert.equal(r.statusCode, 429); assert.ok(r.headers['retry-after']);
  await app.close(); s.close();
});

test('charge revision history retains every draft and billing transition immutably', async () => {
  const s = setup(); queue(s); await new BillingWorker(s, transport()).tick();
  const history = s.all('SELECT version,status,body FROM charge_revisions WHERE hospital=? AND id=? ORDER BY version', p.hospital, 'charge-1');
  assert.deepEqual(history.map(r => r.status), ['DRAFT', 'QUEUED', 'ACCEPTED']);
  assert.equal(JSON.parse(history[0]!.body).notes, 'Synthetic clinical note');
  assert.throws(() => s.run('UPDATE charge_revisions SET body=?', '{}'), /append-only/); s.close();
});

test('summary-only status query replays the identical billing key within its window', async () => {
  const s = setup(); queue(s); let time = 100_000; const requests: Json[] = [];
  const worker = new BillingWorker(s, transport({
    submit: async (_u, _h, payload) => { requests.push(payload); if (requests.length === 1) throw new Error('lost ack'); return { status: 200, body: ack(payload) }; },
    lookup: async () => ({ status: 200, body: { submissionId: requests[0]!.submissionId, status: 'ACCEPTED', billingReference: 'BILL-123' } }),
  }), () => time, () => 0);
  await worker.tick(); time += 1000; await worker.tick();
  assert.deepEqual(requests[0], requests[1]); assert.equal(s.get('SELECT status FROM submissions')!.status, 'ACCEPTED'); s.close();
});

test('retry ceiling parks work; explicit retry retains original submission payload and age', async () => {
  const s = setup(); const identifier = queue(s); let time = 100_000;
  const worker = new BillingWorker(s, transport({ submit: async () => ({ status: 503, body: {} }) }), () => time, () => 0);
  for (let n = 0; n < 10; n++) { await worker.tick(); time += 60_000; }
  const before = s.get('SELECT * FROM submissions WHERE id=?', identifier)!;
  assert.equal(before.status, 'REVIEW'); assert.equal(before.attempts, 10); assert.equal(await worker.tick(), false);
  const app = buildApi(s, demoCredentials);
  const r = await app.inject({ method: 'POST', url: `/v1/submissions/${identifier}/retry`, headers: { authorization: 'Bearer demo-provider-one' } });
  assert.equal(r.statusCode, 200);
  const after = s.get('SELECT * FROM submissions WHERE id=?', identifier)!;
  assert.equal(after.payload, before.payload); assert.equal(after.first_attempt, before.first_attempt);
  await app.close(); s.close();
});

test('separate database connections coordinate worker claims and deduplication', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rounding-concurrency-')); const path = join(directory, 'db.sqlite');
  let a: Store | undefined; let b: Store | undefined;
  try {
    a = new Store(path); seed(a, 'http://billing'); queue(a); b = new Store(path);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const first = new BillingWorker(a, transport({ submit: async (_u, _h, payload) => { await gate; return { status: 200, body: ack(payload) }; } })).tick();
    assert.equal(await new BillingWorker(b, transport()).tick(), false);
    assert.equal(consume(b, p.hospital, sampleEvent()).duplicate, true);
    release(); await first;
    assert.equal(b.get('SELECT status FROM submissions')!.status, 'ACCEPTED');
  } finally { a?.close(); b?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('unassigned providers cannot read or edit another provider charge in the same hospital', async () => {
  const s = setup(); queue(s);
  const app = buildApi(s, { ...demoCredentials, 'unassigned-provider': { hospital: p.hospital, provider: 'OTHER', role: 'provider' } });
  const headers = { authorization: 'Bearer unassigned-provider' };
  assert.equal((await app.inject({ url: '/v1/visits/VISIT-001', headers })).statusCode, 404);
  assert.equal((await app.inject({ url: '/v1/charges/charge-1', headers })).statusCode, 404);
  assert.equal((await app.inject({ url: '/v1/patients', headers })).json().items.length, 0);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/charges', headers, payload: draft('other-charge') })).statusCode, 404);
  await app.close(); s.close();
});
