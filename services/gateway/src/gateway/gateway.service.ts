import { Injectable } from "@nestjs/common";
import { check } from "@rounding/contracts";
import { requestJson } from "@rounding/platform/client";

export type ServiceUrls = { patient: string; charge: string; billing: string };

@Injectable()
export class GatewayService {
  constructor(private readonly urls: ServiceUrls) {}

  async metrics(authorization: string | undefined) {
    const results = await Promise.all(
      Object.entries(this.urls).map(async ([service, base]) => {
        const response = await requestJson(`${base}/v1/admin/metrics`, {
          authorization,
        });
        check(response.status === 200, 503, "METRICS_DEPENDENCY_UNAVAILABLE");
        return [service, response.body];
      }),
    );
    return Object.fromEntries(results);
  }

  async forward(input: {
    path: string;
    search: string;
    method: string;
    authorization: string | undefined;
    body: unknown;
    auditService?: keyof ServiceUrls;
  }) {
    const { path } = input;
    let target: string;
    if (path === "/v1/admin/audit" && input.auditService) {
      target = this.urls[input.auditService];
    } else if (
      /^\/v1\/(patients|visits(?:\/[^/]+)?|integrations\/patient-events|admin\/inbox(?:\/replay)?)$/.test(
        path,
      )
    ) {
      target = this.urls.patient;
    } else if (
      /^\/v1\/(charges(?:\/[^/]+)?|sync|submissions(?:\/[^/]+(?:\/retry)?)?)$/.test(
        path,
      )
    ) {
      target = this.urls.charge;
    } else {
      return {
        status: 404,
        body: { error: { code: "NOT_FOUND" } },
        retryAfter: undefined,
      };
    }
    return requestJson(`${target}${path}${input.search}`, {
      method: input.method,
      authorization: input.authorization,
      ...(input.body === undefined ? {} : { body: input.body }),
    });
  }
}
