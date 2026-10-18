/**
 * Native gh transport adapter for the isolated agent (#3699).
 *
 * gh's http_unix_socket config sends ordinary HTTP over an agent-local Unix
 * socket. This adapter translates its API paths to the separate broker's fixed
 * GitHub service. The broker remains the authority for methods, repositories,
 * queries and upstream credentials. Production startup has not adopted this.
 */
import { assertBrokerCapability } from "./credential_broker_policy.ts";

/** Translate native API requests without accepting an upstream host or token. */
export function createGitHubAgentGateway(options: {
  capability: string;
  forward: (request: Request) => Promise<Response>;
}): (request: Request) => Promise<Response> {
  assertBrokerCapability(options.capability);
  return async (request) => {
    const url = new URL(request.url);
    try {
      return await options.forward(
        new Request(
          `http://broker.invalid/github${url.pathname}${url.search}`,
          {
            method: request.method,
            headers: { authorization: `Bearer ${options.capability}` },
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

function assertSandboxPath(path: string): void {
  if (!/^\/[A-Za-z0-9_./-]+$/.test(path) || path.split("/").includes("..")) {
    throw new Error("GitHub agent state must use absolute sandbox paths");
  }
}

/**
 * Serve on a socket in a fresh agent-owned directory. The only forward path
 * is the fixed broker mount; no DNS, proxy environment or TCP fallback is used.
 */
export function serveGitHubAgentGateway(options: {
  capability: string;
  socketPath: string;
}): { close: () => Promise<void> } {
  assertBrokerCapability(options.capability);
  assertSandboxPath(options.socketPath);
  const client = Deno.createHttpClient({
    proxy: { transport: "unix", path: "/run/broker/broker.sock" },
  });
  let server: Deno.HttpServer<Deno.UnixAddr>;
  try {
    server = Deno.serve(
      { path: options.socketPath, onListen() {} },
      createGitHubAgentGateway({
        capability: options.capability,
        forward: (request) => fetch(request, { client }),
      }),
    );
  } catch (error) {
    client.close();
    throw error;
  }
  return {
    async close() {
      try {
        await server.shutdown();
      } finally {
        client.close();
      }
    },
  };
}

/** Fresh native CLI environment; the caller must use clearEnv: true. */
export function buildBrokeredGitHubEnvironment(options: {
  capability: string;
  homeDir: string;
  configDir: string;
}): Record<string, string> {
  assertBrokerCapability(options.capability);
  assertSandboxPath(options.homeDir);
  assertSandboxPath(options.configDir);
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: options.homeDir,
    GH_CONFIG_DIR: options.configDir,
    GH_HOST: "github.com",
    GH_TOKEN: options.capability,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    GH_TELEMETRY: "0",
  };
}

/** Write this config only inside the run's fresh, credential-free gh state. */
export function githubAgentSocketConfig(socketPath: string): string {
  assertSandboxPath(socketPath);
  return `http_unix_socket: ${JSON.stringify(socketPath)}\n`;
}
