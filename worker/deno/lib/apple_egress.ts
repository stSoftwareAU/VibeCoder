/**
 * Apple `container` lifecycle for egress containment (Issue #4051).
 *
 * The launcher calls {@link bringUpAppleEgress} before it starts the worker
 * container. It measures what the Apple CLI can do, creates a per-launch
 * `--internal` network, starts the allowlist proxy dual-homed on the internal
 * network and the default network, runs the probes, and returns the `--network`
 * and `--env` arguments the worker needs. Every side effect is injected through
 * {@link AppleEgressDeps}, so the whole lifecycle is unit-testable on Linux.
 *
 * Fail-closed rules:
 * - `auto` downgrades to advisory only on a definitive `unsupported` verdict.
 *   An `indeterminate` check throws.
 * - A failed or regressed attempt is never returned as a success, and an
 *   internal-network launch never falls back to advisory after a failure.
 * - The stale sweep touches only `vibe-egress-<pid>` networks whose launcher
 *   pid is dead, and only the names this module derives from that pid.
 *
 * The run-argument and mount checks mirror the containment rules in
 * `container_launch.ts`, which does not export them. See
 * {@link assertAppleRunContained}.
 *
 * Australian English spelling used throughout (behaviour, normalised).
 */

import {
  type AppleCommandRunner,
  type AppleNetworkCapabilities,
  detectAppleNetworkCapabilities,
} from "./apple_container_capabilities.ts";
import { FORBIDDEN_RUN_FLAGS } from "./container_launch.ts";
import {
  CONTAINER_RUNTIMES,
  type ContainerRuntimeDescriptor,
} from "./container_runtime.ts";
import { buildMountArguments } from "./container_runtime.ts";
import {
  launcherPidFromContainerName,
  type RuntimeInvocation,
  WORKER_CONTAINER_PREFIX,
} from "./container_watchdog.ts";
import {
  buildEgressControlReport,
  deriveEgressControls,
  type EgressControlReport,
  type EgressMode,
  formatStartupReport,
  type ProbeRun,
  summariseEgressControls,
} from "./egress_controls.ts";
import {
  buildProbeEnv,
  EGRESS_PROBE_SCRIPT,
  parseProbeOutput,
  type ProbeSpec,
} from "./egress_control_probe.ts";
import type { HostEgressAllowlist } from "./egress_host_allowlist.ts";
import { EGRESS_PROXY_READY_MARKER } from "./egress_proxy.ts";
import {
  EGRESS_PROXY_ENV_NAMES,
  EGRESS_PROXY_PORT,
  egressProxyEnv,
} from "./egress_proxy_env.ts";
import { isAbsolutePath, isAtOrAbove, isRootPath } from "./host_path_style.ts";

/** Operator choice of launch mode. `auto` selects by the capability check. */
export const APPLE_EGRESS_MODE_ENV = "VIBE_APPLE_EGRESS_MODE";

/** Extra bring-up attempts after a failed one. Integer 0 to 5, default 2. */
export const APPLE_EGRESS_RECOVERY_ENV = "VIBE_APPLE_EGRESS_RECOVERY_ATTEMPTS";

/** Readiness polls of the proxy's logs. Positive integer, default 30. */
export const APPLE_EGRESS_READY_TRIES_ENV = "VIBE_APPLE_EGRESS_READY_TRIES";

/** Seconds between readiness polls. Positive number, default 1. */
export const APPLE_EGRESS_READY_INTERVAL_ENV =
  "VIBE_APPLE_EGRESS_READY_INTERVAL";

/** The report file written to the launch's report directory. */
export const APPLE_EGRESS_REPORT_FILE = "egress-controls.json";

/** The container names one launch uses, all derived from the worker's pid. */
export interface AppleEgressNames {
  /** `vibe-egress-<pid>`: the per-launch network. */
  network: string;
  /** `vibe-coder-egress-proxy-<pid>`: the allowlist proxy container. */
  proxy: string;
  /** `vibe-coder-<pid>-egress-int`: the probe on the internal network. */
  internalProbe: string;
  /** `vibe-coder-<pid>-egress-ctl`: the negative control probe. */
  controlProbe: string;
  /** The launcher pid the names were derived from. */
  pid: number;
}

/** A host-side controlled listener the probes report their nonce to. */
export interface HostListener {
  /** The bound port. */
  port: number;
  /** The host's IPv4 addresses (non-loopback, non-link-local), at most 8. */
  addresses: string[];
  /** True only for the nonce of the run being asked about. */
  seen(nonce: string): boolean;
  /** Stop listening. */
  close(): Promise<void>;
}

/** Every side effect the lifecycle performs, injected. */
export interface AppleEgressDeps {
  /** Run the `container` CLI with these arguments. */
  run(args: readonly string[], timeoutMs: number): Promise<RuntimeInvocation>;
  /** Start a listener bound to 0.0.0.0 that reads a nonce line per connection. */
  startHostListener(): Promise<HostListener>;
  /** A fresh nonce: 32 lowercase hex characters. */
  newNonce(): string;
  /** Whether a host process with this pid is alive. */
  isProcessAlive(pid: number): boolean;
  /** Wait. */
  sleep(ms: number): Promise<void>;
  /** The current time. */
  now(): Date;
  /** One line to stderr, for the operator. */
  log(line: string): void;
  /** Write a file atomically (temp file and rename) in production. */
  writeReport(path: string, text: string): Promise<void>;
  /** Run a host command such as `sw_vers`. */
  runHost(command: string, args: readonly string[]): Promise<RuntimeInvocation>;
}

