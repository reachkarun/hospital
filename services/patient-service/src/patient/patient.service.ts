import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { check, type Principal } from "@rounding/contracts";
import {
  encounterRequest,
  encounterContext,
} from "@rounding/contracts/internal";
import { Store } from "../store.js";
import { consume, assigned, replayWaiting } from "./patient-events.js";
@Injectable()
export class PatientService {
  constructor(private readonly store: Store) {}
  list(p: Principal, q: { after: string; limit: number }) {
    const { store } = this;
    const rows = store.all(
      `SELECT DISTINCT e.id,e.body FROM entities e JOIN entities a ON a.hospital=e.hospital AND a.kind='assignment' AND json_extract(a.body,'$.patientId')=e.id
      WHERE e.hospital=? AND e.kind='patient' AND json_extract(a.body,'$.providerId')=? AND json_extract(a.body,'$.active')=1 AND e.id>? ORDER BY e.id LIMIT ?`,
      p.hospital,
      p.provider,
      q.after,
      q.limit,
    );
    store.audit(p.hospital, p.provider, "PATIENT_LIST_READ", "patient-list");
    return {
      items: rows.map((row) => JSON.parse(row.body)),
      nextCursor: rows.length === q.limit ? rows.at(-1)!.id : null,
    };
  }
  visit(p: Principal, identifier: string) {
    const { store } = this;
    const visit = store.entity(p.hospital, "visit", identifier);
    check(
      visit && assigned(store, p.hospital, p.provider, identifier, true),
      404,
      "VISIT_NOT_FOUND",
    );
    store.audit(p.hospital, p.provider, "VISIT_READ", identifier);
    return {
      ...visit,
      patient: store.entity(p.hospital, "patient", visit.patientId),
    };
  }
  resolveEncounter(input: z.infer<typeof encounterRequest>) {
    const { store } = this;
    const visit = store.entity(input.hospitalId, "visit", input.visitId);
    check(
      visit &&
        assigned(
          store,
          input.hospitalId,
          input.providerId,
          input.visitId,
          true,
        ),
      404,
      "VISIT_NOT_FOUND",
    );
    const patient = store.entity(input.hospitalId, "patient", visit.patientId);
    const provider = store.entity(
      input.hospitalId,
      "provider",
      input.providerId,
    );
    check(patient?.mrn && provider?.npi, 422, "BILLING_IDENTIFIERS_MISSING");
    store.audit(
      input.hospitalId,
      input.providerId,
      "ENCOUNTER_RESOLVED_FOR_CHARGE",
      input.visitId,
    );
    return encounterContext.parse({
      ...input,
      patientId: patient.id,
      patientMrn: patient.mrn,
      providerNpi: provider.npi,
      admissionDate: visit.admissionDate,
      ...(visit.dischargeDate ? { dischargeDate: visit.dischargeDate } : {}),
    });
  }
  inbox(p: Principal, q: { after: number; limit: number }) {
    const { store } = this;
    store.audit(p.hospital, p.provider, "INBOX_READ", "inbox");
    return {
      items: store.all(
        "SELECT rowid AS cursor,id,status,error,received_at FROM inbox WHERE hospital=? AND rowid>? ORDER BY rowid LIMIT ?",
        p.hospital,
        q.after,
        q.limit,
      ),
    };
  }
  consume(hospital: string, body: unknown) {
    return consume(this.store, hospital, body);
  }
  replay(hospital: string) {
    return { results: replayWaiting(this.store, hospital) };
  }
  metrics(hospital: string) {
    return {
      events: this.store.all(
        "SELECT status,COUNT(*) AS count FROM inbox WHERE hospital=? GROUP BY status",
        hospital,
      ),
    };
  }
}
