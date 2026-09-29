import {
  Controller,
  Get,
  Post,
  Put,
  HttpCode,
  Inject,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { principal, Internal } from "@rounding/platform/http";
import { z } from "zod";
import { id } from "@rounding/contracts";
import { billingRequest } from "@rounding/contracts/internal";
import { BillingService } from "./billing.service.js";
@Controller()
export class BillingController {
  constructor(
    @Inject(BillingService)
    private readonly service: BillingService,
  ) {}
  @Internal()
  @Put("internal/v1/jobs")
  @HttpCode(200)
  async receive(
    @Req()
    req: Request,
  ) {
    return await this.service.receive(billingRequest.parse(req.body));
  }
  @Internal()
  @Get("internal/v1/jobs/:hospital/:id")
  @HttpCode(200)
  async get(
    @Req()
    req: Request,
  ) {
    const p = z.object({ hospital: id, id }).parse(req.params);
    return await this.service.get(p);
  }
  @Internal()
  @Post("internal/v1/jobs/:hospital/:id/retries")
  @HttpCode(200)
  async retry(
    @Req()
    req: Request,
  ) {
    const p = z.object({ hospital: id, id }).parse(req.params);
    const op = z.object({ operationId: id }).strict().parse(req.body);
    return await this.service.retry(p, op);
  }
  @Get("v1/admin/metrics")
  @HttpCode(200)
  async metrics(
    @Req()
    req: Request,
  ) {
    return await this.service.metrics(principal(req, ["admin"]).hospital);
  }
}
