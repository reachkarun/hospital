# API reference

Base URL: `http://localhost:3002` (Gateway). Interactive Swagger: `/docs/`. Business endpoints require a bearer credential; health and documentation are public. Payloads and results are JSON. Error responses contain a safe machine-readable code and request ID; input errors expose field paths, not submitted PHI. Responses use `Cache-Control: no-store`.

## Endpoints

| Method | Path                                              | Role        | Behavior                                                           |
| ------ | ------------------------------------------------- | ----------- | ------------------------------------------------------------------ |
| GET    | `/health`                                         | Public      | Database liveness                                                  |
| GET    | `/v1/me`                                          | Any         | Authenticated hospital/provider/role                               |
| GET    | `/v1/patients?after=&limit=50`                    | Provider    | Active assigned patients; lexical patient ID cursor                |
| GET    | `/v1/visits/:id`                                  | Provider    | Visit and patient for current/historical assignment                |
| POST   | `/v1/charges`                                     | Provider    | Create/update draft; 200, versioned operation receipt              |
| GET    | `/v1/charges?after=&limit=50`                     | Provider    | Own charges; lexical charge ID cursor                              |
| GET    | `/v1/charges/:id`                                 | Provider    | Current charge, version, errors, submission ID                     |
| POST   | `/v1/sync`                                        | Provider    | 1–100 saves; 207 with independent per-operation outcomes           |
| POST   | `/v1/submissions`                                 | Provider    | Queue a batch; 202 with durable submission ID                      |
| GET    | `/v1/submissions/:id`                             | Provider    | State, attempts, next retry, acknowledgment and reference          |
| POST   | `/v1/submissions/:id/retry`                       | Provider    | Requeue RETRY/REVIEW with the original billing key                 |
| POST   | `/v1/integrations/patient-events`                 | Integration | Consume normalized source event                                    |
| GET    | `/v1/admin/inbox?after=0&limit=50`                | Admin       | Inbox status/errors; numeric row cursor, no clinical bodies        |
| POST   | `/v1/admin/inbox/replay`                          | Admin       | Retry up to 100 missing-dependency events                          |
| GET    | `/v1/admin/audit?service=charge&after=0&limit=50` | Admin       | Service-owned tenant audit; service is patient, charge, or billing |
| GET    | `/v1/admin/metrics`                               | Admin       | Counts grouped under patient, charge, and billing                  |

All list limits are 1–100. For patient/charge lists, use `nextCursor` until null. Admin lists use the last `cursor`/`sequence` value as `after`; audit cursors are independent per service. Charge polling is a paginated current snapshot, not a delta-feed protocol; clients explicitly refresh known charge IDs after queued submissions. Billing result projection is eventually consistent across services.

## Create or edit a draft

```json
{
  "operationId": "device-a-save-001",
  "chargeId": "CHG-001",
  "expectedVersion": 0,
  "charge": {
    "visitId": "VISIT-001",
    "serviceCode": "99213",
    "quantity": 1,
    "dateOfService": "2026-01-15",
    "modifiers": ["25"],
    "notes": "Synthetic clinical note",
    "description": "Established patient visit"
  }
}
```

The stable `chargeId` identifies a logical item across devices/retries. An `operationId` identifies one edit, and must be retained when retrying that edit. New charges use version 0; updates require the current version. Unknown fields are rejected. Notes are optional/null and limited to 2000 characters. Service codes must be five digits or an uppercase letter followed by four digits; this is format validation, not a licensed code catalog. Quantity is an integer 1–999; up to four two-character modifiers are accepted. Billing is authoritative for service/modifier applicability and pricing; `unitPrice` is deliberately not accepted from mobile clients.

Drafts require complete core charge fields but are not sent to billing. Providers may revise notes/service details repeatedly. A date of service must be valid, no later than today, and within the encounter's admission/discharge calendar dates. Dates use the ISO calendar day supplied by the hospital; production should specify each hospital's business timezone explicitly. Submission after discharge is valid for services within that stay. Existing charge visit IDs cannot change. A rejected charge can be edited; queued/accepted charges are immutable.

```json
{ "chargeId": "CHG-001", "version": 1, "status": "DRAFT" }
```

A repeated identical save returns this original receipt even if the current charge later advanced. Refresh `GET /v1/charges/:id` for current state. Reusing the operation ID with a different payload returns `409 OPERATION_ID_REUSED`.

## Offline batch and conflicts

```json
{
  "operations": [
    {
      "operationId": "device-a-save-001",
      "chargeId": "CHG-001",
      "expectedVersion": 0,
      "charge": {
        "visitId": "VISIT-001",
        "serviceCode": "99213",
        "quantity": 1,
        "dateOfService": "2026-01-15"
      }
    }
  ]
}
```

Valid envelopes produce HTTP 207 and `results: [{operationId,status,result|error}]`. Business failures affect only their item. Malformed batches fail schema validation before any writes. A later infrastructure failure may occur after earlier items committed; replay with the same operation IDs is safe.

`409 VERSION_CONFLICT` contains `details.current` with the authorized provider's current charge/version. The mobile app asks the provider to merge conflicting clinical edits, then sends a new operation ID and current version. The server never merges notes automatically. A 429 includes `Retry-After`; split reconnect backlogs into at most 100 operations per request, persist outcomes on-device, and retry outstanding operations with exponential backoff and jitter.

## Submit and inspect

```json
{ "clientSubmissionId": "mobile-batch-001", "chargeIds": ["CHG-001"] }
```

Only draft charges owned by the provider and belonging to one visit can be submitted together. Maximum 100 items; duplicate charge IDs are invalid. Repeating the same client key and charge set returns the same submission/current state. A different set under the same key returns 409. Sending an already queued charge under a fresh key also returns 409. Preserve logical charge IDs: the backend cannot distinguish genuinely repeated services from duplicate new UUIDs invented by a client.

The worker calls billing asynchronously. States are `QUEUED`, `SENDING`, `RETRY`, `ACCEPTED`, `PARTIAL`, `REJECTED`, `FAILED`, `REVIEW`. A response includes `attempts`, `nextAttemptAt`, safe `error`, and the validated billing acknowledgment under `billing`. A partial acknowledgment retains `billingReference`, accepted item IDs and each rejected item's error.

For partial acceptance: leave accepted charges alone, fetch each rejected charge's current version, edit it with a new operation ID, then submit only corrected draft items under a new client submission key. A retry endpoint does not bypass this rule or reset the external idempotency window. Manual retries can recheck `REVIEW` outcomes, but expired unknown outcomes will remain in review unless the billing status query supplies complete per-item evidence.

## Mock failure controls

Only on the mock service, use `Authorization: Bearer demo-billing-secret`:

```http
POST http://127.0.0.1:4001/admin/mode
Content-Type: application/json
Authorization: Bearer demo-billing-secret

{"hospitalId":"HOSP-001","mode":"outage","remaining":2}
```

Modes: `healthy`, `outage` (503 before processing), `rate-limit` (429 + Retry-After), `lost-ack` (commit then 503). Controls affect the next `remaining` uncached submissions for that hospital. `99999` or modifier `99` deterministically rejects an item; other format-valid values are accepted. Mock status queries return full item outcomes, extending the assignment's optional summary-only lookup. The worker also handles summary-only lookups by replaying the original key within the safe window.