/** What one launch is asked to do. */
export interface AppleEgressOptions {
  /** The Apple CLI executable, normally `container`. */
  runtime: string;
  /** The worker image. */
  image: string;
  /** The worker's container name, `vibe-coder-<launcher pid>`. */
  workerContainerName: string;
  /** Host checkout. Only `<baseDir>/worker/deno` is mounted, read-only. */
  baseDir: string;
  /** In-container checkout path (manifest.workdir). */
  workdir: string;
  /** Host home directory, for the mount-source check. */
  homeDir: string;
  /** The resolved allowlist and probe hosts. */
  allowlist: HostEgressAllowlist;
  /** The operator's mode choice. */
  mode: "auto" | "internal" | "advisory";
  /** Extra bring-up attempts after the first. */
  recoveryAttempts: number;
  /** Readiness polls of the proxy's logs. */
  readyTries: number;
  /** Milliseconds between readiness polls. */
  readyIntervalMs: number;
  /** Receives `egress-controls.json`. */
  reportDir: string;
  /** Bounds for CLI calls and probe runs. Defaults 60_000 and 120_000. */
  timeoutMs?: { cli: number; probe: number };
}

/** The arguments the worker launch needs, and the finished report. */
export interface AppleEgressUp {
  report: EgressControlReport;
  workerArgs: string[];
  attempts: number;
}

/** A failed bring-up, carrying the report when one was produced. */
export class AppleEgressError extends Error {
  report?: EgressControlReport;
  diagnostics: string[];

  constructor(
    message: string,
    diagnostics: string[] = [],
    report?: EgressControlReport,
  ) {
    super(message);
    this.name = "AppleEgressError";
    this.diagnostics = diagnostics;
    this.report = report;
  }
}

const DEFAULT_CLI_TIMEOUT_MS = 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 120_000;
const PROXY_MEMORY = "512M";
const PROBE_ATTEMPT_SECONDS = 5;
const NETWORK_DELETE_RETRY_MS = 1_000;
const PROXY_LOG_TAIL_LINES = 10;
const CAUSE_LIMIT = 200;
const WORKER_CODE_SUBDIR = "worker/deno";
const SOCKET_HINTS: readonly string[] = [
  "docker.sock",
  "podman.sock",
  "containerd.sock",
  "container.sock",
  "crio.sock",
  "docker_engine",
];
const STALE_NETWORK = /^vibe-egress-(\d+)$/;
const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const NOT_FOUND = /not ?found|does not exist|no such/i;
const NETWORK_NAME_KEYS: readonly string[] = ["network", "networkName", "name"];
const DIRECT_TARGETS = {
  literals4: ["1.1.1.1:443", "8.8.8.8:443"],
  literals6: ["[2606:4700:4700::1111]:443"],
  names: ["github.com:443"],
  dnsName: "github.com",
};
const DENIED_PROBE_HOST = "example.com";
const GIT_PROBE_URL = "https://github.com/octocat/Hello-World.git";

/** The derived names for the proxy container of one launcher pid. */
function proxyNameFor(pid: number): string {
  return `vibe-coder-egress-proxy-${pid}`;
}

/**
 * Derive every name one launch uses from the worker's container name.
 *
 * None of the derived names starts with `vibe-coder-<digits>`, so the
 * pre-launch reaper never reads them as worker containers.
 *
 * @param workerContainerName - `vibe-coder-<launcher pid>`
 * @returns The network, proxy and probe names, and the pid
 * @throws Error when the name is not a worker container name
 */
export function appleEgressNames(
  workerContainerName: string,
): AppleEgressNames {
  const pid = launcherPidFromContainerName(workerContainerName);
  if (pid === null) {
    throw new Error(
      `${workerContainerName} is not a worker container name (expected ${WORKER_CONTAINER_PREFIX}<launcher pid>)`,
    );
  }
  return {
    pid,
    network: `vibe-egress-${pid}`,
    proxy: proxyNameFor(pid),
    internalProbe: `vibe-coder-${pid}-egress-int`,
    controlProbe: `vibe-coder-${pid}-egress-ctl`,
  };
}

/**
 * Read the egress settings from the environment, failing loud on a bad value.
 *
 * @param env - The environment lookup
 * @returns The mode, recovery bound, readiness tries and interval in ms
 * @throws Error naming the variable and the value when one is malformed
 */
