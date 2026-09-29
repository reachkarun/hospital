import { Inject, Injectable } from "@nestjs/common";
import type { Principal } from "@rounding/contracts";
import { HTTP_OPTIONS, type HttpOptions } from "./http-options.js";
@Injectable()
export class PlatformService {
  constructor(
    @Inject(HTTP_OPTIONS)
    private readonly options: HttpOptions,
  ) {}
  async health() {
    await this.options.database?.get("SELECT 1");
    return { status: "ok", service: this.options.service };
  }
  async audit(
    p: Principal,
    q: {
      after: number;
      limit: number;
    },
  ) {
    const db = this.options.database!;
    await db.audit(p.hospital, p.provider, "AUDIT_READ", "audit");
    return {
      service: this.options.service,
      items: await db.all(
        "SELECT * FROM audit WHERE service=? AND hospital=? AND sequence>? ORDER BY sequence LIMIT ?",
        this.options.service,
        p.hospital,
        q.after,
        q.limit,
      ),
    };
  }
}
