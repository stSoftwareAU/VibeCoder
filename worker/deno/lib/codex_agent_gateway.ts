/**
 * Credential-free Codex API-key transport (#3699).
 *
 * The agent-local adapter forwards only to the fixed Unix broker. The broker
 * owns upstream credentials and route policy. ChatGPT subscription sessions
 * require a different upstream, account binding and trusted token refresh;
 * this slice refuses that mode rather than falling back to metered API use.
 * Provider configuration is verified against openai/codex rust-v0.147.0.
 */
import { assertBrokerCapability } from "./credential_broker_policy.ts";

export type BrokeredCodexMode = "api-key" | "chatgpt";
export interface BrokeredCodexOptions {
  mode: BrokeredCodexMode;
  capability: string;
  baseUrl: string;
  homeDir: string;
  codexHome: string;
}

function assertApiKeyMode(mode: BrokeredCodexMode): void {
  if (mode !== "api-key") {
    throw new Error("Only explicitly selected API-key mode is implemented");
  }
}

/** Fresh native CLI state; the caller must use clearEnv and fresh home mounts. */
export function buildBrokeredCodexLaunch(options: BrokeredCodexOptions): {
  env: Record<string, string>;
  configToml: string;
} {
  assertApiKeyMode(options.mode);
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
  for (const path of [options.homeDir, options.codexHome]) {
    if (!/^\/[A-Za-z0-9_./-]+$/.test(path) || path.split("/").includes("..")) {
      throw new Error("Agent home and state must be absolute sandbox paths");
    }
  }
  return {
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: options.homeDir,
      CODEX_HOME: options.codexHome,
      CODEX_BROKER_CAPABILITY: options.capability,
    },
    configToml: [
      'model_provider = "vibe_broker_api_key"',
      "check_for_update_on_startup = false",
      'cli_auth_credentials_store = "file"',
      "",
      "[model_providers.vibe_broker_api_key]",
      'name = "Isolated OpenAI API-key broker"',
      `base_url = "${base.origin}/v1"`,
      'env_key = "CODEX_BROKER_CAPABILITY"',
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      "",
    ].join("\n"),
  };
}

/** Preserve native Responses streaming, with no agent-selected upstream/account. */
export function createCodexAgentGateway(options: {
  mode: BrokeredCodexMode;
  capability: string;
  forward: (request: Request) => Promise<Response>;
}): (request: Request) => Promise<Response> {
  assertApiKeyMode(options.mode);
  assertBrokerCapability(options.capability);
  return async (request) => {
    const url = new URL(request.url);
    if (
      request.method !== "POST" || url.pathname !== "/v1/responses" ||
      url.search
    ) {
      return new Response("Broker route denied\n", { status: 403 });
    }
    const headers = new Headers();
    for (const name of ["content-type", "accept"]) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set("authorization", `Bearer ${options.capability}`);
    try {
      return await options.forward(
        new Request("http://broker.invalid/openai/v1/responses", {
          method: "POST",
          headers,
          body: request.body,
          redirect: "manual",
          signal: request.signal,
        }),
      );
    } catch {
      return new Response("Broker transport unavailable\n", {
        status: 502,
        headers: { "content-type": "text/plain", "cache-control": "no-store" },
      });
    }
  };
}

/** Agent loopback ingress with only the fixed broker socket as outgoing transport. */
export function serveCodexAgentGateway(options: {
  mode: BrokeredCodexMode;
  capability: string;
}): { baseUrl: string; close: () => Promise<void> } {
  assertApiKeyMode(options.mode);
  assertBrokerCapability(options.capability);
  const client = Deno.createHttpClient({
    proxy: { transport: "unix", path: "/run/broker/broker.sock" },
  });
  let server: Deno.HttpServer<Deno.NetAddr>;
  try {
    server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      createCodexAgentGateway({
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