export function resolveAppleEgressSettings(
  env: (name: string) => string | undefined,
): {
  mode: "auto" | "internal" | "advisory";
  recoveryAttempts: number;
  readyTries: number;
  readyIntervalMs: number;
} {
  const modeText = env(APPLE_EGRESS_MODE_ENV);
  let mode: "auto" | "internal" | "advisory" = "auto";
  if (modeText !== undefined) {
    if (
      modeText !== "auto" && modeText !== "internal" &&
      modeText !== "advisory"
    ) {
      throw new Error(
        `${APPLE_EGRESS_MODE_ENV} must be auto, internal or advisory, got ${
          JSON.stringify(modeText)
        }`,
      );
    }
    mode = modeText;
  }

  const recoveryAttempts = readInteger(
    env,
    APPLE_EGRESS_RECOVERY_ENV,
    2,
    0,
    5,
  );
  const readyTries = readInteger(
    env,
    APPLE_EGRESS_READY_TRIES_ENV,
    30,
    1,
    Number.MAX_SAFE_INTEGER,
  );

  let readyIntervalMs = 1_000;
  const intervalText = env(APPLE_EGRESS_READY_INTERVAL_ENV);
  if (intervalText !== undefined) {
    const seconds = /^\d+(\.\d+)?$/.test(intervalText)
      ? Number(intervalText)
      : NaN;
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(
        `${APPLE_EGRESS_READY_INTERVAL_ENV} must be a number of seconds above zero, got ${
          JSON.stringify(intervalText)
        }`,
      );
    }
    readyIntervalMs = Math.round(seconds * 1000);
  }

  return { mode, recoveryAttempts, readyTries, readyIntervalMs };
}

/** An integer setting from `min` to `max`, or the default when unset. */
function readInteger(
  env: (name: string) => string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const text = env(name);
  if (text === undefined) return fallback;
  const value = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(
      `${name} must be an integer from ${min} to ${max}, got ${
        JSON.stringify(text)
      }`,
    );
  }
  return value;
}

/** The first non-empty line of `text`, capped for a log or error. */
function firstCauseLine(text: string): string {
  const line =
    text.split("\n").map((part) => part.trim()).find((part) => part !== "") ??
      "";
  return line.length > CAUSE_LIMIT ? line.slice(0, CAUSE_LIMIT) : line;
}

/** The last non-empty line of `text`. */
function lastCauseLine(text: string): string {
  const lines = text.split("\n").map((part) => part.trim()).filter((part) =>
    part !== ""
  );
  const line = lines[lines.length - 1] ?? "";
  return line.length > CAUSE_LIMIT ? line.slice(0, CAUSE_LIMIT) : line;
}

/** A failed invocation as one cause phrase: the exit and the first line. */
function describeFailure(inv: RuntimeInvocation): string {
  const cause = firstCauseLine(inv.stderr) || firstCauseLine(inv.stdout) ||
    "no output";
  return `exited ${inv.code}: "${cause}"`;
}

/** True when a failed invocation says its object does not exist. */
function isNotFound(inv: RuntimeInvocation): boolean {
  return inv.code !== 0 && NOT_FOUND.test(`${inv.stdout}\n${inv.stderr}`);
}

/** Error text whatever was thrown. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Throw naming the command when an invocation did not succeed. */
function mustSucceed(label: string, inv: RuntimeInvocation): RuntimeInvocation {
  if (inv.code !== 0) throw new Error(`${label} ${describeFailure(inv)}`);
  return inv;
}

/** The `--env K=V` pairs for every entry, in order. */
function envArguments(values: Record<string, string>): string[] {
  return Object.entries(values).flatMap(([name, value]) => [
    "--env",
    `${name}=${value}`,
  ]);
}

/**
 * Refuse a run argument list that would broaden the container.
 *
 * The same rules `container_launch.ts` applies to worker launches, because
 * that module does not export them: no forbidden flag, no host namespace, and
 * every `--volume` source is an absolute host path that is not the filesystem
 * root, the home directory or an ancestor of it, and not a runtime socket.
 *
 * @param argv - The complete argument list for one `run`
 * @param homeDir - The host home directory
 * @throws Error naming the offending argument
 */
export function assertAppleRunContained(
  argv: readonly string[],
  homeDir: string,
): void {
  for (const arg of argv) {
    const lower = arg.toLowerCase();
    const flag = lower.split("=")[0] ?? lower;
    if (
      FORBIDDEN_RUN_FLAGS.includes(lower) || FORBIDDEN_RUN_FLAGS.includes(flag)
    ) {
      throw new Error(
        `Refusing to launch: run arguments contain ${arg}, which broadens the container beyond its least-privilege contract (Issue #4065).`,
      );
    }
    if (lower === "host" || lower.endsWith("=host")) {
      throw new Error(
        `Refusing to launch: run arguments request host namespace/network access (${arg}).`,
      );
    }
  }
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== "--volume") continue;
    const value = argv[index + 1] ?? "";
    const parts = value.split(":");
    if (
      parts.length < 2 || parts.length > 3 ||
      (parts.length === 3 && parts[2] !== "ro")
    ) {
      throw new Error(
        `Refusing to launch: --volume ${
          JSON.stringify(value)
        } is not source:target or source:target:ro.`,
      );
    }
    const source = parts[0] ?? "";
    const target = parts[1] ?? "";
    assertMountSourcePermitted(source, homeDir);
    if (!isAbsolutePath(target, "posix") || target.includes(":")) {
      throw new Error(
        `Refusing to launch: mount target ${
          JSON.stringify(target)
        } must be an absolute container path without a colon.`,
      );
    }
  }
}

