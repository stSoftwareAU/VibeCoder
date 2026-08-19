/**
 * Tests for fleet_health.ts — FLEET health reporting.
 *
 * Issue #1124: FLEET health reporting migrated from run_core.sh to Deno.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Result } from "../types.ts";
import type {
  FleetHealthConfig,
  FleetHealthDeps,
} from "../lib/fleet_health.ts";
import {
  ACCESS_FAILURE_THRESHOLD,
  recordRepoProbe,
  REPO_ACCESS_LOG_PREFIX,
  resetRepoAccessLogState,
  resetRepoAccessState,
} from "../lib/monitored_repo_access.ts";
import {
  buildCommandFailureError,
  buildFleetHealthConfig,
  createProductionFleetHealthDeps,
  DEFAULT_FLEET_HEALTH_TIMEOUT_MS,
  ensureFleetHealthRepo,
  FleetHealthNotConfiguredError,
  MAX_FAILURE_STREAM_CHARS,
  reportFleetHealth,
  runFleetHealthReporting,
} from "../lib/fleet_health.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a mock FleetHealthDeps for testing. */
function createMockDeps(
  overrides?: Partial<FleetHealthDeps>,
): FleetHealthDeps & {
  logs: string[];
  warnings: string[];
  commands: string[][];
} {
  const logs: string[] = [];
  const warnings: string[] = [];
  const commands: string[][] = [];

  const base: FleetHealthDeps & {
    logs: string[];
    warnings: string[];
    commands: string[][];
  } = {
    logs,
    warnings,
    commands,
    log: (msg: string) => {
      logs.push(msg);
    },
    logWarning: (msg: string) => {
      warnings.push(msg);
    },
    directoryExists: () => Promise.resolve(false),
    fileIsExecutable: () => Promise.resolve(true),
    runCommand: (cmd: string[]) => {
      commands.push(cmd);
      return Promise.resolve({ ok: true, value: undefined } as Result<void>);
    },
    // Verification probes answer "cannot tell" by default (Issue #4218):
    // best-effort verification skips silently, so every pre-existing case
    // keeps its exact behaviour.
    captureCommand: () =>
      Promise.resolve(
        { ok: false, error: new Error("not probed") } as Result<string>,
      ),
  };

  if (overrides) {
    Object.assign(base, overrides);
  }

  return base;
}

