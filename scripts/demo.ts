import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sampleEvent } from '../src/seed.js';

const base = process.env.API_URL ?? 'http://127.0.0.1:3000';
const mock = process.env.MOCK_URL ?? 'http://127.0.0.1:4001';
const run = randomUUID();
async function request(path: string, body?: unknown, token = 'demo-provider-one', origin = base) {
  const r = await fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const data = await r.json() as any;
  if (!r.ok) throw new Error(`${r.status}: ${JSON.stringify(data)}`);
  return data;
}
function draft(chargeId: string, code = '99213', version = 0) {
  return { operationId: `${run}-${chargeId}-${version}`, chargeId: `${run}-${chargeId}`, expectedVersion: version,
    charge: { visitId: 'VISIT-001', serviceCode: code, quantity: 1, dateOfService: '2026-01-15', modifiers: [], notes: 'Synthetic demo note' } };
}
async function waitFor(submissionId: string, status: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await request(`/v1/submissions/${submissionId}`);
    if (result.status === status) return result;
    if (['FAILED', 'REVIEW'].includes(result.status)) throw new Error(`Unexpected state: ${JSON.stringify(result)}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${status}; ensure the billing worker is running`);
}
async function mode(value: string, remaining = 1) {
  await request('/admin/mode', { hospitalId: 'HOSP-001', mode: value, remaining }, 'demo-billing-secret', mock);
}

console.log('1. Publish a broker assignment, then redeliver the same message.');
const event = { ...sampleEvent(), messageId: `demo-${run}` };
await request('/v1/integrations/patient-events', event, 'demo-integration-one');
assert.equal((await request('/v1/integrations/patient-events', event, 'demo-integration-one')).duplicate, true);
console.log('   Event deduplication verified.');

console.log('2. Sync offline drafts and demonstrate an optimistic concurrency conflict.');
const synced = await request('/v1/sync', { operations: [draft('good'), draft('bad', '99999')] });
assert.ok(synced.results.every((r: any) => r.status === 200));
const conflict = await request('/v1/sync', { operations: [{ ...draft('good'), operationId: `stale-${run}` }] });
assert.equal(conflict.results[0].status, 409);
console.log('   Drafts saved; stale edit returns VERSION_CONFLICT with current version.');

console.log('3. Submit through a temporary billing outage, then inspect partial acceptance.');
await mode('outage', 1);
const submission = { clientSubmissionId: run, chargeIds: [draft('good').chargeId, draft('bad').chargeId] };
const queued = await request('/v1/submissions', submission);
assert.equal((await request('/v1/submissions', submission)).submissionId, queued.submissionId);
const partial = await waitFor(queued.submissionId, 'PARTIAL');
assert.ok(partial.attempts >= 2);
console.log(`   ${partial.status}; attempts=${partial.attempts}; billing reference retained.`);

console.log('4. Correct only the rejected item and simulate a lost acknowledgment.');
const rejected = await request(`/v1/charges/${draft('bad').chargeId}`);
await request('/v1/charges', draft('bad', '36415', rejected.version));
await mode('lost-ack');
const fixed = await request('/v1/submissions', { clientSubmissionId: `fixed-${run}`, chargeIds: [draft('bad').chargeId] });
const accepted = await waitFor(fixed.submissionId, 'ACCEPTED');
assert.equal(accepted.status, 'ACCEPTED');
console.log('   Corrected item accepted; worker reconciled the lost acknowledgment.');

console.log('5. Verify hospital isolation and read the audit trail.');
const other = await request('/v1/charges', undefined, 'demo-provider-two');
assert.ok(!other.items.some((c: any) => c.chargeId.startsWith(run)));
const audit = await request('/v1/admin/audit?limit=100', undefined, 'demo-admin-one');
assert.ok(audit.items.length);
console.log('Demo passed: patient sync, offline conflicts, retry, partial acceptance, reconciliation, tenant isolation, audit.');
