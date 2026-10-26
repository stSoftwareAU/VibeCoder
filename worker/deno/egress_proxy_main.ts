/**
 * Foreground entry for the egress-proxy sidecar (Issue #4047).
 *
 * The image does not contain the worker source, and the proxy container has
 * no mounts, so the launcher streams `worker/deno` in on stdin and this file
 * is what `deno run` starts. It is not `mod.ts`: loading every command would
 * pull the whole worker into a process whose only job is the CONNECT proxy.
 *
 * The allowlist arrives in `VIBE_EGRESS_ALLOW_HOSTS`. `--listen` must be an
 * address the worker container can dial; the command's default of
 * `127.0.0.1` is unreachable from another container.
 */

import { parseEgressProxyArgs } from "./commands/egress_proxy.ts";
import { EGRESS_ALLOW_HOSTS_ENV } from "./commands/egress_proxy.ts";
import { startEgressProxy } from "./lib/egress_proxy.ts";
import { EGRESS_PROXY_LISTENING_MARKER } from "./lib/egress_proxy.ts";

function argsRecord(argv: readonly string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token !== "--listen" && token !== "--allow") {
      throw new Error(
        `egress-proxy: unknown argument ${JSON.stringify(token)}`,
      );
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`egress-proxy: ${token} needs a value`);
    }
    args[token.slice(2)] = value;
    i++;
  }
  return args;
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    Deno.addSignalListener("SIGTERM", done);
    Deno.addSignalListener("SIGINT", done);
  });
}

const parsed = parseEgressProxyArgs(argsRecord(Deno.args), {
  [EGRESS_ALLOW_HOSTS_ENV]: Deno.env.get(EGRESS_ALLOW_HOSTS_ENV),
});
const proxy = await startEgressProxy({
  hostname: parsed.hostname,
  port: parsed.port,
  allowlist: parsed.allowlist,
});
console.error(
  `${EGRESS_PROXY_LISTENING_MARKER} on ${proxy.addr.hostname}:${proxy.addr.port} hosts=${parsed.allowlist.length}`,
);
await waitForSignal();
await proxy.close();
