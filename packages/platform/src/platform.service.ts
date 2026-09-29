import { Inject, Injectable } from "@nestjs/common";
import type { Principal } from "@rounding/contracts";
import { HTTP_OPTIONS, type HttpOptions } from "./http-options.js";
@Injectable()
export class PlatformService {
  constructor(@Inject(HTTP_OPTIONS) private readonly options: HttpOptions) {}
  health() {
    this.options.database?.get("SELECT 1");
    return { status: "ok", service: this.options.service };
  }
  audit(p: Principal, q: { after: number; limit: number }) {
    const db = this.options.database!;
    db.audit(p.hospital, p.provider, "AUDIT_READ", "audit");
    return {
      service: this.options.service,
      items: db.all(
        "SELECT * FROM audit WHERE hospital=? AND sequence>? ORDER BY sequence LIMIT ?",
        p.hospital,
        q.after,
        q.limit,
      ),
    };
  }
}
