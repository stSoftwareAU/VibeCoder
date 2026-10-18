/**
 * Credential-free Codex API-key and ChatGPT transport (#3699).
 *
 * The agent-local adapter forwards only to the fixed Unix broker. The broker
 * owns upstream credentials, account binding, refresh and route policy. The
 * trusted selected mode fixes the route; requests cannot change billing mode.
 * Provider configuration is verified against openai/codex rust-v0.147.0.
 */
import { assertBrokerCapability } from "./credential_broker_policy.ts";
import { CODEX_SUBSCRIPTION_METADATA_HEADERS } from "./codex_transport_headers.ts";

export type BrokeredCodexMode = "api-key" | "chatgpt";
export interface BrokeredCodexOptions {
  mode: BrokeredCodexMode;
  capability: string;
  baseUrl: string;
  homeDir: string;
  codexHome: string;
}

function assertMode(mode: BrokeredCodexMode): void {
  if (mode !== "api-key" && mode !== "chatgpt") {
    throw new Error("Codex broker mode must be explicitly selected");
  }
}

/** Fresh native CLI state; the caller must use clearEnv and fresh home mounts. */
export function buildBrokeredCodexLaunch(options: BrokeredCodexOptions): {
  env: Record<string, string>;
  configToml: string;
  providerId: string;
} {
  assertMode(options.mode);
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
  const providerId = options.mode === "api-key"
    ? "vibe_broker_api_key"
    : "vibe_broker_chatgpt";
  const name = options.mode === "api-key"
    ? "Isolated OpenAI API-key broker"
    : "Isolated ChatGPT subscription broker";
  return {
    providerId,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: options.homeDir,
      CODEX_HOME: options.codexHome,
      CODEX_BROKER_CAPABILITY: options.capability,
    },
    configToml: [
      `model_provider = "${providerId}"`,
      "check_for_update_on_startup = false",
      'cli_auth_credentials_store = "file"',
      "",
      `[model_providers.${providerId}]`,
      `name = "${name}"`,
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
  assertMode(options.mode);
  assertBrokerCapability(options.capability);
  const capability = options.capability;
  const forward = options.forward;
  const target = options.mode === "api-key"
    ? "http://broker.invalid/openai/v1/responses"
    : "http://broker.invalid/codex-subscription/responses";
  return async (request) => {
    const url = new URL(request.url);
    if (
      request.method !== "POST" || url.pathname !== "/v1/responses" ||
      url.search
    ) {
      return new Response("Broker route denied\n", { status: 403 });
    }
    const headers = new Headers();
    for (
      const name of [
        "content-type",
        "accept",
        ...CODEX_SUBSCRIPTION_METADATA_HEADERS,
      ]
    ) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set("authorization", `Bearer ${capability}`);
    try {
      return await forward(
        new Request(target, {
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
  assertMode(options.mode);
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
