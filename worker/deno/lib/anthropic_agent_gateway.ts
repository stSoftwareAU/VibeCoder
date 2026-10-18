/**
 * Anthropic-format client adapter for a credential-free agent (#3699).
 *
 * This runs on the untrusted side, bound to agent-local loopback. It is a
 * transport adapter, not the security boundary: the separately isolated
 * credential broker authorises every route and injects upstream credentials.
 * The supplied forwarder must use that broker's Unix socket, never TCP.
 * Production startup has not yet adopted this adapter.
 */
import { assertBrokerCapability } from "./credential_broker_policy.ts";

type AnthropicService = "claude" | "deepseek";
type AnthropicAuthMode = "api-key" | "subscription" | "bearer";

function assertService(service: AnthropicService): void {
  if (service !== "claude" && service !== "deepseek") {
    throw new Error("Unsupported Anthropic broker service");
  }
}

/** Translate native CLI paths to one fixed service on a Unix broker. */
export function createAnthropicAgentGateway(options: {
  service: AnthropicService;
  capability: string;
  forward: (request: Request) => Promise<Response>;
}): (request: Request) => Promise<Response> {
  assertService(options.service);
  assertBrokerCapability(options.capability);
  const prefix = options.service === "deepseek"
    ? "/deepseek/anthropic"
    : "/claude";
  return async (request) => {
    const url = new URL(request.url);
    const headers = new Headers();
    for (const [name, value] of request.headers) {
      if (
        name.startsWith("anthropic-") ||
        name === "content-type" || name === "accept"
      ) headers.set(name, value);
    }
    // This value is a local per-run capability. No provider credential is
    // accepted by this interface or inherited from the process environment.
    headers.set("authorization", `Bearer ${options.capability}`);
    try {
      return await options.forward(
        new Request(
          `http://broker.invalid${prefix}${url.pathname}${url.search}`,
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

/**
 * Serve the adapter on ephemeral IPv4 loopback, forwarding solely over the
 * fixed read-only broker socket mount. No proxy environment, DNS lookup or
 * TCP fallback participates in this connection.
 */
export function serveAnthropicAgentGateway(options: {
  service: AnthropicService;
  capability: string;
}): { baseUrl: string; close: () => Promise<void> } {
  assertService(options.service);
  assertBrokerCapability(options.capability);
  const client = Deno.createHttpClient({
    proxy: { transport: "unix", path: "/run/broker/broker.sock" },
  });
  let server: Deno.HttpServer<Deno.NetAddr>;
  try {
    server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      createAnthropicAgentGateway({
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

/**
 * Build a fresh native CLI environment with only an opaque local capability.
 * A supervisor supplies fresh credential-free home/state mounts. The caller
 * must use clearEnv: true; this map deliberately accepts no parent environment.
 * Subscription mode keeps its own CLI variable and never supplies an API key.
 */
export function buildBrokeredAnthropicEnvironment(options: {
  service: AnthropicService;
  mode: AnthropicAuthMode;
  capability: string;
  baseUrl: string;
  homeDir: string;
  configDir: string;
}): Record<string, string> {
  assertService(options.service);
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
  for (const path of [options.homeDir, options.configDir]) {
    if (!/^\/[A-Za-z0-9_./-]+$/.test(path) || path.split("/").includes("..")) {
      throw new Error("Agent home and state must be absolute sandbox paths");
    }
  }
  if (
    !["api-key", "subscription", "bearer"].includes(options.mode) ||
    (options.service === "deepseek" && options.mode !== "bearer")
  ) throw new Error("Unsupported brokered provider authentication mode");
  const authVariable = options.mode === "subscription"
    ? "CLAUDE_CODE_OAUTH_TOKEN"
    : options.mode === "api-key"
    ? "ANTHROPIC_API_KEY"
    : "ANTHROPIC_AUTH_TOKEN";
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: options.homeDir,
    CLAUDE_CONFIG_DIR: options.configDir,
    ANTHROPIC_BASE_URL: base.origin,
    [authVariable]: options.capability,
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
}
