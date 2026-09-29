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
  async list(
    p: Principal,
    q: {
      after: string;
      limit: number;
    },
  ) {
    const { store } = this;
    const rows = await store.all(
      `SELECT DISTINCT e.id,e.body FROM patient_entities e JOIN patient_entities a ON a.hospital=e.hospital AND a.kind='assignment' AND JSON_UNQUOTE(JSON_EXTRACT(a.body,'$.patientId'))=e.id
      WHERE e.hospital=? AND e.kind='patient' AND JSON_UNQUOTE(JSON_EXTRACT(a.body,'$.providerId'))=? AND JSON_UNQUOTE(JSON_EXTRACT(a.body,'$.active'))='true' AND e.id>? ORDER BY e.id LIMIT ?`,
      p.hospital,
      p.provider,
      q.after,
      q.limit,
    );
    await store.audit(
      p.hospital,
      p.provider,
      "PATIENT_LIST_READ",
      "patient-list",
    );
    return {
      items: rows.map((row) => JSON.parse(row.body)),
      nextCursor: rows.length === q.limit ? rows.at(-1)!.id : null,
    };
  }
  async visit(p: Principal, identifier: string) {
    const { store } = this;
    const visit = await store.entity(p.hospital, "visit", identifier);
    check(
      visit &&
        (await assigned(store, p.hospital, p.provider, identifier, true)),
      404,
      "VISIT_NOT_FOUND",
    );
    await store.audit(p.hospital, p.provider, "VISIT_READ", identifier);
    return {
      ...visit,
      patient: await store.entity(p.hospital, "patient", visit.patientId),
    };
  }
  async resolveEncounter(input: z.infer<typeof encounterRequest>) {
    const { store } = this;
    const visit = await store.entity(input.hospitalId, "visit", input.visitId);
    check(
      visit &&
        (await assigned(
          store,
          input.hospitalId,
          input.providerId,
          input.visitId,
          true,
        )),
      404,
      "VISIT_NOT_FOUND",
    );
    const patient = await store.entity(
      input.hospitalId,
      "patient",
      visit.patientId,
    );
    const provider = await store.entity(
      input.hospitalId,
      "provider",
      input.providerId,
    );
    check(patient?.mrn && provider?.npi, 422, "BILLING_IDENTIFIERS_MISSING");
    await store.audit(
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
  async inbox(
    p: Principal,
    q: {
      after: number;
      limit: number;
    },
  ) {
    const { store } = this;
    await store.audit(p.hospital, p.provider, "INBOX_READ", "inbox");
    return {
      items: await store.all(
        "SELECT sequence AS `cursor`,id,status,error,received_at FROM patient_inbox WHERE hospital=? AND sequence>? ORDER BY sequence LIMIT ?",
        p.hospital,
        q.after,
        q.limit,
      ),
    };
  }
  async consume(hospital: string, body: unknown) {
    return await consume(this.store, hospital, body);
  }
  async replay(hospital: string) {
    return { results: await replayWaiting(this.store, hospital) };
  }
  async metrics(hospital: string) {
    return {
      events: await this.store.all(
        "SELECT status,COUNT(*) AS count FROM patient_inbox WHERE hospital=? GROUP BY status",
        hospital,
      ),
    };
  }
}
