# Patient source integration specification

## Delivery and envelope

`POST /v1/integrations/patient-events`, with a hospital-specific **integration** bearer credential, is the mock broker's delivery adapter. `scripts/demo.ts` is a runnable source publisher. The transport-independent `consume(store, hospital, input)` function is the production consumer seam; an AMQP client can invoke it and ACK only after it returns. The hospital comes from the authenticated connection, and must equal `hospitalId` in the envelope.

The executable schema is [`envelope`](../src/contracts.ts) plus the event-specific [`payloads`](../src/patients.ts) validators. The envelope follows the assignment:

```json
{
  "messageId": "MSG-001",
  "eventType": "PATIENT_ASSIGNMENT",
  "timestamp": "2026-01-15T09:30:00Z",
  "source": "HospitalEnterpriseBroker",
  "hospitalId": "HOSP-001",
  "correlationId": "REQ-123",
  "version": "1.0",
  "payload": {
    "assignmentId": "ASSIGN-123",
    "patient": {
      "id": "PAT-456", "mrn": "SYNTHETIC-123", "firstName": "Jane", "lastName": "Example",
      "dateOfBirth": "1985-03-20", "gender": "F",
      "allergies": ["Penicillin"], "conditions": ["Hypertension"],
      "medications": [{"name": "Lisinopril", "dose": "10 mg daily"}]
    },
    "provider": {"id": "PROV-789", "npi": "1234567890", "name": "Dr. Alex Example", "specialty": "Internal Medicine"},
    "visit": {"id": "VISIT-001", "admissionDate": "2026-01-14T08:00:00Z", "room": "301A", "bed": "1", "unit": "Cardiology", "status": "ACTIVE"},
    "assignedAt": "2026-01-15T09:30:00Z"
  }
}
```

| Field | Schema |
|---|---|
| messageId, source, hospitalId | Required string, 1–100 chars, `A-Z a-z 0-9 _ . : -` |
| eventType | Required string, max 80 chars; supported values below |
| timestamp | Required ISO 8601 datetime with `Z` or explicit offset |
| correlationId | Optional identifier |
| version | Required string; only `1.0` is applied |
| payload | Required object; validated by event type |

`messageId` must be unique across all sources **within a hospital**. The enterprise broker normalizes identifiers into a hospital-wide namespace. Different hospitals may reuse IDs. Reusing a message ID for different contents is a contract violation (409), not a new event.

## Payload schemas

All IDs follow the identifier schema above. All event datetimes require timezone offsets. Patient birth dates are calendar dates. Unknown envelope fields are retained for compatible evolution; unknown fields in supported snapshot payloads are ignored. Unsupported versions or event types are quarantined.

| Type | Required payload | Optional payload |
|---|---|---|
| PATIENT_ASSIGNMENT | `assignmentId`, `patient`, `provider`, `visit`, `assignedAt` | Optional patient/provider/visit fields below |
| PATIENT_UNASSIGNMENT | `assignmentId`, `patientId`, `providerId`, `visitId`, `unassignedAt` | None |
| PATIENT_UPDATE | `patientId`, `changes`, `updatedAt` | `mrn` |
| VISIT_ADMISSION | `patient`, `visit` | Optional snapshot fields |
| VISIT_LOCATION_CHANGE | `visitId`, `patientId`, `newLocation`, `changedAt` | Unknown metadata such as previousLocation/reason is ignored |
| VISIT_DISCHARGE | `visitId`, `patientId`, `dischargeDate`, `dischargeStatus` | `providerId`, `dischargeInstructions` (max 4000 chars) |

`patient`: `id`, nonempty `mrn`, `firstName`, `lastName`, calendar `dateOfBirth`, `gender`. Optional `phone`, string-valued `address`/`emergencyContact` objects, and arrays `allergies`, `conditions`, `medications` (up to 200 entries each, strings or structured objects). Each array is a complete replacement snapshot; absent fields are preserved. An empty array explicitly clears the list.

`provider`: `id`, exactly ten digits `npi`, nonempty `name`, optional `specialty`.