/** Create a test FleetHealthConfig. */
function createTestConfig(
  overrides?: Partial<FleetHealthConfig>,
): FleetHealthConfig {
  return {
    healthDir: "/tmp/test-private-repo-6",
    healthRepo: "git@github.com:test/private-repo-6.git",
    hostId: "test-host",
    reportTimeoutMs: DEFAULT_FLEET_HEALTH_TIMEOUT_MS,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildFleetHealthConfig tests
// ---------------------------------------------------------------------------

Deno.test("buildFleetHealthConfig - uses defaults when env vars not set", () => {
  const savedDir = Deno.env.get("FLEET_HEALTH_DIR");
  const savedRepo = Deno.env.get("FLEET_HEALTH_REPO");
  // Host context: the suite also runs inside the worker image, where the
  // container stamp would otherwise engage the Issue #4165 fallback.
  const savedStamp = Deno.env.get("VIBE_IMAGE_AGENT_PROVIDERS");
  Deno.env.delete("VIBE_IMAGE_AGENT_PROVIDERS");
  try {
    Deno.env.delete("FLEET_HEALTH_DIR");
    Deno.env.delete("FLEET_HEALTH_REPO");

    const config = buildFleetHealthConfig("/home/user/VibeCoder");
    assertEquals(config.healthDir, "/home/user/VibeCoder/../private-repo-6");
    // No repository is assumed: the worker only ever clones a URL the
    // operator named through FLEET_HEALTH_REPO.
    assertEquals(config.healthRepo, undefined);
    assertEquals(typeof config.hostId, "string");
    assertEquals(config.hostId.length > 0, true);
  } finally {
    if (savedDir !== undefined) Deno.env.set("FLEET_HEALTH_DIR", savedDir);
    else Deno.env.delete("FLEET_HEALTH_DIR");
    if (savedRepo !== undefined) Deno.env.set("FLEET_HEALTH_REPO", savedRepo);
    else Deno.env.delete("FLEET_HEALTH_REPO");
  }
  if (savedStamp === undefined) Deno.env.delete("VIBE_IMAGE_AGENT_PROVIDERS");
  else Deno.env.set("VIBE_IMAGE_AGENT_PROVIDERS", savedStamp);
});

Deno.test("buildFleetHealthConfig - respects FLEET_HEALTH_DIR env var", () => {
  const saved = Deno.env.get("FLEET_HEALTH_DIR");
  try {
    Deno.env.set("FLEET_HEALTH_DIR", "/custom/health/dir");
    const config = buildFleetHealthConfig("/home/user/VibeCoder");
    assertEquals(config.healthDir, "/custom/health/dir");
  } finally {
    if (saved !== undefined) Deno.env.set("FLEET_HEALTH_DIR", saved);
    else Deno.env.delete("FLEET_HEALTH_DIR");
  }
});

Deno.test("buildFleetHealthConfig - respects FLEET_HEALTH_REPO env var", () => {
  const saved = Deno.env.get("FLEET_HEALTH_REPO");
  try {
    Deno.env.set("FLEET_HEALTH_REPO", "git@custom:org/repo.git");
    const config = buildFleetHealthConfig("/home/user/VibeCoder");
    assertEquals(config.healthRepo, "git@custom:org/repo.git");
  } finally {
    if (saved !== undefined) Deno.env.set("FLEET_HEALTH_REPO", saved);
    else Deno.env.delete("FLEET_HEALTH_REPO");
  }
});

Deno.test("buildFleetHealthConfig - trims domain suffix from hostname", () => {
  const config = buildFleetHealthConfig("/home/user/VibeCoder");
  assertEquals(config.hostId.includes("."), false);
});

Deno.test("buildFleetHealthConfig - defaults reportTimeoutMs to 10 minutes (Issue #3127)", () => {
  const saved = Deno.env.get("FLEET_HEALTH_TIMEOUT_MS");
  try {
    Deno.env.delete("FLEET_HEALTH_TIMEOUT_MS");
    const config = buildFleetHealthConfig("/home/user/VibeCoder");
    assertEquals(config.reportTimeoutMs, 600_000);
    assertEquals(config.reportTimeoutMs, DEFAULT_FLEET_HEALTH_TIMEOUT_MS);
  } finally {
    if (saved !== undefined) Deno.env.set("FLEET_HEALTH_TIMEOUT_MS", saved);
    else Deno.env.delete("FLEET_HEALTH_TIMEOUT_MS");
  }
});

Deno.test("buildFleetHealthConfig - respects FLEET_HEALTH_TIMEOUT_MS env var (Issue #3127)", () => {
  const saved = Deno.env.get("FLEET_HEALTH_TIMEOUT_MS");
  try {
    Deno.env.set("FLEET_HEALTH_TIMEOUT_MS", "900000");
    const config = buildFleetHealthConfig("/home/user/VibeCoder");
    assertEquals(config.reportTimeoutMs, 900_000);
  } finally {
    if (saved !== undefined) Deno.env.set("FLEET_HEALTH_TIMEOUT_MS", saved);
    else Deno.env.delete("FLEET_HEALTH_TIMEOUT_MS");
  }
});

Deno.test("buildFleetHealthConfig - falls back to default on invalid FLEET_HEALTH_TIMEOUT_MS (Issue #3127)", () => {
  const saved = Deno.env.get("FLEET_HEALTH_TIMEOUT_MS");
  try {
    for (const bad of ["not-a-number", "0", "-1", ""]) {
      Deno.env.set("FLEET_HEALTH_TIMEOUT_MS", bad);
      const config = buildFleetHealthConfig("/home/user/VibeCoder");
      assertEquals(config.reportTimeoutMs, DEFAULT_FLEET_HEALTH_TIMEOUT_MS);
    }
  } finally {
    if (saved !== undefined) Deno.env.set("FLEET_HEALTH_TIMEOUT_MS", saved);
    else Deno.env.delete("FLEET_HEALTH_TIMEOUT_MS");
  }
});

// ---------------------------------------------------------------------------
// ensureFleetHealthRepo tests
// ---------------------------------------------------------------------------

Deno.test("ensureFleetHealthRepo - clones when directory does not exist", async () => {
  const deps = createMockDeps({
    directoryExists: () => Promise.resolve(false),
  });
  const config = createTestConfig();

  const result = await ensureFleetHealthRepo(config, deps);

  assertEquals(result.ok, true);
  assertEquals(deps.commands.length, 1);
  const cmd = deps.commands[0]!;
  assertEquals(cmd[0], "git");
  assertEquals(cmd[1], "clone");
  assertEquals(cmd[2], "--depth=1");
  assertEquals(cmd[3], config.healthRepo);
  assertEquals(cmd[4], config.healthDir);
  assertStringIncludes(deps.logs[0]!, "Cloning");
});

Deno.test("ensureFleetHealthRepo - no checkout and no FLEET_HEALTH_REPO: says tracking is off, never clones a guessed URL", async () => {
  const deps = createMockDeps({
    directoryExists: () => Promise.resolve(false),
  });
  const config = { ...createTestConfig(), healthRepo: undefined };

  const result = await ensureFleetHealthRepo(config, deps);

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error instanceof FleetHealthNotConfiguredError, true);
  }
  assertEquals(deps.commands.length, 0, "no git command may run");
  assertEquals(deps.warnings.length, 0, "not configured is not a warning");
  assertStringIncludes(deps.logs[0]!, "FLEET health tracking is off");
  assertStringIncludes(deps.logs[0]!, config.healthDir);
  assertStringIncludes(deps.logs[0]!, "FLEET_HEALTH_REPO");
});

