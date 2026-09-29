import { Controller, Get, Inject, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Public, principal } from "./http-options.js";
import { PlatformService } from "./platform.service.js";
@Controller()
export class PlatformController {
  constructor(
    @Inject(PlatformService) private readonly service: PlatformService,
  ) {}
  @Public()
  @Get("health")
  health() {
    return this.service.health();
  }
  @Get("v1/me")
  me(@Req() req: Request) {
    return principal(req, ["provider", "integration", "admin"]);
  }
}
@Controller("v1/admin")
export class AuditController {
  constructor(
    @Inject(PlatformService) private readonly service: PlatformService,
  ) {}
  @Get("audit")
  audit(@Req() req: Request) {
    const p = principal(req, ["admin"]);
    const q = z
      .object({
        after: z.coerce.number().int().nonnegative().default(0),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    return this.service.audit(p, q);
  }
}
