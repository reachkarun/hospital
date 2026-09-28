export function sampleEvent(hospitalId = "HOSP-001") {
  return {
    messageId: "seed-assignment-001",
    eventType: "PATIENT_ASSIGNMENT",
    timestamp: "2026-01-15T09:30:00Z",
    source: "DemoEnterpriseBroker",
    hospitalId,
    version: "1.0",
    payload: {
      assignmentId: "ASSIGN-123",
      patient: {
        id: "PAT-456",
        mrn: `SYNTHETIC-${hospitalId}`,
        firstName: "Jane",
        lastName: "Example",
        dateOfBirth: "1985-03-20",
        gender: "F",
        allergies: ["Penicillin"],
        conditions: ["Hypertension"],
        medications: [{ name: "Lisinopril", dose: "10 mg daily" }],
      },
      provider: {
        id: "PROV-789",
        npi: "1234567890",
        name: "Dr. Alex Example",
        specialty: "Internal Medicine",
      },
      visit: {
        id: "VISIT-001",
        admissionDate: "2026-01-14T08:00:00Z",
        room: "301A",
        bed: "1",
        unit: "Cardiology",
        status: "ACTIVE",
        admittingDiagnosis: "Synthetic demonstration encounter",
      },
      assignedAt: "2026-01-15T09:30:00Z",
    },
  };
}