Deno.test("ensureFleetHealthRepo - uses fetch+reset when directory exists (self-heals diverged state)", async () => {
  const deps = createMockDeps({
    directoryExists: () => Promise.resolve(true),
  });
  const config = createTestConfig();

  const result = await ensureFleetHealthRepo(config, deps);

  assertEquals(result.ok, true);
  // Should fetch then reset — NOT pull (pull fails silently on diverged repos)
  assertEquals(deps.commands.length >= 2, true);
  const fetchCmd = deps.commands[0]!;
  assertEquals(fetchCmd[0], "git");
  assertStringIncludes(fetchCmd.join(" "), "fetch");

  const resetCmd = deps.commands[1]!;
  assertEquals(resetCmd[0], "git");
  assertStringIncludes(resetCmd.join(" "), "reset");
  assertStringIncludes(resetCmd.join(" "), "--hard");
});

Deno.test("ensureFleetHealthRepo - logs warning on clone failure", async () => {
  const deps = createMockDeps({
    directoryExists: () => Promise.resolve(false),
    runCommand: () =>
      Promise.resolve({
        ok: false as const,
        error: new Error("Network error"),
      }),
  });
  const config = createTestConfig();

  const result = await ensureFleetHealthRepo(config, deps);

  assertEquals(result.ok, false);
  assertEquals(deps.warnings.length, 1);
  assertStringIncludes(deps.warnings[0]!, "Failed to clone");
});

Deno.test("ensureFleetHealthRepo - logs warning on fetch failure but returns ok", async () => {
  const deps = createMockDeps({
    directoryExists: () => Promise.resolve(true),
    runCommand: () =>
      Promise.resolve({
        ok: false as const,
        error: new Error("Fetch failed"),
      }),
  });
  const config = createTestConfig();

  const result = await ensureFleetHealthRepo(config, deps);

  assertEquals(result.ok, true);
  assertEquals(deps.warnings.length >= 1, true);
  assertStringIncludes(deps.warnings[0]!, "Failed to fetch");
});

Deno.test("ensureFleetHealthRepo - falls back to origin/main when origin/Develop reset fails", async () => {
  let callCount = 0;
  const commands: string[][] = [];
  const deps = createMockDeps({
    directoryExists: () => Promise.resolve(true),
    runCommand: (cmd: string[]) => {
      commands.push(cmd);
      callCount++;
      // Fetch succeeds (call 1), Develop reset fails (call 2), main reset succeeds (call 3)
      if (callCount === 2) {
        return Promise.resolve({
          ok: false as const,
          error: new Error("Reset to Develop failed"),
        });
      }
      return Promise.resolve({ ok: true, value: undefined } as Result<void>);
    },
  });
  Object.defineProperty(deps, "commands", { value: commands });
  const config = createTestConfig();

  const result = await ensureFleetHealthRepo(config, deps);

  assertEquals(result.ok, true);
  // Should have 3 commands: fetch, reset Develop (fail), reset main (success)
  assertEquals(commands.length, 3);
  assertStringIncludes(commands[2]!.join(" "), "origin/main");
});

// ---------------------------------------------------------------------------
// reportFleetHealth tests
// ---------------------------------------------------------------------------

Deno.test("reportFleetHealth - calls health script with correct identity", async () => {
  const deps = createMockDeps();
  const config = createTestConfig({ hostId: "my-machine" });

  const result = await reportFleetHealth(config, deps);

  assertEquals(result.ok, true);
  assertEquals(deps.commands.length, 1);
  const cmd = deps.commands[0]!;
  assertEquals(cmd[0], `${config.healthDir}/helpers/repos.sh`);
  assertEquals(cmd[1], "Vibe Coder:my-machine");
  assertStringIncludes(
    deps.logs[0]!,
    "Reporting health as Vibe Coder:my-machine",
  );
});

Deno.test("reportFleetHealth - passes the configured report timeout to runCommand (Issue #3127)", async () => {
  const seenOptions: Array<{ timeoutMs?: number } | undefined> = [];
  const deps = createMockDeps({
    runCommand: (_cmd: string[], options?: { timeoutMs?: number }) => {
      seenOptions.push(options);
      return Promise.resolve({ ok: true, value: undefined } as Result<void>);
    },
  });
  const config = createTestConfig({ reportTimeoutMs: 600_000 });

  const result = await reportFleetHealth(config, deps);

  assertEquals(result.ok, true);
  assertEquals(seenOptions.length, 1);
  assertEquals(seenOptions[0]?.timeoutMs, 600_000);
});

Deno.test("reportFleetHealth - returns error when script not found", async () => {
  const deps = createMockDeps({
    fileIsExecutable: () => Promise.resolve(false),
  });
  const config = createTestConfig();

  const result = await reportFleetHealth(config, deps);

  assertEquals(result.ok, false);
  assertEquals(deps.commands.length, 0);
  assertEquals(deps.warnings.length, 1);
  assertStringIncludes(deps.warnings[0]!, "not found");
});

