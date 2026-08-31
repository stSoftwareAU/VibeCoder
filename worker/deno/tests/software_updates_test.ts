/**
 * Tests for the software updates module (Issue #906, #1496, #3655).
 *
 * Covers scheduling logic (shouldCheckForUpdates, recordUpdateCheck),
 * self-healing retry with exponential backoff (runUpdateWithRetry,
 * classifyUpdateError), per-tool successful-update timestamps
 * (recordSuccessfulUpdate, getLastSuccessfulUpdate), and the release-age
 * quarantine that now gates every upgrade (Issue #3655).
 *
 * Real update commands are not executed — tests inject a fake command
 * runner and sleep so retries are deterministic and fast.
 *
 * **Documented behaviour change (Issue #3655).** Every updater now consults a
 * release-age gate before running an upgrade, and the production default fails
 * closed. Pre-existing updater tests therefore inject `openGate()` so they keep
 * exercising the retry and timestamp behaviour they were written for; no test
 * was removed or weakened. The gate's own behaviour is covered by the new
 * quarantine tests below and by `tool_release_age_test.ts`.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  checkSoftwareUpdates,
  classifyUpdateError,
  compareSemver,
  DEFAULT_UPDATE_INTERVAL_SECONDS,
  DEFAULT_UPDATE_RETRY_BACKOFF_SECONDS,
  DEFAULT_UPDATE_RETRY_MAX_ATTEMPTS,
  DEFAULT_UPDATE_TIMEOUT_SECONDS,
  getLastSuccessfulUpdate,
  ghReleaseArchive,
  installPinnedVersion,
  isVersionBelowFloor,
  parseSemver,
  recordFloorUpdateAttempt,
  recordSuccessfulUpdate,
  recordUpdateCheck,
  resolveDynamicVersion,
  resolveDynamicVersions,
  runUpdateWithRetry,
  runWithTimeout,
  shouldAttemptFloorUpdate,
  shouldCheckForUpdates,
  skipSoftwareUpdateFromEnv,
  softwareUpdateOptionsFromEnv,
  updateClaudeCli,
  updateDeno,
  updateGhCli,
  versionMatchesExactly,
} from "../lib/software_updates.ts";
import {
  describeChannel,
  type ReleaseAgeGate,
  type ReleaseChannel,
} from "../lib/tool_release_age.ts";
import type { LogContext, Logger, Result } from "../types.ts";

/**
 * Gate that approves every channel, resolving a fixed candidate version.
 *
 * The verdict also carries the `ref` the gate dated (Issue #3952) — a `gh`
 * extension upgrade installs exactly that ref, so a verdict without one is
 * skipped rather than upgraded.
 */
function openGate(version = "9.9.9", ref: string | null = version) {
  return {
    quarantineHours: 24,
    check: (channel: ReleaseChannel) =>
      Promise.resolve({
        source: describeChannel(channel),
        version,
        ref,
        eligible: true,
        indeterminate: false,
        ageHours: 100,
        publishedAt: "2026-07-01T00:00:00Z",
        reason: `${describeChannel(channel)}@${version} is 100.0h old.`,
      }),
  } satisfies ReleaseAgeGate;
}

/** Gate that blocks every channel, either as too new or as unverifiable. */
function closedGate(indeterminate = false): ReleaseAgeGate {
  return {
    quarantineHours: 24,
    check: (channel: ReleaseChannel) =>
      Promise.resolve({
        source: describeChannel(channel),
        version: indeterminate ? null : "9.9.9",
        eligible: false,
        indeterminate,
        ageHours: indeterminate ? null : 2,
        publishedAt: indeterminate ? null : "2026-08-02T00:00:00Z",
        reason: indeterminate
          ? `Could not resolve the newest release of ${
            describeChannel(channel)
          }; the upgrade is skipped.`
          : `${describeChannel(channel)} is only 2.0h old (< 24h quarantine).`,
      }),
  };
}

