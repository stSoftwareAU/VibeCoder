/**
 * Tests for quality_gate.ts (Issue #917).
 *
 * Verifies quality gate orchestration: running checks, collecting results,
 * and producing correct summary output.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CheckExecutionResult,
  formatCheckProgress,
  type QualityGateConfig,
  runChecksParallel,
  runChecksSequential,
  runDenoCheck,
  runDenoFmtCheck,
  runQualityGate,
  runReleaseTagRulesetQualityCheck,
} from "../lib/quality_gate.ts";

// =============================================================================
// Helper to create a test config
// =============================================================================

function createTestConfig(
  overrides?: Partial<QualityGateConfig>,
): QualityGateConfig {
  // Use a nonexistent directory to ensure checks skip/fail predictably
  const tmpDir = Deno.makeTempDirSync();
  return {
    scriptDir: tmpDir,
    denoDir: `${tmpDir}/worker/deno`,
    options: {
      strict: false,
      sequential: true,
      validatePrompts: false,
    },
    ...overrides,
  };
}

// =============================================================================
// Quality gate integration tests
// =============================================================================

Deno.test("runQualityGate - returns result with checks and summary", async () => {
  const config = createTestConfig();
  const result = await runQualityGate(config);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(Array.isArray(result.value.checks), true);
    assertEquals(typeof result.value.summary.text, "string");
    assertEquals(typeof result.value.passed, "boolean");
    assertStringIncludes(result.value.summary.text, "Quality Check Summary");
  }

  // Clean up
  try {
    Deno.removeSync(config.scriptDir, { recursive: true });
  } catch { /* ignore */ }
});

Deno.test("runQualityGate - strict mode fails on skipped checks", async () => {
  const config = createTestConfig({
    options: { strict: true, sequential: true, validatePrompts: false },
  });
  const result = await runQualityGate(config);

  assertEquals(result.ok, true);
  if (result.ok) {
    // With nothing available, there will be skipped or failed checks
    assertEquals(result.value.passed, false);
  }

  try {
    Deno.removeSync(config.scriptDir, { recursive: true });
  } catch { /* ignore */ }
});

Deno.test("runQualityGate - sequential mode runs without parallel message", async () => {
  const config = createTestConfig({
    options: { strict: false, sequential: true, validatePrompts: false },
  });
  const result = await runQualityGate(config);

  assertEquals(result.ok, true);
  if (result.ok) {
    // Sequential mode should not contain parallel message in checks
    const hasParallelMsg = result.value.checks.some(
      (c) => c.name.includes("parallel"),
    );
    assertEquals(hasParallelMsg, false);
  }

  try {
    Deno.removeSync(config.scriptDir, { recursive: true });
  } catch { /* ignore */ }
});

Deno.test("runQualityGate - records audit check for test file quality", async () => {
  const config = createTestConfig();
  const result = await runQualityGate(config);

  assertEquals(result.ok, true);
  if (result.ok) {
    // The audit check should be recorded (may be SKIPPED if script not found)
    const auditCheck = result.value.checks.find(
      (c) => c.name.includes("audit"),
    );
    assertEquals(auditCheck !== undefined, true);
  }

  try {
    Deno.removeSync(config.scriptDir, { recursive: true });
  } catch { /* ignore */ }
});

// =============================================================================
// Audit check TypeScript implementation tests (Issue #970)
// =============================================================================

Deno.test("runQualityGate - audit passes when no violating patterns in tests", async () => {
  const tmpDir = Deno.makeTempDirSync();
  const testsDir = `${tmpDir}/worker/deno/tests`;
  Deno.mkdirSync(testsDir, { recursive: true });

  // Create a clean test file (no violating patterns)
  Deno.writeTextFileSync(
    `${testsDir}/example_test.ts`,
    `Deno.test("should validate input correctly", () => {\n  // clean test\n});\n`,
  );

  const config = createTestConfig({
    scriptDir: tmpDir,
    denoDir: `${tmpDir}/worker/deno`,
  });
  const result = await runQualityGate(config);

  assertEquals(result.ok, true);
  if (result.ok) {
    const auditCheck = result.value.checks.find((c) =>
      c.name.includes("audit")
    );
    assertEquals(auditCheck !== undefined, true);
    if (auditCheck) {
      assertEquals(auditCheck.status, "PASSED");
    }
  }

  try {
    Deno.removeSync(tmpDir, { recursive: true });
  } catch { /* ignore */ }
});