Deno.test("reportFleetHealth - production runCommand surfaces stderr on failure with quiet:true (Issue #1979)", async () => {
  // Write a tiny script that emits an exit-trap-style line on stderr and
  // exits non-zero — mirrors private-repo-6's helpers/repos.sh behaviour.
  const tmpDir = await Deno.makeTempDir({ prefix: "private-repo-6-1979-" });
  try {
    const scriptDir = `${tmpDir}/helpers`;
    await Deno.mkdir(scriptDir);
    const scriptPath = `${scriptDir}/repos.sh`;
    await Deno.writeTextFile(
      scriptPath,
      "#!/bin/sh\necho 'repos.sh status=failed reason=network name=\"foo\"' >&2\nexit 1\n",
    );
    await Deno.chmod(scriptPath, 0o755);

    const deps = createProductionFleetHealthDeps();
    // Suppress console noise.
    const warnings: string[] = [];
    deps.log = () => {};
    deps.logWarning = (m: string) => {
      warnings.push(m);
    };

    const result = await reportFleetHealth(
      {
        healthDir: tmpDir,
        healthRepo: "n/a",
        hostId: "test-host",
        reportTimeoutMs: DEFAULT_FLEET_HEALTH_TIMEOUT_MS,
      },
      deps,
    );

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error.message, "Command failed with code 1");
      // The stderr trap line must survive quiet:true.
      assertStringIncludes(result.error.message, "repos.sh status=failed");
      assertStringIncludes(result.error.message, "reason=network");
    }
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0]!, "FLEET health report failed");
    assertStringIncludes(warnings[0]!, "repos.sh status=failed");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("reportFleetHealth - logs warning on script execution failure", async () => {
  const commands: string[][] = [];
  const deps = createMockDeps({
    runCommand: (cmd: string[]) => {
      commands.push(cmd);
      return Promise.resolve({
        ok: false as const,
        error: new Error("Script failed"),
      });
    },
  });
  // Override commands tracking since we replaced runCommand
  deps.commands.length = 0;
  Object.defineProperty(deps, "commands", { value: commands });
  const config = createTestConfig();

  const result = await reportFleetHealth(config, deps);

  assertEquals(result.ok, false);
  assertEquals(deps.warnings.length, 1);
  assertStringIncludes(deps.warnings[0]!, "health report failed");
});

// ---------------------------------------------------------------------------
// buildCommandFailureError tests (Issues #3173, #3174)
// ---------------------------------------------------------------------------

Deno.test("buildCommandFailureError - includes stdout under a label when present", () => {
  const err = buildCommandFailureError(
    1,
    "ERROR: git push failed after 5 attempts\nremote: error: GH006: Protected branch update failed",
    "repos.sh status=failed reason=push-failed",
  );
  // stderr comes first (historical position), then the stdout tail.
  assertStringIncludes(err.message, "Command failed with code 1");
  assertStringIncludes(
    err.message,
    "repos.sh status=failed reason=push-failed",
  );
  assertStringIncludes(err.message, "stdout:");
  assertStringIncludes(err.message, "GH006: Protected branch update failed");
});

Deno.test("buildCommandFailureError - omits stdout label and matches historical form when stdout empty", () => {
  // With quiet:true (e.g. the fetch/reset calls) stdout is discarded, so the
  // message must stay identical to the previous stderr-only behaviour.
  const err = buildCommandFailureError(2, "", "fatal: something broke");
  assertEquals(
    err.message,
    "Command failed with code 2: fatal: something broke",
  );
});

Deno.test("buildCommandFailureError - reports code only when both streams empty", () => {
  const err = buildCommandFailureError(3, "   ", "");
  assertEquals(err.message, "Command failed with code 3");
});

Deno.test("buildCommandFailureError - caps a chatty stdout to its tail", () => {
  const marker = "TAIL-DIAGNOSTIC-MARKER";
  const long = "x".repeat(MAX_FAILURE_STREAM_CHARS + 500) + marker;
  const err = buildCommandFailureError(1, long, "");
  // The useful diagnostics live at the end, so the tail (and the marker) must
  // survive; the leading bulk must be dropped and elided with an ellipsis.
  assertStringIncludes(err.message, marker);
  assertStringIncludes(err.message, "…");
  // Bounded: message cannot contain the full over-length stream.
  assertEquals(err.message.length < long.length, true);
});

// ---------------------------------------------------------------------------
// reportFleetHealth stdout-surfacing regression (Issues #3173, #3174)
// ---------------------------------------------------------------------------

