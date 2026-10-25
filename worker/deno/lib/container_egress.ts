/**
 * Per-launch egress sidecar for Docker and Podman (Issue #4047).
 *
 * The worker container used to join `--network bridge`, which gave it a route
 * to the whole outbound network and left the egress proxy (#4046) as a
 * suggestion. This module replaces that with a per-launch INTERNAL network: an
 * internal network has no default gateway, so the worker can reach nothing
 * except what shares that network with it. The one member that also sits on
 * the outbound bridge is an egress-proxy sidecar — the `egress-proxy` command
 * from the same image — and the worker's `HTTPS_PROXY` / `HTTP_PROXY` point
 * at it. The worker's only way out is therefore the allowlisting proxy.
 *
 * The sidecar's code is the bind-mounted `worker/deno` checkout, not the
 * image: the image holds only the dependencies. So the sidecar gets exactly
 * one READ-ONLY mount of `worker/deno` — code only, with no credentials,
 * configuration, state or log directory. It is spelled `--mount` rather than
 * `--volume` so the read-only flag cannot be lost to a shorthand.
 *
 * Failure is loud and closed. Any step that fails tears the sidecar and its
 * network down and throws; there is never a fallback to an open network. Apple
 * `container` has no internal network, so its dialect refuses to build a plan
 * (`egressEnforced` is false) and keeps its existing launch path.
 *
 * Imports are local only. Australian English spelling used throughout
 * (behaviour, honour, sanitise).
 */

import type { ContainerRuntimeDialect } from "./container_runtime.ts";
import { EGRESS_PROXY_READY_MARKER } from "./egress_proxy.ts";

/** Port the egress proxy listens on inside the sidecar (and the worker dials). */
export const EGRESS_PROXY_PORT = 3128;

/** Default name of the per-launch internal network the worker joins. */
export const DEFAULT_EGRESS_NETWORK_NAME = "vibe-coder-egress";

/** Default name of the egress-proxy sidecar container. */
export const DEFAULT_EGRESS_PROXY_NAME = "vibe-coder-egress-proxy";

/** Deno cache the image pre-seeds (container/Containerfile VIBE_DENO_SEED_DIR). */
export const EGRESS_PROXY_DENO_DIR = "/opt/deno-seed";

/** How many times the launcher polls the sidecar's logs for readiness. */
const DEFAULT_READY_TRIES = 30;

/** Pause between readiness polls. */
const READY_POLL_INTERVAL_MS = 1000;

/** Most log text quoted in a readiness failure. */
const MAX_LOG_EXCERPT_CHARS = 600;

/** Legal network and container names: no leading punctuation, bounded length. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Names a runtime reserves for its own networks; a sidecar must not use them. */
const RESERVED_NAMES: readonly string[] = ["host", "bridge", "none"];

/** The worker's loopback-only bypass list: the proxy is never bypassed. */
const LOOPBACK_NO_PROXY = "localhost,127.0.0.1,::1";

/**
 * Everything the launcher needs to start, use and tear down the sidecar.
 *
 * Built once by {@link buildEgressSidecarPlan}; every argv is a complete
 * runtime invocation except where a name is appended by the dialect's own
 * sub-command.
 */
export interface EgressSidecarPlan {
  /** Name of the internal network the worker joins. */
  internalNetwork: string;
  /** `NAME=value` strings for the worker's `--env`. */
  workerEnv: string[];
  /** Creates the internal network. */
  networkCreateArgs: string[];
  /** Removes the internal network. */
  networkRemoveArgs: string[];
  /** Starts the sidecar on the outbound bridge. */
  proxyRunArgs: string[];
  /** Attaches the running sidecar to the internal network. */
  proxyConnectArgs: string[];
  /** Prints the sidecar's logs. */
  proxyLogsArgs: string[];
  /** Force-removes the sidecar. */
  proxyRemoveArgs: string[];
  /** Log text that means the sidecar is listening. */
  proxyReadyMarker: string;
}

/** The outcome of one runtime invocation. */
export interface RuntimeRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one runtime invocation. Injectable so tests need no runtime installed. */
export type RuntimeRunner = (
  args: readonly string[],
) => Promise<RuntimeRunResult>;

/** Refuse to build a sidecar plan; the message names what was refused. */
function refuse(reason: string): never {
  throw new Error(`Refusing to launch: ${reason}`);
}

/** Reject a network or container name the runtime would not accept safely. */
function checkName(kind: string, name: string): void {
  if (!NAME_PATTERN.test(name)) {
    refuse(
      `the ${kind} name '${name}' must match ${NAME_PATTERN.source} ` +
        "(letters, digits, '_', '.', '-'; at most 64 characters)",
    );
  }
  if (RESERVED_NAMES.includes(name.toLowerCase())) {
    refuse(
      `the ${kind} name '${name}' is reserved by the container runtime`,
    );
  }
}

