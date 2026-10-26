/**
 * Bring the egress network and proxy up and down from a launch plan
 * (Issue #4047).
 *
 * `run.sh` and `run.ps1` perform the same sequence themselves — they cannot
 * import this module on the hot path. The containment suite and the tabletop
 * runner execute `plan.runArgs` directly, so they call here instead of
 * growing a second copy of the sequence. A failed create or a proxy that
 * never listens throws; the caller must not start the worker on the runtime's
 * open network.
 *
 * Australian English spelling throughout (behaviour).
 */

import { EGRESS_PROXY_LISTENING_MARKER } from "./egress_proxy.ts";

/** The slice of a launch plan this helper needs. */
export interface EgressSidecarPlan {
  runtime: string;
  egressEnforced: boolean;
  networkCreateArgs: readonly string[];
  networkRemoveArgs: readonly string[];
  networkConnectArgs: readonly string[];
  proxyRunArgs: readonly string[];
  proxyStopArgs: readonly string[];
  proxyName: string;
  proxyBundle: string;
}

/** One runtime invocation. `stdin` is the packed worker source for the proxy. */
export type EgressCommandRunner = (
  args: readonly string[],
  stdin?: Uint8Array,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface EgressSidecarOptions {
  run?: EgressCommandRunner;
  /** Pack `worker/deno` under the bundle root. Tests inject this. */
  pack?: (bundleRoot: string) => Promise<Uint8Array>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long to wait for the proxy's listening line. Default 90s. */
  readyTimeoutMs?: number;
  /** Host file that receives the proxy log on stop. */
  logFile?: string;
}

const DEFAULT_READY_MS = 90_000;
const POLL_MS = 200;

/**
 * Proxy clients started by {@link defaultRun}. `docker run -i` stays attached
 * until the container is removed; stop signals the client after `rm`.
 */
const proxyClients = new Map<string, Deno.ChildProcess>();

function assertComplete(plan: EgressSidecarPlan): void {
  if (
    plan.networkCreateArgs.length === 0 ||
    plan.networkRemoveArgs.length === 0 ||
    plan.networkConnectArgs.length === 0 ||
    plan.proxyRunArgs.length === 0 ||
    plan.proxyStopArgs.length === 0 ||
    plan.proxyName.trim() === "" ||
    plan.proxyBundle.trim() === "" ||
    plan.runtime.trim() === ""
  ) {
    throw new Error(
      "egress sidecar: the launch plan declares enforcement but is missing a network or proxy key — refusing to launch",
    );
  }
}

async function defaultPack(bundleRoot: string): Promise<Uint8Array> {
  const command = new Deno.Command("tar", {
    args: ["-C", bundleRoot, "-cf", "-", "worker/deno"],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (output.code !== 0) {
    const detail = new TextDecoder().decode(output.stderr).trim();
    throw new Error(
      `egress sidecar: could not pack worker/deno from ${bundleRoot}${
        detail === "" ? "" : ` — ${detail}`
      }`,
    );
  }
  return output.stdout;
}

function defaultRun(runtime: string): EgressCommandRunner {
  return async (args, stdin) => {
    if (args[0] === "run" && stdin !== undefined) {
      const child = new Deno.Command(runtime, {
        args: [...args],
        stdin: "piped",
        stdout: "null",
        stderr: "piped",
      }).spawn();
      const nameAt = args.indexOf("--name");
      const name = nameAt >= 0 ? args[nameAt + 1] : undefined;
      if (name) proxyClients.set(name, child);
      const writer = child.stdin.getWriter();
      await writer.write(stdin);
      await writer.close();
      return { code: 0, stdout: "", stderr: "" };
    }
    const output = await new Deno.Command(runtime, {
      args: [...args],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Remove a leftover network, create the internal one, start the proxy, and
 * connect it. Throws on any failure. A plan that does not enforce is a no-op.
 */
export async function startEgressSidecar(
  plan: EgressSidecarPlan,
  options: EgressSidecarOptions = {},
): Promise<void> {
  if (!plan.egressEnforced) return;
  assertComplete(plan);
  const run = options.run ?? defaultRun(plan.runtime);
  const pack = options.pack ?? defaultPack;
  const pause = options.sleep ?? sleep;
  const now = options.now ?? Date.now;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_MS;

  await run(plan.networkRemoveArgs);
  const created = await run(plan.networkCreateArgs);
  if (created.code !== 0) {
    throw new Error(
      `egress sidecar: could not create the internal network (exit ${created.code}) — refusing to launch. ${created.stderr.trim()}`,
    );
  }
  await run(plan.proxyStopArgs);
  const packed = await pack(plan.proxyBundle);
  const started = await run(plan.proxyRunArgs, packed);
  if (started.code !== 0) {
    throw new Error(
      `egress sidecar: the egress proxy did not start (exit ${started.code}) — refusing to launch. ${started.stderr.trim()}`,
    );
  }
  const deadline = now() + readyTimeoutMs;
  let listening = false;
  while (now() <= deadline) {
    const logs = await run(["logs", plan.proxyName]);
    const text = `${logs.stdout}\n${logs.stderr}`;
    if (text.includes(EGRESS_PROXY_LISTENING_MARKER)) {
      listening = true;
      break;
    }
    await pause(POLL_MS);
  }
  if (!listening) {
    throw new Error(
      "egress sidecar: the egress proxy did not start listening — refusing to launch",
    );
  }
  const connected = await run(plan.networkConnectArgs);
  if (connected.code !== 0) {
    throw new Error(
      `egress sidecar: could not connect the proxy to the internal network (exit ${connected.code}) — refusing to launch. ${connected.stderr.trim()}`,
    );
  }
}

/**
 * Append the proxy log, then remove the proxy and the network. A plan that
 * does not enforce is a no-op. Removal failures are returned, not thrown, so
 * a caller in a `finally` still finishes its own cleanup.
 */
export async function stopEgressSidecar(
  plan: EgressSidecarPlan,
  options: EgressSidecarOptions = {},
): Promise<string[]> {
  if (!plan.egressEnforced) return [];
  const run = options.run ?? defaultRun(plan.runtime);
  const problems: string[] = [];
  if (plan.proxyName.trim() !== "") {
    const logs = await run(["logs", plan.proxyName]);
    const text = `${logs.stdout}${logs.stderr}`;
    if (options.logFile && text !== "") {
      try {
        await Deno.writeTextFile(options.logFile, text, { append: true });
      } catch (error) {
        problems.push(
          `could not write ${options.logFile}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
  if (plan.proxyStopArgs.length > 0) {
    const stopped = await run(plan.proxyStopArgs);
    if (stopped.code !== 0) {
      problems.push(
        `could not remove the egress proxy (exit ${stopped.code})`,
      );
    }
  }
  if (plan.networkRemoveArgs.length > 0) {
    const removed = await run(plan.networkRemoveArgs);
    if (removed.code !== 0) {
      problems.push(
        `could not remove the egress network (exit ${removed.code})`,
      );
    }
  }
  const client = proxyClients.get(plan.proxyName);
  if (client) {
    proxyClients.delete(plan.proxyName);
    try {
      client.kill("SIGTERM");
    } catch {
      // The client already exited when the container was removed.
    }
  }
  return problems;
}