Deno.test("reportFleetHealth - surfaces the real git push rejection printed to stdout (Issue #3174)", async () => {
  // Mirror repos.sh: the terse trap line goes to stderr, but the actual
  // GH006 protected-branch rejection is printed to stdout. The pre-fix code
  // ran with quiet:true and discarded stdout, hiding the cause.
  const tmpDir = await Deno.makeTempDir({ prefix: "private-repo-6-3174-" });
  try {
    const scriptDir = `${tmpDir}/helpers`;
    await Deno.mkdir(scriptDir);
    const scriptPath = `${scriptDir}/repos.sh`;
    await Deno.writeTextFile(
      scriptPath,
      [
        "#!/bin/sh",
        "echo 'ERROR: git push failed after 5 attempts'",
        "echo 'remote: error: GH006: Protected branch update failed for refs/heads/Develop.'",
        "echo ' ! [remote rejected]     Develop -> Develop (protected branch hook declined)'",
        "echo \"repos.sh status=failed reason=push-failed name='Vibe Coder:test-host'\" >&2",
        "exit 1",
        "",
      ].join("\n"),
    );
    await Deno.chmod(scriptPath, 0o755);

    const deps = createProductionFleetHealthDeps();
    const warnings: string[] = [];
    deps.log = () => {};
    deps.logWarning = (m: string) => {
      warnings.push(m);
    };

    const result = await reportFleetHealth(
      {
        healthDir: tmpDir,
        healthRepo: "n/a",
        hostId: "test-host",
        reportTimeoutMs: DEFAULT_FLEET_HEALTH_TIMEOUT_MS,
      },
      deps,
    );

    assertEquals(result.ok, false);
    if (!result.ok) {
      // The stderr trap line still survives.
      assertStringIncludes(result.error.message, "reason=push-failed");
      // The real cause, printed to stdout, is now surfaced too.
      assertStringIncludes(
        result.error.message,
        "GH006: Protected branch update failed",
      );
      assertStringIncludes(
        result.error.message,
        "protected branch hook declined",
      );
    }
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0]!, "FLEET health report failed");
    assertStringIncludes(warnings[0]!, "GH006: Protected branch update failed");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("reportFleetHealth - does not suppress stdout capture (Issue #3173)", async () => {
  // Guard against a regression to quiet:true, which would discard the stdout
  // diagnostics again. reportFleetHealth must not request stdout suppression.
  const seenOptions: Array<{ quiet?: boolean } | undefined> = [];
  const deps = createMockDeps({
    runCommand: (_cmd: string[], options?: { quiet?: boolean }) => {
      seenOptions.push(options);
      return Promise.resolve({ ok: true, value: undefined } as Result<void>);
    },
  });

  const result = await reportFleetHealth(createTestConfig(), deps);

  assertEquals(result.ok, true);
  assertEquals(seenOptions.length, 1);
  assertEquals(seenOptions[0]?.quiet, undefined);
});

// ---------------------------------------------------------------------------
// runFleetHealthReporting tests
// ---------------------------------------------------------------------------

Deno.test("runFleetHealthReporting - syncs repo and reports health", async () => {
  const deps = createMockDeps({
    directoryExists: () => Promise.resolve(true),
  });
  const config = createTestConfig();

  const result = await runFleetHealthReporting(config, deps);

  assertEquals(result.ok, true);
  // fetch + reset + repos.sh = at least 3 commands
  assertEquals(deps.commands.length >= 3, true);
  const fetchCmd = deps.commands[0]!;
  assertStringIncludes(fetchCmd.join(" "), "fetch");
  const healthCmd = deps.commands[deps.commands.length - 1]!;
  assertStringIncludes(healthCmd[0]!, "repos.sh");
});

Deno.test("runFleetHealthReporting - not configured: skips the report too, so the log carries one line, not a failed clone plus a missing script", async () => {
  const deps = createMockDeps({
    directoryExists: () => Promise.resolve(false),
  });
  const config = { ...createTestConfig(), healthRepo: undefined };

  const result = await runFleetHealthReporting(config, deps);

  assertEquals(result.ok, false);
  assertEquals(deps.commands.length, 0);
  assertEquals(deps.warnings.length, 0, deps.warnings.join("\n"));
  assertEquals(deps.logs.length, 1, deps.logs.join("\n"));
});

Deno.test("runFleetHealthReporting - still attempts report after sync failure", async () => {
  let callCount = 0;
  const commands: string[][] = [];
  const deps = createMockDeps({
    directoryExists: () => Promise.resolve(false),
    runCommand: (cmd: string[]) => {
      commands.push(cmd);
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: false as const,
          error: new Error("Clone failed"),
        });
      }
      return Promise.resolve({ ok: true, value: undefined } as Result<void>);
    },
  });
  Object.defineProperty(deps, "commands", { value: commands });
  const config = createTestConfig();

  await runFleetHealthReporting(config, deps);

  assertEquals(commands.length >= 1, true);
});

// ---------------------------------------------------------------------------
// createProductionFleetHealthDeps logger wiring (Issue #2015)
// ---------------------------------------------------------------------------

Deno.test(
  "createProductionFleetHealthDeps - routes log/logWarning through injected Logger so heartbeat output reaches the worker log file (Issue #2015)",
  () => {
    const infoCalls: string[] = [];
    const warnCalls: string[] = [];
    // Minimal Logger stub — only the methods private-repo-6 uses need to fire.
    const logger = {
      info: (msg: string) => {
        infoCalls.push(msg);
      },
      warn: (msg: string) => {
        warnCalls.push(msg);
      },
      error: () => {},
      debug: () => {},
      security: () => {},
      skipReason: () => {},
      timing: () => {},
      scanSummary: () => {},
      workerSummary: () => {},
    };

    const deps = createProductionFleetHealthDeps(logger);
    deps.log("hello from heartbeat");
    deps.logWarning("fleet fetch warning");

    assertEquals(infoCalls, ["hello from heartbeat"]);
    assertEquals(warnCalls, ["fleet fetch warning"]);
  },
);

