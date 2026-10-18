/**
 * Credential-free Gemini API-key transport (#3699).
 *
 * The local adapter is untrusted. The isolated broker owns route policy and
 * credentials. This API-key slice does not implement Google OAuth or Vertex.
 * Pinned CLI v0.55.1 uses GOOGLE_GEMINI_BASE_URL with gateway authentication:
 * https://github.com/google-gemini/gemini-cli/blob/v0.55.1/packages/core/src/core/contentGenerator.ts
 */
import { assertBrokerCapability } from "./credential_broker_policy.ts";

/** Preserve native model requests while selecting only the Gemini broker route. */
export function createGeminiAgentGateway(options: {
  capability: string;
  forward: (request: Request) => Promise<Response>;
}): (request: Request) => Promise<Response> {
  assertBrokerCapability(options.capability);
  return async (request) => {
    const url = new URL(request.url);
    const headers = new Headers();
    for (const name of ["content-type", "accept"]) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set("authorization", `Bearer ${options.capability}`);
    try {
      return await options.forward(
        new Request(
          `http://broker.invalid/gemini${url.pathname}${url.search}`,
          {
            method: request.method,
            headers,
            body: request.body,
            redirect: "manual",
            signal: request.signal,
          },
        ),
      );
    } catch {
      return new Response("Broker transport unavailable\n", {
        status: 502,
        headers: { "content-type": "text/plain", "cache-control": "no-store" },
      });
    }
  };
}

/** Serve agent-local loopback; the only outgoing transport is the fixed Unix socket. */
export function serveGeminiAgentGateway(options: {
  capability: string;
}): { baseUrl: string; close: () => Promise<void> } {
  assertBrokerCapability(options.capability);
  const client = Deno.createHttpClient({
    proxy: { transport: "unix", path: "/run/broker/broker.sock" },
  });
  let server: Deno.HttpServer<Deno.NetAddr>;
  try {
    server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      createGeminiAgentGateway({
        ...options,
        forward: (request) => fetch(request, { client }),
      }),
    );
  } catch (error) {
    client.close();
    throw error;
  }
  return {
    baseUrl: `http://127.0.0.1:${server.addr.port}`,
    async close() {
      try {
        await server.shutdown();
      } finally {
        client.close();
      }
    },
  };
}

/** Fresh child environment; its caller must use clearEnv and a fresh home. */
export function buildBrokeredGeminiEnvironment(options: {
  capability: string;
  baseUrl: string;
  homeDir: string;
}): Record<string, string> {
  assertBrokerCapability(options.capability);
  const base = new URL(options.baseUrl);
  if (
    base.protocol !== "http:" || base.hostname !== "127.0.0.1" ||
    !base.port || base.username || base.password || base.pathname !== "/" ||
    base.search || base.hash
  ) {
    throw new Error(
      "Agent model gateway must be an explicit local loopback port",
    );
  }
  if (
    !/^\/[A-Za-z0-9_./-]+$/.test(options.homeDir) ||
    options.homeDir.split("/").includes("..")
  ) throw new Error("Agent home must be an absolute sandbox path");
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: options.homeDir,
    GEMINI_API_KEY: options.capability,
    GOOGLE_GEMINI_BASE_URL: base.origin,
    GOOGLE_GENAI_API_VERSION: "v1beta",
    GEMINI_TELEMETRY_ENABLED: "false",
    CI: "true",
  };
}
