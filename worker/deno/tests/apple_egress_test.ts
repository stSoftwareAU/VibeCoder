/**
 * Tests for the Apple `container` egress lifecycle (Issue #4051).
 *
 * Every side effect is a fake: a scripted CLI that answers by subcommand and
 * records each argument list, a host listener whose `seen` is true only for
 * the nonce a fake probe reported, and recorded log and report writes. The
 * tests check exact argument lists, the mode table, the bounded retries, the
 * fail-closed rules, and that nothing is returned as a success on a failure.
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  APPLE_EGRESS_MODE_ENV,
  APPLE_EGRESS_READY_INTERVAL_ENV,
  APPLE_EGRESS_READY_TRIES_ENV,
  APPLE_EGRESS_RECOVERY_ENV,
  APPLE_EGRESS_REPORT_FILE,
  type AppleEgressDeps,
  AppleEgressError,
  appleEgressNames,
  type AppleEgressOptions,
  assertAppleRunContained,
  bringUpAppleEgress,
  type HostListener,
  readIpv4OnNetwork,
  resolveAppleEgressSettings,
  tearDownAppleEgress,
} from "../lib/apple_egress.ts";
import { launcherPidFromContainerName } from "../lib/container_watchdog.ts";
import {
  EGRESS_MODE_LABELS,
  type EgressControlReport,
} from "../lib/egress_controls.ts";
import { EGRESS_PROBE_SCRIPT } from "../lib/egress_control_probe.ts";
import type { HostEgressAllowlist } from "../lib/egress_host_allowlist.ts";
import { EGRESS_PROXY_READY_MARKER } from "../lib/egress_proxy.ts";
import type { RuntimeInvocation } from "../lib/container_watchdog.ts";

const WORKER = "vibe-coder-42";
const NET = "vibe-egress-42";
const PROXY = "vibe-coder-egress-proxy-42";
const INT_PROBE = "vibe-coder-42-egress-int";
const CTL_PROBE = "vibe-coder-42-egress-ctl";
const IMAGE = "vibe-worker:latest";
const BASE = "/Users/op/vibe";
const WORKDIR = "/work/checkout";
const HOME = "/Users/op";
const REPORT_DIR = "/Users/op/vibe/reports";
const REPORT_PATH = `${REPORT_DIR}/${APPLE_EGRESS_REPORT_FILE}`;
const PROXY_IP_INTERNAL = "192.168.64.9";
const PROXY_IP_DEFAULT = "192.168.65.9";

const ALLOWLIST: HostEgressAllowlist = {
  allowlist: ["api.github.com", "registry.npmjs.org", "api.example.test"],
  probeHosts: {
    github: "api.github.com",
    registry: "registry.npmjs.org",
    providers: [{ provider: "example", host: "api.example.test" }],
  },
};

function lines(...rows: string[]): string {
  return `${rows.join("\n")}\n`;
}

/** The negative control: direct connections succeed, and the host saw it. */
const CONTROL_GOOD = lines(
  "net 192.168.65.5 192.168.65.1 yes",
  "tcp literal4 1.1.1.1:443 ok",
  "tcp literal4 8.8.8.8:443 ok",
  "tcp literal6 [2606:4700:4700::1111]:443 ok",
  "tcp name4 github.com:443 ok",
  "dns github.com ok",
);

/** The internal probe, containment working: direct attempts fail, proxy enforces. */
const INTERNAL_GOOD = lines(
  "net 192.168.64.3 192.168.64.1 no",
  "tcp literal4 1.1.1.1:443 timeout",
  "tcp literal4 8.8.8.8:443 timeout",
  "tcp literal6 [2606:4700:4700::1111]:443 timeout",
  "tcp name4 github.com:443 timeout",
  "tcp host 192.168.1.20:45678 timeout",
  "dns github.com fail",
  "connect api.github.com 200 none",
  "connect example.com 403 not-allowlisted",
  "tool github ok HTTP200",
  "tool registry ok HTTP200",
  "tool provider:example ok HTTP200",
  "tool git ok ls-remote",
);

/** The internal probe with a direct IPv4 connection that succeeded: a regression. */
const INTERNAL_BAD = INTERNAL_GOOD.replace(
  "tcp literal4 1.1.1.1:443 timeout",
  "tcp literal4 1.1.1.1:443 ok",
);

/** The advisory probe on the default network: direct egress is not blocked. */
const ADVISORY_GOOD = INTERNAL_GOOD.replace(
  "tcp literal4 1.1.1.1:443 timeout",
  "tcp literal4 1.1.1.1:443 ok",
).replace(
  "net 192.168.64.3 192.168.64.1 no",
  "net 192.168.65.5 192.168.65.1 yes",
);

const CAPABLE_HELP_CREATE =
  "USAGE: container network create [--internal] [--label <label>] <name>\n";
const CAPABLE_HELP_RUN =
  "USAGE: container run [--network <network>] [--detach] [--name <name>]\n";

type Invocation = RuntimeInvocation;

function ok(stdout = ""): Invocation {
  return { code: 0, stdout, stderr: "" };
}

function fail(stderr: string, code = 1): Invocation {
  return { code, stdout: "", stderr };
}

