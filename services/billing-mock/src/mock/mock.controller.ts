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
import { Public } from "@rounding/platform/http";
import { requestSchema, modeSchema } from "./mock.schemas.js";
import { MockService } from "./mock.service.js";
@Controller()
export class MockController {
  constructor(@Inject(MockService) private readonly service: MockService) {}
  @Public()
  @Get("health")
  @HttpCode(200)
  async health() {
    return { status: "ok" };
  }
  @Post("admin/mode")
  @HttpCode(200)
  async setMode(@Req() req: Request, @Res() reply: Response) {
    const parsed = modeSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.status(400).send({ error: "INVALID_MODE" });
    return reply.status(200).send(this.service.setMode(parsed.data));
  }
  @Post("api/v1/charges/submit")
  @HttpCode(200)
  async submit(@Req() req: Request, @Res() reply: Response) {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR" } });
    if (parsed.data.hospitalId !== req.headers["x-hospital-id"])
      return reply.status(403).send({ error: "HOSPITAL_MISMATCH" });
    const result = this.service.submit(parsed.data);
    if (result.code === 429) reply.setHeader("retry-after", "2");
    return reply.status(result.code).send(result.body);
  }
  @Get("api/v1/charges/submissions/:id")
  @HttpCode(200)
  async get(@Req() req: Request, @Res() reply: Response) {
    const hospital = req.headers["x-hospital-id"];
    if (typeof hospital !== "string")
      return reply.status(400).send({ error: "HOSPITAL_REQUIRED" });
    const result = this.service.get(
      hospital,
      (req.params as { id: string }).id,
    );
    return reply.status(result.code).send(result.body);
  }
}