/** The mount-source rules, POSIX spelling. */
function assertMountSourcePermitted(source: string, homeDir: string): void {
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      throw new Error(
        `Mount source contains a control character: ${JSON.stringify(source)}`,
      );
    }
  }
  if (!isAbsolutePath(source, "posix") || source.includes(":")) {
    throw new Error(
      `Mount source must be an absolute host path without a colon, got: ${source}`,
    );
  }
  if (isRootPath(source, "posix")) {
    throw new Error("Refusing to mount the host filesystem root");
  }
  if (homeDir !== "" && isAtOrAbove(source, homeDir, "posix")) {
    throw new Error(
      `Refusing to mount ${source}: it is the host home directory (or an ancestor of it) (Issue #4060).`,
    );
  }
  const lower = source.toLowerCase();
  if (
    lower.endsWith(".sock") || SOCKET_HINTS.some((hint) => lower.includes(hint))
  ) {
    throw new Error(
      `Refusing to mount ${source}: a container-runtime control socket would let the worker escape its own containment (Issue #4060).`,
    );
  }
}

/** The descriptor the mount builder reads the Apple dialect from. */
function appleDescriptor(runtime: string): ContainerRuntimeDescriptor {
  const candidate = CONTAINER_RUNTIMES["apple-container"];
  return {
    platform: "darwin",
    kind: "apple-container",
    executable: runtime,
    displayName: candidate.displayName,
    dialect: candidate.dialect,
    probed: ["apple-container"],
  };
}

/** Arguments the worker needs: the network (internal mode) and the proxy env. */
function workerArgsFor(
  mode: EgressMode,
  network: string,
  proxyIp: string,
): string[] {
  const env = egressProxyEnv(proxyIp);
  const args: string[] = mode === "internal-network"
    ? ["--network", network]
    : [];
  for (const name of EGRESS_PROXY_ENV_NAMES) {
    args.push("--env", `${name}=${env[name]}`);
  }
  return args;
}

/** The capability runner: `sw_vers` on the host, the CLI through `run`. */
function capabilityRunner(
  deps: AppleEgressDeps,
  runtime: string,
  timeoutMs: number,
): AppleCommandRunner {
  return (command, args) => {
    if (command === "sw_vers") return deps.runHost(command, args);
    if (command === runtime) return deps.run(args, timeoutMs);
    return Promise.reject(new Error(`no runner for ${command}`));
  };
}

/**
 * Turn the capability verdict and the operator's choice into one mode.
 *
 * @throws AppleEgressError when internal is requested without a capable CLI,
 *   or when `auto` meets an indeterminate verdict (fail closed)
 */
function selectMode(
  requested: "auto" | "internal" | "advisory",
  caps: AppleNetworkCapabilities,
  log: (line: string) => void,
): EgressMode {
  if (requested === "internal") {
    if (caps.verdict !== "capable") {
      throw new AppleEgressError(
        `internal egress needs a capable Apple container CLI, but the capability check is ${caps.verdict}: ${
          caps.reasons.join(" ")
        }`,
        [...caps.reasons],
      );
    }
    return "internal-network";
  }
  if (requested === "advisory") {
    log(
      "[egress] warning: advisory mode chosen by the operator; direct egress is NOT blocked",
    );
    return "advisory-proxy";
  }
  if (caps.verdict === "capable") return "internal-network";
  if (caps.verdict === "unsupported") {
    log(
      "[egress] warning: this Apple container CLI cannot run an internal network, so egress falls back to advisory-proxy (direct egress is NOT blocked):",
    );
    for (const reason of caps.reasons) log(`[egress] warning: ${reason}`);
    return "advisory-proxy";
  }
  throw new AppleEgressError(
    `the Apple container capability check is indeterminate, so egress containment fails closed: ${
      caps.reasons.join(" ")
    }`,
    [...caps.reasons],
  );
}

/** Delete one container. Returns a problem sentence, or null on success. */
async function deleteContainer(
  deps: AppleEgressDeps,
  name: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const inv = await deps.run(["delete", "--force", name], timeoutMs);
    if (inv.code === 0 || isNotFound(inv)) return null;
    return `could not delete container ${name}: container delete --force ${
      describeFailure(inv)
    }`;
  } catch (error) {
    return `could not delete container ${name}: ${errorMessage(error)}`;
  }
}

/** Delete one network. Returns a problem sentence, or null on success. */
async function deleteNetwork(
  deps: AppleEgressDeps,
  name: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const inv = await deps.run(["network", "delete", name], timeoutMs);
    if (inv.code === 0 || isNotFound(inv)) return null;
    return `could not delete network ${name}: container network delete ${
      describeFailure(inv)
    }`;
  } catch (error) {
    return `could not delete network ${name}: ${errorMessage(error)}`;
  }
}

/** Log a warning line for each problem sentence. */
function warnAll(deps: AppleEgressDeps, problems: readonly string[]): void {
  for (const problem of problems) {
    deps.log(`[egress] warning: ${problem}`);
  }
}

/**
 * Remove networks left by launchers that are gone. Never throws.
 *
 * Only names matching `vibe-egress-<pid>` exactly are considered, and only when
 * the pid is not this launch's and no process with that pid is alive.
 */
