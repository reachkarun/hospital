import { z } from "zod";
import { check } from "@rounding/contracts";
import { createHttp } from "@rounding/platform/http";
import { requestJson } from "@rounding/platform/client";
import type { Credentials } from "@rounding/platform/config";
import { registerDocumentation } from "./openapi.js";

export function buildGateway(
  credentials: Credentials,
  urls: { patient: string; charge: string; billing: string },
) {
  const { app, principal } = createHttp(credentials, {
    service: "gateway",
    logger: false,
  });
  app.route({
    method: ["GET", "POST"],
    url: "/v1/*",
    handler: async (req, reply) => {
      const url = new URL(req.url, "http://gateway");
      const path = url.pathname;
      let target: string;
      if (path === "/v1/admin/audit") {
        principal(req, ["admin"]);
        const service = z
          .enum(["patient", "charge", "billing"])
          .parse(url.searchParams.get("service") ?? "charge");
        target = urls[service];
        url.searchParams.delete("service");
      } else if (path === "/v1/admin/metrics") {
        principal(req, ["admin"]);
        const results = await Promise.all(
          Object.entries(urls).map(async ([service, base]) => {
            const response = await requestJson(`${base}/v1/admin/metrics`, {
              authorization: req.headers.authorization,
            });
            check(
              response.status === 200,
              503,
              "METRICS_DEPENDENCY_UNAVAILABLE",
            );
            return [service, response.body];
          }),
        );
        return Object.fromEntries(results);
      } else if (
        /^\/v1\/(patients|visits(?:\/[^/]+)?|integrations\/patient-events|admin\/inbox(?:\/replay)?)$/.test(
          path,
        )
      )
        target = urls.patient;
      else if (
        /^\/v1\/(charges(?:\/[^/]+)?|sync|submissions(?:\/[^/]+(?:\/retry)?)?)$/.test(
          path,
        )
      )
        target = urls.charge;
      else return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      const upstream = await requestJson(
        `${target}${url.pathname}${url.search}`,
        {
          method: req.method,
          authorization: req.headers.authorization,
          ...(req.body === undefined ? {} : { body: req.body }),
        },
      );
      if (upstream.retryAfter) reply.header("retry-after", upstream.retryAfter);
      return reply.code(upstream.status).send(upstream.body);
    },
  });
  registerDocumentation(app);
  return app;
}