/** What the scripted CLI and listener answer. Every field has a default. */
interface Script {
  /** `sw_vers -productVersion`; null makes the read exit 1. */
  macos?: string | null;
  /** Networks that exist before the launch. */
  networks?: string[];
  /** Containers that exist before the launch. */
  containers?: string[];
  /** Shape of `inspect`: `modern` uses ipv4Address, `legacy` uses address. */
  inspectStyle?: "modern" | "legacy";
  /** Replaces the whole `inspect` output. */
  inspectJson?: string;
  /** The status `inspect` reports. */
  inspectStatus?: string;
  /** The 1-based `logs` call on which the ready marker appears. */
  logsReadyAt?: number;
  /** Log lines printed before the marker. */
  logLines?: string[];
  /** How many `network create` calls fail before one succeeds. */
  createFailures?: number;
  /** The stderr of a failed `network create`. */
  createStderr?: string;
  /** Replaces the `network list --quiet` answer. */
  networkList?: Invocation;
  /** The negative control probe's answer. */
  control?: Invocation;
  /** The internal probe's answer. */
  internal?: Invocation;
  /** Whether the host listener saw the negative control's nonce. */
  controlReached?: boolean;
  /** Whether the host listener saw the internal probe's nonce. */
  internalReached?: boolean;
  /** Whether reading the listener throws. */
  listenerSeenThrows?: boolean;
  /** The macOS release is a capable one unless the test says otherwise. */
  helpFlags?: boolean;
}

/** A scripted Apple CLI that answers by subcommand and records every call. */
class FakeApple {
  readonly calls: string[][] = [];
  readonly networks: Set<string>;
  readonly containers: Set<string>;
  readonly reached = new Set<string>();
  logsCalls = 0;
  private createFailures: number;

  constructor(readonly script: Script) {
    this.networks = new Set(script.networks ?? []);
    this.containers = new Set(script.containers ?? []);
    this.createFailures = script.createFailures ?? 0;
  }

  run(args: readonly string[]): Promise<Invocation> {
    return Promise.resolve(this.answer([...args]));
  }

  runHost(command: string, args: readonly string[]): Promise<Invocation> {
    this.calls.push([command, ...args]);
    if (this.script.macos === null) return Promise.resolve(fail("no sw_vers"));
    return Promise.resolve(ok(`${this.script.macos ?? "26.0.1"}\n`));
  }

  /** The `network create` calls, excluding the capability probe's `--help`. */
  networkCreates(): string[][] {
    return this.calls.filter((call) =>
      call[0] === "network" && call[1] === "create" && call[2] !== "--help"
    );
  }

  /** The calls whose argument list starts with `prefix`. */
  callsStartingWith(...prefix: string[]): string[][] {
    return this.calls.filter((call) =>
      prefix.every((word, index) => call[index] === word)
    );
  }

  private answer(argv: string[]): Invocation {
    this.calls.push(argv);
    const [first, second] = argv;
    if (first === "--version") {
      return ok("container CLI version 1.2.2 (build: release)\n");
    }
    if (first === "network" && second === "create" && argv[2] === "--help") {
      return ok(
        this.script.helpFlags === false
          ? "USAGE: container network create <name>\n"
          : CAPABLE_HELP_CREATE,
      );
    }
    if (first === "run" && second === "--help") {
      return ok(
        this.script.helpFlags === false
          ? "USAGE: container run <image>\n"
          : CAPABLE_HELP_RUN,
      );
    }
    if (first === "network" && second === "list") {
      return this.script.networkList ??
        ok(`${[...this.networks].join("\n")}\n`);
    }
    if (first === "network" && second === "create") {
      if (this.createFailures > 0) {
        this.createFailures--;
        return fail(this.script.createStderr ?? "boom");
      }
      const name = argv[argv.length - 1] ?? "";
      this.networks.add(name);
      return ok(`${name}\n`);
    }
    if (first === "network" && second === "delete") {
      const name = argv[2] ?? "";
      if (this.networks.delete(name)) return ok();
      return fail(`network ${name} not found`);
    }
    if (first === "delete") {
      const name = argv[argv.length - 1] ?? "";
      if (this.containers.delete(name)) return ok();
      return fail(`container ${name} not found`);
    }
    if (first === "run" && second === "--detach") {
      this.containers.add(valueAfter(argv, "--name"));
      return ok("proxy-container-id\n");
    }
    if (first === "run" && second === "--rm") {
      const name = valueAfter(argv, "--name");
      const env = envOf(argv);
      const isControl = name === CTL_PROBE;
      const reached = isControl
        ? this.script.controlReached ?? true
        : this.script.internalReached ?? false;
      if (reached && env.PROBE_NONCE !== undefined) {
        this.reached.add(env.PROBE_NONCE);
      }
      return isControl
        ? this.script.control ?? ok(CONTROL_GOOD)
        : this.script.internal ?? ok(INTERNAL_GOOD);
    }
    if (first === "logs") {
      this.logsCalls++;
      const text = [...(this.script.logLines ?? [])];
      if (this.logsCalls >= (this.script.logsReadyAt ?? 1)) {
        text.push(`${EGRESS_PROXY_READY_MARKER} on 0.0.0.0:3128 hosts=3`);
      }
      return ok(lines(...text));
    }
    if (first === "inspect") {
      const name = argv[1] ?? "";
      if (!this.containers.has(name)) {
        return fail(`container ${name} not found`);
      }
      return ok(this.inspectText());
    }
    return fail(`unexpected invocation: ${argv.join(" ")}`);
  }

  private inspectText(): string {
    if (this.script.inspectJson !== undefined) return this.script.inspectJson;
    const status = this.script.inspectStatus ?? "running";
    const legacy = this.script.inspectStyle === "legacy";
    const networks = legacy
      ? [
        {
          name: "default",
          address: `${PROXY_IP_DEFAULT}/24`,
          gateway: "192.168.65.1",
        },
        {
          name: NET,
          address: `${PROXY_IP_INTERNAL}/24`,
          gateway: "192.168.64.1",
        },
      ]
      : [
        {
          network: "default",
          ipv4Address: `${PROXY_IP_DEFAULT}/24`,
          ipv4Gateway: "192.168.65.1",
        },
        {
          network: NET,
          ipv4Address: `${PROXY_IP_INTERNAL}/24`,
          ipv4Gateway: "192.168.64.1",
        },
      ];
    return JSON.stringify([{ name: PROXY, status, networks }]);
  }
}

