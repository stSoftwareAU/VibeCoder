/**
 * Experimental request broker: credentials stay on the forwarding side of a
 * future agent namespace boundary (#3698, #3699). It does not create that
 * boundary, change container egress, or support native CLI OAuth refresh.
 *
 * No arbitrary CONNECT, redirects, token-issuing endpoints, GitHub mutations
 * or caller-selected upstreams. Errors deliberately name a stable category
 * rather than an upstream exception that may contain an injected credential.
 */
import {
  assertBrokerCapability,
  type BrokerService,
  resolveCredentialBrokerRoute,
} from "./credential_broker_policy.ts";

interface CredentialBrokerOptions {
  /** Per-run broker capability; never an upstream provider/GitHub credential. */
  capability: string;
  /**
   * Selected upstream values, held only by the trusted broker. Claude's value
   * uses claudeAuthentication; no fallback or token refresh is implied.
   */
  credentials: Partial<Record<BrokerService, string>>;
  /** Trusted selection only; bearer mode never falls back to an API key. */
  claudeAuthentication?: "api-key" | "bearer";
  /** Repository names supplied by the trusted worker, not by an agent request. */
  repositories: readonly string[];
  /** Production defaults to fetch; tests can observe the outgoing request. */
  fetch?: (request: Request) => Promise<Response>;
  /** Hard request-body bound, including streaming/chunked requests. */
  maxRequestBytes?: number;
}

function failure(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "content-type": "text/plain", "cache-control": "no-store" },
  });
}

async function boundedBody(
  request: Request,
  maximum: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        return;
      }
      chunks.push(value);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } finally {
    reader.releaseLock();
  }
}

/** Create one run-scoped handler; callers provide the network boundary. */
export function createCredentialBroker(
  options: CredentialBrokerOptions,
): (request: Request) => Promise<Response> {
  assertBrokerCapability(options.capability);
  const claudeAuthentication = options.claudeAuthentication ?? "api-key";
  if (claudeAuthentication !== "api-key" && claudeAuthentication !== "bearer") {
    throw new Error("Unsupported broker Claude authentication mode");
  }
  const maximum = options.maxRequestBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new Error(
      "Broker request-body limit must be a positive safe integer",
    );
  }
  if (
    options.repositories.some((repo) =>
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)
    )
  ) {
    throw new Error("Broker repositories must be owner/name pairs");
  }
  const repositories = new Set(
    options.repositories.map((repo) => repo.toLowerCase()),
  );
  const credentials = { ...options.credentials };
  for (const value of Object.values(credentials)) {
    if (!/^[\x21-\x7e]+$/.test(value)) {
      throw new Error("Invalid broker credential");
    }
  }
  const capabilityHash = crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`Bearer ${options.capability}`),
  );
  const forward = options.fetch ?? fetch;

  return async (request) => {
    const presented = request.headers.get("authorization") ?? "";
    const actual = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(presented),
      ),
    );
    const expected = new Uint8Array(await capabilityHash);
    let difference = 0;
    for (let index = 0; index < expected.length; index++) {
      difference |= expected[index]! ^ actual[index]!;
    }
    if (difference !== 0) return failure(401, "Broker capability required");
    const route = resolveCredentialBrokerRoute(request, repositories);
    if (!route) return failure(403, "Broker route denied");
    const credential = credentials[route.service];
    if (!credential) return failure(503, "Broker service is not configured");

    let body: Uint8Array<ArrayBuffer> | undefined;
    try {
      body = await boundedBody(request, maximum);
    } catch {
      return failure(400, "Request body could not be read");
    }
    if (!body) return failure(413, "Request body exceeds broker limit");
    const headers = new Headers();
    headers.set("accept", "application/json, text/event-stream");
    if (body.byteLength > 0) headers.set("content-type", "application/json");
    const anthropic = route.service === "claude" ||
      (route.service === "deepseek" &&
        route.upstream.pathname.startsWith("/anthropic/"));
    if (anthropic) {
      // The official gateway protocol defines this as an open namespace:
      // new capability headers must survive together with their body fields.
      // Upstream authentication stays exclusively in the injected headers.
      for (const [name, value] of request.headers) {
        if (name.startsWith("anthropic-")) headers.set(name, value);
      }
      if (!headers.has("anthropic-version")) {
        headers.set("anthropic-version", "2023-06-01");
      }
    }
    if (route.service === "claude" && claudeAuthentication === "api-key") {
      headers.set("x-api-key", credential);
    } else if (route.service === "gemini") {
      headers.set("x-goog-api-key", credential);
    } else {
      headers.set("authorization", `Bearer ${credential}`);
    }
    if (route.service === "github") {
      headers.set("x-github-api-version", "2022-11-28");
    }
    let response: Response;
    try {
      response = await forward(
        new Request(route.upstream, {
          method: request.method,
          headers,
          body: request.method === "POST" ? body : undefined,
          redirect: "manual",
          signal: AbortSignal.any([
            request.signal,
            AbortSignal.timeout(180_000),
          ]),
        }),
      );
    } catch {
      return failure(502, "Upstream request failed");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return failure(502, "Upstream redirect refused");
    }
    const responseHeaders = new Headers({ "cache-control": "no-store" });
    // An allowlist keeps auth/cookie/location/debug headers from the agent.
    for (const [name, value] of response.headers) {
      if (
        ["content-type", "retry-after", "x-request-id", "request-id"].includes(
          name,
        ) ||
        (anthropic &&
          (name === "x-should-retry" ||
            name.startsWith("anthropic-ratelimit-unified-")))
      ) responseHeaders.set(name, value);
    }
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  };
}
