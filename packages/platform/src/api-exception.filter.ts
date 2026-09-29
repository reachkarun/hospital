import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import type { Response } from "express";
import { ZodError } from "zod";
import { DomainError } from "@rounding/contracts";
import type { AuthenticatedRequest } from "./http-options.js";
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);
  catch(error: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest<AuthenticatedRequest>();
    const reply = host.switchToHttp().getResponse<Response>();
    if (reply.headersSent) return;
    const requestId = req.requestId;
    if (error instanceof DomainError)
      return reply.status(error.status).json({
        error: { code: error.code, details: error.details },
        requestId,
      });
    if (error instanceof ZodError)
      return reply.status(400).json({
        error: {
          code: "INVALID_REQUEST",
          fields: error.issues.map((i) => ({
            path: i.path.join("."),
            code: i.code,
          })),
        },
        requestId,
      });
    if (error instanceof HttpException) {
      const status = error.getStatus();
      const body = error.getResponse();
      if (
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string" &&
        body.error === "UNAUTHORIZED"
      )
        return reply.status(status).json(body);
      if (status >= 400 && status < 500)
        return reply.status(status).json({
          error: {
            code: status === 404 ? "NOT_FOUND" : "INVALID_HTTP_REQUEST",
          },
          requestId,
        });
    }
    const status =
      (error as { status?: number; statusCode?: number } | null)?.status ??
      (error as { statusCode?: number } | null)?.statusCode;
    if (status && status >= 400 && status < 500)
      return reply
        .status(status)
        .json({ error: { code: "INVALID_HTTP_REQUEST" }, requestId });
    this.logger.error({ requestId, code: "INTERNAL_ERROR" });
    return reply
      .status(503)
      .json({ error: { code: "TEMPORARILY_UNAVAILABLE" }, requestId });
  }
}