/** A listener that reports the nonces the fake probes reached. */
class FakeListener implements HostListener {
  readonly port = 45678;
  readonly addresses = ["192.168.1.20", "10.0.0.5"];
  closed = 0;

  constructor(private readonly apple: FakeApple) {}

  seen(nonce: string): boolean {
    if (this.apple.script.listenerSeenThrows) {
      throw new Error("listener read failed");
    }
    return this.apple.reached.has(nonce);
  }

  close(): Promise<void> {
    this.closed++;
    return Promise.resolve();
  }
}

/** The value after a flag in an argument list. */
function valueAfter(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  return index === -1 ? "" : args[index + 1] ?? "";
}

/** The `--env K=V` pairs of an argument list. */
function envOf(args: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "--env") continue;
    const pair = args[index + 1] ?? "";
    const at = pair.indexOf("=");
    env[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return env;
}

interface Harness {
  deps: AppleEgressDeps;
  apple: FakeApple;
  logs: string[];
  writes: Array<{ path: string; text: string }>;
  sleeps: number[];
  listeners: FakeListener[];
}

/** Build the injected dependencies around a scripted CLI. */
function harness(
  script: Script = {},
  alive: number[] = [],
  overrides: Partial<AppleEgressDeps> = {},
): Harness {
  const apple = new FakeApple(script);
  const logs: string[] = [];
  const writes: Array<{ path: string; text: string }> = [];
  const sleeps: number[] = [];
  const listeners: FakeListener[] = [];
  let nonces = 0;
  const deps: AppleEgressDeps = {
    run: (args) => apple.run(args),
    startHostListener: () => {
      const listener = new FakeListener(apple);
      listeners.push(listener);
      return Promise.resolve(listener);
    },
    newNonce: () => (++nonces).toString(16).padStart(32, "0"),
    isProcessAlive: (pid) => alive.includes(pid),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    now: () => new Date("2026-10-26T00:00:00.000Z"),
    log: (line) => {
      logs.push(line);
    },
    writeReport: (path, text) => {
      writes.push({ path, text });
      return Promise.resolve();
    },
    runHost: (command, args) => apple.runHost(command, args),
    ...overrides,
  };
  return { deps, apple, logs, writes, sleeps, listeners };
}

function options(
  overrides: Partial<AppleEgressOptions> = {},
): AppleEgressOptions {
  return {
    runtime: "container",
    image: IMAGE,
    workerContainerName: WORKER,
    baseDir: BASE,
    workdir: WORKDIR,
    homeDir: HOME,
    allowlist: ALLOWLIST,
    mode: "auto",
    recoveryAttempts: 2,
    readyTries: 3,
    readyIntervalMs: 0,
    reportDir: REPORT_DIR,
    timeoutMs: { cli: 1000, probe: 1000 },
    ...overrides,
  };
}

const isProxyRun = (args: readonly string[]) =>
  args[0] === "run" && args[1] === "--detach";
const isProbeRun = (args: readonly string[]) =>
  args[0] === "run" && args[1] === "--rm";

/** The complete argument list of the internal network create. */
const EXPECTED_NETWORK_CREATE = [
  "network",
  "create",
  "--internal",
  "--label",
  `vibe-coder.launch=${WORKER}`,
  NET,
];

/** The complete proxy argument list for an internal-network launch. */
function expectedProxyRunInternal(): string[] {
  return [
    "run",
    "--detach",
    "--name",
    PROXY,
    "--network",
    "default",
    "--network",
    NET,
    "--memory",
    "512M",
    "--volume",
    `${BASE}/worker/deno:${WORKDIR}/worker/deno:ro`,
    "--env",
    "VIBE_EGRESS_ALLOW_HOSTS=api.github.com,registry.npmjs.org,api.example.test",
    "--entrypoint",
    "deno",
    IMAGE,
    "run",
    "--frozen",
    "--cached-only",
    `--lock=${WORKDIR}/worker/deno/deno.lock`,
    "--allow-read",
    "--allow-env",
    "--allow-net",
    `${WORKDIR}/worker/deno/mod.ts`,
    "egress-proxy",
    "--listen",
    "0.0.0.0:3128",
  ];
}

/** The worker arguments for a proxy at `ip`, with or without the internal network. */
function expectedWorkerArgs(ip: string, internal: boolean): string[] {
  const proxy = `http://${ip}:3128`;
  return [
    ...(internal ? ["--network", NET] : []),
    "--env",
    `HTTPS_PROXY=${proxy}`,
    "--env",
    `HTTP_PROXY=${proxy}`,
    "--env",
    `https_proxy=${proxy}`,
    "--env",
    `http_proxy=${proxy}`,
    "--env",
    "NO_PROXY=localhost,127.0.0.1,::1",
    "--env",
    "no_proxy=localhost,127.0.0.1,::1",
  ];
}

async function persistedOutcome(
  writes: Array<{ path: string; text: string }>,
): Promise<{ outcome: string; report: EgressControlReport }> {
  const write = writes.find((entry) => entry.path === REPORT_PATH);
  assert(write, `no report written to ${REPORT_PATH}`);
  const parsed = JSON.parse(write.text);
  return { outcome: parsed.outcome, report: parsed };
}

// ---------------------------------------------------------------------------
// Names and reaper safety
// ---------------------------------------------------------------------------

Deno.test("appleEgressNames derives every name from the worker pid", () => {
  assertEquals(appleEgressNames(WORKER), {
    pid: 42,
    network: NET,
    proxy: PROXY,
    internalProbe: INT_PROBE,
    controlProbe: CTL_PROBE,
  });
});

Deno.test("derived names are never read as worker containers and are container-name valid", () => {
  const names = appleEgressNames(WORKER);
  const containerNameRe = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
  for (const name of [names.proxy, names.internalProbe, names.controlProbe]) {
    assertEquals(launcherPidFromContainerName(name), null, name);
  }
  assertEquals(launcherPidFromContainerName(NET), null);
  assertFalse(NET.startsWith("vibe-coder-"));
  for (
    const name of [
      names.network,
      names.proxy,
      names.internalProbe,
      names.controlProbe,
    ]
  ) {
    assertMatch(name, containerNameRe);
  }
});

