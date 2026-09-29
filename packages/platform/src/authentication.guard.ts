import {
  Inject,
  Injectable,
  HttpException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { check, DomainError, type Principal } from "@rounding/contracts";
import {
  HTTP_OPTIONS,
  PUBLIC,
  INTERNAL,
  type HttpOptions,
  type AuthenticatedRequest,
} from "./http-options.js";
const hash = (value: string) => createHash("sha256").update(value).digest();
@Injectable()
export class AuthenticationGuard implements CanActivate {
  private readonly keys;
  private readonly buckets = new Map<
    Principal,
    {
      start: number;
      count: number;
    }
  >();
  constructor(
    @Inject(HTTP_OPTIONS)
    private readonly options: HttpOptions,
    @Inject(Reflector)
    private readonly reflector: Reflector,
  ) {
    this.keys = Object.entries(options.credentials).map(([token, p]) => ({
      hash: hash(token),
      p,
    }));
  }
  async canActivate(context: ExecutionContext) {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (this.options.externalToken !== undefined) {
      const token = req.headers.authorization ?? "";
      if (
        !timingSafeEqual(
          hash(token),
          hash(`Bearer ${this.options.externalToken}`),
        )
      )
        throw new HttpException({ error: "UNAUTHORIZED" }, 401);
      return true;
    }
    if (this.reflector.getAllAndOverride<boolean>(INTERNAL, targets)) {
      const token = req.headers["x-service-token"];
      check(
        this.options.serviceToken &&
          typeof token === "string" &&
          timingSafeEqual(hash(token), hash(this.options.serviceToken)),
        401,
        "SERVICE_UNAUTHORIZED",
      );
      return true;
    }
    const token = req.headers.authorization;
    check(token?.startsWith("Bearer "), 401, "UNAUTHORIZED");
    const p = this.keys.find((k) =>
      timingSafeEqual(hash(token!.slice(7)), k.hash),
    )?.p;
    check(p, 401, "UNAUTHORIZED");
    if (this.options.database)
      check(
        await this.options.database.get(
          "SELECT id FROM hospitals WHERE id=?",
          p.hospital,
        ),
        401,
        "UNAUTHORIZED",
      );
    const now = Date.now();
    const bucket = this.buckets.get(p);
    if (!bucket || now - bucket.start >= 60000)
      this.buckets.set(p, { start: now, count: 1 });
    else if (++bucket.count > (this.options.rateLimit ?? 240)) {
      context
        .switchToHttp()
        .getResponse<Response>()
        .setHeader(
          "retry-after",
          Math.ceil((60000 - now + bucket.start) / 1000),
        );
      throw new DomainError(429, "RATE_LIMITED");
    }
    req.principal = p;
    return true;
  }
}
