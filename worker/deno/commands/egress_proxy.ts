/**
 * `egress-proxy` — run the single outbound allowlist proxy in the foreground
 * until it is signalled (Issue #4046).
 *
 * The proxy itself lives in `lib/egress_proxy.ts`; this command only reads the
 * allowlist and listen address from the command line or the environment, starts
 * the proxy, and stops it on SIGTERM or SIGINT. It starts before any config
 * exists, so it is registered as config-optional in `mod.ts`.
 *
 * The allowlist is never read from a file or a mounted path. It comes from
 * `--allow` (comma-separated) or, when that is absent, from the environment
 * variable `VIBE_EGRESS_ALLOW_HOSTS` (comma-separated). A missing or invalid
 * allowlist is a loud failure with exit status 2, not a proxy that quietly
 * allows nothing or everything.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { parseEgressAllowlist, startEgressProxy } from "../lib/egress_proxy.ts";

/** Environment variable that supplies the allowlist when `--allow` is absent. */
export const EGRESS_ALLOW_HOSTS_ENV = "VIBE_EGRESS_ALLOW_HOSTS";

/** Listen address used when `--listen` is absent. */
export const EGRESS_PROXY_DEFAULT_LISTEN = "127.0.0.1:3128";

/** The validated inputs the command hands to the proxy. */
export interface EgressProxyArgs {
  readonly hostname: string;
  readonly port: number;
  readonly allowlist: string[];
}

/** The seams of the command: the proxy start and the wait for a stop signal. */
export interface EgressProxyCommandSeams {
  start?: typeof startEgressProxy;
  waitForStop?: () => Promise<void>;
}

export interface EgressProxyCommand extends Command {
  execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
    seams?: EgressProxyCommandSeams,
  ): Promise<CommandResult>;
}

/**
 * Resolve the allowlist and listen address from the parsed arguments and the
 * environment. Throws an Error whose message names the problem.
 */
export function parseEgressProxyArgs(
  args: Record<string, unknown>,
  env: Record<string, string | undefined>,
): EgressProxyArgs {
  const allowlist = parseEgressAllowlist(allowlistSource(args, env));
  const { hostname, port } = parseListen(args["listen"]);
  return { hostname, port, allowlist };
}

function allowlistSource(
  args: Record<string, unknown>,
  env: Record<string, string | undefined>,
): string | string[] {
  const fromArgs = args["allow"];
  if (fromArgs !== undefined) {
    if (typeof fromArgs === "string") return fromArgs;
    if (
      Array.isArray(fromArgs) && fromArgs.every((v) => typeof v === "string")
    ) {
      return fromArgs as string[];
    }
    throw new Error(
      "egress-proxy: --allow needs a comma-separated host list, for example --allow api.github.com,registry.npmjs.org",
    );
  }
  const fromEnv = env[EGRESS_ALLOW_HOSTS_ENV];
  if (fromEnv === undefined || fromEnv.trim() === "") {
    throw new Error(
      `egress-proxy: no allowlist — pass --allow <hosts> or set ${EGRESS_ALLOW_HOSTS_ENV} (the allowlist is never read from a file)`,
    );
  }
  return fromEnv;
}

function parseListen(value: unknown): { hostname: string; port: number } {
  const listen = value === undefined ? EGRESS_PROXY_DEFAULT_LISTEN : value;
  if (typeof listen !== "string") {
    throw new Error(
      "egress-proxy: --listen needs host:port, for example --listen 127.0.0.1:3128",
    );
  }
  const colon = listen.lastIndexOf(":");
  const rawHost = colon < 0 ? "" : listen.slice(0, colon);
  // Accept a bracketed IPv6 literal such as [::1]:3128 as well as a name or IPv4.
  const hostname = rawHost.replace(/^\[(.*)\]$/, "$1");
  const portText = colon < 0 ? "" : listen.slice(colon + 1);
  if (hostname === "") {
    throw new Error(
      `egress-proxy: --listen "${listen}" has no host (expected host:port)`,
    );
  }
  const port = Number(portText);
  if (
    !/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 ||
    port > 65535
  ) {
    throw new Error(
      `egress-proxy: --listen "${listen}" has an invalid port "${portText}" (expected an integer from 1 to 65535)`,
    );
  }
  return { hostname, port };
}

/** Resolve on the first SIGTERM or SIGINT. */
function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      Deno.removeSignalListener("SIGTERM", stop);
      Deno.removeSignalListener("SIGINT", stop);
      resolve();
    };
    Deno.addSignalListener("SIGTERM", stop);
    Deno.addSignalListener("SIGINT", stop);
  });
}

export const egressProxyCommand: EgressProxyCommand = {
  name: "egress-proxy",
  description:
    "Run the single outbound allowlist proxy in the foreground until signalled; allowlist from --allow or VIBE_EGRESS_ALLOW_HOSTS (Issue #4046)",
  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
    seams: EgressProxyCommandSeams = {},
  ): Promise<CommandResult> {
    let parsed: EgressProxyArgs;
    try {
      parsed = parseEgressProxyArgs(args, Deno.env.toObject());
    } catch (error) {
      return {
        success: false,
        exitCode: 2,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const start = seams.start ?? startEgressProxy;
    const waitForStop = seams.waitForStop ?? waitForSignal;

    let proxy: Awaited<ReturnType<typeof startEgressProxy>>;
    try {
      proxy = await start({
        hostname: parsed.hostname,
        port: parsed.port,
        allowlist: parsed.allowlist,
      });
    } catch (error) {
      return {
        success: false,
        exitCode: 1,
        message:
          `egress-proxy: could not start on ${parsed.hostname}:${parsed.port} — ${
            error instanceof Error ? error.message : String(error)
          }`,
      };
    }

    console.error(
      `[EGRESS_PROXY] listening on ${parsed.hostname}:${parsed.port} hosts=${parsed.allowlist.length}`,
    );
    await waitForStop();
    await proxy.close();
    return {
      success: true,
      message: `egress-proxy: stopped (${parsed.hostname}:${parsed.port})`,
    };
  },
};