Deno.test("appleEgressNames refuses a name that is not a worker container", () => {
  for (
    const bad of ["not-a-worker", "vibe-coder-", "vibe-coder-0", "vibe-coder-x"]
  ) {
    assertRejectsSync(() => appleEgressNames(bad), bad);
  }
});

function assertRejectsSync(fn: () => unknown, label: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, `expected ${label} to be refused`);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

Deno.test("resolveAppleEgressSettings uses the defaults when nothing is set", () => {
  assertEquals(resolveAppleEgressSettings(() => undefined), {
    mode: "auto",
    recoveryAttempts: 2,
    readyTries: 30,
    readyIntervalMs: 1000,
  });
});

Deno.test("resolveAppleEgressSettings accepts every legal value", () => {
  const env: Record<string, string> = {
    [APPLE_EGRESS_MODE_ENV]: "advisory",
    [APPLE_EGRESS_RECOVERY_ENV]: "5",
    [APPLE_EGRESS_READY_TRIES_ENV]: "7",
    [APPLE_EGRESS_READY_INTERVAL_ENV]: "0.5",
  };
  assertEquals(resolveAppleEgressSettings((name) => env[name]), {
    mode: "advisory",
    recoveryAttempts: 5,
    readyTries: 7,
    readyIntervalMs: 500,
  });
  const internalEnv = new Map([[APPLE_EGRESS_MODE_ENV, "internal"]]);
  assertEquals(
    resolveAppleEgressSettings((name) => internalEnv.get(name)).mode,
    "internal",
  );
});

Deno.test("resolveAppleEgressSettings refuses each bad value, naming the variable", () => {
  const cases: Array<[string, string]> = [
    [APPLE_EGRESS_MODE_ENV, "on"],
    [APPLE_EGRESS_MODE_ENV, ""],
    [APPLE_EGRESS_MODE_ENV, "Auto"],
    [APPLE_EGRESS_RECOVERY_ENV, "6"],
    [APPLE_EGRESS_RECOVERY_ENV, "-1"],
    [APPLE_EGRESS_RECOVERY_ENV, "1.5"],
    [APPLE_EGRESS_RECOVERY_ENV, "two"],
    [APPLE_EGRESS_READY_TRIES_ENV, "0"],
    [APPLE_EGRESS_READY_TRIES_ENV, "x"],
    [APPLE_EGRESS_READY_INTERVAL_ENV, "0"],
    [APPLE_EGRESS_READY_INTERVAL_ENV, "-2"],
    [APPLE_EGRESS_READY_INTERVAL_ENV, "soon"],
  ];
  for (const [name, value] of cases) {
    const error = assertThrowsReturn(() =>
      resolveAppleEgressSettings((key) => (key === name ? value : undefined))
    );
    assertStringIncludes(error.message, name);
    assertStringIncludes(error.message, JSON.stringify(value));
  }
});

function assertThrowsReturn(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a throw");
}

// ---------------------------------------------------------------------------
// Mode selection
// ---------------------------------------------------------------------------

Deno.test("auto with a capable CLI selects the internal network", async () => {
  const h = harness();
  const up = await bringUpAppleEgress(h.deps, options());
  assertEquals(up.report.selectedMode, "internal-network");
  assertEquals(up.report.effectiveMode, "internal-network");
  assertEquals(h.apple.networkCreates().length, 1);
});

Deno.test("auto with an unsupported CLI falls back to advisory, loudly", async () => {
  const h = harness({ macos: "15.6" });
  const up = await bringUpAppleEgress(h.deps, options());
  assertEquals(up.report.selectedMode, "advisory-proxy");
  assertEquals(h.apple.networkCreates().length, 0);
  const warnings = h.logs.filter((line) =>
    line.startsWith("[egress] warning:")
  );
  assert(
    warnings.some((line) =>
      line.includes("macOS 15.6 is below the required 26")
    ),
    "the unsupported reasons are logged as warnings",
  );
});

Deno.test("auto with an indeterminate check fails closed and starts nothing", async () => {
  const h = harness({ macos: null });
  const error = await assertRejects(
    () => bringUpAppleEgress(h.deps, options()),
    AppleEgressError,
    "fails closed",
  );
  assertEquals(error.report, undefined);
  assertEquals(h.apple.callsStartingWith("run", "--detach").length, 0);
  assertEquals(h.apple.networkCreates().length, 0);
});

Deno.test("internal with an unsupported CLI throws, naming the reasons", async () => {
  const h = harness({ macos: "15.6" });
  const error = await assertRejects(
    () => bringUpAppleEgress(h.deps, options({ mode: "internal" })),
    AppleEgressError,
    "internal egress needs a capable Apple container CLI",
  );
  assertStringIncludes(error.message, "macOS 15.6 is below the required 26");
  assertEquals(h.apple.callsStartingWith("run", "--detach").length, 0);
});

Deno.test("internal with an indeterminate check throws", async () => {
  const h = harness({ macos: null });
  await assertRejects(
    () => bringUpAppleEgress(h.deps, options({ mode: "internal" })),
    AppleEgressError,
    "internal egress needs a capable",
  );
});

Deno.test("advisory runs advisory even on a capable CLI, and says the operator chose it", async () => {
  const h = harness({ internal: ok(ADVISORY_GOOD) });
  const up = await bringUpAppleEgress(h.deps, options({ mode: "advisory" }));
  assertEquals(up.report.selectedMode, "advisory-proxy");
  assertEquals(h.apple.networkCreates().length, 0);
  assert(
    h.logs.some((line) =>
      line.includes("advisory mode chosen by the operator")
    ),
  );
});

