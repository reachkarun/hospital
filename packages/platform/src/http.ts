import "reflect-metadata";
import { randomUUID } from "node:crypto";
import type { DynamicModule } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "./http-options.js";
export {
  Public,
  Internal,
  principal,
  type HttpOptions,
} from "./http-options.js";
export { PlatformModule } from "./platform.module.js";
export { AuthenticationGuard } from "./authentication.guard.js";
export { ApiExceptionFilter } from "./api-exception.filter.js";
export async function createApplication(module: DynamicModule) {
  const app = await NestFactory.create<NestExpressApplication>(module, {
    logger: false,
    abortOnError: false,
  });
  app.disable("x-powered-by");
  app.use((req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    req.requestId = randomUUID();
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-request-id", req.requestId);
    next();
  });
  app.useBodyParser("json", { limit: 1_048_576 });
  app.getHttpServer().requestTimeout = 15_000;
  return app;
}