/**
 * Reject a checkout path that cannot be spelled safely in a `--mount` value.
 *
 * The mount value is comma-separated and quoted by nothing, so a comma, a
 * double quote or a control character would let the path inject extra mount
 * options. An empty path is refused for the same reason it always is.
 */
function checkMountPath(label: string, value: string): void {
  if (value.trim() === "") refuse(`the checkout ${label} is empty`);
  if (/[,"\p{Cc}]/u.test(value)) {
    refuse(
      `the checkout ${label} '${value}' contains a comma, double quote or ` +
        "control character, which the --mount value cannot carry",
    );
  }
}

/**
 * Plan the egress sidecar and its internal network for one launch.
 *
 * The sidecar gets one READ-ONLY `--mount` of the worker source (`checkout`)
 * and nothing else from the host: no `--volume`, no `--publish`, and no
 * `--rm`, so its logs survive until the launcher has read them. It runs as the
 * egress proxy with the allowlist in an environment variable, which keeps the
 * allowlist off every argv flag other than `--env`.
 *
 * @param input - The dialect, image, names, allowlist and checkout to plan for
 * @returns The plan the launcher runs in order
 * @throws {Error} `Refusing to launch: ...` when the dialect does not enforce
 *   egress, the allowlist is empty, a name is illegal or reserved, a mount path
 *   is unsafe, or the image is blank
 */
export function buildEgressSidecarPlan(input: {
  dialect: ContainerRuntimeDialect;
  image: string;
  networkName: string;
  proxyName: string;
  allowlist: readonly string[];
  checkout: { source: string; target: string };
}): EgressSidecarPlan {
  const { dialect, image, networkName, proxyName, allowlist, checkout } = input;

  if (!dialect.egressEnforced) {
    refuse(
      "this container runtime does not enforce egress (Apple container has " +
        "no internal network), so the worker cannot be confined",
    );
  }
  if (image.trim() === "") refuse("the container image name is empty");
  if (allowlist.length === 0) {
    refuse(
      "the egress allowlist is empty, so the proxy would refuse every host",
    );
  }
  checkName("network", networkName);
  checkName("proxy", proxyName);
  checkMountPath("source", checkout.source);
  checkMountPath("target", checkout.target);

  const networkMode = dialect.networkMode;
  if (networkMode === undefined) {
    refuse("the container runtime names no outbound network for the sidecar");
  }

  const proxyUrl = `http://${proxyName}:${EGRESS_PROXY_PORT}`;
  const mount =
    `type=bind,source=${checkout.source},target=${checkout.target},readonly`;
  const { target } = checkout;

  return {
    internalNetwork: networkName,
    workerEnv: [
      `HTTPS_PROXY=${proxyUrl}`,
      `https_proxy=${proxyUrl}`,
      `HTTP_PROXY=${proxyUrl}`,
      `http_proxy=${proxyUrl}`,
      `NO_PROXY=${LOOPBACK_NO_PROXY}`,
      `no_proxy=${LOOPBACK_NO_PROXY}`,
    ],
    networkCreateArgs: [...dialect.networkCreateArgs, networkName],
    networkRemoveArgs: [...dialect.networkRemoveArgs, networkName],
    proxyRunArgs: [
      "run",
      "--detach",
      "--name",
      proxyName,
      "--network",
      networkMode,
      "--memory",
      "256m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--mount",
      mount,
      "--env",
      `DENO_DIR=${EGRESS_PROXY_DENO_DIR}`,
      "--env",
      `VIBE_EGRESS_ALLOW_HOSTS=${allowlist.join(",")}`,
      "--entrypoint",
      "deno",
      image,
      "run",
      "--frozen",
      `--lock=${target}/deno.lock`,
      "--cached-only",
      "--allow-read",
      "--allow-env",
      "--allow-net",
      `${target}/mod.ts`,
      "egress-proxy",
      "--listen",
      `0.0.0.0:${EGRESS_PROXY_PORT}`,
    ],
    proxyConnectArgs: [...dialect.networkConnectArgs, networkName, proxyName],
    proxyLogsArgs: [...dialect.containerLogsArgs, proxyName],
    proxyRemoveArgs: [...dialect.containerRemoveArgs, proxyName],
    proxyReadyMarker: EGRESS_PROXY_READY_MARKER,
  };
}

/** The first non-empty line of a runtime's output, or "" when there is none. */
function firstNonEmptyLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find((line) =>
    line !== ""
  ) ?? "";
}

/** The tail of a log, trimmed and capped, for an error message. */
function logExcerpt(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_LOG_EXCERPT_CHARS) return trimmed;
  return `…${trimmed.slice(-MAX_LOG_EXCERPT_CHARS)}`;
}

/** Run one step and throw, naming it, when the runtime exits non-zero. */
async function runStep(
  run: RuntimeRunner,
  step: string,
  args: readonly string[],
): Promise<void> {
  const result = await run(args);
  if (result.code !== 0) {
    const detail = firstNonEmptyLine(result.stderr) || "(no stderr)";
    throw new Error(
      `egress sidecar: could not ${step} (exit ${result.code}): ${detail}`,
    );
  }
}

