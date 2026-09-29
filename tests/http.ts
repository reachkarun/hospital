import type { INestApplication } from "@nestjs/common";

/** Exercise the real Nest HTTP server, including middleware, guards and filters. */
export async function httpRequest(
  app: INestApplication,
  input:
    | string
    | {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        payload?: unknown;
      },
) {
  const options = typeof input === "string" ? { url: input } : input;
  const response = await fetch(new URL(options.url, await app.getUrl()), {
    method: options.method ?? "GET",
    headers: {
      ...(options.payload === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...options.headers,
    },
    ...(options.payload === undefined
      ? {}
      : { body: JSON.stringify(options.payload) }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  return {
    statusCode: response.status,
    headers: response.headers,
    body,
    json: () => JSON.parse(body),
  };
}
