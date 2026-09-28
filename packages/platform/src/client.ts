import { DomainError } from "@rounding/contracts";

export async function requestJson(
  url: string,
  options: {
    method?: string;
    token?: string;
    authorization?: string;
    body?: unknown;
  } = {},
) {
  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        "content-type": "application/json",
        ...(options.token ? { "x-service-token": options.token } : {}),
        ...(options.authorization
          ? { authorization: options.authorization }
          : {}),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const reader = response.body?.getReader();
    let text = "";
    let bytes = 0;
    if (reader) {
      const decoder = new TextDecoder();
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 2_097_152) {
          await reader.cancel();
          throw new Error("Response too large");
        }
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
    }
    const body = JSON.parse(text);
    return {
      status: response.status,
      body,
      retryAfter: response.headers.get("retry-after"),
    };
  } catch {
    throw new DomainError(503, "DEPENDENCY_UNAVAILABLE");
  }
}

export async function internalJson(
  url: string,
  token: string,
  body?: unknown,
  method = "POST",
) {
  const response = await requestJson(url, { token, body, method });
  if (response.status >= 400)
    throw new DomainError(
      response.status >= 500 ? 503 : response.status,
      response.body.error?.code ?? "DEPENDENCY_ERROR",
    );
  return response.body;
}