async function sweepStaleNetworks(
  deps: AppleEgressDeps,
  ownPid: number,
  cliTimeoutMs: number,
): Promise<void> {
  try {
    const listing = await deps.run(
      ["network", "list", "--quiet"],
      cliTimeoutMs,
    );
    if (listing.code !== 0) {
      deps.log(
        `[egress] warning: could not list networks for the stale sweep: container network list ${
          describeFailure(listing)
        }`,
      );
      return;
    }
    for (const raw of listing.stdout.split("\n")) {
      const line = raw.trim();
      const match = STALE_NETWORK.exec(line);
      if (match === null) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === ownPid) continue;
      if (deps.isProcessAlive(pid)) continue;
      const problems: string[] = [];
      const proxyProblem = await deleteContainer(
        deps,
        proxyNameFor(pid),
        cliTimeoutMs,
      );
      if (proxyProblem !== null) problems.push(proxyProblem);
      const networkProblem = await deleteNetwork(deps, line, cliTimeoutMs);
      if (networkProblem !== null) problems.push(networkProblem);
      deps.log(
        `[egress] stale network ${line} belongs to dead launcher pid ${pid}; removing it`,
      );
      warnAll(deps, problems);
    }
  } catch (error) {
    deps.log(
      `[egress] warning: stale network sweep failed: ${errorMessage(error)}`,
    );
  }
}

/**
 * Read the proxy's IPv4 address on one network from `inspect` output.
 *
 * Walks the JSON for an object that names the network and carries an IPv4
 * string under an address-like key. A `/prefix` is stripped. Fails loud,
 * naming the keys seen, when nothing matches.
 */
export function readIpv4OnNetwork(text: string, network: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `container inspect did not return JSON, so the proxy's IPv4 on ${network} could not be read (${
        errorMessage(error)
      })`,
    );
  }
  const keys = new Set<string>();
  const found = findIpv4(parsed, network, keys);
  if (found !== null) return found;
  throw new Error(
    `could not read the proxy's IPv4 address on network ${network} from container inspect output; keys seen: ${
      [...keys].join(", ") || "none"
    }`,
  );
}

function findIpv4(
  node: unknown,
  network: string,
  keys: Set<string>,
): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findIpv4(item, network, keys);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof node !== "object" || node === null) return null;
  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) keys.add(key);
  if (NETWORK_NAME_KEYS.some((key) => record[key] === network)) {
    for (const [key, value] of Object.entries(record)) {
      if (typeof value !== "string") continue;
      if (!/address|ipv4|ipaddr/i.test(key) || /gateway/i.test(key)) continue;
      const address = value.split("/")[0] ?? "";
      if (IPV4.test(address)) return address;
    }
  }
  for (const value of Object.values(record)) {
    const found = findIpv4(value, network, keys);
    if (found !== null) return found;
  }
  return null;
}

/** The status field of the first inspected object, or null when absent. */
function statusOf(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (typeof first !== "object" || first === null) return null;
    const status = (first as Record<string, unknown>).status;
    return typeof status === "string" ? status : null;
  } catch {
    return null;
  }
}

/**
 * Poll the proxy's logs until it reports ready, or fail with the last line.
 *
 * Stops early when `inspect` says the container is no longer running.
 */
async function awaitProxyReady(
  deps: AppleEgressDeps,
  options: AppleEgressOptions,
  names: AppleEgressNames,
  cliTimeoutMs: number,
): Promise<void> {
  let lastLine = "no log output";
  for (let attempt = 1; attempt <= options.readyTries; attempt++) {
    const logs = await deps.run(["logs", names.proxy], cliTimeoutMs);
    const text = `${logs.stdout}\n${logs.stderr}`;
    if (text.includes(EGRESS_PROXY_READY_MARKER)) return;
    const last = lastCauseLine(text);
    if (last !== "") lastLine = last;
    if (attempt < options.readyTries) {
      const inspected = await deps.run(["inspect", names.proxy], cliTimeoutMs)
        .catch(() => null);
      const status = inspected !== null && inspected.code === 0
        ? statusOf(inspected.stdout)
        : null;
      if (status !== null && status.toLowerCase() !== "running") {
        throw new Error(
          `the egress proxy ${names.proxy} is not running (status ${status}); last log line: ${
            JSON.stringify(lastLine)
          }`,
        );
      }
      await deps.sleep(options.readyIntervalMs);
    }
  }
  throw new Error(
    `the egress proxy ${names.proxy} did not report ready after ${options.readyTries} tries; last log line: ${
      JSON.stringify(lastLine)
    }`,
  );
}

