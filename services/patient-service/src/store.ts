import { Database, type Json } from "@rounding/platform/db";
import { databaseConfig, type DatabaseConfig } from "@rounding/platform/config";
export { timestamp, type Json } from "@rounding/platform/db";

export class Store extends Database {
  constructor(options: DatabaseConfig = databaseConfig()) {
    super(options, "patient");
  }
  async entity(
    hospital: string,
    kind: string,
    id: string,
  ): Promise<Json | undefined> {
    const row = await this.get(
      "SELECT body FROM patient_entities WHERE hospital=? AND kind=? AND id=?",
      hospital,
      kind,
      id,
    );
    return row ? JSON.parse(row.body) : undefined;
  }
}
