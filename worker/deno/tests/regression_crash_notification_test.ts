/**
 * Regression test suite — crash notification parity validation (Issue #1235).
 *
 * Validates that the Deno crash notification module produces identical results
 * to the original shell implementation, focusing on message formatting,
 * rate limiting, signal detection, and edge cases.
 *
 * Uses Australian English spelling throughout (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildCrashMessage,
  captureFileTail,
  type CrashNotificationConfig,
  type CrashNotificationParams,
  formatElapsedTime,
  isCrashExit,
  recordNotificationSent,
  shouldRateLimitNotification,
  signalNameFromExitCode,
} from "../lib/crash_notification.ts";

// ============================================================================
// formatElapsedTime — boundary and edge cases
// ============================================================================

Deno.test("regression crash - formatElapsedTime with zero seconds", () => {
  assertEquals(formatElapsedTime(0), "0m 0s");
});

Deno.test("regression crash - formatElapsedTime with exactly 60 seconds", () => {
  assertEquals(formatElapsedTime(60), "1m 0s");
});

Deno.test("regression crash - formatElapsedTime with exactly 3600 seconds", () => {
  assertEquals(formatElapsedTime(3600), "1h 0m 0s");
});

Deno.test("regression crash - formatElapsedTime with fractional seconds", () => {
  assertEquals(formatElapsedTime(90.7), "1m 30s");
});

Deno.test("regression crash - formatElapsedTime with NaN", () => {
  assertEquals(formatElapsedTime(NaN), "unknown");
});

Deno.test("regression crash - formatElapsedTime with negative value", () => {
  assertEquals(formatElapsedTime(-10), "unknown");
});

Deno.test("regression crash - formatElapsedTime with Infinity", () => {
  assertEquals(formatElapsedTime(Infinity), "unknown");
});

Deno.test("regression crash - formatElapsedTime with very large value", () => {
  // 1 week = 604800 seconds
  const result = formatElapsedTime(604800);
  assertEquals(result, "168h 0m 0s");
});

// ============================================================================
// isCrashExit — all scenarios
// ============================================================================

Deno.test("regression crash - isCrashExit with exit code 0", () => {
  assertEquals(isCrashExit(0, false), false);
});

Deno.test("regression crash - isCrashExit with exit code 0 and planned shutdown", () => {
  assertEquals(isCrashExit(0, true), false);
});

Deno.test("regression crash - isCrashExit with non-zero and not planned", () => {
  assertEquals(isCrashExit(1, false), true);
  assertEquals(isCrashExit(137, false), true);
});

Deno.test("regression crash - isCrashExit with non-zero and planned shutdown", () => {
  assertEquals(isCrashExit(1, true), false);
  assertEquals(isCrashExit(137, true), false);
});

// ============================================================================
// signalNameFromExitCode — comprehensive signal mapping
// ============================================================================

Deno.test("regression crash - signalNameFromExitCode for non-signal exits", () => {
  assertEquals(signalNameFromExitCode(0), "");
  assertEquals(signalNameFromExitCode(1), "");
  assertEquals(signalNameFromExitCode(127), "");
  assertEquals(signalNameFromExitCode(128), "");
});

Deno.test("regression crash - signalNameFromExitCode for known signals", () => {
  assertEquals(signalNameFromExitCode(129), "SIGHUP");
  assertEquals(signalNameFromExitCode(130), "SIGINT");
  assertEquals(signalNameFromExitCode(131), "SIGQUIT");
  assertEquals(signalNameFromExitCode(134), "SIGABRT");
  assertEquals(signalNameFromExitCode(137), "SIGKILL");
  assertEquals(signalNameFromExitCode(139), "SIGSEGV");
  assertEquals(signalNameFromExitCode(141), "SIGPIPE");
  assertEquals(signalNameFromExitCode(142), "SIGALRM");
  assertEquals(signalNameFromExitCode(143), "SIGTERM");
});

Deno.test("regression crash - signalNameFromExitCode for unknown signal numbers", () => {
  assertEquals(signalNameFromExitCode(200), "signal 72");
  assertEquals(signalNameFromExitCode(160), "signal 32");
});

// ============================================================================
// buildCrashMessage — content validation
// ============================================================================

function makeConfig(
  overrides: Partial<CrashNotificationConfig> = {},
): CrashNotificationConfig {
  return {
    workerName: "test-worker",
    cooldownSeconds: 600,
    logTailMaxBytes: 50000,
    stateDir: "/tmp/test",
    ...overrides,
  };
}

function makeParams(
  overrides: Partial<CrashNotificationParams> = {},
): CrashNotificationParams {
  return {
    exitCode: 1,
    repo: "org/repo",
    issueNumber: 42,
    logTail: "",
    claudeOutput: "",
    workStage: "running_claude",
    workStartTime: 0,
    plannedShutdown: false,
    ...overrides,
  };
}

Deno.test("regression crash - buildCrashMessage includes worker name", () => {
  const msg = buildCrashMessage(makeConfig(), makeParams());
  assert(msg.includes("test-worker"), "Should include worker name");
});

Deno.test("regression crash - buildCrashMessage includes exit code", () => {
  const msg = buildCrashMessage(makeConfig(), makeParams({ exitCode: 137 }));
  assert(msg.includes("137"), "Should include exit code");
  assert(msg.includes("SIGKILL"), "Should include signal name for 137");
});

Deno.test("regression crash - buildCrashMessage includes last activity", () => {
  const msg = buildCrashMessage(makeConfig(), makeParams());
  assert(msg.includes("issue #42"), "Should include issue number");
  assert(msg.includes("org/repo"), "Should include repo");
});

Deno.test("regression crash - buildCrashMessage with no issue in progress", () => {
  const msg = buildCrashMessage(
    makeConfig(),
    makeParams({ repo: "", issueNumber: 0 }),
  );
  assert(msg.includes("No issue in progress"), "Should indicate no issue");
});

Deno.test("regression crash - buildCrashMessage includes work stage", () => {
  const msg = buildCrashMessage(makeConfig(), makeParams());
  assert(msg.includes("running_claude"), "Should include work stage");
});

Deno.test("regression crash - buildCrashMessage includes elapsed time", () => {
  const now = 1000;
  const params = makeParams({ workStartTime: 900 });
  const msg = buildCrashMessage(makeConfig(), params, () => now);
  assert(msg.includes("1m 40s"), "Should include elapsed time");
});

Deno.test("regression crash - buildCrashMessage with empty worker name", () => {
  const msg = buildCrashMessage(makeConfig({ workerName: "" }), makeParams());
  assert(
    msg.includes("unknown"),
    "Should show 'unknown' for empty worker name",
  );
});

Deno.test("regression crash - buildCrashMessage includes log tail in details", () => {
  const params = makeParams({
    logTail: "Error: something failed\nStack trace here",
  });
  const msg = buildCrashMessage(makeConfig(), params);
  assert(msg.includes("Worker log tail"), "Should include log tail section");
  assert(msg.includes("something failed"), "Should include log content");
});

Deno.test("regression crash - buildCrashMessage truncates large log tails", () => {
  const longLog = "x".repeat(60000);
  const config = makeConfig({ logTailMaxBytes: 1000 });
  const params = makeParams({ logTail: longLog });
  const msg = buildCrashMessage(config, params);
  assert(msg.includes("truncated"), "Should indicate truncation");
});

Deno.test("regression crash - buildCrashMessage includes key errors prominently", () => {
  const params = makeParams({
    logTail: "Info: starting\nError: test failed\nInfo: done",
  });
  const msg = buildCrashMessage(makeConfig(), params);
  assert(msg.includes("Key Errors"), "Should have Key Errors section");
  assert(msg.includes("> Error: test failed"), "Should quote key error lines");
});

// ============================================================================
// captureFileTail — edge cases
// ============================================================================

Deno.test("regression crash - captureFileTail with empty path", async () => {
  const result = await captureFileTail("", 100, 50000);
  assertEquals(result, "");
});

Deno.test("regression crash - captureFileTail with non-existent file", async () => {
  const result = await captureFileTail(
    "/tmp/nonexistent-file-12345",
    100,
    50000,
  );
  assertEquals(result, "");
});

Deno.test("regression crash - captureFileTail reads last N lines", async () => {
  const tmpFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tmpFile, "line1\nline2\nline3\nline4\nline5\n");
    const result = await captureFileTail(tmpFile, 2, 50000);
    assert(result.includes("line5"), "Should include last line");
    assert(!result.includes("line1"), "Should not include first line");
  } finally {
    await Deno.remove(tmpFile);
  }
});

// ============================================================================
// shouldRateLimitNotification — state management
// ============================================================================

Deno.test("regression crash - shouldRateLimitNotification with no state file", async () => {
  const config = makeConfig({ stateDir: "/tmp/nonexistent-dir-12345" });
  const result = await shouldRateLimitNotification(config);
  assertEquals(result, false, "No state file means no rate limiting");
});

Deno.test("regression crash - shouldRateLimitNotification within cooldown", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const config = makeConfig({ stateDir: tmpDir, cooldownSeconds: 600 });
    const now = 1000;

    // Record a recent notification
    await Deno.writeTextFile(
      `${tmpDir}/last_crash_notification`,
      String(now - 100),
    );
    const result = await shouldRateLimitNotification(config, () => now);
    assertEquals(result, true, "Should rate limit within cooldown");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("regression crash - shouldRateLimitNotification after cooldown expired", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const config = makeConfig({ stateDir: tmpDir, cooldownSeconds: 600 });
    const now = 1000;

    // Record an old notification
    await Deno.writeTextFile(
      `${tmpDir}/last_crash_notification`,
      String(now - 700),
    );
    const result = await shouldRateLimitNotification(config, () => now);
    assertEquals(result, false, "Should not rate limit after cooldown expires");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("regression crash - shouldRateLimitNotification with corrupt state file", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const config = makeConfig({ stateDir: tmpDir });
    await Deno.writeTextFile(
      `${tmpDir}/last_crash_notification`,
      "not-a-number",
    );
    const result = await shouldRateLimitNotification(config);
    assertEquals(result, false, "Corrupt state should not rate limit");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ============================================================================
// recordNotificationSent — persistence
// ============================================================================

Deno.test("regression crash - recordNotificationSent creates state file", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const config = makeConfig({ stateDir: tmpDir });
    const result = await recordNotificationSent(config, () => 12345);
    assert(result.ok, "Should succeed");

    const content = await Deno.readTextFile(
      `${tmpDir}/last_crash_notification`,
    );
    assertEquals(content, "12345");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