`visit`: `id`, `admissionDate`, `room`, `bed`, `unit`, `status: "ACTIVE"`, optional `admittingDiagnosis`. Existing visit IDs cannot be reassigned to different patients. `newLocation` requires `room`, `bed`, `unit`.

`changes` maps mutable patient field names to `{ "old": optionalValue, "new": value }`. `new` must satisfy the corresponding patient field schema. Unknown/identity fields and empty changes are rejected into quarantine. `old` is advisory; timestamp ordering, not matching an old snapshot, decides the winning value.

The assignment did not define admission/unassignment payloads; the schemas above are explicit implementation assumptions. For example:

```json
{"assignmentId":"ASSIGN-123","patientId":"PAT-456","providerId":"PROV-789","visitId":"VISIT-001","unassignedAt":"2026-01-16T14:00:00Z"}
```

```json
{"patientId":"PAT-456","changes":{"phone":{"old":"555-0100","new":"555-0200"},"allergies":{"new":["Penicillin"]}},"updatedAt":"2026-01-16T10:00:00Z"}
```

## Reliable processing and deduplication

1. Authenticate connection; validate envelope and tenant before persistence. Invalid envelope: 400; tenant mismatch: 403.
2. Begin a write transaction. Look up `(hospital, messageId)`. The canonical payload digest detects conflicting ID reuse. Exact redelivery returns the previously committed status.
3. Insert the durable inbox record. Validate event-specific schema. A savepoint protects projections from partial application failures.
4. Apply source-owned fields and their ordering clocks; retain assignment tombstones. Missing patient/visit prerequisites produce `WAITING`; invalid payloads produce `QUARANTINED` with a safe error code.
5. Commit projection/inbox/audit atomically. Return 200 for `APPLIED`; 202 for durably retained `WAITING` or `QUARANTINED`. A broker adapter may ACK both because the app has taken durable responsibility.
6. Unexpected failures roll back everything and surface 503; the broker redelivers with exponential backoff. A response lost after commit is safe to redeliver.

Waiting events are retried after successful consumption, periodically by the worker, and through an admin replay endpoint, with a maximum of 100 per hospital per pass. Persistent missing prerequisites need an operator to restore source data. Quarantined records are visible in the admin inbox; send a corrected event with a **new message ID**. They are never silently discarded or force-applied. Malformed envelopes cannot enter the validated inbox; a real broker adapter must dead-letter them using its delivery metadata.

Inbox receipts have no TTL in this implementation, so ancient duplicate messages cannot accidentally reapply after deduplication expiry. Define an archival/tombstone policy before managing long-term PHI retention. HTTP limits are 1 MiB, 120 requests/minute per credential; brokers must honor 429 `Retry-After` as well as 503.

## Ordering and competing consumers

Each source field has a `(normalized UTC timestamp, messageId)` clock. Only larger clocks replace that field. Ties use message ID lexical order for deterministic results; the broker should avoid contradictory same-time events. Location updates cannot discard allergies; an older phone update can still supply an independently missing allergy field. An unassignment can arrive before its assignment and remains a tombstone after the older assignment arrives.

The envelope timestamp is the authoritative ordering field. Event-specific timestamps remain domain data. Snapshot and change events must be semantically consistent with that clock. This produces the same field projection as sorted event application for supported updates, including dependency replay, but does **not** pretend arbitrary late events execute in literal timestamp order. A strict ordered stream requires broker partitioning by hospital/patient and a sequence or watermark/replay protocol that the supplied contract does not include. This is a documented trade-off rather than dropping an older event wholesale.

SQLite `BEGIN IMMEDIATE` plus composite keys handles competing processes on the same host. There are no process-local deduplication sets. Multiple hosts require PostgreSQL transaction locks or a partitioned broker plus database uniqueness, not a shared network SQLite file.

## Schema evolution

Keep v1 compatible for additive envelope/snapshot fields. Breaking semantics get a new version and an explicit validator/upcaster; unsupported versions remain quarantined until reviewed. Do not coerce unknown event types into known ones. The source system stays authoritative for patient/visit/provider information; mobile APIs never edit those fields.
