import {
  Controller,
  Get,
  Post,
  HttpCode,
  Inject,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { principal, Internal } from "@rounding/platform/http";
import { z } from "zod";
import { id } from "@rounding/contracts";
import { encounterRequest } from "@rounding/contracts/internal";
import { PatientService } from "./patient.service.js";
@Controller()
export class PatientController {
  constructor(
    @Inject(PatientService)
    private readonly service: PatientService,
  ) {}
  @Get("v1/patients")
  @HttpCode(200)
  async list(
    @Req()
    req: Request,
  ) {
    const p = principal(req);
    const q = z
      .object({
        after: z.string().default(""),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    return await this.service.list(p, q);
  }
  @Get("v1/visits/:id")
  @HttpCode(200)
  async visit(
    @Req()
    req: Request,
  ) {
    const p = principal(req);
    const identifier = id.parse(
      (
        req.params as {
          id: string;
        }
      ).id,
    );
    return await this.service.visit(p, identifier);
  }
  @Internal()
  @Post("internal/v1/encounters/resolve")
  @HttpCode(200)
  async resolveEncounter(
    @Req()
    req: Request,
  ) {
    const input = encounterRequest.parse(req.body);
    return await this.service.resolveEncounter(input);
  }
  @Post("v1/integrations/patient-events")
  @HttpCode(200)
  async consume(
    @Req()
    req: Request,
    @Res()
    reply: Response,
  ) {
    const p = principal(req, ["integration"]);
    const result = await this.service.consume(p.hospital, req.body);
    return reply.status(result.status === "APPLIED" ? 200 : 202).send(result);
  }
  @Get("v1/admin/inbox")
  @HttpCode(200)
  async inbox(
    @Req()
    req: Request,
  ) {
    const p = principal(req, ["admin"]);
    const q = z
      .object({
        after: z.coerce.number().int().nonnegative().default(0),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    return await this.service.inbox(p, q);
  }
  @Post("v1/admin/inbox/replay")
  @HttpCode(200)
  async replay(
    @Req()
    req: Request,
  ) {
    return await this.service.replay(principal(req, ["admin"]).hospital);
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
