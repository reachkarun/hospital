import { Database } from "@rounding/platform/db";
import { databaseConfig, type DatabaseConfig } from "@rounding/platform/config";
export { timestamp, type Json } from "@rounding/platform/db";
export class Store extends Database {
  constructor(options: DatabaseConfig = databaseConfig()) {
    super(options, "charge");
  }
}
