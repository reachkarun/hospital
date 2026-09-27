import { z } from 'zod';
import { check, id } from '@rounding/contracts';
import { encounterRequest, encounterContext } from '@rounding/contracts/internal';
import { createHttp } from '@rounding/platform/http';
import type { Credentials } from '@rounding/platform/config';
import { Store } from './store.js';
import { consume, assigned, replayWaiting } from './patients.js';

export function buildPatientApi(store: Store, credentials: Credentials, serviceToken: string) {
  const { app, principal } = createHttp(credentials, { service: 'patient', serviceToken, database: store });
  app.get('/v1/patients', async req => {
    const p = principal(req); const q = z.object({ after: z.string().default(''), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    const rows = store.all(`SELECT DISTINCT e.id,e.body FROM entities e JOIN entities a ON a.hospital=e.hospital AND a.kind='assignment' AND json_extract(a.body,'$.patientId')=e.id
      WHERE e.hospital=? AND e.kind='patient' AND json_extract(a.body,'$.providerId')=? AND json_extract(a.body,'$.active')=1 AND e.id>? ORDER BY e.id LIMIT ?`, p.hospital, p.provider, q.after, q.limit);
    store.audit(p.hospital, p.provider, 'PATIENT_LIST_READ', 'patient-list');
    return { items: rows.map(row => JSON.parse(row.body)), nextCursor: rows.length === q.limit ? rows.at(-1)!.id : null };
  });
  app.get('/v1/visits/:id', async req => {
    const p = principal(req); const identifier = id.parse((req.params as { id: string }).id);
    const visit = store.entity(p.hospital, 'visit', identifier);
    check(visit && assigned(store, p.hospital, p.provider, identifier, true), 404, 'VISIT_NOT_FOUND');
    store.audit(p.hospital, p.provider, 'VISIT_READ', identifier);
    return { ...visit, patient: store.entity(p.hospital, 'patient', visit.patientId) };
  });
  app.post('/internal/v1/encounters/resolve', async req => {
    const input = encounterRequest.parse(req.body);
    const visit = store.entity(input.hospitalId, 'visit', input.visitId);
    check(visit && assigned(store, input.hospitalId, input.providerId, input.visitId, true), 404, 'VISIT_NOT_FOUND');
    const patient = store.entity(input.hospitalId, 'patient', visit.patientId);
    const provider = store.entity(input.hospitalId, 'provider', input.providerId);
    check(patient?.mrn && provider?.npi, 422, 'BILLING_IDENTIFIERS_MISSING');
    store.audit(input.hospitalId, input.providerId, 'ENCOUNTER_RESOLVED_FOR_CHARGE', input.visitId);
    return encounterContext.parse({ ...input, patientId: patient.id, patientMrn: patient.mrn, providerNpi: provider.npi, admissionDate: visit.admissionDate, ...(visit.dischargeDate ? { dischargeDate: visit.dischargeDate } : {}) });
  });
  app.post('/v1/integrations/patient-events', async (req, reply) => {
    const p = principal(req, ['integration']); const result = consume(store, p.hospital, req.body);
    return reply.code(result.status === 'APPLIED' ? 200 : 202).send(result);
  });
  app.get('/v1/admin/inbox', async req => {
    const p = principal(req, ['admin']);
    const q = z.object({ after: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    store.audit(p.hospital, p.provider, 'INBOX_READ', 'inbox');
    return { items: store.all('SELECT rowid AS cursor,id,status,error,received_at FROM inbox WHERE hospital=? AND rowid>? ORDER BY rowid LIMIT ?', p.hospital, q.after, q.limit) };
  });
  app.post('/v1/admin/inbox/replay', async req => ({ results: replayWaiting(store, principal(req, ['admin']).hospital) }));
  app.get('/v1/admin/metrics', async req => ({ events: store.all('SELECT status,COUNT(*) AS count FROM inbox WHERE hospital=? GROUP BY status', principal(req, ['admin']).hospital) }));
  return app;
}
