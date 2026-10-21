/**
 * Tests for the CONNECT egress proxy (Issue #4046).
 *
 * `deno task test:unit` grants no network access by design, so the socket
 * scenarios run in a child process (tests/support/egress_proxy_socket_scenarios.ts)
 * granted `--allow-net=127.0.0.1` only. Each socket test spawns the child for
 * one scenario and asserts on its JSON result. The child exits on its own; the
 * parent also bounds it with a timer and kills it in a finally block.
 *
 * The pure parsing tests run in this process and touch no sockets.
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  parseEgressAllowlist,
  sanitiseEgressHost,
} from "../lib/egress_proxy.ts";

const SCENARIO_SCRIPT = new URL(
  "./support/egress_proxy_socket_scenarios.ts",
  import.meta.url,
);
const CHILD_TIMEOUT_MS = 20_000;
const decoder = new TextDecoder();

function killQuietly(child: Deno.ChildProcess): void {
  try {
    child.kill("SIGKILL");
  } catch {
    // The child has already exited.
  }
}

/**
 * Run one socket scenario in a child process and throw, with the child's
 * stderr attached, if it fails, times out or prints an unreadable result.
 */
async function runScenario(scenario: string): Promise<void> {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-config",
      "--no-lock",
      "--allow-net=127.0.0.1",
      SCENARIO_SCRIPT.href,
      scenario,
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
    const { code, stdout, stderr } = await child.output();
    const stderrText = decoder.decode(stderr);
    if (timedOut) {
      throw new Error(
        `scenario ${scenario} timed out after ${CHILD_TIMEOUT_MS}ms\n${stderrText}`,
      );
    }

    const lines = decoder.decode(stdout).split("\n").filter((l) => l.trim());
    const last = lines[lines.length - 1] ?? "";
    let result: { scenario?: unknown; ok?: unknown; error?: unknown };
    try {
      result = JSON.parse(last);
    } catch {
      throw new Error(
        `scenario ${scenario} printed no JSON result (exit ${code})\n` +
          `stdout: ${JSON.stringify(decoder.decode(stdout))}\n` +
          `stderr: ${stderrText}`,
      );
    }

    if (code !== 0 || result.ok !== true) {
      throw new Error(
        `scenario ${scenario} failed (exit ${code}): ${
          String(result.error)
        }\n` +
          `stderr: ${stderrText}`,
      );
    }
  } finally {
    clearTimeout(timer);
    killQuietly(child);
  }
}

Deno.test("egress proxy tunnels an allowlisted CONNECT byte-for-byte", async () => {
  await runScenario("tunnel-byte-for-byte");
});

Deno.test("egress proxy refuses a non-allowlisted host with 403 and opens no upstream connection", async () => {
  await runScenario("refuse-non-allowlisted");
});

Deno.test("egress proxy refuses an IP-literal target", async () => {
  await runScenario("refuse-ip-literal");
});

Deno.test("egress proxy refuses allowlisted names resolving to private addresses", async () => {
  await runScenario("refuse-private-resolution");
});

Deno.test("egress proxy refuses a non-CONNECT request", async () => {
  await runScenario("refuse-non-connect");
});

Deno.test("egress proxy writes exactly one denial line per refusal", async () => {
  await runScenario("one-denial-line-per-refusal");
});

Deno.test("egress proxy refuses and sanitises a hostname carrying control characters", async () => {
  await runScenario("sanitise-control-characters");
});

Deno.test("egress proxy cuts off an over-long request header", async () => {
  await runScenario("cut-off-over-long-header");
});

Deno.test("egress proxy cuts off an idle client", async () => {
  await runScenario("cut-off-idle-client");
});

Deno.test("egress proxy refuses a non-443 port", async () => {
  await runScenario("refuse-non-443-port");
});

Deno.test("egress proxy refuses at the connection cap", async () => {
  await runScenario("refuse-at-connection-cap");
});

Deno.test("egress proxy hands an allowlisted host with a route to the route, not upstream", async () => {
  await runScenario("hand-off-to-route");
});

Deno.test("parseEgressAllowlist splits a comma-separated string", () => {
  assertEquals(
    parseEgressAllowlist(" Api.Example , *.Cdn.example,, "),
    ["api.example", "*.cdn.example"],
  );
});

Deno.test("parseEgressAllowlist accepts an array", () => {
  assertEquals(
    parseEgressAllowlist(["api.example", "*.cdn.example"]),
    ["api.example", "*.cdn.example"],
  );
});

Deno.test("parseEgressAllowlist rejects an IP literal", () => {
  assertThrows(
    () => parseEgressAllowlist("api.example,10.0.0.1"),
    Error,
    "10.0.0.1",
  );
});

Deno.test("parseEgressAllowlist rejects an empty list", () => {
  assertThrows(() => parseEgressAllowlist(" , "), Error, "empty");
  assertThrows(() => parseEgressAllowlist([]), Error, "empty");
});

Deno.test("sanitiseEgressHost caps the host at 64 characters", () => {
  assertEquals(sanitiseEgressHost("a".repeat(100)), "a".repeat(64));
  assertEquals(sanitiseEgressHost("ok\u0000\r\n.example"), "ok.example");
});