Deno.test("advisory proceeds on an indeterminate check, because it never promises containment", async () => {
  const h = harness({ macos: null, internal: ok(ADVISORY_GOOD) });
  const up = await bringUpAppleEgress(h.deps, options({ mode: "advisory" }));
  assertEquals(up.report.selectedMode, "advisory-proxy");
});

// ---------------------------------------------------------------------------
// Argument exactness
// ---------------------------------------------------------------------------

Deno.test("network create is exactly the internal, labelled, per-launch network", async () => {
  const h = harness();
  await bringUpAppleEgress(h.deps, options());
  const creates = h.apple.networkCreates();
  assertEquals(creates, [EXPECTED_NETWORK_CREATE]);
});

Deno.test("proxy run is exactly the expected argument list, with default before the internal network", async () => {
  const h = harness();
  await bringUpAppleEgress(h.deps, options());
  const runs = h.apple.calls.filter(isProxyRun);
  assertEquals(runs.length, 1);
  const argv = runs[0] ?? [];
  assertEquals(argv, expectedProxyRunInternal());
  const networkValues = argv.flatMap((arg, index) =>
    arg === "--network" ? [argv[index + 1]] : []
  );
  assertEquals(networkValues, ["default", NET]);
  assertFalse(argv.includes("--publish"));
  assertFalse(argv.includes("-p"));
  assertEquals(argv.filter((arg) => arg === "--volume").length, 1);
});

Deno.test("advisory proxy run attaches to the default network only", async () => {
  const h = harness({ internal: ok(ADVISORY_GOOD) });
  await bringUpAppleEgress(h.deps, options({ mode: "advisory" }));
  const argv = h.apple.calls.find(isProxyRun) ?? [];
  assertEquals(argv.filter((arg) => arg === "--network"), ["--network"]);
  assertEquals(argv[argv.indexOf("--network") + 1], "default");
  assertFalse(argv.includes(NET));
});

Deno.test("the internal probe is on the internal network, the control on the default one", async () => {
  const h = harness();
  await bringUpAppleEgress(h.deps, options());
  const probes = h.apple.calls.filter(isProbeRun);
  assertEquals(probes.length, 2);
  const control = probes.find((argv) =>
    valueAfter(argv, "--name") === CTL_PROBE
  );
  const internal = probes.find((argv) =>
    valueAfter(argv, "--name") === INT_PROBE
  );
  assert(control && internal);
  assertEquals(valueAfter(control, "--network"), "default");
  assertEquals(valueAfter(internal, "--network"), NET);
  // The negative control has no proxy and no tools.
  const controlEnv = envOf(control);
  assertEquals(controlEnv.PROBE_PROXY, "");
  assertEquals(controlEnv.PROBE_TOOLS, "");
  assertFalse("HTTPS_PROXY" in controlEnv);
  // The internal probe carries the proxy as the worker will see it.
  const internalEnv = envOf(internal);
  assertEquals(internalEnv.HTTPS_PROXY, `http://${PROXY_IP_INTERNAL}:3128`);
  assertEquals(internalEnv.PROBE_PROXY, `${PROXY_IP_INTERNAL}:3128`);
  assertEquals(internalEnv.PROBE_ALLOW_HOST, "api.github.com");
  assertEquals(internalEnv.PROBE_DENY_HOST, "example.com");
  assertEquals(internalEnv.PROBE_HOSTS, "192.168.1.20 10.0.0.5");
  assertEquals(internalEnv.PROBE_HOST_PORT, "45678");
  assertMatch(internalEnv.PROBE_NONCE ?? "", /^[0-9a-f]{32}$/);
  for (const argv of [control, internal]) {
    assertEquals(argv.at(-1), EGRESS_PROBE_SCRIPT);
    assertFalse(argv.includes("--publish"));
  }
});

Deno.test("advisory probes run on the default network with no control run", async () => {
  const h = harness({ internal: ok(ADVISORY_GOOD) });
  const up = await bringUpAppleEgress(h.deps, options({ mode: "advisory" }));
  const probes = h.apple.calls.filter(isProbeRun);
  assertEquals(probes.length, 1);
  assertEquals(valueAfter(probes[0] ?? [], "--name"), INT_PROBE);
  assertEquals(valueAfter(probes[0] ?? [], "--network"), "default");
  assertFalse(up.report.controls.negativeControl.executed);
});

Deno.test("worker args for internal mode are the network and all six proxy variables", async () => {
  const h = harness();
  const up = await bringUpAppleEgress(h.deps, options());
  assertEquals(up.workerArgs, expectedWorkerArgs(PROXY_IP_INTERNAL, true));
  assertEquals(up.attempts, 1);
});

Deno.test("worker args for advisory mode carry the same variables and no network", async () => {
  const h = harness({ internal: ok(ADVISORY_GOOD) });
  const up = await bringUpAppleEgress(h.deps, options({ mode: "advisory" }));
  assertEquals(up.workerArgs, expectedWorkerArgs(PROXY_IP_DEFAULT, false));
  assertFalse(up.workerArgs.includes("--network"));
});

// ---------------------------------------------------------------------------
// Containment guard
// ---------------------------------------------------------------------------

Deno.test("assertAppleRunContained refuses --publish in either spelling", () => {
  assertThrowsSync(() =>
    assertAppleRunContained(["run", "--publish", "8080:80", IMAGE], HOME)
  );
  assertThrowsSync(() =>
    assertAppleRunContained(["run", "--publish=8080:80", IMAGE], HOME)
  );
  assertThrowsSync(() =>
    assertAppleRunContained(["run", "--network=host", IMAGE], HOME)
  );
});