Deno.test("runQualityGate - audit fails when perf pattern found in test name", async () => {
  const tmpDir = Deno.makeTempDirSync();
  const testsDir = `${tmpDir}/worker/deno/tests`;
  Deno.mkdirSync(testsDir, { recursive: true });

  // Create a test file with a perf-test pattern that triggers the audit.
  // Build the string dynamically to avoid triggering the audit on THIS file.
  const prefix = "bench";
  const violatingContent = `Deno.test("${prefix}_sorting_perf", () => {});\n`;
  Deno.writeTextFileSync(`${testsDir}/bad_test.ts`, violatingContent);

  const config = createTestConfig({
    scriptDir: tmpDir,
    denoDir: `${tmpDir}/worker/deno`,
  });
  const result = await runQualityGate(config);

  assertEquals(result.ok, true);
  if (result.ok) {
    const auditCheck = result.value.checks.find((c) =>
      c.name.includes("audit")
    );
    assertEquals(auditCheck !== undefined, true);
    if (auditCheck) {
      assertEquals(auditCheck.status, "FAILED");
    }
  }

  try {
    Deno.removeSync(tmpDir, { recursive: true });
  } catch { /* ignore */ }
});

// =============================================================================
// Promise.allSettled resilience tests (Issue #1168)
// =============================================================================

Deno.test("runQualityGate - parallel mode collects all results even with failures", async () => {
  // Use parallel mode (sequential: false) — verify that all checks run
  // even if some fail, thanks to Promise.allSettled usage.
  const config = createTestConfig({
    options: { strict: false, sequential: false, validatePrompts: false },
  });
  const result = await runQualityGate(config);

  assertEquals(result.ok, true);
  if (result.ok) {
    // Should have multiple checks recorded regardless of individual failures
    assertEquals(
      result.value.checks.length >= 2,
      true,
      `Expected at least 2 checks, got ${result.value.checks.length}`,
    );
    // Output should contain the parallel message
    assertStringIncludes(result.value.output, "parallel");
  }

  try {
    Deno.removeSync(config.scriptDir, { recursive: true });
  } catch { /* ignore */ }
});

// =============================================================================
// runChecksParallel — direct unit tests (Issue #1170)
// =============================================================================

Deno.test("runChecksParallel - one throwing check does not prevent others from completing", async () => {
  const executionOrder: string[] = [];

  const checks: Array<() => Promise<CheckExecutionResult>> = [
    async () => {
      executionOrder.push("check-a");
      return { name: "check-a", status: "PASSED" as const, output: "ok" };
    },
    async () => {
      executionOrder.push("check-b-throws");
      throw new Error("unexpected failure in check B");
    },
    async () => {
      executionOrder.push("check-c");
      return { name: "check-c", status: "PASSED" as const, output: "ok" };
    },
  ];

  const results = await runChecksParallel(checks);

  assertEquals(results.length, 3, "All three check results should be returned");

  assertEquals(results[0]!.name, "check-a");
  assertEquals(results[0]!.status, "PASSED");

  assertEquals(results[1]!.status, "FAILED");
  assertStringIncludes(results[1]!.output, "unexpected failure in check B");

  assertEquals(results[2]!.name, "check-c");
  assertEquals(results[2]!.status, "PASSED");

  assertEquals(
    executionOrder.length,
    3,
    "All three checks should have executed",
  );
});

Deno.test("runChecksParallel - rejected promise with non-Error reason is stringified", async () => {
  const checks: Array<() => Promise<CheckExecutionResult>> = [
    () => Promise.reject("plain string rejection"),
    async () => ({
      name: "ok-check",
      status: "PASSED" as const,
      output: "fine",
    }),
  ];

  const results = await runChecksParallel(checks);

  assertEquals(results.length, 2);
  assertEquals(results[0]!.status, "FAILED");
  assertStringIncludes(results[0]!.output, "plain string rejection");
  assertEquals(results[1]!.name, "ok-check");
  assertEquals(results[1]!.status, "PASSED");
});