Deno.test(
  "createProductionFleetHealthDeps - falls back to console output when no Logger passed (standalone command path)",
  () => {
    // Capture console.log / console.error so the test stays quiet and we can
    // assert the fallback still uses them.
    const logCalls: string[] = [];
    const errorCalls: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args: unknown[]) => {
      logCalls.push(args.join(" "));
    };
    console.error = (...args: unknown[]) => {
      errorCalls.push(args.join(" "));
    };
    try {
      const deps = createProductionFleetHealthDeps();
      deps.log("standalone info");
      deps.logWarning("standalone warn");

      assertEquals(logCalls, ["standalone info"]);
      assertEquals(errorCalls, ["WARNING: standalone warn"]);
    } finally {
      console.log = origLog;
      console.error = origError;
    }
  },
);

// ---------------------------------------------------------------------------
// Naming the inaccessible repos (Issue #4039)
// ---------------------------------------------------------------------------

/** Drive `repo` to the inaccessible verdict through the real store. */
function denyToThreshold(repo: string): void {
  for (let i = 0; i < ACCESS_FAILURE_THRESHOLD; i++) {
    recordRepoProbe(repo, "access_denied", 1_700_000_000_000 + i);
  }
}

Deno.test(
  "reportFleetHealth - health payload names every inaccessible repo, comma-separated in the store's order (Issue #4039)",
  async () => {
    resetRepoAccessState();
    try {
      // Recorded out of order — the payload must use the store's stable
      // (lexicographic) order, not the order the probes arrived in.
      denyToThreshold("TitlePage/foo");
      denyToThreshold("TitlePage/bar");

      const deps = createMockDeps();
      const config = createTestConfig({ hostId: "host-3" });

      const result = await reportFleetHealth(config, deps);

      assertEquals(result.ok, true);
      const cmd = deps.commands[0]!;
      // Additive: the script path and identity are exactly as before.
      assertEquals(cmd[0], `${config.healthDir}/helpers/repos.sh`);
      assertEquals(cmd[1], "Vibe Coder:host-3");
      assertEquals(cmd[2], "--message");
      assertEquals(cmd[3], "repos inaccessible: TitlePage/bar, TitlePage/foo");
      assertEquals(cmd.length, 4);
    } finally {
      resetRepoAccessState();
    }
  },
);

Deno.test(
  "reportFleetHealth - a healthy host sends the historical payload and logs nothing (Issue #4039)",
  async () => {
    resetRepoAccessState();
    try {
      const deps = createMockDeps();
      const config = createTestConfig({ hostId: "host-3" });

      const result = await reportFleetHealth(config, deps);

      assertEquals(result.ok, true);
      // Byte-identical to today's invocation — existing private-repo-6
      // consumers of docs/repos.json must not see a new field.
      assertEquals(deps.commands[0], [
        `${config.healthDir}/helpers/repos.sh`,
        "Vibe Coder:host-3",
      ]);
      assertEquals(
        [...deps.logs, ...deps.warnings].filter((l) =>
          l.includes(REPO_ACCESS_LOG_PREFIX)
        ),
        [],
        "a healthy host must stay quiet — no [repo-access] line",
      );
    } finally {
      resetRepoAccessState();
    }
  },
);

Deno.test(
  "reportFleetHealth - emits the structured [repo-access] line naming the repos (Issue #4039)",
  async () => {
    resetRepoAccessState();
    try {
      denyToThreshold("TitlePage/foo");
      denyToThreshold("TitlePage/bar");

      const deps = createMockDeps();
      await reportFleetHealth(createTestConfig({ hostId: "host-3" }), deps);

      const lines = deps.warnings.filter((l) =>
        l.includes(REPO_ACCESS_LOG_PREFIX)
      );
      assertEquals(lines.length, 1);
      assertEquals(
        lines[0],
        "[repo-access] host=host-3 status=inaccessible " +
          `repos=TitlePage/bar,TitlePage/foo consecutive=${ACCESS_FAILURE_THRESHOLD}`,
      );
    } finally {
      resetRepoAccessState();
    }
  },
);

