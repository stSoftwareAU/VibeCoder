/**
 * Tests for the production egress host side effects (Issue #4051).
 *
 * `deno task test:unit` grants no network access, so the real-loopback
 * listener scenario runs in a child process granted `--allow-net` for loopback
 * and the wildcard bind, and `--allow-sys=networkInterfaces`. The nonce and
 * report tests run in this process and touch no socket.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  createAppleEgressDeps,
  newAppleEgressNonce,
  NO_HOST_ADDRESS_WARNING,
  usableHostAddresses,
} from "../lib/apple_egress_host.ts";

const SCENARIO_SCRIPT = new URL(
  "./support/apple_egress_host_scenarios.ts",
  import.meta.url,
);
const CHILD_TIMEOUT_MS = 20_000;
const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const decoder = new TextDecoder();

interface ListenerScenario {
  port: number;
  addresses: string[];
  beforeSend: boolean;
  afterSend: boolean;
  otherSeen: boolean;
}

function killQuietly(child: Deno.ChildProcess): void {
  try {
    child.kill("SIGKILL");
  } catch {
    // The child has already exited.
  }
}

/** A child's JSON result and its stderr, for the warning assertions. */
interface ScenarioRun {
  result: ListenerScenario;
  stderr: string;
}

/**
 * Run the listener scenario in a child and return its JSON result.
 *
 * @param sysFlags - Extra permission flags; the sys grant is the one that varies
 */
async function runListenerScenario(
  sysFlags: readonly string[],
): Promise<ScenarioRun> {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-config",
      "--no-lock",
      "--allow-net=127.0.0.1,0.0.0.0",
      ...sysFlags,
      SCENARIO_SCRIPT.href,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killQuietly(child);
  }, CHILD_TIMEOUT_MS);
  try {
    const output = await child.output();
    const stderr = decoder.decode(output.stderr);
    assertEquals(timedOut, false, "the listener scenario timed out");
    assertEquals(
      output.code,
      0,
      `the listener scenario exited ${output.code}: ${stderr}`,
    );
    const line = decoder.decode(output.stdout).trim().split("\n").pop() ?? "";
    return { result: JSON.parse(line) as ListenerScenario, stderr };
  } finally {
    clearTimeout(timer);
  }
}

let scenarioPromise: Promise<ScenarioRun> | undefined;

/** The scenario runs once, with the sys grant, and both listener tests read it. */
function listenerResult(): Promise<ListenerScenario> {
  scenarioPromise ??= runListenerScenario([
    "--allow-sys=networkInterfaces",
  ]);
  return scenarioPromise.then((run) => run.result);
}

/** Pure address selection, with no socket: usable IPv4 only, capped at 8. */
Deno.test("apple-egress host - usableHostAddresses keeps usable IPv4 addresses in order, at most 8, and logs nothing", () => {
  const logged: string[] = [];
  const interfaces = [
    { family: "IPv4" as const, address: "127.0.0.1" },
    { family: "IPv6" as const, address: "fe80::1" },
    { family: "IPv4" as const, address: "169.254.10.1" },
    { family: "IPv4" as const, address: "192.168.64.2" },
    { family: "IPv4" as const, address: "192.168.64.2" },
    ...Array.from({ length: 10 }, (_, index) => ({
      family: "IPv4" as const,
      address: `10.0.0.${index + 1}`,
    })),
  ];
  const addresses = usableHostAddresses(
    interfaces,
    (line) => logged.push(line),
  );
  assertEquals(addresses, [
    "192.168.64.2",
    "10.0.0.1",
    "10.0.0.2",
    "10.0.0.3",
    "10.0.0.4",
    "10.0.0.5",
    "10.0.0.6",
    "10.0.0.7",
  ]);
  assertEquals(logged, []);
});

Deno.test("apple-egress host - no usable interface gives no addresses and exactly one warning line", () => {
  const logged: string[] = [];
  const addresses = usableHostAddresses(
    [
      { family: "IPv4", address: "127.0.0.1" },
      { family: "IPv4", address: "169.254.0.9" },
      { family: "IPv6", address: "::1" },
    ],
    (line) => logged.push(line),
  );
  assertEquals(addresses, []);
  assertEquals(logged, [NO_HOST_ADDRESS_WARNING]);
  assert(NO_HOST_ADDRESS_WARNING.startsWith("[egress] warning: "));
  assertStringIncludes(
    NO_HOST_ADDRESS_WARNING,
    "host-hop probes cannot be measured",
  );
});

Deno.test("apple-egress host - a denied interface listing gives no addresses and exactly one warning line", async () => {
  // No --allow-sys grant: Deno.networkInterfaces() is denied in the child.
  const run = await runListenerScenario([]);
  assertEquals(run.result.addresses, []);
  const warnings = run.stderr.split("\n").filter((line) =>
    line === NO_HOST_ADDRESS_WARNING
  );
  assertEquals(warnings.length, 1, run.stderr);
  // The listener still works without the sys grant.
  assertEquals(run.result.afterSend, true);
});

Deno.test("apple-egress host - seen() is false before any send and true only after the nonce is sent over loopback", async () => {
  const result = await listenerResult();
  assert(result.port > 0 && result.port <= 65535, `port ${result.port}`);
  assertEquals(result.beforeSend, false);
  assertEquals(result.afterSend, true);
  assertEquals(result.otherSeen, false);
});

Deno.test("apple-egress host - the listener reports at most 8 IPv4 addresses, none loopback or link-local", async () => {
  const result = await listenerResult();
  assert(result.addresses.length <= 8, `${result.addresses.length} addresses`);
  for (const address of result.addresses) {
    assertMatch(address, IPV4);
    assert(!address.startsWith("127."), `loopback ${address}`);
    assert(!address.startsWith("169.254."), `link-local ${address}`);
  }
});

Deno.test("apple-egress host - newAppleEgressNonce is 32 lowercase hex characters and differs per call", () => {
  const first = newAppleEgressNonce();
  const second = newAppleEgressNonce();
  assertMatch(first, /^[0-9a-f]{32}$/);
  assertMatch(second, /^[0-9a-f]{32}$/);
  assertNotEquals(first, second);
});

Deno.test("apple-egress host - writeReport replaces the file atomically and leaves no temp file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "apple-egress-report-" });
  try {
    const deps = createAppleEgressDeps({ runtime: "container" });
    const path = `${dir}/egress-controls.json`;
    await deps.writeReport(path, "first\n");
    await deps.writeReport(path, "second\n");
    assertEquals(await Deno.readTextFile(path), "second\n");

    const entries: string[] = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry.name);
    assertEquals(entries, ["egress-controls.json"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("apple-egress host - writeReport rejects a missing target directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "apple-egress-report-" });
  try {
    const deps = createAppleEgressDeps({ runtime: "container" });
    await assertRejects(() =>
      deps.writeReport(`${dir}/absent/report.json`, "x")
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
