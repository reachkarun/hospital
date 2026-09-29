import { SetMetadata } from "@nestjs/common";
import type { Request } from "express";
import { check, type Principal } from "@rounding/contracts";
import type { Credentials } from "./config.js";
import type { Database } from "./db.js";
export const HTTP_OPTIONS = Symbol("HTTP_OPTIONS");
export const PUBLIC = "rounding:public";
export const INTERNAL = "rounding:internal";
export const Public = () => SetMetadata(PUBLIC, true);
export const Internal = () => SetMetadata(INTERNAL, true);
export interface HttpOptions {
  service: string;
  credentials: Credentials;
  serviceToken?: string;
  database?: Database;
  rateLimit?: number;
  externalToken?: string;
}
export type AuthenticatedRequest = Request & {
  principal?: Principal;
  requestId?: string;
};
export function principal(
  req: Request,
  roles: Principal["role"][] = ["provider"],
) {
  const p = (req as AuthenticatedRequest).principal;
  check(p, 401, "UNAUTHORIZED");
  check(roles.includes(p.role), 403, "FORBIDDEN");
  return p;
}