Deno.test(
  "reportFleetHealth - several call sites in one iteration emit exactly one [repo-access] line (Issue #4039)",
  async () => {
    resetRepoAccessState();
    try {
      denyToThreshold("TitlePage/foo");

      const deps = createMockDeps();
      const config = createTestConfig({ hostId: "host-3" });

      // Two call sites within the same iteration: the per-iteration
      // heartbeat and the end-of-run report.
      await reportFleetHealth(config, deps);
      await runFleetHealthReporting(config, deps);

      const lines = deps.warnings.filter((l) =>
        l.includes(REPO_ACCESS_LOG_PREFIX)
      );
      assertEquals(lines.length, 1, "no per-call-site alert spam");
      // Both reports still carry the reason on their payload.
      const messages = deps.commands.filter((c) => c.includes("--message"));
      assertEquals(messages.length, 2);

      // A new iteration boundary re-arms the line so an ongoing outage
      // stays visible in the log.
      resetRepoAccessLogState();
      await reportFleetHealth(config, deps);
      assertEquals(
        deps.warnings.filter((l) => l.includes(REPO_ACCESS_LOG_PREFIX)).length,
        2,
      );
    } finally {
      resetRepoAccessState();
    }
  },
);

Deno.test("buildFleetHealthConfig - container mode clones under the work-dir mount", () => {
  // Issue #4165: the sibling default resolves to the root-owned "/" inside
  // the container ("could not create work tree dir '/workspace/../private-repo-6'"
  // observed live). The work-dir mount is writable and the remote is the
  // repository of record, so a disposable clone belongs there.
  const savedDir = Deno.env.get("FLEET_HEALTH_DIR");
  const savedStamp = Deno.env.get("VIBE_IMAGE_AGENT_PROVIDERS");
  const savedWork = Deno.env.get("WORK_DIR");
  try {
    Deno.env.delete("FLEET_HEALTH_DIR");
    Deno.env.set("VIBE_IMAGE_AGENT_PROVIDERS", "claude");
    Deno.env.set("WORK_DIR", "/home/vibe/auto-issue-work");
    const config = buildFleetHealthConfig("/workspace");
    assertEquals(config.healthDir, "/home/vibe/auto-issue-work/private-repo-6");
  } finally {
    restoreEnvVar("FLEET_HEALTH_DIR", savedDir);
    restoreEnvVar("VIBE_IMAGE_AGENT_PROVIDERS", savedStamp);
    restoreEnvVar("WORK_DIR", savedWork);
  }
});

Deno.test("buildFleetHealthConfig - an explicit FLEET_HEALTH_DIR wins even in container mode", () => {
  const savedDir = Deno.env.get("FLEET_HEALTH_DIR");
  const savedStamp = Deno.env.get("VIBE_IMAGE_AGENT_PROVIDERS");
  try {
    Deno.env.set("FLEET_HEALTH_DIR", "/mnt/telemetry/private-repo-6");
    Deno.env.set("VIBE_IMAGE_AGENT_PROVIDERS", "claude");
    const config = buildFleetHealthConfig("/workspace");
    assertEquals(config.healthDir, "/mnt/telemetry/private-repo-6");
  } finally {
    restoreEnvVar("FLEET_HEALTH_DIR", savedDir);
    restoreEnvVar("VIBE_IMAGE_AGENT_PROVIDERS", savedStamp);
  }
});

/** Restore an env var to its saved value (delete when it was unset). */
function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) Deno.env.delete(name);
  else Deno.env.set(name, value);
}

Deno.test("buildFleetHealthConfig - VIBE_HOST_ID names the real host from inside the container", () => {
  // The container's own hostname is the ephemeral container name
  // (observed live: "Reporting health as Vibe Coder:vibe-coder-66770"),
  // which would leave the real host permanently "dead" on the private-repo-6
  // board and register a phantom host per cycle. The launcher passes the
  // host's identity through VIBE_HOST_ID.
  const savedHost = Deno.env.get("VIBE_HOST_ID");
  try {
    Deno.env.set("VIBE_HOST_ID", "host-23.local");
    const config = buildFleetHealthConfig("/workspace");
    assertEquals(config.hostId, "host-23");
  } finally {
    restoreEnvVar("VIBE_HOST_ID", savedHost);
  }
});

// ---------------------------------------------------------------------------
// Heartbeat outcome verification (Issue #4218)
// ---------------------------------------------------------------------------

/** Deps whose captureCommand answers rev-parse/rev-list from a queue. */
function createVerifyingDeps(queue: Array<Result<string>>): {
  deps: FleetHealthDeps;
  warnings: string[];
} {
  const warnings: string[] = [];
  const deps: FleetHealthDeps = {
    log: () => {},
    logWarning: (msg: string) => {
      warnings.push(msg);
    },
    directoryExists: () => Promise.resolve(true),
    fileIsExecutable: () => Promise.resolve(true),
    runCommand: () => Promise.resolve({ ok: true, value: undefined }),
    captureCommand: () =>
      Promise.resolve(
        queue.shift() ??
          ({ ok: false, error: new Error("queue empty") } as Result<string>),
      ),
  };
  return { deps, warnings };
}

Deno.test("reportFleetHealth - a landed heartbeat verifies quietly (Issue #4218)", async () => {
  const { deps, warnings } = createVerifyingDeps([
    { ok: true, value: "aaa" }, // HEAD before
    { ok: true, value: "bbb" }, // HEAD after — the script committed
    { ok: true, value: "0" }, // nothing left unpushed
  ]);
  const result = await reportFleetHealth(createTestConfig(), deps);
  assertEquals(result.ok, true);
  assertEquals(warnings, []);
});