/** Build the proxy's `run` argument list. */
function proxyRunArgs(
  options: AppleEgressOptions,
  names: AppleEgressNames,
  mode: EgressMode,
): string[] {
  const codeSource = `${options.baseDir}/${WORKER_CODE_SUBDIR}`;
  const codeTarget = `${options.workdir}/${WORKER_CODE_SUBDIR}`;
  const mount = buildMountArguments(appleDescriptor(options.runtime), {
    source: codeSource,
    target: codeTarget,
    readOnly: true,
  });
  const networks = mode === "internal-network"
    ? ["--network", "default", "--network", names.network]
    : ["--network", "default"];
  return [
    "run",
    "--detach",
    "--name",
    names.proxy,
    ...networks,
    "--memory",
    PROXY_MEMORY,
    ...mount,
    "--env",
    `VIBE_EGRESS_ALLOW_HOSTS=${options.allowlist.allowlist.join(",")}`,
    "--entrypoint",
    "deno",
    options.image,
    "run",
    "--frozen",
    "--cached-only",
    `--lock=${codeTarget}/deno.lock`,
    "--allow-read",
    "--allow-env",
    "--allow-net",
    `${codeTarget}/mod.ts`,
    "egress-proxy",
    "--listen",
    `0.0.0.0:${EGRESS_PROXY_PORT}`,
  ];
}

/** Read a probe container's result into a ProbeRun body. */
function probeOutcome(
  inv: RuntimeInvocation,
): Pick<ProbeRun, "executed" | "error" | "observations"> {
  if (inv.code !== 0) {
    return {
      executed: false,
      error: `the probe container ${describeFailure(inv)}`,
      observations: [],
    };
  }
  let observations: ReturnType<typeof parseProbeOutput>;
  try {
    observations = parseProbeOutput(inv.stdout);
  } catch (error) {
    return {
      executed: false,
      error: errorMessage(error),
      observations: [],
    };
  }
  if (observations.length === 0) {
    return {
      executed: false,
      error: "the probe printed no observations",
      observations: [],
    };
  }
  return { executed: true, observations };
}

interface ProbeInput {
  label: "internal" | "control";
  container: string;
  network: string;
  spec: ProbeSpec;
  listener: HostListener;
  nonce: string;
  proxyEnv?: Record<string, string>;
  proxyCheck?: { allowedHost: string; deniedHost: string };
}

/**
 * Run one probe container and read its observations. Removes the container
 * in every case. A probe that cannot run is recorded as not executed, never
 * as a pass.
 */
async function runProbe(
  deps: AppleEgressDeps,
  options: AppleEgressOptions,
  input: ProbeInput,
  timeouts: { cli: number; probe: number },
): Promise<ProbeRun> {
  const env = {
    ...buildProbeEnv(input.spec),
    ...(input.proxyEnv ?? {}),
  };
  const argv = [
    "run",
    "--rm",
    "--name",
    input.container,
    "--network",
    input.network,
    ...envArguments(env),
    "--entrypoint",
    "/bin/bash",
    options.image,
    "-c",
    EGRESS_PROBE_SCRIPT,
  ];
  assertAppleRunContained(argv, options.homeDir);
  try {
    let outcome: Pick<ProbeRun, "executed" | "error" | "observations">;
    try {
      outcome = probeOutcome(await deps.run(argv, timeouts.probe));
    } catch (error) {
      outcome = {
        executed: false,
        error: `the probe container could not run: ${errorMessage(error)}`,
        observations: [],
      };
    }
    const run: ProbeRun = {
      label: input.label,
      ...outcome,
      hostSawNonce: input.listener.seen(input.nonce),
    };
    if (input.proxyCheck !== undefined) run.proxyCheck = input.proxyCheck;
    return run;
  } finally {
    const problem = await deleteContainer(
      deps,
      input.container,
      timeouts.cli,
    );
    if (problem !== null) warnAll(deps, [problem]);
  }
}

interface AttemptContext {
  deps: AppleEgressDeps;
  options: AppleEgressOptions;
  names: AppleEgressNames;
  mode: EgressMode;
  caps: AppleNetworkCapabilities;
  cliTimeoutMs: number;
  probeTimeoutMs: number;
}

interface AttemptResult {
  report: EgressControlReport;
  workerArgs: string[];
}

/**
 * One bring-up attempt: create, start, wait, read, probe, derive. Throws on
 * an infrastructure failure. A regression comes back in the report.
 */
