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
import { principal } from "@rounding/platform/http";
import { z } from "zod";
import { id, saveCharge, submit, syncBatch } from "@rounding/contracts";
import { ChargeService } from "./charge.service.js";
@Controller()
export class ChargeController {
  constructor(@Inject(ChargeService) private readonly service: ChargeService) {}
  @Post("v1/charges")
  @HttpCode(200)
  async save(@Req() req: Request) {
    return this.service.save(principal(req), saveCharge.parse(req.body));
  }
  @Get("v1/charges")
  @HttpCode(200)
  async list(@Req() req: Request) {
    const p = principal(req);
    const q = z
      .object({
        after: z.string().max(100).default(""),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    return this.service.list(p, q);
  }
  @Get("v1/charges/:id")
  @HttpCode(200)
  async get(@Req() req: Request) {
    const p = principal(req);
    const identifier = id.parse((req.params as { id: string }).id);
    return this.service.get(p, identifier);
  }
  @Post("v1/sync")
  @HttpCode(200)
  async sync(@Req() req: Request, @Res() reply: Response) {
    const p = principal(req);
    const batch = syncBatch.parse(req.body);
    return reply.status(207).send(await this.service.sync(p, batch));
  }
  @Post("v1/submissions")
  @HttpCode(200)
  async submit(@Req() req: Request, @Res() reply: Response) {
    return reply
      .status(202)
      .send(await this.service.submit(principal(req), submit.parse(req.body)));
  }
  @Get("v1/submissions/:id")
  @HttpCode(200)
  async submission(@Req() req: Request) {
    const p = principal(req);
    const identifier = id.parse((req.params as { id: string }).id);
    return this.service.submission(p, identifier);
  }
  @Post("v1/submissions/:id/retry")
  @HttpCode(200)
  async retry(@Req() req: Request) {
    return this.service.retry(
      principal(req),
      id.parse((req.params as { id: string }).id),
    );
  }
  @Get("v1/admin/metrics")
  @HttpCode(200)
  async metrics(@Req() req: Request) {
    return this.service.metrics(principal(req, ["admin"]).hospital);
  }
}