Deno.test("assertAppleRunContained refuses a home mount, the root, a socket and a colon source", () => {
  const refused: string[][] = [
    ["run", "--volume", `${HOME}:/mnt`, IMAGE],
    ["run", "--volume", "/:/mnt", IMAGE],
    ["run", "--volume", "/var/run/docker.sock:/var/run/docker.sock", IMAGE],
    ["run", "--volume", `${BASE}:rw/x:/work/x:ro`, IMAGE],
    ["run", "--volume", `${BASE}/x:relative:ro`, IMAGE],
    ["run", "--volume", `${BASE}/x:/work/x:rw`, IMAGE],
    ["run", "--volume", `${BASE}/x:work/x:ro`, IMAGE],
  ];
  for (const argv of refused) {
    assertThrowsSync(() => assertAppleRunContained(argv, HOME));
  }
});

Deno.test("assertAppleRunContained accepts the read-only code mount", () => {
  assertAppleRunContained(expectedProxyRunInternal(), HOME);
});

function assertThrowsSync(fn: () => unknown): void {
  assertThrowsReturn(fn);
}

// ---------------------------------------------------------------------------
// Stale sweep
// ---------------------------------------------------------------------------

Deno.test("the stale sweep removes dead-launcher networks and leaves live, foreign and own names alone", async () => {
  const h = harness(
    {
      networks: [
        "vibe-egress-111",
        "vibe-egress-222",
        "vibe-egress-333",
        "vibe-egressX",
        "my-vibe-egress-7",
        "vibe-egress-42-x",
        "vibe-egress-0",
      ],
    },
    [222],
  );
  await bringUpAppleEgress(h.deps, options());
  assertEquals(
    h.apple.calls.filter((argv) => argv.includes("vibe-egress-111")),
    [["network", "delete", "vibe-egress-111"]],
  );
  assert(
    h.apple.calls.some((argv) =>
      argv.join(" ") === "delete --force vibe-coder-egress-proxy-111"
    ),
  );
  assert(
    h.apple.calls.some((argv) =>
      argv.join(" ") === "network delete vibe-egress-333"
    ),
  );
  for (
    const forbidden of ["222", "egressX", "my-vibe", "42-x", "vibe-egress-0"]
  ) {
    assertEquals(
      h.apple.calls.filter((argv) =>
        argv.some((word) => word.includes(forbidden))
      ),
      [],
      `${forbidden} must not be touched`,
    );
  }
});

Deno.test("a failed stale sweep is a warning and the launch goes on", async () => {
  const h = harness({
    networkList: fail("listing broke"),
    internal: ok(INTERNAL_GOOD),
  });
  const up = await bringUpAppleEgress(h.deps, options());
  assertEquals(up.attempts, 1);
  assert(
    h.logs.some((line) =>
      line.startsWith(
        "[egress] warning: could not list networks for the stale sweep",
      )
    ),
  );
});

// ---------------------------------------------------------------------------
// Attempts, readiness and inspect
// ---------------------------------------------------------------------------

Deno.test("re-creating over leftovers removes our names before the create", async () => {
  const h = harness({ networks: [NET], containers: [PROXY] });
  const up = await bringUpAppleEgress(h.deps, options());
  assertEquals(up.attempts, 1);
  const order = h.apple.calls.map((argv) => argv.join(" "));
  const deleteProxy = order.indexOf(`delete --force ${PROXY}`);
  const deleteNetworkIndex = order.indexOf(`network delete ${NET}`);
  const createIndex = order.indexOf(EXPECTED_NETWORK_CREATE.join(" "));
  const runIndex = order.findIndex((line) => line.startsWith("run --detach"));
  assert(deleteProxy !== -1 && deleteProxy < createIndex);
  assert(deleteNetworkIndex !== -1 && deleteNetworkIndex < createIndex);
  assert(createIndex < runIndex);
});

Deno.test("readiness polls the logs until the marker appears", async () => {
  const h = harness({ logsReadyAt: 3 });
  await bringUpAppleEgress(
    h.deps,
    options({ readyTries: 5, readyIntervalMs: 250 }),
  );
  const logsCalls = h.apple.callsStartingWith("logs").length;
  // Two misses, the hit, then the proxy-log tail is not needed on success.
  assertEquals(logsCalls, 3);
  assertEquals(h.sleeps, [250, 250]);
});

Deno.test("a readiness timeout quotes the last logs line and fails after the bound", async () => {
  const h = harness({
    logLines: ["[boot] waiting for allowlist"],
    logsReadyAt: Infinity,
  });
  const error = await assertRejects(
    () =>
      bringUpAppleEgress(
        h.deps,
        options({ recoveryAttempts: 0, readyTries: 3 }),
      ),
    AppleEgressError,
    "did not report ready after 3 tries",
  );
  assertStringIncludes(
    error.message,
    `last log line: "[boot] waiting for allowlist"`,
  );
  assertEquals(h.apple.callsStartingWith("run", "--detach").length, 1);
});

Deno.test("readiness stops early when inspect says the proxy is not running", async () => {
  const h = harness({ logsReadyAt: Infinity, inspectStatus: "exited" });
  const error = await assertRejects(
    () =>
      bringUpAppleEgress(
        h.deps,
        options({ recoveryAttempts: 0, readyTries: 5 }),
      ),
    AppleEgressError,
    "is not running (status exited)",
  );
  assertEquals(error.diagnostics.length > 0, true);
  // One poll, then the status check stops the loop; the tail adds one more.
  assertEquals(h.apple.callsStartingWith("logs").length, 2);
});