async function runAttempt(ctx: AttemptContext): Promise<AttemptResult> {
  const { deps, options, names, mode, caps, cliTimeoutMs, probeTimeoutMs } =
    ctx;
  const internal = mode === "internal-network";

  // (a) Remove our own leftovers. A missing object is success.
  const leftovers: string[] = [];
  const proxyLeft = await deleteContainer(deps, names.proxy, cliTimeoutMs);
  if (proxyLeft !== null) leftovers.push(proxyLeft);
  const networkLeft = await deleteNetwork(deps, names.network, cliTimeoutMs);
  if (networkLeft !== null) leftovers.push(networkLeft);
  warnAll(deps, leftovers);

  // (b) The per-launch internal network.
  if (internal) {
    mustSucceed(
      "container network create",
      await deps.run(
        [
          "network",
          "create",
          "--internal",
          "--label",
          `vibe-coder.launch=${options.workerContainerName}`,
          names.network,
        ],
        cliTimeoutMs,
      ),
    );
  }

  // (c) The proxy, dual-homed in internal mode, default network first.
  const proxyArgv = proxyRunArgs(options, names, mode);
  assertAppleRunContained(proxyArgv, options.homeDir);
  mustSucceed(
    "container run (egress proxy)",
    await deps.run(proxyArgv, cliTimeoutMs),
  );

  // (d) Readiness.
  await awaitProxyReady(deps, options, names, cliTimeoutMs);

  // (e) The proxy's address on the network the probes will use.
  const wanted = internal ? names.network : "default";
  const inspected = mustSucceed(
    "container inspect",
    await deps.run(["inspect", names.proxy], cliTimeoutMs),
  );
  const proxyIp = readIpv4OnNetwork(inspected.stdout, wanted);

  // (f) Probes, with the listener open only while they run.
  const hosts = options.allowlist.probeHosts;
  const tools = [
    { name: "github", url: `https://${hosts.github}/` },
    { name: "registry", url: `https://${hosts.registry}/` },
    ...hosts.providers.map((entry) => ({
      name: `provider:${entry.provider}`,
      url: `https://${entry.host}/`,
    })),
  ];
  const proxyCheck = {
    allowedHost: hosts.github,
    deniedHost: DENIED_PROBE_HOST,
  };
  const listener = await deps.startHostListener();
  let runs: { control: ProbeRun | null; internalRun: ProbeRun };
  try {
    let control: ProbeRun | null = null;
    if (internal) {
      const controlNonce = deps.newNonce();
      control = await runProbe(deps, options, {
        label: "control",
        container: names.controlProbe,
        network: "default",
        spec: {
          timeoutSeconds: PROBE_ATTEMPT_SECONDS,
          ...DIRECT_TARGETS,
          hostAddresses: listener.addresses,
          hostPort: listener.port,
          nonce: controlNonce,
          tools: [],
        },
        listener,
        nonce: controlNonce,
      }, { cli: cliTimeoutMs, probe: probeTimeoutMs });
    }
    const internalNonce = deps.newNonce();
    const internalRun = await runProbe(deps, options, {
      label: "internal",
      container: names.internalProbe,
      network: internal ? names.network : "default",
      spec: {
        timeoutSeconds: PROBE_ATTEMPT_SECONDS,
        ...DIRECT_TARGETS,
        hostAddresses: listener.addresses,
        hostPort: listener.port,
        nonce: internalNonce,
        proxy: {
          host: proxyIp,
          port: EGRESS_PROXY_PORT,
          allowedHost: hosts.github,
          deniedHost: DENIED_PROBE_HOST,
        },
        tools,
        gitUrl: GIT_PROBE_URL,
      },
      listener,
      nonce: internalNonce,
      proxyEnv: egressProxyEnv(proxyIp),
      proxyCheck,
    }, { cli: cliTimeoutMs, probe: probeTimeoutMs });
    runs = { control, internalRun };
  } finally {
    try {
      await listener.close();
    } catch (error) {
      deps.log(
        `[egress] warning: could not close the host listener: ${
          errorMessage(error)
        }`,
      );
    }
  }

  // (g) Derive the controls and check the promises of the mode.
  const controls = deriveEgressControls(runs.internalRun, runs.control);
  const report = buildEgressControlReport({
    recordedAt: deps.now().toISOString(),
    launch: options.workerContainerName,
    runtime: {
      executable: options.runtime,
      version: caps.containerVersion,
      macos: caps.macos.version,
    },
    selectedMode: mode,
    effectiveMode: mode,
    controls,
  });
  return {
    report,
    workerArgs: workerArgsFor(mode, names.network, proxyIp),
  };
}

/** Write the report with its outcome. A failed write is a warning only. */
async function persistReport(
  deps: AppleEgressDeps,
  reportDir: string,
  report: EgressControlReport,
  outcome: "launched" | "refused",
): Promise<void> {
  const path = `${reportDir.replace(/\/+$/, "")}/${APPLE_EGRESS_REPORT_FILE}`;
  const text = `${JSON.stringify({ ...report, outcome }, null, 2)}\n`;
  try {
    await deps.writeReport(path, text);
  } catch (error) {
    deps.log(
      `[egress] warning: could not write ${path}: ${errorMessage(error)}`,
    );
  }
}

/** The last few proxy log lines, for a diagnostic. Never throws. */
async function proxyLogTail(
  deps: AppleEgressDeps,
  names: AppleEgressNames,
  cliTimeoutMs: number,
): Promise<string[]> {
  try {
    const logs = await deps.run(["logs", names.proxy], cliTimeoutMs);
    const lines = `${logs.stdout}\n${logs.stderr}`.split("\n").map((line) =>
      line.trim()
    ).filter((line) => line !== "");
    if (lines.length === 0) return ["proxy logs: none recorded"];
    return lines.slice(-PROXY_LOG_TAIL_LINES).map((line) =>
      `proxy log: ${line}`
    );
  } catch (error) {
    return [`proxy logs unavailable: ${errorMessage(error)}`];
  }
}

/**
 * Bring up egress containment for one worker launch.
 *
 * @param deps - Every side effect, injected
 * @param options - The launch's settings
 * @returns The finished report, the worker's network and proxy arguments, and
 *   the attempt count
 * @throws AppleEgressError when the mode cannot be selected, or when every
 *   attempt failed or regressed. Nothing is returned as a success on a failure.
 */