/**
 * Start the egress sidecar and wait until it is listening.
 *
 * Any leftover sidecar or network from an earlier launch is removed first on a
 * best-effort basis. Then the network is created, the sidecar started on the
 * outbound bridge and attached to the internal network, and its logs polled
 * for the ready marker. Any failure after the leftover clean-up tears the
 * sidecar and network down before the error is thrown; if that teardown also
 * fails, its error is appended, never swallowed.
 *
 * @param sidecar - The plan from {@link buildEgressSidecarPlan}
 * @param run - Runs one runtime invocation
 * @param options - Readiness tries and an injectable pause between polls
 * @throws {Error} When any step fails or the proxy never reports ready
 */
export async function startEgressSidecar(
  sidecar: EgressSidecarPlan,
  run: RuntimeRunner,
  options: {
    readyTries?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const readyTries = options.readyTries ?? DEFAULT_READY_TRIES;
  const sleep = options.sleep ?? defaultSleep;

  // Leftovers from an earlier launch are expected to be absent; their results
  // do not matter, because the create and run steps below check their own.
  await run(sidecar.proxyRemoveArgs).catch(() => undefined);
  await run(sidecar.networkRemoveArgs).catch(() => undefined);

  try {
    await runStep(
      run,
      "create the internal network",
      sidecar.networkCreateArgs,
    );
    await runStep(run, "start the egress proxy", sidecar.proxyRunArgs);
    await runStep(
      run,
      "attach the egress proxy to the internal network",
      sidecar.proxyConnectArgs,
    );
    await waitForReady(sidecar, run, readyTries, sleep);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      await stopEgressSidecar(sidecar, run);
    } catch (teardownError) {
      const teardown = teardownError instanceof Error
        ? teardownError.message
        : String(teardownError);
      throw new Error(`${reason}; teardown also failed: ${teardown}`);
    }
    throw error;
  }
}

/** Pause for `ms` milliseconds. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll the sidecar's logs until the ready marker appears or tries run out. */
async function waitForReady(
  sidecar: EgressSidecarPlan,
  run: RuntimeRunner,
  readyTries: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  let lastLog = "";
  for (let attempt = 1; attempt <= readyTries; attempt++) {
    const result = await run(sidecar.proxyLogsArgs);
    lastLog = `${result.stdout}${result.stderr}`;
    if (lastLog.includes(sidecar.proxyReadyMarker)) return;
    if (attempt < readyTries) await sleep(READY_POLL_INTERVAL_MS);
  }
  throw new Error(
    `egress sidecar: ${sidecar.proxyLogsArgs.at(-1)} never reported ready ` +
      `after ${readyTries} tries; last log: ${
        logExcerpt(lastLog) || "(empty)"
      }`,
  );
}

/**
 * Tear the egress sidecar and its network down.
 *
 * Reads the sidecar's logs first and hands any text to `appendLog`, so the
 * launcher's own log keeps what the proxy said. Then removes the sidecar and
 * the network. Every step is attempted even when an earlier one fails, and one
 * error listing every failure is thrown at the end (fail loud).
 *
 * @param sidecar - The plan from {@link buildEgressSidecarPlan}
 * @param run - Runs one runtime invocation
 * @param options - Optional sink for the sidecar's log text
 * @throws {Error} Listing every step that failed
 */
export async function stopEgressSidecar(
  sidecar: EgressSidecarPlan,
  run: RuntimeRunner,
  options: { appendLog?: (text: string) => Promise<void> } = {},
): Promise<void> {
  const failures: string[] = [];

  try {
    const logs = await run(sidecar.proxyLogsArgs);
    if (logs.code !== 0) {
      failures.push(
        `read the proxy logs (exit ${logs.code}): ${
          firstNonEmptyLine(logs.stderr) || "(no stderr)"
        }`,
      );
    }
    const text = `${logs.stdout}${logs.stderr}`.trim();
    if (text !== "" && options.appendLog) {
      await options.appendLog(text);
    }
  } catch (error) {
    failures.push(
      `read the proxy logs: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  await removeOrRecord(
    run,
    sidecar.proxyRemoveArgs,
    "remove the egress proxy",
    failures,
  );
  await removeOrRecord(
    run,
    sidecar.networkRemoveArgs,
    "remove the internal network",
    failures,
  );

  if (failures.length > 0) {
    throw new Error(
      `egress sidecar teardown failed: ${failures.join("; ")}`,
    );
  }
}

/** Run one removal, recording a failure instead of throwing. */
async function removeOrRecord(
  run: RuntimeRunner,
  args: readonly string[],
  step: string,
  failures: string[],
): Promise<void> {
  try {
    const result = await run(args);
    if (result.code !== 0) {
      failures.push(
        `${step} (exit ${result.code}): ${
          firstNonEmptyLine(result.stderr) || "(no stderr)"
        }`,
      );
    }
  } catch (error) {
    failures.push(
      `${step}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