Deno.test("readIpv4OnNetwork reads both key spellings and strips the prefix", () => {
  const modern = JSON.stringify([{
    networks: [
      {
        network: "default",
        ipv4Address: "192.168.65.9/24",
        ipv4Gateway: "192.168.65.1",
      },
      {
        network: NET,
        ipv4Address: "192.168.64.9/24",
        ipv4Gateway: "192.168.64.1",
      },
    ],
  }]);
  const legacy = JSON.stringify({
    networks: [
      { name: "default", address: "192.168.65.9/24", gateway: "192.168.65.1" },
      { name: NET, address: "192.168.64.9/24", gateway: "192.168.64.1" },
    ],
  });
  assertEquals(readIpv4OnNetwork(modern, NET), "192.168.64.9");
  assertEquals(readIpv4OnNetwork(modern, "default"), "192.168.65.9");
  assertEquals(readIpv4OnNetwork(legacy, NET), "192.168.64.9");
  assertEquals(readIpv4OnNetwork(legacy, "default"), "192.168.65.9");
});

Deno.test("readIpv4OnNetwork fails loud, naming the keys seen, when nothing matches", () => {
  const text = JSON.stringify([{
    id: "abc",
    networks: [{ network: "other", ipv4Address: "10.0.0.1/24" }],
  }]);
  const error = assertThrowsReturn(() => readIpv4OnNetwork(text, NET));
  assertStringIncludes(error.message, `network ${NET}`);
  assertStringIncludes(
    error.message,
    "keys seen: id, networks, network, ipv4Address",
  );
});

Deno.test("an inspect output without the proxy's IPv4 fails the attempt with the keys named", async () => {
  const h = harness({
    inspectJson: JSON.stringify([{
      networks: [{ network: "other", ipv4Address: "10.0.0.1/24" }],
    }]),
  });
  const error = await assertRejects(
    () => bringUpAppleEgress(h.deps, options({ recoveryAttempts: 0 })),
    AppleEgressError,
    "keys seen",
  );
  assertStringIncludes(error.message, "ipv4Address");
});

Deno.test("an infrastructure failure is retried within the bound and can succeed", async () => {
  const h = harness({ createFailures: 1, createStderr: "boom" });
  const up = await bringUpAppleEgress(h.deps, options());
  assertEquals(up.attempts, 2);
  assert(
    h.logs.some((line) =>
      line.includes(
        `attempt 1 of 3 failed: container network create exited 1: "boom"`,
      )
    ),
  );
  assertEquals(h.apple.networkCreates().length, 2);
});

Deno.test("an infrastructure failure on every attempt throws with the cause line", async () => {
  const h = harness({ createFailures: 10, createStderr: "boom" });
  const error = await assertRejects(
    () => bringUpAppleEgress(h.deps, options({ recoveryAttempts: 1 })),
    AppleEgressError,
    'after 2 attempt(s): container network create exited 1: "boom"',
  );
  assertEquals(error.report, undefined);
  assertEquals(h.apple.networkCreates().length, 2);
});

Deno.test("a probe that cannot run is not a pass: the attempt regresses and nothing is returned", async () => {
  const h = harness({ internal: fail("image not found") });
  const error = await assertRejects(
    () => bringUpAppleEgress(h.deps, options({ recoveryAttempts: 0 })),
    AppleEgressError,
    "failed its promises on all 1 attempt(s)",
  );
  assert(error.report);
  assertEquals(error.report.controls.proxyAllowlist.state, "untested");
  assertStringIncludes(error.report.regressions[0] ?? "", "did not run");
  assertStringIncludes(error.report.regressions[0] ?? "", "image not found");
});

Deno.test("a probe that prints nothing is not a pass", async () => {
  const h = harness({ internal: ok("") });
  await assertRejects(
    () => bringUpAppleEgress(h.deps, options({ recoveryAttempts: 0 })),
    AppleEgressError,
    "failed its promises",
  );
});

Deno.test("regression runs exactly 1 + recovery attempts, tears down, persists refused, and returns nothing", async () => {
  const h = harness({ internal: ok(INTERNAL_BAD) });
  let returned = false;
  const error = await assertRejects(
    async () => {
      await bringUpAppleEgress(h.deps, options({ recoveryAttempts: 2 }));
      returned = true;
    },
    AppleEgressError,
    "failed its promises on all 3 attempt(s)",
  );
  assertFalse(returned);
  assertEquals(h.apple.calls.filter(isProxyRun).length, 3);
  assert(h.logs.includes("[egress] bounded recovery: attempt 2 of 3"));
  assert(h.logs.includes("[egress] bounded recovery: attempt 3 of 3"));
  assert(error.report);
  assertStringIncludes(
    error.report.regressions[0] ?? "",
    "directInternetV4 is reachable",
  );
  // Teardown ran: nothing of ours is left.
  assertFalse(h.apple.networks.has(NET));
  assertFalse(h.apple.containers.has(PROXY));
  // Never fell back: every proxy run kept the internal network.
  for (const argv of h.apple.calls.filter(isProxyRun)) {
    assertStringIncludes(argv.join(" "), `--network default --network ${NET}`);
  }
  // Refused report persisted.
  const persisted = await persistedOutcome(h.writes);
  assertEquals(persisted.outcome, "refused");
  assertEquals(h.writes.length, 1);
});

Deno.test("the failed attempt logs its formatted report and the proxy logs in diagnostics", async () => {
  const h = harness({
    internal: ok(INTERNAL_BAD),
    logLines: ["[proxy] refusing example.com"],
  });
  const error = await assertRejects(
    () => bringUpAppleEgress(h.deps, options({ recoveryAttempts: 0 })),
    AppleEgressError,
  );
  assert(h.logs.some((line) => line.startsWith("[egress] REGRESSION: ")));
  assert(
    error.diagnostics.some((line) =>
      line.includes("[proxy] refusing example.com")
    ),
  );
});