/** Collect logger calls for assertions. */
function testLogger(): {
  logger: Logger;
  infos: string[];
  warns: string[];
  errors: string[];
} {
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  const logger: Logger = {
    info: (m: string, _c?: LogContext) => {
      infos.push(m);
    },
    warn: (m: string, _c?: LogContext) => {
      warns.push(m);
    },
    error: (m: string, _c?: LogContext) => {
      errors.push(m);
    },
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
  return { logger, infos, warns, errors };
}

// ---------- Scheduling (pre-existing behaviour) ----------

Deno.test("software_updates - DEFAULT_UPDATE_INTERVAL_SECONDS is 7 days", () => {
  assertEquals(DEFAULT_UPDATE_INTERVAL_SECONDS, 604800);
});

Deno.test("software_updates - DEFAULT_UPDATE_TIMEOUT_SECONDS is 120", () => {
  assertEquals(DEFAULT_UPDATE_TIMEOUT_SECONDS, 120);
});

Deno.test("software_updates - DEFAULT_UPDATE_RETRY_MAX_ATTEMPTS is 3", () => {
  assertEquals(DEFAULT_UPDATE_RETRY_MAX_ATTEMPTS, 3);
});

Deno.test("software_updates - DEFAULT_UPDATE_RETRY_BACKOFF_SECONDS is [30, 90, 300]", () => {
  assertEquals([...DEFAULT_UPDATE_RETRY_BACKOFF_SECONDS], [30, 90, 300]);
});

Deno.test("software_updates - shouldCheckForUpdates returns true when no timestamp file", () => {
  const result = shouldCheckForUpdates("/tmp/nonexistent_dir_test");
  assertEquals(result, true);
});

Deno.test("software_updates - shouldCheckForUpdates returns true after interval elapsed", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const fixedTime = 1700000000;
    recordUpdateCheck(tmpDir, () => fixedTime);
    const result = shouldCheckForUpdates(
      tmpDir,
      604800,
      () => fixedTime + 691200,
    );
    assertEquals(result, true);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("software_updates - shouldCheckForUpdates returns false within interval", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const fixedTime = 1700000000;
    recordUpdateCheck(tmpDir, () => fixedTime);
    const result = shouldCheckForUpdates(
      tmpDir,
      604800,
      () => fixedTime + 259200,
    );
    assertEquals(result, false);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("software_updates - shouldCheckForUpdates returns true at exact interval boundary", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const fixedTime = 1700000000;
    recordUpdateCheck(tmpDir, () => fixedTime);
    const result = shouldCheckForUpdates(
      tmpDir,
      604800,
      () => fixedTime + 604800,
    );
    assertEquals(result, true);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("software_updates - shouldCheckForUpdates returns true for garbage data", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      `${tmpDir}/.last_software_update_check`,
      "not-a-number",
    );
    const result = shouldCheckForUpdates(tmpDir, 604800, () => 1700000000);
    assertEquals(result, true);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("software_updates - shouldCheckForUpdates returns true for empty file", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(`${tmpDir}/.last_software_update_check`, "");
    const result = shouldCheckForUpdates(tmpDir, 604800, () => 1700000000);
    assertEquals(result, true);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("software_updates - recordUpdateCheck creates timestamp file", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const fixedTime = 1700000000;
    const result = recordUpdateCheck(tmpDir, () => fixedTime);
    assertEquals(result.ok, true);
    const content = Deno.readTextFileSync(
      `${tmpDir}/.last_software_update_check`,
    );
    assertEquals(content, "1700000000");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("software_updates - recordUpdateCheck overwrites previous timestamp", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    recordUpdateCheck(tmpDir, () => 1700000000);
    recordUpdateCheck(tmpDir, () => 1700100000);
    const content = Deno.readTextFileSync(
      `${tmpDir}/.last_software_update_check`,
    );
    assertEquals(content, "1700100000");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("software_updates - custom interval is respected", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const fixedTime = 1700000000;
    recordUpdateCheck(tmpDir, () => fixedTime);
    assertEquals(
      shouldCheckForUpdates(tmpDir, 3600, () => fixedTime + 1800),
      false,
    );
    assertEquals(
      shouldCheckForUpdates(tmpDir, 3600, () => fixedTime + 3660),
      true,
    );
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

// ---------- Per-tool successful-update timestamps (Issue #1496) ----------

Deno.test("software_updates - recordSuccessfulUpdate creates per-tool file", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const result = recordSuccessfulUpdate(tmpDir, "claude", () => 1700000000);
    assertEquals(result.ok, true);
    const content = Deno.readTextFileSync(
      `${tmpDir}/.last_successful_update_claude`,
    );
    assertEquals(content, "1700000000");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("software_updates - recordSuccessfulUpdate is isolated per tool", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    recordSuccessfulUpdate(tmpDir, "claude", () => 1700000000);
    recordSuccessfulUpdate(tmpDir, "gh", () => 1700100000);
    recordSuccessfulUpdate(tmpDir, "deno", () => 1700200000);
    assertEquals(getLastSuccessfulUpdate(tmpDir, "claude"), 1700000000);
    assertEquals(getLastSuccessfulUpdate(tmpDir, "gh"), 1700100000);
    assertEquals(getLastSuccessfulUpdate(tmpDir, "deno"), 1700200000);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("software_updates - getLastSuccessfulUpdate returns null when missing", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    assertEquals(getLastSuccessfulUpdate(tmpDir, "claude"), null);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("software_updates - getLastSuccessfulUpdate returns null for garbage data", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      `${tmpDir}/.last_successful_update_claude`,
      "not-a-number",
    );
    assertEquals(getLastSuccessfulUpdate(tmpDir, "claude"), null);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

// ---------- classifyUpdateError (Issue #1496) ----------

Deno.test("classifyUpdateError - timeout exit codes are transient", () => {
  assertEquals(classifyUpdateError(124, "Timed out after 120s"), "transient");
  assertEquals(classifyUpdateError(137, ""), "transient");
});

Deno.test("classifyUpdateError - network errors are transient", () => {
  assertEquals(
    classifyUpdateError(1, "could not resolve host: registry.example.com"),
    "transient",
  );
  assertEquals(classifyUpdateError(1, "Connection refused"), "transient");
  assertEquals(classifyUpdateError(1, "Connection reset by peer"), "transient");
  assertEquals(classifyUpdateError(1, "Network is unreachable"), "transient");
});

Deno.test("classifyUpdateError - rate limits are transient", () => {
  assertEquals(classifyUpdateError(1, "API rate limit exceeded"), "transient");
  assertEquals(
    classifyUpdateError(1, "HTTP 429 Too Many Requests"),
    "transient",
  );
});

Deno.test("classifyUpdateError - 5xx errors are transient", () => {
  assertEquals(
    classifyUpdateError(1, "HTTP 503 Service Unavailable"),
    "transient",
  );
  assertEquals(classifyUpdateError(1, "HTTP 502 Bad Gateway"), "transient");
});

Deno.test("classifyUpdateError - exit 127 is permanent (missing binary)", () => {
  assertEquals(classifyUpdateError(127, ""), "permanent");
});

Deno.test("classifyUpdateError - auth failures are permanent", () => {
  assertEquals(
    classifyUpdateError(1, "Authentication failed: invalid token"),
    "permanent",
  );
  assertEquals(classifyUpdateError(1, "Unauthorized"), "permanent");
  assertEquals(classifyUpdateError(1, "Permission denied"), "permanent");
  assertEquals(classifyUpdateError(1, "You are not logged in"), "permanent");
  assertEquals(classifyUpdateError(1, "403 Forbidden"), "permanent");
});

Deno.test("classifyUpdateError - unsupported platform is permanent", () => {
  assertEquals(
    classifyUpdateError(1, "Unsupported platform: freebsd"),
    "permanent",
  );
  assertEquals(
    classifyUpdateError(1, "Architecture not supported"),
    "permanent",
  );
});

Deno.test("classifyUpdateError - missing binary output is permanent", () => {
  assertEquals(
    classifyUpdateError(1, "bash: claude: command not found"),
    "permanent",
  );
  assertEquals(
    classifyUpdateError(1, "/usr/local/bin/claude: No such file or directory"),
    "permanent",
  );
});

Deno.test("classifyUpdateError - unknown failures default to transient", () => {
  // An unrecognised non-zero exit with no known signal — allow self-heal.
  assertEquals(classifyUpdateError(1, "Something odd happened"), "transient");
});

// ---------- runUpdateWithRetry (Issue #1496) ----------

interface RunCall {
  cmd: string[];
  timeoutSeconds: number;
}

function makeFakeRunner(
  responses: Array<{ exitCode: number; output: string } | Error>,
  calls: RunCall[],
): (
  cmd: string[],
  timeoutSeconds: number,
) => Promise<Result<{ exitCode: number; output: string }>> {
  return (cmd, timeoutSeconds) => {
    calls.push({ cmd, timeoutSeconds });
    const next = responses.shift();
    if (next === undefined) {
      return Promise.resolve({
        ok: false,
        error: new Error("fake runner: no more responses"),
      });
    }
    if (next instanceof Error) {
      return Promise.resolve({ ok: false, error: next });
    }
    return Promise.resolve({ ok: true, value: next });
  };
}

Deno.test("runUpdateWithRetry - happy path succeeds on first attempt", async () => {
  const { logger } = testLogger();
  const calls: RunCall[] = [];
  const sleeps: number[] = [];
  const result = await runUpdateWithRetry(
    logger,
    "test-tool",
    ["test-tool", "update"],
    {
      runFn: makeFakeRunner([{ exitCode: 0, output: "up to date" }], calls),
      sleepFn: (s: number) => {
        sleeps.push(s);
        return Promise.resolve();
      },
    },
  );
  assertEquals(result.success, true);
  assertEquals(result.attempts, 1);
  assertEquals(result.finalExitCode, 0);
  assertEquals(calls.length, 1);
  assertEquals(sleeps, []);
});

Deno.test("runUpdateWithRetry - transient retry succeeds on attempt 2", async () => {
  const { logger } = testLogger();
  const calls: RunCall[] = [];
  const sleeps: number[] = [];
  const result = await runUpdateWithRetry(
    logger,
    "test-tool",
    ["test-tool", "update"],
    {
      runFn: makeFakeRunner(
        [
          { exitCode: 1, output: "network timeout" },
          { exitCode: 0, output: "updated" },
        ],
        calls,
      ),
      sleepFn: (s: number) => {
        sleeps.push(s);
        return Promise.resolve();
      },
    },
  );
  assertEquals(result.success, true);
  assertEquals(result.attempts, 2);
  assertEquals(calls.length, 2);
  // Waited the first backoff between attempt 1 and 2.
  assertEquals(sleeps, [30]);
});

Deno.test("runUpdateWithRetry - permanent failure does not retry", async () => {
  const { logger, warns } = testLogger();
  const calls: RunCall[] = [];
  const sleeps: number[] = [];
  const result = await runUpdateWithRetry(
    logger,
    "test-tool",
    ["test-tool", "update"],
    {
      runFn: makeFakeRunner(
        [{ exitCode: 1, output: "Authentication failed" }],
        calls,
      ),
      sleepFn: (s: number) => {
        sleeps.push(s);
        return Promise.resolve();
      },
    },
  );
  assertEquals(result.success, false);
  assertEquals(result.attempts, 1);
  assertEquals(result.classification, "permanent");
  assertEquals(calls.length, 1);
  assertEquals(sleeps, []);
  assertEquals(warns.some((m) => m.includes("permanently")), true);
});

Deno.test("runUpdateWithRetry - all attempts fail returns gracefully (worker not blocked)", async () => {
  const { logger, warns } = testLogger();
  const calls: RunCall[] = [];
  const sleeps: number[] = [];
  const result = await runUpdateWithRetry(
    logger,
    "test-tool",
    ["test-tool", "update"],
    {
      runFn: makeFakeRunner(
        [
          { exitCode: 1, output: "network timeout" },
          { exitCode: 1, output: "network timeout" },
          { exitCode: 1, output: "network timeout" },
        ],
        calls,
      ),
      sleepFn: (s: number) => {
        sleeps.push(s);
        return Promise.resolve();
      },
    },
  );
  assertEquals(result.success, false);
  assertEquals(result.attempts, 3);
  assertEquals(result.classification, "transient");
  assertEquals(calls.length, 3);
  // Two sleeps between three attempts, using the first two backoff entries.
  assertEquals(sleeps, [30, 90]);
  assertEquals(warns.some((m) => m.includes("after 3 attempts")), true);
});

Deno.test("runUpdateWithRetry - respects custom backoff schedule", async () => {
  const { logger } = testLogger();
  const calls: RunCall[] = [];
  const sleeps: number[] = [];
  const result = await runUpdateWithRetry(
    logger,
    "test-tool",
    ["test-tool", "update"],
    {
      maxAttempts: 3,
      backoffSeconds: [5, 10, 20],
      runFn: makeFakeRunner(
        [
          { exitCode: 1, output: "rate limit" },
          { exitCode: 1, output: "rate limit" },
          { exitCode: 0, output: "ok" },
        ],
        calls,
      ),
      sleepFn: (s: number) => {
        sleeps.push(s);
        return Promise.resolve();
      },
    },
  );
  assertEquals(result.success, true);
  assertEquals(result.attempts, 3);
  assertEquals(sleeps, [5, 10]);
});

Deno.test("runUpdateWithRetry - spawn error is treated as transient and retried", async () => {
  const { logger } = testLogger();
  const calls: RunCall[] = [];
  const sleeps: number[] = [];
  const result = await runUpdateWithRetry(
    logger,
    "test-tool",
    ["test-tool", "update"],
    {
      runFn: makeFakeRunner(
        [
          new Error("spawn failed: ENOMEM"),
          { exitCode: 0, output: "ok" },
        ],
        calls,
      ),
      sleepFn: (s: number) => {
        sleeps.push(s);
        return Promise.resolve();
      },
    },
  );
  assertEquals(result.success, true);
  assertEquals(result.attempts, 2);
  assertEquals(calls.length, 2);
});

Deno.test("runUpdateWithRetry - passes timeout through to runner", async () => {
  const { logger } = testLogger();
  const calls: RunCall[] = [];
  await runUpdateWithRetry(
    logger,
    "test-tool",
    ["test-tool", "update"],
    {
      timeout: 42,
      runFn: makeFakeRunner([{ exitCode: 0, output: "" }], calls),
      sleepFn: () => Promise.resolve(),
    },
  );
  assertEquals(calls[0]?.timeoutSeconds, 42);
});

// ---------- Per-tool update integration (Issue #1496) ----------

Deno.test("updateClaudeCli - skip does not invoke runner", async () => {
  const { logger, infos } = testLogger();
  const calls: RunCall[] = [];
  await updateClaudeCli(logger, {
    skip: true,
    retry: {
      runFn: makeFakeRunner([], calls),
      sleepFn: () => Promise.resolve(),
    },
  });
  assertEquals(calls.length, 0);
  assertEquals(infos.some((m) => m.includes("skipped")), true);
});

Deno.test("updateClaudeCli - success records per-tool timestamp", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger } = testLogger();
    const calls: RunCall[] = [];
    await updateClaudeCli(logger, {
      timestampDir: tmpDir,
      now: () => 1700000000,
      ageGate: openGate(),
      retry: {
        runFn: makeFakeRunner([{ exitCode: 0, output: "" }], calls),
        sleepFn: () => Promise.resolve(),
      },
    });
    assertEquals(getLastSuccessfulUpdate(tmpDir, "claude"), 1700000000);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("updateClaudeCli - transient retry succeeds and persists timestamp", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger } = testLogger();
    const calls: RunCall[] = [];
    await updateClaudeCli(logger, {
      timestampDir: tmpDir,
      now: () => 1700000000,
      ageGate: openGate(),
      retry: {
        runFn: makeFakeRunner(
          [
            { exitCode: 1, output: "timeout" },
            { exitCode: 0, output: "ok" },
          ],
          calls,
        ),
        sleepFn: () => Promise.resolve(),
      },
    });
    assertEquals(calls.length, 2);
    assertEquals(getLastSuccessfulUpdate(tmpDir, "claude"), 1700000000);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("updateClaudeCli - all-fail does not record timestamp and does not throw", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger, warns } = testLogger();
    const calls: RunCall[] = [];
    await updateClaudeCli(logger, {
      timestampDir: tmpDir,
      now: () => 1700000000,
      ageGate: openGate(),
      retry: {
        runFn: makeFakeRunner(
          [
            { exitCode: 1, output: "network error" },
            { exitCode: 1, output: "network error" },
            { exitCode: 1, output: "network error" },
          ],
          calls,
        ),
        sleepFn: () => Promise.resolve(),
      },
    });
    assertEquals(calls.length, 3);
    assertEquals(getLastSuccessfulUpdate(tmpDir, "claude"), null);
    assertEquals(warns.length > 0, true);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("updateClaudeCli - permanent failure does not retry and does not persist", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger } = testLogger();
    const calls: RunCall[] = [];
    await updateClaudeCli(logger, {
      timestampDir: tmpDir,
      now: () => 1700000000,
      ageGate: openGate(),
      retry: {
        runFn: makeFakeRunner(
          [{ exitCode: 1, output: "Authentication failed" }],
          calls,
        ),
        sleepFn: () => Promise.resolve(),
      },
    });
    assertEquals(calls.length, 1);
    assertEquals(getLastSuccessfulUpdate(tmpDir, "claude"), null);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("updateDeno - absent binary skips without retry", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger, infos } = testLogger();
    const calls: RunCall[] = [];
    // First response is the `which deno` probe reporting exit 1 (not installed).
    await updateDeno(logger, {
      timestampDir: tmpDir,
      retry: {
        runFn: makeFakeRunner([{ exitCode: 1, output: "" }], calls),
        sleepFn: () => Promise.resolve(),
      },
    });
    assertEquals(calls.length, 1);
    assertEquals(calls[0]?.cmd, ["which", "deno"]);
    assertEquals(infos.some((m) => m.includes("not installed")), true);
    assertEquals(getLastSuccessfulUpdate(tmpDir, "deno"), null);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("updateDeno - present binary runs upgrade with retry", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger } = testLogger();
    const calls: RunCall[] = [];
    await updateDeno(logger, {
      timestampDir: tmpDir,
      now: () => 1700000000,
      ageGate: openGate("2.9.0"),
      retry: {
        runFn: makeFakeRunner(
          [
            { exitCode: 0, output: "/usr/local/bin/deno" }, // which deno
            { exitCode: 1, output: "timeout" }, // attempt 1
            { exitCode: 0, output: "upgraded" }, // attempt 2
          ],
          calls,
        ),
        sleepFn: () => Promise.resolve(),
      },
    });
    assertEquals(calls.length, 3);
    // Issue #3655: the upgrade is pinned to the version the gate approved.
    assertEquals(calls[1]?.cmd, ["deno", "upgrade", "2.9.0"]);
    assertEquals(getLastSuccessfulUpdate(tmpDir, "deno"), 1700000000);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("updateGhCli - brew missing skips binary upgrade but still upgrades extensions", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger } = testLogger();
    const calls: RunCall[] = [];
    await updateGhCli(logger, {
      timestampDir: tmpDir,
      now: () => 1700000000,
      ageGate: openGate(),
      retry: {
        runFn: makeFakeRunner(
          [
            { exitCode: 1, output: "" }, // which brew
            { exitCode: 0, output: "gh dash\tdlvhdr/gh-dash\tv4.6.0" }, // list
            { exitCode: 0, output: "upgraded" }, // pinned extension install
          ],
          calls,
        ),
        sleepFn: () => Promise.resolve(),
      },
    });
    assertEquals(calls.length, 3);
    assertEquals(calls[0]?.cmd, ["which", "brew"]);
    // Issue #3655: extensions are enumerated and upgraded individually so each
    // can be age-checked, instead of a wholesale `upgrade --all`.
    assertEquals(calls[1]?.cmd, ["gh", "extension", "list"]);
    // Issue #3952: the install is pinned to the ref the gate dated.
    assertEquals(calls[2]?.cmd, [
      "gh",
      "extension",
      "install",
      "dlvhdr/gh-dash",
      "--pin",
      "9.9.9",
      "--force",
    ]);
    assertEquals(getLastSuccessfulUpdate(tmpDir, "gh"), 1700000000);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

// ---------- Version floor: semver parsing & comparison (Issue #2622) ----------

Deno.test("parseSemver - parses Claude --version output", () => {
  assertEquals(parseSemver("2.1.170 (Claude Code)"), [2, 1, 170]);
});

Deno.test("parseSemver - parses leading v prefix", () => {
  assertEquals(parseSemver("v1.2.3"), [1, 2, 3]);
});

Deno.test("parseSemver - parses gh version output", () => {
  assertEquals(parseSemver("gh version 2.40.0 (2024-01-01)"), [2, 40, 0]);
});

Deno.test("parseSemver - returns null for unparseable output", () => {
  assertEquals(parseSemver("not a version"), null);
});

Deno.test("compareSemver - numeric per segment (2.1.170 > 2.1.9)", () => {
  // String comparison would wrongly order "2.1.170" < "2.1.9".
  assertEquals(compareSemver([2, 1, 170], [2, 1, 9]) > 0, true);
});

Deno.test("compareSemver - equal triples compare to zero", () => {
  assertEquals(compareSemver([2, 1, 170], [2, 1, 170]), 0);
});

Deno.test("compareSemver - lower major compares negative", () => {
  assertEquals(compareSemver([1, 9, 9], [2, 0, 0]) < 0, true);
});

Deno.test("isVersionBelowFloor - true when below floor", () => {
  assertEquals(isVersionBelowFloor("2.1.9 (Claude Code)", "2.1.170"), true);
});

Deno.test("isVersionBelowFloor - false when equal to floor", () => {
  assertEquals(isVersionBelowFloor("2.1.170 (Claude Code)", "2.1.170"), false);
});

Deno.test("isVersionBelowFloor - false when above floor", () => {
  assertEquals(isVersionBelowFloor("2.2.0 (Claude Code)", "2.1.170"), false);
});

Deno.test("isVersionBelowFloor - null when output unparseable", () => {
  assertEquals(isVersionBelowFloor("garbage", "2.1.170"), null);
});

// ---------- Floor-attempt backoff timestamps (Issue #2622) ----------

Deno.test("shouldAttemptFloorUpdate - true when no record exists", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    assertEquals(
      shouldAttemptFloorUpdate(tmpDir, "claude", 604800, () => 1700000000),
      true,
    );
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("shouldAttemptFloorUpdate - false within interval, true after", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const t = 1700000000;
    recordFloorUpdateAttempt(tmpDir, "claude", () => t);
    assertEquals(
      shouldAttemptFloorUpdate(tmpDir, "claude", 604800, () => t + 1000),
      false,
    );
    assertEquals(
      shouldAttemptFloorUpdate(tmpDir, "claude", 604800, () => t + 604800),
      true,
    );
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

// ---------- checkSoftwareUpdates floor orchestration (Issue #2622) ----------

/** Fake runner that always succeeds, recording the commands it was given. */
function alwaysOkRunner(
  calls: RunCall[],
): (
  cmd: string[],
  timeoutSeconds: number,
) => Promise<Result<{ exitCode: number; output: string }>> {
  return (cmd, timeoutSeconds) => {
    calls.push({ cmd, timeoutSeconds });
    return Promise.resolve({ ok: true, value: { exitCode: 0, output: "ok" } });
  };
}

Deno.test("checkSoftwareUpdates - below floor triggers update despite recent interval", async () => {
  const { logger } = testLogger();
  const tmpDir = Deno.makeTempDirSync();
  try {
    const now = 1700000000;
    recordUpdateCheck(tmpDir, () => now); // interval NOT elapsed
    const calls: RunCall[] = [];
    let reads = 0;
    await checkSoftwareUpdates(logger, {
      // Host context: the suite also runs inside the worker image, where
      // the container stamp would otherwise suppress the update under test.
      env: () => undefined,
      timestampDir: tmpDir,
      intervalSeconds: 604800,
      now: () => now + 100,
      minVersions: { claude: "2.1.170" },
      readVersion: (tool) => {
        reads++;
        if (tool !== "claude") return Promise.resolve(null);
        // First read: below floor; post-update read: at floor.
        return Promise.resolve(
          reads === 1 ? "2.1.9 (Claude Code)" : "2.1.170 (Claude Code)",
        );
      },
      ageGate: openGate(),
      retry: { runFn: alwaysOkRunner(calls), sleepFn: () => Promise.resolve() },
    });
    // Claude update ran even though the interval said "not yet".
    assertEquals(
      calls.some((c) => c.cmd[0] === "claude" && c.cmd[1] === "update"),
      true,
    );
    // gh and deno did NOT run (interval not elapsed, no floor).
    assertEquals(calls.some((c) => c.cmd[0] === "gh"), false);
    assertEquals(calls.some((c) => c.cmd[0] === "deno"), false);
    // A floor attempt was recorded → backoff now blocks an immediate re-trigger.
    assertEquals(
      shouldAttemptFloorUpdate(tmpDir, "claude", 604800, () => now + 200),
      false,
    );
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("checkSoftwareUpdates - at/above floor preserves interval skip", async () => {
  const { logger, infos } = testLogger();
  const tmpDir = Deno.makeTempDirSync();
  try {
    const now = 1700000000;
    recordUpdateCheck(tmpDir, () => now); // interval NOT elapsed
    const calls: RunCall[] = [];
    await checkSoftwareUpdates(logger, {
      // Host context: the suite also runs inside the worker image, where
      // the container stamp would otherwise suppress the update under test.
      env: () => undefined,
      timestampDir: tmpDir,
      intervalSeconds: 604800,
      now: () => now + 100,
      minVersions: { claude: "2.1.170" },
      readVersion: () => Promise.resolve("2.1.170 (Claude Code)"),
      ageGate: openGate(),
      retry: { runFn: alwaysOkRunner(calls), sleepFn: () => Promise.resolve() },
    });
    // No updates ran; existing skip behaviour preserved.
    assertEquals(calls.length, 0);
    assertEquals(infos.some((m) => m.includes("checked recently")), true);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("checkSoftwareUpdates - interval elapsed runs all three tools", async () => {
  const { logger } = testLogger();
  const tmpDir = Deno.makeTempDirSync();
  try {
    const now = 1700000000;
    // No timestamp recorded → interval elapsed.
    const calls: RunCall[] = [];
    await checkSoftwareUpdates(logger, {
      // Host context: the suite also runs inside the worker image, where
      // the container stamp would otherwise suppress the update under test.
      env: () => undefined,
      timestampDir: tmpDir,
      intervalSeconds: 604800,
      now: () => now,
      minVersions: { claude: "2.1.170" },
      readVersion: () => Promise.resolve("2.5.0 (Claude Code)"), // above floor
      ageGate: openGate(),
      retry: { runFn: alwaysOkRunner(calls), sleepFn: () => Promise.resolve() },
    });
    assertEquals(
      calls.some((c) => c.cmd[0] === "claude" && c.cmd[1] === "update"),
      true,
    );
    assertEquals(calls.some((c) => c.cmd[0] === "gh"), true);
    assertEquals(calls.some((c) => c.cmd[0] === "deno"), true);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("checkSoftwareUpdates - unparseable version falls back to interval with warning", async () => {
  const { logger, warns } = testLogger();
  const tmpDir = Deno.makeTempDirSync();
  try {
    const now = 1700000000;
    recordUpdateCheck(tmpDir, () => now); // interval NOT elapsed
    const calls: RunCall[] = [];
    await checkSoftwareUpdates(logger, {
      // Host context: the suite also runs inside the worker image, where
      // the container stamp would otherwise suppress the update under test.
      env: () => undefined,
      timestampDir: tmpDir,
      intervalSeconds: 604800,
      now: () => now + 100,
      minVersions: { claude: "2.1.170" },
      readVersion: () => Promise.resolve("totally unparseable output"),
      ageGate: openGate(),
      retry: { runFn: alwaysOkRunner(calls), sleepFn: () => Promise.resolve() },
    });
    // Never blocks: no update, falls back to interval (which says skip).
    assertEquals(calls.length, 0);
    assertEquals(warns.some((m) => m.includes("Could not parse")), true);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("checkSoftwareUpdates - unreadable version falls back to interval with warning", async () => {
  const { logger, warns } = testLogger();
  const tmpDir = Deno.makeTempDirSync();
  try {
    const now = 1700000000;
    recordUpdateCheck(tmpDir, () => now);
    const calls: RunCall[] = [];
    await checkSoftwareUpdates(logger, {
      // Host context: the suite also runs inside the worker image, where
      // the container stamp would otherwise suppress the update under test.
      env: () => undefined,
      timestampDir: tmpDir,
      intervalSeconds: 604800,
      now: () => now + 100,
      minVersions: { claude: "2.1.170" },
      readVersion: () => Promise.resolve(null),
      ageGate: openGate(),
      retry: { runFn: alwaysOkRunner(calls), sleepFn: () => Promise.resolve() },
    });
    assertEquals(calls.length, 0);
    assertEquals(warns.some((m) => m.includes("Could not read")), true);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("checkSoftwareUpdates - floor still unmet after update logs warning", async () => {
  const { logger, warns } = testLogger();
  const tmpDir = Deno.makeTempDirSync();
  try {
    const now = 1700000000;
    recordUpdateCheck(tmpDir, () => now); // interval NOT elapsed
    const calls: RunCall[] = [];
    await checkSoftwareUpdates(logger, {
      // Host context: the suite also runs inside the worker image, where
      // the container stamp would otherwise suppress the update under test.
      env: () => undefined,
      timestampDir: tmpDir,
      intervalSeconds: 604800,
      now: () => now + 100,
      minVersions: { claude: "2.1.170" },
      // Always below floor — update cannot reach it.
      readVersion: () => Promise.resolve("2.1.9 (Claude Code)"),
      ageGate: openGate(),
      retry: { runFn: alwaysOkRunner(calls), sleepFn: () => Promise.resolve() },
    });
    assertEquals(
      calls.some((c) => c.cmd[0] === "claude" && c.cmd[1] === "update"),
      true,
    );
    assertEquals(
      warns.some((m) => m.includes("still below the required version floor")),
      true,
    );
    // Floor attempt recorded → no retry-loop on the next iteration.
    assertEquals(
      shouldAttemptFloorUpdate(tmpDir, "claude", 604800, () => now + 200),
      false,
    );
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("checkSoftwareUpdates - recent floor attempt defers re-trigger (no loop)", async () => {
  const { logger, infos } = testLogger();
  const tmpDir = Deno.makeTempDirSync();
  try {
    const now = 1700000000;
    recordUpdateCheck(tmpDir, () => now); // interval NOT elapsed
    recordFloorUpdateAttempt(tmpDir, "claude", () => now); // recent attempt
    const calls: RunCall[] = [];
    await checkSoftwareUpdates(logger, {
      // Host context: the suite also runs inside the worker image, where
      // the container stamp would otherwise suppress the update under test.
      env: () => undefined,
      timestampDir: tmpDir,
      intervalSeconds: 604800,
      now: () => now + 100,
      minVersions: { claude: "2.1.170" },
      readVersion: () => Promise.resolve("2.1.9 (Claude Code)"), // below floor
      ageGate: openGate(),
      retry: { runFn: alwaysOkRunner(calls), sleepFn: () => Promise.resolve() },
    });
    // Deferred: no update ran this iteration.
    assertEquals(calls.length, 0);
    assertEquals(infos.some((m) => m.includes("deferring")), true);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("checkSoftwareUpdates - skipClaude wins but logs unmet floor", async () => {
  const { logger, warns } = testLogger();
  const tmpDir = Deno.makeTempDirSync();
  try {
    const now = 1700000000;
    recordUpdateCheck(tmpDir, () => now); // interval NOT elapsed
    const calls: RunCall[] = [];
    await checkSoftwareUpdates(logger, {
      // Host context: the suite also runs inside the worker image, where
      // the container stamp would otherwise suppress the update under test.
      env: () => undefined,
      timestampDir: tmpDir,
      intervalSeconds: 604800,
      now: () => now + 100,
      minVersions: { claude: "2.1.170" },
      skipClaude: true,
      readVersion: () => Promise.resolve("2.1.9 (Claude Code)"), // below floor
      ageGate: openGate(),
      retry: { runFn: alwaysOkRunner(calls), sleepFn: () => Promise.resolve() },
    });
    // Update suppressed: the runner was never asked to run `claude update`.
    assertEquals(
      calls.some((c) => c.cmd[0] === "claude" && c.cmd[1] === "update"),
      false,
    );
    assertEquals(
      warns.some((m) =>
        m.includes("suppressed") && m.includes("SKIP_CLAUDE_UPDATE")
      ),
      true,
    );
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

// =============================================================================
// runWithTimeout — timer-leak regression (Issue #3167)
// =============================================================================

Deno.test("runWithTimeout - success path returns output and leaks no timer", async () => {
  // A fast command under a large timeout. If the timeout timer were left
  // queued (the pre-#3167 bug), Deno's default op sanitiser would fail this
  // test with a leaked-timer error.
  const result = await runWithTimeout(["echo", "hello"], 300);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.exitCode, 0);
    assertEquals(result.value.output, "hello");
  }
});

Deno.test("runWithTimeout - captures non-zero exit code", async () => {
  const result = await runWithTimeout(["sh", "-c", "exit 7"], 300);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.exitCode, 7);
  }
});

Deno.test("runWithTimeout - returns exitCode 124 on timeout", async () => {
  const result = await runWithTimeout(["sh", "-c", "sleep 30"], 1);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.exitCode, 124);
    assertEquals(result.value.output.includes("Timed out"), true);
  }
});

Deno.test("runWithTimeout - returns error for non-existent executable", async () => {
  const result = await runWithTimeout(["nonexistent_cmd_3167_xyz"], 300);
  assertEquals(result.ok, false);
});

// ---------- Release-age quarantine (Issue #3655) ----------

Deno.test("updateClaudeCli - a release inside the quarantine window is not installed", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger, infos } = testLogger();
    const calls: RunCall[] = [];
    await updateClaudeCli(logger, {
      timestampDir: tmpDir,
      now: () => 1700000000,
      ageGate: closedGate(),
      retry: {
        runFn: makeFakeRunner([{ exitCode: 0, output: "" }], calls),
        sleepFn: () => Promise.resolve(),
      },
    });
    assertEquals(calls.length, 0);
    assertEquals(getLastSuccessfulUpdate(tmpDir, "claude"), null);
    assertEquals(infos.some((m) => m.includes("deferred")), true);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("updateClaudeCli - an unverifiable release age fails closed and warns", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger, warns } = testLogger();
    const calls: RunCall[] = [];
    await updateClaudeCli(logger, {
      timestampDir: tmpDir,
      now: () => 1700000000,
      ageGate: closedGate(true),
      retry: {
        runFn: makeFakeRunner([{ exitCode: 0, output: "" }], calls),
        sleepFn: () => Promise.resolve(),
      },
    });
    assertEquals(calls.length, 0);
    assertEquals(getLastSuccessfulUpdate(tmpDir, "claude"), null);
    assertStringIncludes(warns.join("\n"), "Claude CLI upgrade skipped");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("updateDeno - a release inside the quarantine window is not installed", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger } = testLogger();
    const calls: RunCall[] = [];
    await updateDeno(logger, {
      timestampDir: tmpDir,
      now: () => 1700000000,
      ageGate: closedGate(),
      retry: {
        runFn: makeFakeRunner(
          [{ exitCode: 0, output: "/usr/local/bin/deno" }],
          calls,
        ),
        sleepFn: () => Promise.resolve(),
      },
    });
    // Only the `which deno` presence probe ran — no upgrade.
    assertEquals(calls.length, 1);
    assertEquals(calls[0]?.cmd, ["which", "deno"]);
    assertEquals(getLastSuccessfulUpdate(tmpDir, "deno"), null);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("updateGhCli - a quarantined gh release skips the brew upgrade", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger } = testLogger();
    const calls: RunCall[] = [];
    await updateGhCli(logger, {
      timestampDir: tmpDir,
      now: () => 1700000000,
      ageGate: closedGate(),
      retry: {
        runFn: makeFakeRunner(
          [
            { exitCode: 0, output: "/opt/homebrew/bin/brew" }, // which brew
            { exitCode: 0, output: "gh dash\tdlvhdr/gh-dash\tv4.6.0" }, // list
          ],
          calls,
        ),
        sleepFn: () => Promise.resolve(),
      },
    });
    assertEquals(calls.map((c) => c.cmd[0]), ["which", "gh"]);
    assertEquals(calls.some((c) => c.cmd[0] === "brew"), false);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("updateGhCli - a quarantined extension is not upgraded", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger, infos } = testLogger();
    const calls: RunCall[] = [];
    await updateGhCli(logger, {
      timestampDir: tmpDir,
      now: () => 1700000000,
      ageGate: closedGate(),
      retry: {
        runFn: makeFakeRunner(
          [
            { exitCode: 1, output: "" }, // which brew — absent
            { exitCode: 0, output: "gh dash\tdlvhdr/gh-dash\tv4.6.0" }, // list
          ],
          calls,
        ),
        sleepFn: () => Promise.resolve(),
      },
    });
    assertEquals(calls.length, 2);
    assertEquals(
      calls.some((c) => c.cmd.includes("upgrade")),
      false,
    );
    assertStringIncludes(infos.join("\n"), "gh extension dlvhdr/gh-dash");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("updateGhCli - only the aged extension of a mixed pair is upgraded", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger } = testLogger();
    const calls: RunCall[] = [];
    /** Approves `gh-dash`, quarantines `gh-poi`. */
    const mixedGate: ReleaseAgeGate = {
      quarantineHours: 24,
      check: (channel: ReleaseChannel) => {
        const source = describeChannel(channel);
        const eligible = source.includes("gh-dash");
        return Promise.resolve({
          source,
          version: "1.0.0",
          ref: "v1.0.0",
          eligible,
          indeterminate: false,
          ageHours: eligible ? 100 : 1,
          publishedAt: "2026-07-01T00:00:00Z",
          reason: `${source} age verdict`,
        });
      },
    };
    await updateGhCli(logger, {
      timestampDir: tmpDir,
      now: () => 1700000000,
      ageGate: mixedGate,
      retry: {
        runFn: makeFakeRunner(
          [
            { exitCode: 1, output: "" }, // which brew — absent
            {
              exitCode: 0,
              output: "gh dash\tdlvhdr/gh-dash\tv4.6.0\n" +
                "gh poi\tseachicken/gh-poi\tv0.11.1",
            },
            { exitCode: 0, output: "upgraded" }, // pinned install of gh-dash
          ],
          calls,
        ),
        sleepFn: () => Promise.resolve(),
      },
    });
    assertEquals(calls.length, 3);
    assertEquals(calls[2]?.cmd, [
      "gh",
      "extension",
      "install",
      "dlvhdr/gh-dash",
      "--pin",
      "v1.0.0",
      "--force",
    ]);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

// ---------- gh extension refs are installed as dated (Issue #3952) ----------

Deno.test("updateGhCli - a binary extension is installed at the dated tag", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger } = testLogger();
    const calls: RunCall[] = [];
    await updateGhCli(logger, {
      timestampDir: tmpDir,
      now: () => 1700000000,
      // The gate dated release v4.25.2; the upgrade must install that same ref.
      ageGate: openGate("4.25.2", "v4.25.2"),
      retry: {
        runFn: makeFakeRunner(
          [
            { exitCode: 1, output: "" }, // which brew — absent
            { exitCode: 0, output: "gh dash\tdlvhdr/gh-dash\tv4.25.1" },
            { exitCode: 0, output: "upgraded from v4.25.1 to v4.25.2" },
          ],
          calls,
        ),
        sleepFn: () => Promise.resolve(),
      },
    });
    assertEquals(calls[2]?.cmd, [
      "gh",
      "extension",
      "install",
      "dlvhdr/gh-dash",
      "--pin",
      "v4.25.2",
      "--force",
    ]);
    assertEquals(getLastSuccessfulUpdate(tmpDir, "gh"), 1700000000);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("updateGhCli - a script extension is installed at the dated HEAD sha", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger } = testLogger();
    const calls: RunCall[] = [];
    const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    await updateGhCli(logger, {
      timestampDir: tmpDir,
      now: () => 1700000000,
      ageGate: openGate(sha.slice(0, 12), sha),
      retry: {
        runFn: makeFakeRunner(
          [
            { exitCode: 1, output: "" }, // which brew — absent
            { exitCode: 0, output: "gh branch\tmislav/gh-branch\t7ed0aff7" },
            { exitCode: 0, output: "installed" },
          ],
          calls,
        ),
        sleepFn: () => Promise.resolve(),
      },
    });
    assertEquals(calls[2]?.cmd, [
      "gh",
      "extension",
      "install",
      "mislav/gh-branch",
      "--pin",
      sha,
      "--force",
    ]);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("updateGhCli - an extension whose HEAD cannot be dated is skipped, not upgraded", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger, warns } = testLogger();
    const calls: RunCall[] = [];
    await updateGhCli(logger, {
      timestampDir: tmpDir,
      now: () => 1700000000,
      ageGate: closedGate(true), // indeterminate — no datable ref
      retry: {
        runFn: makeFakeRunner(
          [
            { exitCode: 1, output: "" }, // which brew — absent
            { exitCode: 0, output: "gh branch\tmislav/gh-branch\t7ed0aff7" },
          ],
          calls,
        ),
        sleepFn: () => Promise.resolve(),
      },
    });
    assertEquals(calls.length, 2);
    assertEquals(calls.some((c) => c.cmd.includes("install")), false);
    assertStringIncludes(warns.join("\n"), "gh extension mislav/gh-branch");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("updateGhCli - an approved verdict without a ref is reported, not installed", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger, warns } = testLogger();
    const calls: RunCall[] = [];
    await updateGhCli(logger, {
      timestampDir: tmpDir,
      now: () => 1700000000,
      // Eligible, but nothing to pin to — installing would fetch an undated ref.
      ageGate: openGate("9.9.9", null),
      retry: {
        runFn: makeFakeRunner(
          [
            { exitCode: 1, output: "" }, // which brew — absent
            { exitCode: 0, output: "gh dash\tdlvhdr/gh-dash\tv4.6.0" },
          ],
          calls,
        ),
        sleepFn: () => Promise.resolve(),
      },
    });
    assertEquals(calls.length, 2);
    assertStringIncludes(warns.join("\n"), "no dated ref to pin");
    // Nothing was upgraded, so the run is not recorded as a clean success.
    assertEquals(getLastSuccessfulUpdate(tmpDir, "gh"), null);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("updateGhCli - unenumerable extensions upgrade nothing and warn", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger, warns } = testLogger();
    const calls: RunCall[] = [];
    await updateGhCli(logger, {
      timestampDir: tmpDir,
      now: () => 1700000000,
      ageGate: openGate(),
      retry: {
        runFn: makeFakeRunner(
          [
            { exitCode: 1, output: "" }, // which brew — absent
            { exitCode: 1, output: "gh: not logged in" }, // list fails
          ],
          calls,
        ),
        sleepFn: () => Promise.resolve(),
      },
    });
    assertEquals(calls.length, 2);
    assertStringIncludes(warns.join("\n"), "Could not enumerate gh extensions");
    assertEquals(getLastSuccessfulUpdate(tmpDir, "gh"), null);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("updateGhCli - no installed extensions still records success", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger, infos } = testLogger();
    const calls: RunCall[] = [];
    await updateGhCli(logger, {
      timestampDir: tmpDir,
      now: () => 1700000000,
      ageGate: openGate(),
      retry: {
        runFn: makeFakeRunner(
          [
            { exitCode: 1, output: "" }, // which brew — absent
            { exitCode: 0, output: "" }, // no extensions installed
          ],
          calls,
        ),
        sleepFn: () => Promise.resolve(),
      },
    });
    assertEquals(calls.length, 2);
    assertStringIncludes(infos.join("\n"), "No gh extensions installed");
    assertEquals(getLastSuccessfulUpdate(tmpDir, "gh"), 1700000000);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

// ---------- Environment-derived options (Issue #3655) ----------

Deno.test("softwareUpdateOptionsFromEnv - reads the documented skip flags", () => {
  const env: Record<string, string> = {
    HOME: "/home/worker",
    SKIP_CLAUDE_UPDATE: "true",
    SKIP_GH_UPDATE: "true",
    SKIP_DENO_UPDATE: "true",
  };
  const options = softwareUpdateOptionsFromEnv({}, (n) => env[n]);
  assertEquals(options.skipClaude, true);
  assertEquals(options.skipGh, true);
  assertEquals(options.skipDeno, true);
  assertEquals(options.timestampDir, "/home/worker");
});

Deno.test("softwareUpdateOptionsFromEnv - unset skip flags default to false", () => {
  const options = softwareUpdateOptionsFromEnv({}, () => undefined);
  assertEquals(options.skipClaude, false);
  assertEquals(options.skipGh, false);
  assertEquals(options.skipDeno, false);
  assertEquals(options.quarantineHours, undefined);
});

Deno.test("softwareUpdateOptionsFromEnv - carries config floors and retry policy", () => {
  const options = softwareUpdateOptionsFromEnv(
    {
      softwareMinVersions: { claude: "2.1.170" },
      updateRetryMaxAttempts: 5,
      updateRetryBackoffSeconds: [1, 2],
    },
    () => undefined,
  );
  assertEquals(options.minVersions, { claude: "2.1.170" });
  assertEquals(options.retry?.maxAttempts, 5);
  assertEquals([...(options.retry?.backoffSeconds ?? [])], [1, 2]);
});

Deno.test("softwareUpdateOptionsFromEnv - reads the quarantine window and interval", () => {
  const env: Record<string, string> = {
    VIBE_BUMP_QUARANTINE_HOURS: "72",
    SOFTWARE_UPDATE_CHECK_INTERVAL_SECONDS: "3600",
    CLAUDE_UPDATE_TIMEOUT: "240",
    SOFTWARE_UPDATE_TIMESTAMP_DIR: "/var/state",
  };
  const options = softwareUpdateOptionsFromEnv({}, (n) => env[n]);
  assertEquals(options.quarantineHours, 72);
  assertEquals(options.intervalSeconds, 3600);
  assertEquals(options.timeout, 240);
  assertEquals(options.timestampDir, "/var/state");
});

Deno.test("softwareUpdateOptionsFromEnv - rejects non-numeric env values", () => {
  const env: Record<string, string> = { VIBE_BUMP_QUARANTINE_HOURS: "0.5" };
  const options = softwareUpdateOptionsFromEnv({}, (n) => env[n]);
  assertEquals(options.quarantineHours, undefined);
});

Deno.test("skipSoftwareUpdateFromEnv - honours SKIP_SOFTWARE_UPDATE", () => {
  assertEquals(
    skipSoftwareUpdateFromEnv((n) =>
      n === "SKIP_SOFTWARE_UPDATE" ? "true" : undefined
    ),
    true,
  );
  assertEquals(skipSoftwareUpdateFromEnv(() => undefined), false);
  assertEquals(
    skipSoftwareUpdateFromEnv((n) =>
      n === "SKIP_SOFTWARE_UPDATE" ? "false" : undefined
    ),
    false,
  );
});

Deno.test("skipSoftwareUpdateFromEnv - the contained worker never self-updates", () => {
  // Issue #4062: the image is the update mechanism. An in-container update
  // installs unpinned packages at run time into an ephemeral VM — repeated
  // every run, lost on exit, and outside the image's supply-chain pins
  // (observed live: claude 2.1.223→2.1.233 npm-installed into the VM, and a
  // deno self-update retry loop). The container stamp suppresses the step.
  assertEquals(
    skipSoftwareUpdateFromEnv((n) =>
      n === "VIBE_IMAGE_AGENT_PROVIDERS" ? "claude" : undefined
    ),
    true,
  );
});

Deno.test("checkSoftwareUpdates - the container stamp suppresses every caller", async () => {
  // Defence in depth for Issue #4062: the bootstrap consults
  // skipSoftwareUpdateFromEnv before calling, but run-core's periodic path
  // called this entry directly — observed live running the weekly check
  // inside the container. The gate inside the entry covers every caller,
  // present and future.
  const commands: string[][] = [];
  const logs: string[] = [];
  const logger = {
    info: (m: string) => logs.push(m),
    error: (m: string) => logs.push(m),
    warn: (m: string) => logs.push(m),
    debug: (m: string) => logs.push(m),
  } as unknown as Parameters<typeof checkSoftwareUpdates>[0];

  const dir = await Deno.makeTempDir();
  try {
    await checkSoftwareUpdates(logger, {
      timestampDir: dir,
      env: (name) =>
        name === "VIBE_IMAGE_AGENT_PROVIDERS" ? "claude" : undefined,
      retry: {
        runFn: (cmd) => {
          commands.push(cmd);
          return Promise.resolve({
            ok: true as const,
            value: { exitCode: 0, output: "" },
          });
        },
      },
    });
    assertEquals(commands, []);
    assertEquals(
      logs.some((line) => /container.*image|image.*container/i.test(line)),
      true,
      logs.join("\n"),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------- Exact-version (pinned) installs (Issue #623) ----------

/**
 * Runner that answers by command shape rather than by call order.
 *
 * The pinned-install path interleaves version reads with install steps, so a
 * positional queue would be brittle. Every response is scripted here — no test
 * reaches a real network, installer, or binary.
 */
function makePinnedRunner(
  handler: (cmd: string[]) => { exitCode: number; output: string } | Error,
  calls: RunCall[],
): (
  cmd: string[],
  timeoutSeconds: number,
) => Promise<Result<{ exitCode: number; output: string }>> {
  return (cmd, timeoutSeconds) => {
    calls.push({ cmd, timeoutSeconds });
    const response = handler(cmd);
    if (response instanceof Error) {
      return Promise.resolve({ ok: false, error: response });
    }
    return Promise.resolve({ ok: true, value: response });
  };
}

/** Version output that reports `version` for `tool`, changing after install. */
function versionSequence(versions: string[]): () => string {
  let index = 0;
  return () => versions[Math.min(index++, versions.length - 1)]!;
}

Deno.test("updateClaudeCli - targetVersion installs that exact npm tarball", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger, infos } = testLogger();
    const calls: RunCall[] = [];
    const claudeVersion = versionSequence([
      "2.1.100 (Claude Code)",
      "2.1.200 (Claude Code)",
    ]);
    await updateClaudeCli(logger, {
      targetVersion: "2.1.200",
      timestampDir: tmpDir,
      now: () => 1700000000,
      retry: {
        runFn: makePinnedRunner((cmd) => {
          if (cmd[0] === "claude") {
            return { exitCode: 0, output: claudeVersion() };
          }
          return { exitCode: 0, output: "" };
        }, calls),
        sleepFn: () => Promise.resolve(),
      },
    });

    const curl = calls.find((c) => c.cmd[0] === "curl");
    assertStringIncludes(
      curl?.cmd.at(-1) ?? "",
      "@anthropic-ai/claude-code/-/claude-code-2.1.200.tgz",
    );
    const npm = calls.find((c) => c.cmd[0] === "npm");
    assertEquals(npm?.cmd.slice(0, 4), [
      "npm",
      "install",
      "-g",
      "--ignore-scripts",
    ]);
    assertEquals(npm?.cmd.at(-1), curl?.cmd[3]);
    // The staged tarball is cleaned up rather than left on the host.
    assertEquals(calls.some((c) => c.cmd[0] === "rm"), true);
    assertEquals(getLastSuccessfulUpdate(tmpDir, "claude"), 1700000000);
    assertEquals(
      infos.some((m) => m.includes("now at the pinned version 2.1.200")),
      true,
    );
    // The unpinned `claude update` path is not taken.
    assertEquals(
      calls.some((c) => c.cmd[0] === "claude" && c.cmd[1] === "update"),
      false,
    );
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("updateClaudeCli - a tool already at the pinned version is left alone", async () => {
  const { logger, infos } = testLogger();
  const calls: RunCall[] = [];
  await updateClaudeCli(logger, {
    targetVersion: "2.1.200",
    retry: {
      runFn: makePinnedRunner(
        () => ({ exitCode: 0, output: "2.1.200 (Claude Code)" }),
        calls,
      ),
      sleepFn: () => Promise.resolve(),
    },
  });
  assertEquals(calls.map((c) => c.cmd), [["claude", "--version"]]);
  assertEquals(
    infos.some((m) => m.includes("already at the pinned version 2.1.200")),
    true,
  );
});

Deno.test("updateClaudeCli - a version mismatch after install fails loud", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger } = testLogger();
    const calls: RunCall[] = [];
    const error = await assertRejects(
      () =>
        updateClaudeCli(logger, {
          targetVersion: "2.1.200",
          timestampDir: tmpDir,
          retry: {
            runFn: makePinnedRunner((cmd) => {
              if (cmd[0] === "claude") {
                return { exitCode: 0, output: "2.1.100 (Claude Code)" };
              }
              return { exitCode: 0, output: "" };
            }, calls),
            sleepFn: () => Promise.resolve(),
          },
        }),
      Error,
    );
    assertStringIncludes(error.message, "requested 2.1.200");
    assertStringIncludes(error.message, "installed 2.1.100");
    assertEquals(getLastSuccessfulUpdate(tmpDir, "claude"), null);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("updateClaudeCli - a failed pinned install fails loud", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger } = testLogger();
    const calls: RunCall[] = [];
    const error = await assertRejects(
      () =>
        updateClaudeCli(logger, {
          targetVersion: "2.1.200",
          timestampDir: tmpDir,
          retry: {
            maxAttempts: 1,
            runFn: makePinnedRunner((cmd) => {
              if (cmd[0] === "claude") {
                return { exitCode: 0, output: "2.1.100 (Claude Code)" };
              }
              if (cmd[0] === "curl") {
                return { exitCode: 22, output: "HTTP 404 not found" };
              }
              return { exitCode: 0, output: "" };
            }, calls),
            sleepFn: () => Promise.resolve(),
          },
        }),
      Error,
    );
    assertStringIncludes(error.message, "pinned install of 2.1.200 failed");
    assertStringIncludes(error.message, "curl");
    // The install step never runs once the download failed.
    assertEquals(calls.some((c) => c.cmd[0] === "npm"), false);
    assertEquals(getLastSuccessfulUpdate(tmpDir, "claude"), null);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("installPinnedVersion - a malformed version is refused before any command", async () => {
  const { logger } = testLogger();
  const calls: RunCall[] = [];
  const error = await assertRejects(
    () =>
      installPinnedVersion(logger, "claude", "2.1.200; rm -rf /", {
        retry: {
          runFn: makePinnedRunner(() => ({ exitCode: 0, output: "" }), calls),
        },
      }),
    Error,
  );
  assertStringIncludes(error.message, "is not a valid version");
  assertEquals(calls.length, 0);
});

Deno.test("updateGhCli - targetVersion installs that exact release archive", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger } = testLogger();
    const calls: RunCall[] = [];
    const ghVersion = versionSequence([
      "gh version 2.60.0 (2026-01-01)",
      "gh version 2.62.0 (2026-02-02)",
    ]);
    await updateGhCli(logger, {
      targetVersion: "2.62.0",
      timestampDir: tmpDir,
      now: () => 1700000000,
      retry: {
        runFn: makePinnedRunner((cmd) => {
          if (cmd[0] === "gh") return { exitCode: 0, output: ghVersion() };
          if (cmd[0] === "which") {
            return { exitCode: 0, output: "/usr/local/bin/gh\n" };
          }
          return { exitCode: 0, output: "" };
        }, calls),
        sleepFn: () => Promise.resolve(),
      },
    });

    const curl = calls.find((c) => c.cmd[0] === "curl");
    assertStringIncludes(curl?.cmd.at(-1) ?? "", "cli/cli/releases/download/");
    assertStringIncludes(curl?.cmd.at(-1) ?? "", "gh_2.62.0_");
    const install = calls.find((c) => c.cmd[0] === "install");
    assertEquals(install?.cmd.slice(0, 3), ["install", "-m", "0755"]);
    assertStringIncludes(install?.cmd[3] ?? "", "gh_2.62.0_");
    assertEquals(install?.cmd.at(-1), "/usr/local/bin/gh");
    assertEquals(getLastSuccessfulUpdate(tmpDir, "gh"), 1700000000);
    // Neither brew nor the extension sweep runs on the pinned path.
    assertEquals(calls.some((c) => c.cmd[0] === "brew"), false);
    assertEquals(calls.some((c) => c.cmd[1] === "extension"), false);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("updateGhCli - an unlocatable gh binary fails loud", async () => {
  const { logger } = testLogger();
  const calls: RunCall[] = [];
  const error = await assertRejects(
    () =>
      updateGhCli(logger, {
        targetVersion: "2.62.0",
        retry: {
          runFn: makePinnedRunner((cmd) => {
            if (cmd[0] === "gh") {
              return { exitCode: 0, output: "gh version 2.60.0 (2026-01-01)" };
            }
            return { exitCode: 1, output: "" };
          }, calls),
          sleepFn: () => Promise.resolve(),
        },
      }),
    Error,
  );
  assertStringIncludes(error.message, "could not be located");
  assertEquals(calls.some((c) => c.cmd[0] === "curl"), false);
});

Deno.test("ghReleaseArchive - names the published archive per platform", () => {
  assertEquals(ghReleaseArchive("2.62.0", "linux", "x86_64"), {
    dir: "gh_2.62.0_linux_amd64",
    archive: "gh_2.62.0_linux_amd64.tar.gz",
    zipped: false,
    url:
      "https://github.com/cli/cli/releases/download/v2.62.0/gh_2.62.0_linux_amd64.tar.gz",
  });
  const mac = ghReleaseArchive("2.62.0", "darwin", "aarch64");
  assertEquals(mac?.dir, "gh_2.62.0_macOS_arm64");
  assertEquals(mac?.zipped, true);
  assertEquals(ghReleaseArchive("2.62.0", "windows", "x86_64"), null);
  assertEquals(ghReleaseArchive("2.62.0", "linux", "riscv64"), null);
});

Deno.test("updateDeno - targetVersion pins the upgrade instead of the gate verdict", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger } = testLogger();
    const calls: RunCall[] = [];
    const denoVersion = versionSequence([
      "deno 2.5.0 (stable)",
      "deno 2.6.1 (stable)",
    ]);
    await updateDeno(logger, {
      targetVersion: "2.6.1",
      timestampDir: tmpDir,
      now: () => 1700000000,
      // A gate that would block the unpinned path is irrelevant when pinned.
      ageGate: closedGate(),
      retry: {
        runFn: makePinnedRunner((cmd) => {
          if (cmd[1] === "--version") {
            return { exitCode: 0, output: denoVersion() };
          }
          return { exitCode: 0, output: "" };
        }, calls),
        sleepFn: () => Promise.resolve(),
      },
    });
    assertEquals(
      calls.some((c) => c.cmd.join(" ") === "deno upgrade 2.6.1"),
      true,
    );
    assertEquals(getLastSuccessfulUpdate(tmpDir, "deno"), 1700000000);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("updateDeno - no targetVersion still pins to the gate verdict", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { logger } = testLogger();
    const calls: RunCall[] = [];
    await updateDeno(logger, {
      timestampDir: tmpDir,
      now: () => 1700000000,
      ageGate: openGate("9.9.9"),
      retry: {
        runFn: makePinnedRunner(() => ({ exitCode: 0, output: "" }), calls),
        sleepFn: () => Promise.resolve(),
      },
    });
    assertEquals(calls[0]?.cmd, ["which", "deno"]);
    assertEquals(calls[1]?.cmd, ["deno", "upgrade", "9.9.9"]);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("resolveDynamicVersions - reports what dynamic mode would install now", async () => {
  const { logger } = testLogger();
  const candidates = await resolveDynamicVersions(logger, {
    ageGate: openGate("7.7.7"),
  });
  assertEquals(candidates.map((c) => c.tool), ["claude", "gh", "deno"]);
  assertEquals(candidates.every((c) => c.version === "7.7.7"), true);
  assertEquals(candidates.every((c) => c.eligible), true);
});

Deno.test("resolveDynamicVersion - an unresolvable version is reported as a failure", async () => {
  const { logger } = testLogger();
  const candidate = await resolveDynamicVersion(logger, "gh", {
    ageGate: closedGate(true),
  });
  assertEquals(candidate.version, null);
  assertEquals(candidate.eligible, false);
  assertStringIncludes(candidate.reason, "Could not resolve");
});

Deno.test("versionMatchesExactly - exact match, mismatch, and unparseable", () => {
  assertEquals(versionMatchesExactly("2.1.200 (Claude Code)", "2.1.200"), true);
  assertEquals(
    versionMatchesExactly("2.1.100 (Claude Code)", "2.1.200"),
    false,
  );
  assertEquals(versionMatchesExactly("unknown", "2.1.200"), null);
});

// ---------- Frozen update mode (Issue #625) ----------

/** Pinned versions a frozen host in these tests is held at. */
const FROZEN_PINS = { claude: "2.0.76", gh: "2.62.0", deno: "2.5.4" };

/** Run `body` with a temporary state directory, always removed afterwards. */
async function withTempDir(
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = Deno.makeTempDirSync();
  try {
    await body(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

/**
 * Runner for a frozen host, answering each tool's `--version` from its own
 * sequence so an install is observed as a version change.
 *
 * `versions[tool]` supplies the readings in order: the first is what the host
 * reports before any install, the rest what it reports afterwards.
 */
function frozenRunner(
  calls: RunCall[],
  versions: Record<string, string[]>,
): (
  cmd: string[],
  timeoutSeconds: number,
) => Promise<Result<{ exitCode: number; output: string }>> {
  const readers: Record<string, () => string> = {};
  for (const [tool, sequence] of Object.entries(versions)) {
    readers[tool] = versionSequence(sequence);
  }
  return makePinnedRunner((cmd) => {
    const reader = readers[cmd[0] ?? ""];
    if (cmd[1] === "--version" && reader) {
      return { exitCode: 0, output: reader() };
    }
    if (cmd[0] === "which" && cmd[1] === "gh") {
      return { exitCode: 0, output: "/usr/local/bin/gh\n" };
    }
    return { exitCode: 0, output: "" };
  }, calls);
}

Deno.test("checkSoftwareUpdates - frozen mode installs each tool at its pin", async () => {
  await withTempDir(async (tmpDir) => {
    const { logger, infos } = testLogger();
    const now = 1700000000;
    // Interval NOT elapsed: a frozen host converges on its pins at launch,
    // not on the weekly cadence.
    recordUpdateCheck(tmpDir, () => now);
    const calls: RunCall[] = [];
    await checkSoftwareUpdates(logger, {
      env: () => undefined,
      timestampDir: tmpDir,
      now: () => now + 100,
      updateMode: "frozen",
      pinnedToolVersions: FROZEN_PINS,
      // A gate that blocks every channel must not block a pinned install.
      ageGate: closedGate(),
      retry: {
        runFn: frozenRunner(calls, {
          claude: ["2.1.100 (Claude Code)", "2.0.76 (Claude Code)"],
          gh: [
            "gh version 2.70.0 (2026-01-01)",
            "gh version 2.62.0 (2026-02-02)",
          ],
          deno: ["deno 2.6.0 (stable)", "deno 2.5.4 (stable)"],
        }),
        sleepFn: () => Promise.resolve(),
      },
    });

    // Claude CLI: the exact npm tarball, not `claude update`.
    const claudeCurl = calls.find((c) =>
      c.cmd[0] === "curl" && (c.cmd.at(-1) ?? "").includes("claude-code-")
    );
    assertStringIncludes(
      claudeCurl?.cmd.at(-1) ?? "",
      "claude-code-2.0.76.tgz",
    );
    assertEquals(
      calls.some((c) => c.cmd[0] === "claude" && c.cmd[1] === "update"),
      false,
    );
    // gh: the exact release archive, not brew and not the extension sweep.
    assertEquals(
      calls.some((c) =>
        c.cmd[0] === "curl" && (c.cmd.at(-1) ?? "").includes("gh_2.62.0_")
      ),
      true,
    );
    assertEquals(calls.some((c) => c.cmd[0] === "brew"), false);
    // Deno: pinned upgrade.
    assertEquals(
      calls.some((c) => c.cmd.join(" ") === "deno upgrade 2.5.4"),
      true,
    );

    // One line per tool naming the tool and its pinned version.
    for (
      const line of [
        "Claude CLI pinned to 2.0.76 (update_mode=frozen)",
        "GH CLI pinned to 2.62.0 (update_mode=frozen)",
        "Deno pinned to 2.5.4 (update_mode=frozen)",
      ]
    ) {
      assertEquals(infos.includes(line), true, infos.join("\n"));
    }

    // Each install is verified and its success recorded.
    assertEquals(getLastSuccessfulUpdate(tmpDir, "claude"), now + 100);
    assertEquals(getLastSuccessfulUpdate(tmpDir, "gh"), now + 100);
    assertEquals(getLastSuccessfulUpdate(tmpDir, "deno"), now + 100);
  });
});

Deno.test("checkSoftwareUpdates - frozen tools already at their pins install nothing", async () => {
  await withTempDir(async (tmpDir) => {
    const { logger, infos } = testLogger();
    const calls: RunCall[] = [];
    await checkSoftwareUpdates(logger, {
      env: () => undefined,
      timestampDir: tmpDir,
      now: () => 1700000000,
      updateMode: "frozen",
      pinnedToolVersions: FROZEN_PINS,
      retry: {
        runFn: frozenRunner(calls, {
          claude: ["2.0.76 (Claude Code)"],
          gh: ["gh version 2.62.0 (2026-02-02)"],
          deno: ["deno 2.5.4 (stable)"],
        }),
        sleepFn: () => Promise.resolve(),
      },
    });
    // Only the three version reads — no download, no install.
    assertEquals(calls.map((c) => c.cmd), [
      ["claude", "--version"],
      ["gh", "--version"],
      ["deno", "--version"],
    ]);
    for (const version of ["2.0.76", "2.62.0", "2.5.4"]) {
      assertEquals(
        infos.some((m) =>
          m.includes(`already at the pinned version ${version}`)
        ),
        true,
        infos.join("\n"),
      );
    }
  });
});

Deno.test("checkSoftwareUpdates - a frozen install that misses its pin fails loud", async () => {
  await withTempDir(async (tmpDir) => {
    const { logger } = testLogger();
    const calls: RunCall[] = [];
    const error = await assertRejects(
      () =>
        checkSoftwareUpdates(logger, {
          env: () => undefined,
          timestampDir: tmpDir,
          now: () => 1700000000,
          updateMode: "frozen",
          pinnedToolVersions: FROZEN_PINS,
          retry: {
            // The install "succeeds" but the version never moves.
            runFn: frozenRunner(calls, {
              claude: ["2.1.100 (Claude Code)"],
            }),
            sleepFn: () => Promise.resolve(),
          },
        }),
      Error,
    );
    assertStringIncludes(error.message, "Claude CLI");
    assertStringIncludes(error.message, "requested 2.0.76");
    assertStringIncludes(error.message, "installed 2.1.100");
  });
});

Deno.test("checkSoftwareUpdates - frozen mode without a pin for a tool fails loud", async () => {
  await withTempDir(async (tmpDir) => {
    const { logger } = testLogger();
    const calls: RunCall[] = [];
    const error = await assertRejects(
      () =>
        checkSoftwareUpdates(logger, {
          env: () => undefined,
          timestampDir: tmpDir,
          now: () => 1700000000,
          updateMode: "frozen",
          pinnedToolVersions: { claude: "2.0.76", deno: "2.5.4" },
          retry: {
            runFn: frozenRunner(calls, {
              claude: ["2.0.76 (Claude Code)"],
            }),
            sleepFn: () => Promise.resolve(),
          },
        }),
      Error,
    );
    assertStringIncludes(error.message, "GH CLI");
    assertStringIncludes(error.message, "pinned_tool_versions.gh");
    // Deno is never reached — the launch stops at the unpinned tool.
    assertEquals(calls.some((c) => c.cmd[0] === "deno"), false);
  });
});

Deno.test("checkSoftwareUpdates - a suppressed frozen tool is reported, not silently pinned", async () => {
  await withTempDir(async (tmpDir) => {
    const { logger, warns } = testLogger();
    const calls: RunCall[] = [];
    await checkSoftwareUpdates(logger, {
      env: () => undefined,
      timestampDir: tmpDir,
      now: () => 1700000000,
      updateMode: "frozen",
      pinnedToolVersions: FROZEN_PINS,
      skipClaude: true,
      retry: {
        runFn: frozenRunner(calls, {
          gh: ["gh version 2.62.0 (2026-02-02)"],
          deno: ["deno 2.5.4 (stable)"],
        }),
        sleepFn: () => Promise.resolve(),
      },
    });
    assertEquals(calls.some((c) => c.cmd[0] === "claude"), false);
    assertEquals(
      warns.some((m) =>
        m.includes("Claude CLI") && m.includes("2.0.76") &&
        m.includes("SKIP_CLAUDE_UPDATE")
      ),
      true,
      warns.join("\n"),
    );
  });
});

Deno.test("checkSoftwareUpdates - dynamic mode ignores leftover pins", async () => {
  await withTempDir(async (tmpDir) => {
    const { logger } = testLogger();
    const calls: RunCall[] = [];
    await checkSoftwareUpdates(logger, {
      env: () => undefined,
      timestampDir: tmpDir, // no timestamp recorded → interval elapsed
      now: () => 1700000000,
      updateMode: "dynamic",
      // A host that flipped back to dynamic keeps its stale pins.
      pinnedToolVersions: FROZEN_PINS,
      ageGate: openGate("9.9.9"),
      retry: {
        runFn: frozenRunner(calls, {}),
        sleepFn: () => Promise.resolve(),
      },
    });
    // The unpinned paths run exactly as they did before the mode existed.
    assertEquals(calls.some((c) => c.cmd.join(" ") === "claude update"), true);
    assertEquals(
      calls.some((c) => c.cmd.join(" ") === "deno upgrade 9.9.9"),
      true,
    );
    assertEquals(calls.some((c) => c.cmd[0] === "curl"), false);
  });
});

Deno.test("softwareUpdateOptionsFromEnv - carries the update mode and its pins", () => {
  const options = softwareUpdateOptionsFromEnv(
    { updateMode: "frozen", pinnedToolVersions: FROZEN_PINS },
    () => undefined,
  );
  assertEquals(options.updateMode, "frozen");
  assertEquals(options.pinnedToolVersions, FROZEN_PINS);
  // An unset mode stays undefined, which reads as dynamic.
  assertEquals(
    softwareUpdateOptionsFromEnv({}, () => undefined).updateMode,
    undefined,
  );
});