export async function bringUpAppleEgress(
  deps: AppleEgressDeps,
  options: AppleEgressOptions,
): Promise<AppleEgressUp> {
  const names = appleEgressNames(options.workerContainerName);
  const cliTimeoutMs = options.timeoutMs?.cli ?? DEFAULT_CLI_TIMEOUT_MS;
  const probeTimeoutMs = options.timeoutMs?.probe ?? DEFAULT_PROBE_TIMEOUT_MS;

  // (1) Measure the CLI and choose the mode.
  const caps = await detectAppleNetworkCapabilities(
    capabilityRunner(deps, options.runtime, cliTimeoutMs),
    options.runtime,
  );
  const mode = selectMode(options.mode, caps, (line) => deps.log(line));

  // (2) Remove networks of dead launchers. Never throws.
  await sweepStaleNetworks(deps, names.pid, cliTimeoutMs);

  // (3) Bounded attempts.
  const total = 1 + options.recoveryAttempts;
  const diagnostics: string[] = [];
  for (let attempt = 1; attempt <= total; attempt++) {
    if (attempt > 1) {
      deps.log(`[egress] bounded recovery: attempt ${attempt} of ${total}`);
    }
    const ctx: AttemptContext = {
      deps,
      options,
      names,
      mode,
      caps,
      cliTimeoutMs,
      probeTimeoutMs,
    };

    let result: AttemptResult;
    try {
      result = await runAttempt(ctx);
    } catch (error) {
      const cause = errorMessage(error);
      deps.log(
        `[egress] warning: attempt ${attempt} of ${total} failed: ${cause}`,
      );
      diagnostics.push(`attempt ${attempt} of ${total} failed: ${cause}`);
      if (attempt === total) {
        diagnostics.push(...await proxyLogTail(deps, names, cliTimeoutMs));
      }
      warnAll(
        deps,
        await tearDownAppleEgress(deps, names),
      );
      if (attempt === total) {
        throw new AppleEgressError(
          `Apple container egress containment could not be brought up after ${total} attempt(s): ${cause}`,
          diagnostics,
        );
      }
      continue;
    }

    const { report } = result;
    if (report.regressions.length === 0) {
      await persistReport(deps, options.reportDir, report, "launched");
      for (const line of formatStartupReport(report)) deps.log(line);
      deps.log(summariseEgressControls(report));
      return { report, workerArgs: result.workerArgs, attempts: attempt };
    }

    const lines = formatStartupReport(report);
    for (const line of lines) deps.log(line);
    diagnostics.push(...lines);
    const reason = report.regressions[0];
    deps.log(
      `[egress] warning: attempt ${attempt} of ${total} regressed: ${reason}`,
    );
    if (attempt < total) {
      warnAll(deps, await tearDownAppleEgress(deps, names));
      continue;
    }
    diagnostics.push(...await proxyLogTail(deps, names, cliTimeoutMs));
    warnAll(deps, await tearDownAppleEgress(deps, names));
    await persistReport(deps, options.reportDir, report, "refused");
    throw new AppleEgressError(
      `Apple container egress containment failed its promises on all ${total} attempt(s): ${reason}`,
      diagnostics,
      report,
    );
  }
  throw new AppleEgressError(
    "Apple container egress containment was not attempted",
    diagnostics,
  );
}

/**
 * Remove the proxy and its network. Never throws.
 *
 * Optionally saves the proxy's logs first. Both deletions are always attempted.
 * The network delete is retried once after a second, because the proxy may
 * still be detaching.
 *
 * @param deps - The injected side effects
 * @param names - The launch's names
 * @param options - `proxyLogPath` saves the proxy's logs before deletion
 * @returns One problem sentence per deletion that failed, empty on success
 */
export async function tearDownAppleEgress(
  deps: AppleEgressDeps,
  names: AppleEgressNames,
  options?: { proxyLogPath?: string },
): Promise<string[]> {
  const problems: string[] = [];
  if (options?.proxyLogPath !== undefined) {
    try {
      const logs = await deps.run(
        ["logs", names.proxy],
        DEFAULT_CLI_TIMEOUT_MS,
      );
      await deps.writeReport(
        options.proxyLogPath,
        `${logs.stdout}${logs.stderr}`,
      );
    } catch (error) {
      deps.log(
        `[egress] warning: could not save the proxy logs: ${
          errorMessage(error)
        }`,
      );
    }
  }
  const proxyProblem = await deleteContainer(
    deps,
    names.proxy,
    DEFAULT_CLI_TIMEOUT_MS,
  );
  if (proxyProblem !== null) problems.push(proxyProblem);

  let networkProblem = await deleteNetwork(
    deps,
    names.network,
    DEFAULT_CLI_TIMEOUT_MS,
  );
  if (networkProblem !== null) {
    try {
      await deps.sleep(NETWORK_DELETE_RETRY_MS);
    } catch {
      // A failed sleep only shortens the wait; the retry still runs.
    }
    networkProblem = await deleteNetwork(
      deps,
      names.network,
      DEFAULT_CLI_TIMEOUT_MS,
    );
  }
  if (networkProblem !== null) problems.push(networkProblem);
  return problems;
}