Deno.test("the success path persists launched, logs the report and the summary", async () => {
  const h = harness();
  const up = await bringUpAppleEgress(h.deps, options());
  assertEquals(up.report.regressions, []);
  const persisted = await persistedOutcome(h.writes);
  assertEquals(persisted.outcome, "launched");
  assertEquals(persisted.report.selectedMode, "internal-network");
  assertEquals(persisted.report.controls.directInternetV4.state, "blocked");
  assertStringIncludes(
    h.writes[0]?.text ?? "",
    '  "outcome": "launched"',
  );
  assert(h.writes[0]?.text.endsWith("}\n"));
  assert(
    h.logs.includes(`[egress] mode: ${EGRESS_MODE_LABELS["internal-network"]}`),
  );
  assert(
    h.logs.some((line) =>
      line.startsWith(
        "egress-containment: mode=internal-network proxy=enforced direct-v4=blocked",
      )
    ),
  );
});

Deno.test("a failed report write is a warning and does not mask the success", async () => {
  const h = harness({}, [], {
    writeReport: () => Promise.reject(new Error("disk full")),
  });
  const up = await bringUpAppleEgress(h.deps, options());
  assertEquals(up.attempts, 1);
  assert(
    h.logs.some((line) =>
      line.startsWith(
        `[egress] warning: could not write ${REPORT_PATH}: disk full`,
      )
    ),
  );
});

Deno.test("the host listener is closed on every attempt, even when reading the probe throws", async () => {
  const h = harness({ listenerSeenThrows: true });
  await assertRejects(
    () => bringUpAppleEgress(h.deps, options({ recoveryAttempts: 2 })),
    AppleEgressError,
    "listener read failed",
  );
  assertEquals(h.listeners.length, 3);
  for (const listener of h.listeners) assertEquals(listener.closed, 1);
});

Deno.test("probe containers are always deleted, on success and on failure", async () => {
  const success = harness();
  await bringUpAppleEgress(success.deps, options());
  for (const name of [INT_PROBE, CTL_PROBE]) {
    assert(
      success.apple.calls.some((argv) =>
        argv.join(" ") === `delete --force ${name}`
      ),
      `success path must delete ${name}`,
    );
  }

  const failure = harness({ internal: fail("image not found") });
  await assertRejects(() =>
    bringUpAppleEgress(failure.deps, options({ recoveryAttempts: 0 }))
  );
  assert(
    failure.apple.calls.some((argv) =>
      argv.join(" ") === `delete --force ${INT_PROBE}`
    ),
    "failure path must delete the internal probe",
  );
  assert(
    failure.apple.calls.some((argv) =>
      argv.join(" ") === `delete --force ${CTL_PROBE}`
    ),
    "failure path must delete the control probe",
  );
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

Deno.test("tearDownAppleEgress saves logs, deletes the proxy then the network", async () => {
  const h = harness({
    containers: [PROXY],
    networks: [NET],
    logLines: ["[proxy] done"],
    logsReadyAt: Infinity,
  });
  const names = appleEgressNames(WORKER);
  const problems = await tearDownAppleEgress(h.deps, names, {
    proxyLogPath: "/Users/op/vibe/reports/proxy.log",
  });
  assertEquals(problems, []);
  assertEquals(h.writes, [{
    path: "/Users/op/vibe/reports/proxy.log",
    text: lines("[proxy] done"),
  }]);
  const order = h.apple.calls.map((argv) => argv.join(" "));
  assert(
    order.indexOf(`delete --force ${PROXY}`) <
      order.indexOf(`network delete ${NET}`),
  );
  assertFalse(h.apple.networks.has(NET));
});

Deno.test("tearDownAppleEgress retries a network delete once after a second, and succeeds", async () => {
  let attempts = 0;
  const h = harness({ containers: [PROXY], networks: [NET] });
  const original = h.apple.run.bind(h.apple);
  h.deps.run = (args) => {
    if (args[0] === "network" && args[1] === "delete" && attempts++ === 0) {
      return Promise.resolve(fail("network has attached containers"));
    }
    return original(args);
  };
  const problems = await tearDownAppleEgress(h.deps, appleEgressNames(WORKER));
  assertEquals(problems, []);
  assertEquals(h.sleeps, [1000]);
  assertEquals(attempts, 2);
});

Deno.test("tearDownAppleEgress treats not-found as success and reports other failures, always trying both", async () => {
  const h = harness({ containers: [] });
  let networkDeletes = 0;
  let containerDeletes = 0;
  h.deps.run = (args) => {
    if (args[0] === "delete") {
      containerDeletes++;
      return Promise.resolve(fail("permission denied for proxy"));
    }
    if (args[0] === "network" && args[1] === "delete") {
      networkDeletes++;
      return Promise.resolve(fail("network is busy"));
    }
    return Promise.resolve(fail(`unexpected ${args.join(" ")}`));
  };
  const problems = await tearDownAppleEgress(h.deps, appleEgressNames(WORKER));
  assertEquals(problems.length, 2);
  assertStringIncludes(
    problems[0] ?? "",
    `could not delete container ${PROXY}`,
  );
  assertStringIncludes(problems[0] ?? "", `"permission denied for proxy"`);
  assertStringIncludes(problems[1] ?? "", `could not delete network ${NET}`);
  assertStringIncludes(problems[1] ?? "", `"network is busy"`);
  // Both deletions are attempted, and the network delete is retried once.
  assertEquals(containerDeletes, 1);
  assertEquals(networkDeletes, 2);
  assertEquals(h.sleeps, [1000]);
});

Deno.test("tearDownAppleEgress never throws, even when the CLI rejects", async () => {
  const h = harness({});
  h.deps.run = () => Promise.reject(new Error("cli crashed"));
  const problems = await tearDownAppleEgress(h.deps, appleEgressNames(WORKER), {
    proxyLogPath: "/tmp/proxy.log",
  });
  assertEquals(problems.length, 2);
  assert(problems.every((problem) => problem.includes("cli crashed")));
});

Deno.test("a not-found network delete at teardown is success, with no retry", async () => {
  const h = harness({ containers: [], networks: [] });
  const problems = await tearDownAppleEgress(h.deps, appleEgressNames(WORKER));
  assertEquals(problems, []);
  assertEquals(h.sleeps, []);
});