Deno.test("runChecksParallel - all checks pass returns all results unchanged", async () => {
  const checks: Array<() => Promise<CheckExecutionResult>> = [
    async () => ({ name: "alpha", status: "PASSED" as const, output: "a" }),
    async () => ({ name: "beta", status: "PASSED" as const, output: "b" }),
  ];

  const results = await runChecksParallel(checks);

  assertEquals(results.length, 2);
  assertEquals(results[0]!.name, "alpha");
  assertEquals(results[1]!.name, "beta");
});

// =============================================================================
// Hardcoded branch name check tests (Issue #1182)
// =============================================================================

Deno.test("runQualityGate - hardcoded branch check passes for clean source", async () => {
  const tmpDir = Deno.makeTempDirSync();
  const libDir = `${tmpDir}/worker/deno/lib`;
  Deno.mkdirSync(libDir, { recursive: true });

  Deno.writeTextFileSync(
    `${libDir}/clean.ts`,
    "const branch = await getDefaultBranch(repo);\n",
  );

  const config = createTestConfig({
    scriptDir: tmpDir,
    denoDir: `${tmpDir}/worker/deno`,
  });
  const result = await runQualityGate(config);

  assertEquals(result.ok, true);
  if (result.ok) {
    const branchCheck = result.value.checks.find((c) =>
      c.name === "hardcoded branch names"
    );
    assertEquals(branchCheck !== undefined, true);
    if (branchCheck) {
      assertEquals(branchCheck.status, "PASSED");
    }
  }

  try {
    Deno.removeSync(tmpDir, { recursive: true });
  } catch { /* ignore */ }
});

Deno.test("runQualityGate - hardcoded branch check fails for violating source", async () => {
  const tmpDir = Deno.makeTempDirSync();
  const libDir = `${tmpDir}/worker/deno/lib`;
  Deno.mkdirSync(libDir, { recursive: true });

  Deno.writeTextFileSync(
    `${libDir}/bad.ts`,
    'let defaultBranch = "main";\n',
  );

  const config = createTestConfig({
    scriptDir: tmpDir,
    denoDir: `${tmpDir}/worker/deno`,
  });
  const result = await runQualityGate(config);

  assertEquals(result.ok, true);
  if (result.ok) {
    const branchCheck = result.value.checks.find((c) =>
      c.name === "hardcoded branch names"
    );
    assertEquals(branchCheck !== undefined, true);
    if (branchCheck) {
      assertEquals(branchCheck.status, "FAILED");
    }
  }

  try {
    Deno.removeSync(tmpDir, { recursive: true });
  } catch { /* ignore */ }
});

Deno.test("runQualityGate - hardcoded branch check skips when dirs missing", async () => {
  const tmpDir = Deno.makeTempDirSync();

  const config = createTestConfig({
    scriptDir: tmpDir,
    denoDir: `${tmpDir}/worker/deno`,
  });
  const result = await runQualityGate(config);

  assertEquals(result.ok, true);
  if (result.ok) {
    const branchCheck = result.value.checks.find((c) =>
      c.name === "hardcoded branch names"
    );
    assertEquals(branchCheck !== undefined, true);
    if (branchCheck) {
      assertEquals(branchCheck.status, "SKIPPED");
    }
  }

  try {
    Deno.removeSync(tmpDir, { recursive: true });
  } catch { /* ignore */ }
});

Deno.test("runQualityGate - hardcoded branch check respects allow-list marker", async () => {
  const tmpDir = Deno.makeTempDirSync();
  const libDir = `${tmpDir}/worker/deno/lib`;
  Deno.mkdirSync(libDir, { recursive: true });

  Deno.writeTextFileSync(
    `${libDir}/allowed.ts`,
    'let defaultBranch = "main"; // allow-hardcoded-branch\n',
  );

  const config = createTestConfig({
    scriptDir: tmpDir,
    denoDir: `${tmpDir}/worker/deno`,
  });
  const result = await runQualityGate(config);

  assertEquals(result.ok, true);
  if (result.ok) {
    const branchCheck = result.value.checks.find((c) =>
      c.name === "hardcoded branch names"
    );
    assertEquals(branchCheck !== undefined, true);
    if (branchCheck) {
      assertEquals(branchCheck.status, "PASSED");
    }
  }

  try {
    Deno.removeSync(tmpDir, { recursive: true });
  } catch { /* ignore */ }
});

