import { Controller, All, HttpCode, Inject, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { principal } from "@rounding/platform/http";
import { z } from "zod";
import { GatewayService } from "./gateway.service.js";
@Controller()
export class GatewayController {
  constructor(
    @Inject(GatewayService) private readonly service: GatewayService,
  ) {}
  @All([
    "v1/patients",
    "v1/visits",
    "v1/visits/:id",
    "v1/integrations/patient-events",
    "v1/admin/inbox",
    "v1/admin/inbox/replay",
    "v1/admin/audit",
    "v1/admin/metrics",
    "v1/charges",
    "v1/charges/:id",
    "v1/sync",
    "v1/submissions",
    "v1/submissions/:id",
    "v1/submissions/:id/retry",
  ])
  @HttpCode(200)
  async forward(@Req() req: Request, @Res() reply: Response) {
    if (!["GET", "POST"].includes(req.method))
      return reply.status(404).send({ error: { code: "NOT_FOUND" } });
    const url = new URL(req.originalUrl, "http://gateway");
    let auditService: "patient" | "charge" | "billing" | undefined;
    if (url.pathname === "/v1/admin/audit") {
      principal(req, ["admin"]);
      auditService = z
        .enum(["patient", "charge", "billing"])
        .parse(url.searchParams.get("service") ?? "charge");
      url.searchParams.delete("service");
    } else if (url.pathname === "/v1/admin/metrics") {
      principal(req, ["admin"]);
      return reply
        .status(200)
        .send(await this.service.metrics(req.headers.authorization));
    }
    const response = await this.service.forward({
      path: url.pathname,
      search: url.search,
      method: req.method,
      authorization: req.headers.authorization,
      body: req.body,
      auditService,
    });
    if (response.retryAfter)
      reply.setHeader("retry-after", response.retryAfter);
    return reply.status(response.status).send(response.body);
  }
}
