/**
 * Read-only native Git on agent-local loopback, forwarded solely through the
 * fixed Unix broker mount. This adapter has no GitHub credential or push mode.
 * The separate broker and network namespace remain the security boundary.
 */
import {
  assertBrokerCapability,
  GITHUB_GIT_UPSTREAM,
} from "./credential_broker_policy.ts";

/** Translate native read RPCs; never accept a caller-selected upstream. */
export function createGitAgentGateway(options: {
  capability: string;
  forward: (request: Request) => Promise<Response>;
}): (request: Request) => Promise<Response> {
  assertBrokerCapability(options.capability);
  return async (request) => {
    const url = new URL(request.url);
    const path =
      /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(info\/refs|git-upload-pack)$/
        .exec(url.pathname);
    if (!path || url.hash) {
      return new Response("Git read route denied\n", { status: 403 });
    }
    const endpoint = path[3]!;
    const discovery = endpoint === "info/refs";
    if (
      discovery
        ? request.method !== "GET" || url.search !== "?service=git-upload-pack"
        : request.method !== "POST" || url.search !== ""
    ) {
      return new Response("Git read route denied\n", { status: 403 });
    }
    const repo = path[2]!.endsWith(".git") ? path[2]! : `${path[2]}.git`;
    const headers = new Headers();
    for (const name of ["git-protocol", "content-type", "content-encoding"]) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set("authorization", `Bearer ${options.capability}`);
    try {
      const response = await options.forward(
        new Request(
          `http://broker.invalid/git/${
            path[1]
          }/${repo}/${endpoint}${url.search}`,
          {
            method: request.method,
            headers,
            body: request.body,
            redirect: "manual",
            signal: request.signal,
          },
        ),
      );
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return new Response("Git broker redirect denied\n", { status: 502 });
      }
      return response;
    } catch {
      return new Response("Git broker transport unavailable\n", {
        status: 502,
      });
    }
  };
}

/** Bind only ephemeral IPv4 loopback; the only outbound client uses the UDS. */
export function serveGitAgentGateway(options: { capability: string }): {
  baseUrl: string;
  close: () => Promise<void>;
} {
  assertBrokerCapability(options.capability);
  const client = Deno.createHttpClient({
    proxy: { transport: "unix", path: "/run/broker/broker.sock" },
  });
  let server: Deno.HttpServer<Deno.NetAddr>;
  try {
    server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      createGitAgentGateway({
        capability: options.capability,
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

/** Native Git URL rewrite and closed transports in a fresh config file. */
export function gitAgentReadConfig(baseUrl: string): string {
  const base = new URL(baseUrl);
  if (
    base.protocol !== "http:" || base.hostname !== "127.0.0.1" || !base.port ||
    base.username || base.password || base.pathname !== "/" || base.search ||
    base.hash
  ) {
    throw new Error(
      "Git agent gateway must be an explicit local loopback port",
    );
  }
  return `[url "${base.origin}/"]\n\tinsteadOf = ${GITHUB_GIT_UPSTREAM}/\n` +
    "[credential]\n\thelper =\n\tinteractive = false\n" +
    "[http]\n\tfollowRedirects = false\n\tproxy =\n" +
    '[protocol]\n\tallow = never\n[protocol "http"]\n\tallow = always\n';
}

/** Caller must use clearEnv:true and newly provisioned credential-free paths. */
export function buildBrokeredGitEnvironment(options: {
  homeDir: string;
  configFile: string;
}): Record<string, string> {
  for (const path of [options.homeDir, options.configFile]) {
    if (!/^\/[A-Za-z0-9_./-]+$/.test(path) || path.split("/").includes("..")) {
      throw new Error("Git agent state must use absolute sandbox paths");
    }
  }
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: options.homeDir,
    GIT_CONFIG_GLOBAL: options.configFile,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}