// =============================================================================
// runDenoCheck — whole-tree type check (Issue #2569)
//
// The gate must type-check every `.ts` file, not just the graph reachable
// from `mod.ts`. Standalone entrypoints (e.g. `quality.ts`, `setup/*.ts`)
// that nothing imports were previously left unchecked. These tests use a
// real `deno check` against a temp tree, so they verify behaviour rather
// than inspecting the command string.
// =============================================================================

function makeDenoCheckConfig(denoDir: string): QualityGateConfig {
  return {
    scriptDir: denoDir,
    denoDir,
    options: { strict: false, sequential: true, validatePrompts: false },
  };
}

Deno.test("runDenoCheck - a cached PASS is reused on the second run with the same inputs, and a source edit busts it (Issue #86)", async () => {
  const tmpDir = await Deno.makeTempDir();
  const cacheDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${tmpDir}/mod.ts`,
      'export const greeting: string = "hi";\n',
    );
    const config: QualityGateConfig = {
      scriptDir: tmpDir,
      denoDir: tmpDir,
      options: { strict: false, sequential: true, validatePrompts: false },
      cacheDir,
    };

    const first = await runDenoCheck(config, "deno");
    assertEquals(first.status, "PASSED");
    // A cold run actually invoked deno check, so its output carries the
    // command's own text, not the cached-skip line.
    assertEquals(first.output.includes("cached"), false);

    const second = await runDenoCheck(config, "deno");
    assertEquals(second.status, "PASSED");
    assertStringIncludes(second.output, "cached");

    // Any source change busts the digest → a real run again, no cache line.
    await Deno.writeTextFile(
      `${tmpDir}/mod.ts`,
      'export const greeting: string = "hello";\n',
    );
    const third = await runDenoCheck(config, "deno");
    assertEquals(third.status, "PASSED");
    assertEquals(third.output.includes("cached"), false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    await Deno.remove(cacheDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("runDenoCheck - a FAILED result is never cached: the next run re-checks (Issue #86)", async () => {
  const tmpDir = await Deno.makeTempDir();
  const cacheDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${tmpDir}/standalone.ts`,
      'const broken: number = "not a number";\nexport { broken };\n',
    );
    const config: QualityGateConfig = {
      scriptDir: tmpDir,
      denoDir: tmpDir,
      options: { strict: false, sequential: true, validatePrompts: false },
      cacheDir,
    };
    const first = await runDenoCheck(config, "deno");
    assertEquals(first.status, "FAILED");
    const second = await runDenoCheck(config, "deno");
    // Still runs (no cached skip on a failing tree) — output is the compiler's,
    // not the cache line.
    assertEquals(second.status, "FAILED");
    assertEquals(second.output.includes("cached"), false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    await Deno.remove(cacheDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("runDenoCheck - FAILED when a standalone entrypoint has a type error", async () => {
  const tmpDir = await Deno.makeTempDir();
  // Clean module graph reachable from mod.ts.
  await Deno.writeTextFile(
    `${tmpDir}/mod.ts`,
    'export const greeting: string = "hi";\n',
  );
  // Top-level standalone entrypoint that mod.ts does NOT import — mirrors
  // quality.ts. It has a deliberate type error. Under the old `deno check
  // mod.ts` gate this file was invisible and the check passed; the
  // whole-tree glob must now catch it.
  await Deno.writeTextFile(
    `${tmpDir}/standalone.ts`,
    'const broken: number = "not a number";\nexport { broken };\n',
  );

  const result = await runDenoCheck(makeDenoCheckConfig(tmpDir), "deno");

  assertEquals(result.status, "FAILED");
  assertStringIncludes(result.output, "standalone.ts");

  try {
    await Deno.remove(tmpDir, { recursive: true });
  } catch { /* ignore */ }
});

Deno.test("runDenoCheck - FAILED when a nested entrypoint has a type error", async () => {
  const tmpDir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${tmpDir}/mod.ts`,
    'export const greeting: string = "hi";\n',
  );
  // Nested standalone entrypoint (mirrors setup/setup_cli.ts) — confirms the
  // glob recurses below the top level too.
  await Deno.mkdir(`${tmpDir}/setup`, { recursive: true });
  await Deno.writeTextFile(
    `${tmpDir}/setup/cli.ts`,
    'const broken: number = "nope";\nexport { broken };\n',
  );

  const result = await runDenoCheck(makeDenoCheckConfig(tmpDir), "deno");

  assertEquals(result.status, "FAILED");
  assertStringIncludes(result.output, "cli.ts");

  try {
    await Deno.remove(tmpDir, { recursive: true });
  } catch { /* ignore */ }
});

Deno.test("runDenoCheck - PASSED when every .ts file type-checks", async () => {
  const tmpDir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${tmpDir}/mod.ts`,
    'export const greeting: string = "hi";\n',
  );
  await Deno.writeTextFile(
    `${tmpDir}/standalone.ts`,
    "export const answer: number = 42;\n",
  );
  await Deno.mkdir(`${tmpDir}/setup`, { recursive: true });
  await Deno.writeTextFile(
    `${tmpDir}/setup/cli.ts`,
    "export const ok = true;\n",
  );

  const result = await runDenoCheck(makeDenoCheckConfig(tmpDir), "deno");

  assertEquals(result.status, "PASSED");
  assertStringIncludes(result.output, "PASSED");

  try {
    await Deno.remove(tmpDir, { recursive: true });
  } catch { /* ignore */ }
});

// =============================================================================
// runDenoFmtCheck — formatting-drift gate (Issue #2940)
//
// `deno lint` was already enforced but `deno fmt --check` was not, so
// formatting drift could merge unnoticed. The gate must run `deno fmt
// --check` against the Deno tree and FAIL when any file is unformatted.
// These tests run a real `deno fmt --check` against a temp tree, so they
// verify behaviour rather than inspecting the command string.
// =============================================================================

Deno.test("runDenoFmtCheck - FAILED when a file is not formatted", async () => {
  const tmpDir = await Deno.makeTempDir();
  // Deliberately mis-formatted: bad indentation and spacing that
  // `deno fmt` would normalise.
  await Deno.writeTextFile(
    `${tmpDir}/messy.ts`,
    "export const x = {a:1,b:2,\n     c:3}\n",
  );

  const result = await runDenoFmtCheck(makeDenoCheckConfig(tmpDir), "deno");

  assertEquals(result.status, "FAILED");
  assertStringIncludes(result.output, "messy.ts");

  try {
    await Deno.remove(tmpDir, { recursive: true });
  } catch { /* ignore */ }
});

Deno.test("runDenoFmtCheck - PASSED when every file is formatted", async () => {
  const tmpDir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${tmpDir}/tidy.ts`,
    'export const greeting: string = "hi";\n',
  );

  const result = await runDenoFmtCheck(makeDenoCheckConfig(tmpDir), "deno");

  assertEquals(result.status, "PASSED");
  assertStringIncludes(result.output, "PASSED");

  try {
    await Deno.remove(tmpDir, { recursive: true });
  } catch { /* ignore */ }
});

Deno.test("runQualityGate - audit skips when test directory missing", async () => {
  const tmpDir = Deno.makeTempDirSync();
  // Deliberately do NOT create the tests directory

  const config = createTestConfig({
    scriptDir: tmpDir,
    denoDir: `${tmpDir}/worker/deno`,
  });
  const result = await runQualityGate(config);

  assertEquals(result.ok, true);
  if (result.ok) {
    const auditCheck = result.value.checks.find((c) =>
      c.name.includes("audit")
    );
    assertEquals(auditCheck !== undefined, true);
    if (auditCheck) {
      assertEquals(auditCheck.status, "SKIPPED");
    }
  }

  try {
    Deno.removeSync(tmpDir, { recursive: true });
  } catch { /* ignore */ }
});

Deno.test("runQualityGate - never records a shellcheck check (Issue #3129)", async () => {
  // Worker-side shellcheck was removed — bash linting is delegated to each
  // target repo's CI. The gate must never record a shellcheck check of any
  // kind, regardless of whether .sh files exist in the tree.
  const config = createTestConfig();
  const result = await runQualityGate(config);

  assertEquals(result.ok, true);
  if (result.ok) {
    const shellcheckCheck = result.value.checks.find(
      (c) => c.name === "shellcheck" || c.name === "shellcheck (changed files)",
    );
    assertEquals(
      shellcheckCheck,
      undefined,
      "the gate must not run or record any shellcheck check",
    );
  }

  try {
    Deno.removeSync(config.scriptDir, { recursive: true });
  } catch { /* ignore */ }
});

// =============================================================================
// Streamed progress (Issue #399)
//
// The gate printed nothing until every check had finished — up to 16 minutes
// on a busy container — so an agent driving it could not tell a slow run from
// a hung one. That is why the `sleep`/`pgrep` poll loops existed. Each check
// must be reported the moment it settles.
// =============================================================================

Deno.test("formatCheckProgress - names the check, its status and its duration (Issue #399)", () => {
  const line = formatCheckProgress({
    name: "deno tests",
    status: "PASSED",
    output: "irrelevant",
    durationMs: 12_300,
  });
  assertStringIncludes(line, "deno tests");
  assertStringIncludes(line, "PASSED");
  assertStringIncludes(line, "12.3s");
});

Deno.test("formatCheckProgress - a check with no measured duration still reports (Issue #399)", () => {
  const line = formatCheckProgress({
    name: "prompt placeholders",
    status: "SKIPPED",
    output: "",
  });
  assertStringIncludes(line, "prompt placeholders");
  assertStringIncludes(line, "SKIPPED");
  assertEquals(line.includes("undefined"), false);
});

Deno.test("runChecksSequential - reports each check before the next one starts (Issue #399)", async () => {
  const events: string[] = [];
  const checks: Array<() => Promise<CheckExecutionResult>> = [
    async () => {
      events.push("start:alpha");
      return { name: "alpha", status: "PASSED" as const, output: "a" };
    },
    async () => {
      events.push("start:beta");
      return { name: "beta", status: "FAILED" as const, output: "b" };
    },
  ];

  const results = await runChecksSequential(checks, (line) => {
    events.push(`progress:${line}`);
  });

  assertEquals(results.length, 2);
  assertEquals(events[0], "start:alpha");
  // The alpha progress line must land BEFORE beta starts — that is what
  // makes a long run observable rather than silent.
  assertStringIncludes(events[1]!, "progress:");
  assertStringIncludes(events[1]!, "alpha");
  assertEquals(events[2], "start:beta");
  assertStringIncludes(events[3]!, "beta");
  assertStringIncludes(events[3]!, "FAILED");
});

Deno.test("runChecksParallel - a fast check is reported while a slow one is still running (Issue #399)", async () => {
  let releaseSlow: () => void = () => {};
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const reported: string[] = [];
  let fastReported: () => void = () => {};
  const fastSeen = new Promise<void>((resolve) => {
    fastReported = resolve;
  });

  const checks: Array<() => Promise<CheckExecutionResult>> = [
    async () => {
      await slowGate;
      return { name: "slow", status: "PASSED" as const, output: "s" };
    },
    async () => ({ name: "fast", status: "PASSED" as const, output: "f" }),
  ];

  const run = runChecksParallel(checks, (line) => {
    reported.push(line);
    if (line.includes("fast")) fastReported();
  });

  // The fast check reports while the slow one is still blocked — no waiting
  // for the whole set to settle.
  await fastSeen;
  assertEquals(reported.length, 1);
  assertStringIncludes(reported[0]!, "fast");

  releaseSlow();
  const results = await run;
  assertEquals(results.length, 2);
  assertEquals(reported.length, 2);
  assertStringIncludes(reported[1]!, "slow");
});

Deno.test("runChecksParallel - a throwing check is still reported (Issue #399)", async () => {
  const reported: string[] = [];
  const checks: Array<() => Promise<CheckExecutionResult>> = [
    () => Promise.reject(new Error("boom")),
  ];

  const results = await runChecksParallel(checks, (line) => {
    reported.push(line);
  });

  assertEquals(results.length, 1);
  assertEquals(results[0]!.status, "FAILED");
  assertEquals(reported.length, 1, "a failure must never be silent");
  assertStringIncludes(reported[0]!, "FAILED");
});

Deno.test("runQualityGate - streams its pre-checks through onProgress (Issue #399)", async () => {
  const lines: string[] = [];
  const config = createTestConfig({ onProgress: (line) => lines.push(line) });

  const result = await runQualityGate(config);
  assertEquals(result.ok, true);

  assertEquals(
    lines.length > 0,
    true,
    "the gate must report progress while it runs, not only at the end",
  );
  if (result.ok) {
    // Every check the gate recorded must have been streamed as it settled,
    // except the tool-missing placeholders recorded after the run.
    const streamed = lines.join("\n");
    const streamedNames = result.value.checks
      .map((c) => c.name)
      .filter((name) => streamed.includes(name));
    assertEquals(
      streamedNames.length > 0,
      true,
      `no recorded check appeared in the progress stream:\n${streamed}`,
    );
  }

  try {
    Deno.removeSync(config.scriptDir, { recursive: true });
  } catch { /* ignore */ }
});

// =============================================================================
// Release-tag ruleset reconciliation (Issue #1049)
//
// The gate stage is three lines of mapping, and getting them wrong is how the
// original drift stayed invisible: a `skipped` reported as PASSED, or a
// `drift` reported as SKIPPED, would leave the gate green over an unenforced
// ruleset. Each outcome is pinned here, with the reconciliation injected so
// no test touches the network.
// =============================================================================

/** A stub reconciler returning one fixed outcome. */
function reconcilerReturning(
  status: "ok" | "drift" | "absent" | "skipped",
  message = `stub ${status}`,
) {
  return () => Promise.resolve({ status, findings: [], message });
}

Deno.test("runReleaseTagRulesetQualityCheck - a matching ruleset PASSES", async () => {
  const config = createTestConfig();
  try {
    const result = await runReleaseTagRulesetQualityCheck(
      config,
      "stSoftwareAU/VibeCoder",
      reconcilerReturning("ok", "matches infra/rulesets/release-tags.json"),
    );
    assertEquals(result.name, "release-tag ruleset");
    assertEquals(result.status, "PASSED");
    assertStringIncludes(result.output, "matches");
  } finally {
    Deno.removeSync(config.scriptDir, { recursive: true });
  }
});

Deno.test("runReleaseTagRulesetQualityCheck - drift and absence FAIL the gate", async () => {
  const config = createTestConfig();
  try {
    for (const status of ["drift", "absent"] as const) {
      const result = await runReleaseTagRulesetQualityCheck(
        config,
        "stSoftwareAU/VibeCoder",
        reconcilerReturning(status),
      );
      assertEquals(result.status, "FAILED", `${status} did not fail the gate`);
      assertStringIncludes(result.output, `stub ${status}`);
    }
  } finally {
    Deno.removeSync(config.scriptDir, { recursive: true });
  }
});

Deno.test("runReleaseTagRulesetQualityCheck - no credential SKIPS, it does not pass", async () => {
  const config = createTestConfig();
  try {
    const result = await runReleaseTagRulesetQualityCheck(
      config,
      "stSoftwareAU/VibeCoder",
      reconcilerReturning("skipped", "SKIPPED: no credential; not a pass"),
    );
    assertEquals(result.status, "SKIPPED");
    assertStringIncludes(result.output, "not a pass");
  } finally {
    Deno.removeSync(config.scriptDir, { recursive: true });
  }
});

Deno.test("runReleaseTagRulesetQualityCheck - an unexpected error is FAILED, never a pass", async () => {
  const config = createTestConfig();
  try {
    const result = await runReleaseTagRulesetQualityCheck(
      config,
      "stSoftwareAU/VibeCoder",
      () => Promise.reject(new Error("HTTP 422: unprocessable")),
    );
    assertEquals(result.status, "FAILED");
    assertStringIncludes(result.output, "422");
  } finally {
    Deno.removeSync(config.scriptDir, { recursive: true });
  }
});