Deno.test("reportFleetHealth - exit 0 without a commit warns loud (Issue #4218)", async () => {
  // Observed live: the containerised report exited 0 three times in a row
  // while docs/repos.json stayed 25 hours stale — every local signal green,
  // the fleet-health tile dead.
  const { deps, warnings } = createVerifyingDeps([
    { ok: true, value: "aaa" }, // HEAD before
    { ok: true, value: "aaa" }, // HEAD after — nothing committed
  ]);
  const result = await reportFleetHealth(createTestConfig(), deps);
  assertEquals(result.ok, true, "verification is observability, never fatal");
  assertEquals(warnings.length, 1, warnings.join("\n"));
  assert(warnings[0]!.includes("without committing"), warnings[0]);
  assert(warnings[0]!.includes("4218"), warnings[0]);
});

Deno.test("reportFleetHealth - unpushed heartbeat commits warn loud (Issue #4218)", async () => {
  const { deps, warnings } = createVerifyingDeps([
    { ok: true, value: "aaa" },
    { ok: true, value: "bbb" },
    { ok: true, value: "2" }, // committed but the push never landed
  ]);
  const result = await reportFleetHealth(createTestConfig(), deps);
  assertEquals(result.ok, true);
  assertEquals(warnings.length, 1, warnings.join("\n"));
  assert(warnings[0]!.includes("unpushed"), warnings[0]);
});

Deno.test("reportFleetHealth - verification probes failing stays quiet and non-fatal (Issue #4218)", async () => {
  const { deps, warnings } = createVerifyingDeps([
    { ok: false, error: new Error("no upstream") } as Result<string>,
  ]);
  const result = await reportFleetHealth(createTestConfig(), deps);
  assertEquals(result.ok, true);
  assertEquals(warnings, [], "best-effort verification must not add noise");
});

Deno.test("reportFleetHealth - the script's rate-limit skip is not a missing heartbeat (Issue #4243)", async () => {
  // Observed live three seconds after the pipeline's first fully-working
  // in-container heartbeat: a second report took repos.sh's deliberate
  // rate-limit skip (exit 0, HEAD unchanged, by design) and the #4219
  // verification cried "did not land".
  const warnings: string[] = [];
  const deps: FleetHealthDeps = {
    log: () => {},
    logWarning: (msg: string) => {
      warnings.push(msg);
    },
    directoryExists: () => Promise.resolve(true),
    fileIsExecutable: () => Promise.resolve(true),
    runCommand: (_cmd, options) => {
      options?.onOutput?.(
        "Skipping update for 'Vibe Coder:host-23' - last updated 0 minutes ago\n" +
          "repos.sh status=skipped reason=rate-limited name='Vibe Coder:host-23'\n",
      );
      return Promise.resolve({ ok: true, value: undefined });
    },
    captureCommand: () =>
      Promise.resolve({ ok: true, value: "same-head" } as Result<string>),
  };
  const result = await reportFleetHealth(createTestConfig(), deps);
  assertEquals(result.ok, true);
  assertEquals(warnings, [], "a deliberate skip must not warn");
});

Deno.test("reportFleetHealth - a skip whose status line is stderr-only stays quiet (Issue #4243)", async () => {
  // repos.sh writes the human "Skipping update…" line to stdout and the
  // machine-readable status to STDERR; the first fix scanned stdout only
  // and the false positive survived — reproduced on the host.
  const warnings: string[] = [];
  const deps: FleetHealthDeps = {
    log: () => {},
    logWarning: (msg: string) => {
      warnings.push(msg);
    },
    directoryExists: () => Promise.resolve(true),
    fileIsExecutable: () => Promise.resolve(true),
    runCommand: (_cmd, options) => {
      // Only the stdout half — the stderr status line arrives combined by
      // the production runCommand, but the guard must also match this
      // phrasing alone.
      options?.onOutput?.(
        "Skipping update for 'Vibe Coder:host-23' - last updated 2 minutes ago (within 1 hour threshold)\n",
      );
      return Promise.resolve({ ok: true, value: undefined });
    },
    captureCommand: () =>
      Promise.resolve({ ok: true, value: "same-head" } as Result<string>),
  };
  const result = await reportFleetHealth(createTestConfig(), deps);
  assertEquals(result.ok, true);
  assertEquals(
    warnings,
    [],
    "the stdout phrasing alone must also read as a skip",
  );
});

Deno.test("production captureCommand returns the command's stdout (Issue #4252)", async () => {
  // The #4219 verification reads `git rev-parse HEAD` through this dep. It
  // ran the subprocess with quiet:true, which nulls stdout at the OS level —
  // every capture came back empty, "" === "" read as HEAD-unchanged, and a
  // 'did not land' warning fired on every successful report.
  const deps = createProductionFleetHealthDeps();
  const result = await deps.captureCommand(["echo", "captured-4252"]);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, "captured-4252");
});
