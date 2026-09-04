/**
 * Tests for subprocess_timeout.ts — subprocess and fetch timeout utilities.
 *
 * Issue #1168: Robustness and fault tolerance improvements.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  DEFAULT_SUBPROCESS_TIMEOUT_MS,
  EXTENDED_SUBPROCESS_TIMEOUT_MS,
  fetchWithTimeout,
  runWithTimeout,
} from "../lib/subprocess_timeout.ts";
import {
  getFaultEventCount,
  resetFaultCounters,
} from "../lib/fault_tolerance_counters.ts";

// =============================================================================
// runWithTimeout tests
// =============================================================================

Deno.test("subprocess_timeout - runWithTimeout returns stdout from successful command", async () => {
  const result = await runWithTimeout("echo", ["hello world"]);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.success, true);
    assertEquals(result.value.stdout, "hello world");
    assertEquals(result.value.timedOut, false);
    assertEquals(result.value.code, 0);
  }
});

Deno.test("subprocess_timeout - runWithTimeout captures non-zero exit code", async () => {
  const result = await runWithTimeout("sh", ["-c", "exit 42"]);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.success, false);
    assertEquals(result.value.code, 42);
    assertEquals(result.value.timedOut, false);
  }
});

Deno.test("subprocess_timeout - runWithTimeout times out on slow command", async () => {
  resetFaultCounters();
  const result = await runWithTimeout("sh", ["-c", "sleep 30"], {
    timeoutMs: 200,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.timedOut, true);
    assertEquals(result.value.code, 124);
    assertEquals(result.value.success, false);
    assertStringIncludes(result.value.stderr, "Timed out");
  }
  assertEquals(getFaultEventCount("timeout") >= 1, true);
});

Deno.test("subprocess_timeout - runWithTimeout returns error for non-existent executable", async () => {
  const result = await runWithTimeout("nonexistent_command_xyz_12345", []);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error instanceof Error, true);
  }
});

Deno.test("subprocess_timeout - runWithTimeout captures stderr", async () => {
  const result = await runWithTimeout("sh", ["-c", "echo error >&2; exit 1"]);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.stderr, "error");
    assertEquals(result.value.success, false);
  }
});

Deno.test("subprocess_timeout - runWithTimeout with quiet:true mutes stdout but still captures stderr (Issue #1979)", async () => {
  const result = await runWithTimeout(
    "bash",
    ["-c", "echo out; echo err >&2; exit 1"],
    { quiet: true },
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.success, false);
    assertEquals(result.value.code, 1);
    // stdout is muted by quiet
    assertEquals(result.value.stdout, "");
    // stderr is always captured, even with quiet
    assertEquals(result.value.stderr, "err");
  }
});

Deno.test("subprocess_timeout - runWithTimeout with quiet:true captures multi-line stderr on failure (Issue #1979)", async () => {
  const result = await runWithTimeout(
    "bash",
    [
      "-c",
      "echo 'repos.sh status=failed reason=network name=\"foo\"' >&2; exit 2",
    ],
    { quiet: true },
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.success, false);
    assertEquals(result.value.code, 2);
    assertStringIncludes(result.value.stderr, "repos.sh status=failed");
    assertStringIncludes(result.value.stderr, "reason=network");
  }
});

Deno.test("subprocess_timeout - runWithTimeout supports cwd option", async () => {
  const result = await runWithTimeout("pwd", [], { cwd: "/tmp" });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.success, true);
    assertStringIncludes(result.value.stdout, "tmp");
  }
});

Deno.test("subprocess_timeout - runWithTimeout uses default timeout constant", () => {
  assertEquals(DEFAULT_SUBPROCESS_TIMEOUT_MS, 30_000);
  assertEquals(EXTENDED_SUBPROCESS_TIMEOUT_MS, 60_000);
});

// =============================================================================
// fetchWithTimeout tests
// =============================================================================

Deno.test("subprocess_timeout - fetchWithTimeout rejects on timeout", async () => {
  resetFaultCounters();

  let caught = false;
  try {
    // Use a non-routable address to simulate a hanging connection
    await fetchWithTimeout("http://192.0.2.1:1", undefined, 200);
  } catch (error: unknown) {
    caught = true;
    if (error instanceof Error) {
      // Either timeout message or connection error
      assertEquals(error instanceof Error, true);
    }
  }
  assertEquals(caught, true);
});

Deno.test("subprocess_timeout - fetchWithTimeout passes through init options", async () => {
  let caught = false;
  try {
    await fetchWithTimeout(
      "http://192.0.2.1:1",
      { method: "POST", headers: { "X-Test": "value" } },
      200,
    );
  } catch {
    caught = true;
  }
  assertEquals(caught, true);
});

// ---------------------------------------------------------------------------
// Environment control and timeout capture (Issue #806)
// ---------------------------------------------------------------------------

Deno.test({
  name: "subprocess_timeout - env entries reach the child",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const result = await runWithTimeout("/bin/sh", [
      "-c",
      'printf "%s" "$VIBE_TEST_VALUE"',
    ], { env: { VIBE_TEST_VALUE: "carried" } });
    assertEquals(result.ok, true);
    assertEquals(result.ok && result.value.stdout, "carried");
  },
});

Deno.test({
  name: "subprocess_timeout - clearEnv keeps the parent environment out",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    // Reads the parent value, never sets one: mutating `Deno.env` races
    // under `deno test --parallel` and the cap in
    // `parallel_safety_cap_test.ts` (Issue #880) forbids new mutators.
    const parentHome = Deno.env.get("HOME");
    assert(
      parentHome !== undefined && parentHome !== "",
      "the test host must export HOME for this test to mean anything",
    );
    const result = await runWithTimeout("/bin/sh", [
      "-c",
      'printf "%s" "${HOME:-absent}"',
    ], {
      clearEnv: true,
      env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
    });
    assertEquals(result.ok, true);
    assertEquals(result.ok && result.value.stdout, "absent");
  },
});

Deno.test({
  name:
    "subprocess_timeout - without clearEnv the parent environment is inherited",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const parentHome = Deno.env.get("HOME");
    assert(
      parentHome !== undefined && parentHome !== "",
      "the test host must export HOME for this test to mean anything",
    );
    const result = await runWithTimeout("/bin/sh", [
      "-c",
      'printf "%s" "${HOME:-absent}"',
    ]);
    assertEquals(result.ok && result.value.stdout, parentHome);
  },
});

Deno.test({
  name: "subprocess_timeout - a timeout reports no output by default",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const result = await runWithTimeout("/bin/sh", [
      "-c",
      'printf "before-the-hang"; exec sleep 30',
    ], { timeoutMs: 300 });
    assertEquals(result.ok, true);
    assert(result.ok && result.value.timedOut);
    assertEquals(result.ok && result.value.code, 124);
    assertEquals(result.ok && result.value.stdout, "");
    assertEquals(result.ok && result.value.stderr, "Timed out after 300ms");
  },
});

Deno.test({
  name:
    "subprocess_timeout - captureOutputOnTimeout keeps what the child printed",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const result = await runWithTimeout("/bin/sh", [
      "-c",
      'printf "before-the-hang"; echo "diagnostic" >&2; exec sleep 30',
    ], { timeoutMs: 300, captureOutputOnTimeout: true });
    assert(result.ok && result.value.timedOut);
    assertEquals(result.ok && result.value.stdout, "before-the-hang");
    assert(result.ok && result.value.stderr.includes("Timed out after 300ms"));
    assert(result.ok && result.value.stderr.includes("diagnostic"));
  },
});
