/**
 * Tests for crash_notification.ts — crash alerting via GitHub issues
 * and webhooks (Issue #634, #909).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildCrashMessage,
  CRASH_NOTIFICATION_DEFAULTS,
  type CrashNotificationConfig,
  type CrashNotificationParams,
  formatElapsedTime,
  isCrashExit,
  notifyCrashViaIssueComment,
  notifyCrashViaWebhook,
  recordNotificationSent,
  shouldRateLimitNotification,
  signalNameFromExitCode,
} from "../lib/crash_notification.ts";

async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "cn-test-" });
}

function testConfig(stateDir: string): CrashNotificationConfig {
  return {
    workerName: "test-worker",
    cooldownSeconds: CRASH_NOTIFICATION_DEFAULTS.cooldownSeconds,
    logTailMaxBytes: CRASH_NOTIFICATION_DEFAULTS.logTailMaxBytes,
    stateDir,
  };
}

function testParams(
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

// ============================================================================
// formatElapsedTime
// ============================================================================

Deno.test("crash notification - formatElapsedTime for seconds only", () => {
  assertEquals(formatElapsedTime(45), "0m 45s");
});

Deno.test("crash notification - formatElapsedTime for minutes", () => {
  assertEquals(formatElapsedTime(754), "12m 34s");
});

Deno.test("crash notification - formatElapsedTime for hours", () => {
  assertEquals(formatElapsedTime(3723), "1h 2m 3s");
});

Deno.test("crash notification - formatElapsedTime for zero", () => {
  assertEquals(formatElapsedTime(0), "0m 0s");
});

Deno.test("crash notification - formatElapsedTime for negative returns unknown", () => {
  assertEquals(formatElapsedTime(-1), "unknown");
});

Deno.test("crash notification - formatElapsedTime for NaN returns unknown", () => {
  assertEquals(formatElapsedTime(NaN), "unknown");
});

// ============================================================================
// isCrashExit
// ============================================================================

Deno.test("crash notification - exit code 0 is not a crash", () => {
  assertEquals(isCrashExit(0, false), false);
});

Deno.test("crash notification - exit code 1 is a crash", () => {
  assertEquals(isCrashExit(1, false), true);
});

Deno.test("crash notification - planned shutdown is not a crash", () => {
  assertEquals(isCrashExit(137, true), false);
});

Deno.test("crash notification - SIGKILL without planned shutdown is a crash", () => {
  assertEquals(isCrashExit(137, false), true);
});

Deno.test("crash notification - SIGINT (130) is a crash when unplanned", () => {
  assertEquals(isCrashExit(130, false), true);
});

// ============================================================================
// signalNameFromExitCode
// ============================================================================

Deno.test("crash notification - exit code below 128 has no signal name", () => {
  assertEquals(signalNameFromExitCode(1), "");
  assertEquals(signalNameFromExitCode(42), "");
  assertEquals(signalNameFromExitCode(128), "");
});

Deno.test("crash notification - SIGINT is 130", () => {
  assertEquals(signalNameFromExitCode(130), "SIGINT");
});

Deno.test("crash notification - SIGKILL is 137", () => {
  assertEquals(signalNameFromExitCode(137), "SIGKILL");
});

Deno.test("crash notification - SIGTERM is 143", () => {
  assertEquals(signalNameFromExitCode(143), "SIGTERM");
});

Deno.test("crash notification - SIGHUP is 129", () => {
  assertEquals(signalNameFromExitCode(129), "SIGHUP");
});

Deno.test("crash notification - unknown signal returns generic name", () => {
  assertEquals(signalNameFromExitCode(128 + 20), "signal 20");
});

// ============================================================================
// buildCrashMessage
// ============================================================================

Deno.test("crash notification - buildCrashMessage includes worker name", () => {
  const dir = "/tmp/test-state";
  const config = testConfig(dir);
  const params = testParams();
  const message = buildCrashMessage(config, params);
  assertEquals(message.includes("test-worker"), true);
});

Deno.test("crash notification - buildCrashMessage includes exit code", () => {
  const config = testConfig("/tmp");
  const params = testParams({ exitCode: 137 });
  const message = buildCrashMessage(config, params);
  assertEquals(message.includes("137"), true);
  assertEquals(message.includes("SIGKILL"), true);
});

Deno.test("crash notification - buildCrashMessage includes activity info", () => {
  const config = testConfig("/tmp");
  const params = testParams({ repo: "org/myrepo", issueNumber: 99 });
  const message = buildCrashMessage(config, params);
  assertEquals(message.includes("org/myrepo"), true);
  assertEquals(message.includes("#99"), true);
});

Deno.test("crash notification - buildCrashMessage shows no-issue when none in progress", () => {
  const config = testConfig("/tmp");
  const params = testParams({ repo: "", issueNumber: 0 });
  const message = buildCrashMessage(config, params);
  assertEquals(message.includes("No issue in progress"), true);
});

Deno.test("crash notification - buildCrashMessage includes work stage", () => {
  const config = testConfig("/tmp");
  const params = testParams({ workStage: "quality_check" });
  const message = buildCrashMessage(config, params);
  assertEquals(message.includes("quality_check"), true);
});

Deno.test("crash notification - buildCrashMessage shows elapsed time", () => {
  const config = testConfig("/tmp");
  const params = testParams({ workStartTime: 1000 });
  const now = () => 1754; // 754 seconds elapsed = 12m 34s
  const message = buildCrashMessage(config, params, now);
  assertEquals(message.includes("12m 34s"), true);
});

Deno.test("crash notification - buildCrashMessage includes log tail", () => {
  const config = testConfig("/tmp");
  const params = testParams({
    logTail: "Error: something broke\nMore details",
  });
  const message = buildCrashMessage(config, params);
  assertEquals(message.includes("Worker log tail"), true);
  assertEquals(message.includes("something broke"), true);
});

Deno.test("crash notification - buildCrashMessage includes key errors from log", () => {
  const config = testConfig("/tmp");
  const params = testParams({
    logTail: "Error: critical failure\nInfo: normal line",
  });
  const message = buildCrashMessage(config, params);
  assertEquals(message.includes("Key Errors"), true);
  assertEquals(message.includes("critical failure"), true);
});

Deno.test("crash notification - buildCrashMessage includes claude output", () => {
  const config = testConfig("/tmp");
  const params = testParams({
    claudeOutput: "Claude was working on something",
  });
  const message = buildCrashMessage(config, params);
  assertEquals(message.includes("Claude Output"), true);
});

// ============================================================================
// buildCrashMessage — secret redaction (Issue #2486)
// ============================================================================

Deno.test("crash notification - buildCrashMessage redacts GitHub token in claude output", () => {
  const config = testConfig("/tmp");
  const token = `ghs_${"a".repeat(36)}`;
  const params = testParams({
    claudeOutput: `git auth failed using ${token} oops`,
  });
  const message = buildCrashMessage(config, params);
  assertEquals(message.includes(token), false);
  assertEquals(message.includes("***REDACTED***"), true);
});

Deno.test("crash notification - buildCrashMessage redacts ghp_ token in log tail", () => {
  const config = testConfig("/tmp");
  const token = `ghp_${"b".repeat(36)}`;
  const params = testParams({ logTail: `Error: push rejected with ${token}` });
  const message = buildCrashMessage(config, params);
  assertEquals(message.includes(token), false);
  assertEquals(message.includes("***REDACTED***"), true);
});

Deno.test("crash notification - buildCrashMessage redacts tokenised git clone URL", () => {
  const config = testConfig("/tmp");
  const url = `https://x-access-token:${
    "ghs_" + "c".repeat(36)
  }@github.com/org/repo.git`;
  const params = testParams({ logTail: `fatal: unable to access ${url}` });
  const message = buildCrashMessage(config, params);
  assertEquals(message.includes("ghs_" + "c".repeat(36)), false);
  assertEquals(message.includes("***REDACTED***"), true);
  // Host/path remain visible after the embedded token is masked.
  assertEquals(message.includes("github.com/org/repo.git"), true);
});

// ============================================================================
// shouldRateLimitNotification / recordNotificationSent
// ============================================================================

Deno.test("crash notification - first notification is not rate limited", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const limited = await shouldRateLimitNotification(config);
    assertEquals(limited, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("crash notification - recent notification is rate limited", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const now = () => 1000000;
    await recordNotificationSent(config, now);
    const limited = await shouldRateLimitNotification(config, () => 1000100);
    assertEquals(limited, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("crash notification - notification after cooldown is not rate limited", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const now = () => 1000000;
    await recordNotificationSent(config, now);
    const limited = await shouldRateLimitNotification(
      config,
      () => 1000000 + config.cooldownSeconds + 1,
    );
    assertEquals(limited, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// notifyCrashViaIssueComment — delivery path (Issue #3043)
// ============================================================================

Deno.test("crash notification - issue comment suppressed when repo missing", async () => {
  const config = testConfig("/tmp");
  const ghCalls: string[][] = [];
  const result = await notifyCrashViaIssueComment(
    config,
    testParams({ repo: "" }),
    (args) => {
      ghCalls.push(args);
      return Promise.resolve();
    },
  );
  assertEquals(result.ok, true);
  // Guard suppresses delivery — no gh call is made.
  assertEquals(ghCalls.length, 0);
});

Deno.test("crash notification - issue comment suppressed when issueNumber missing", async () => {
  const config = testConfig("/tmp");
  const ghCalls: string[][] = [];
  const result = await notifyCrashViaIssueComment(
    config,
    testParams({ issueNumber: 0 }),
    (args) => {
      ghCalls.push(args);
      return Promise.resolve();
    },
  );
  assertEquals(result.ok, true);
  assertEquals(ghCalls.length, 0);
});

Deno.test("crash notification - issue comment posts crash detail on happy path", async () => {
  const config = testConfig("/tmp");
  const ghCalls: string[][] = [];
  const result = await notifyCrashViaIssueComment(
    config,
    testParams({ repo: "org/myrepo", issueNumber: 77, exitCode: 137 }),
    (args) => {
      ghCalls.push(args);
      return Promise.resolve();
    },
  );
  assertEquals(result.ok, true);
  assertEquals(ghCalls.length, 1);
  const args = ghCalls[0]!;
  // Posts a comment to the right issue/repo.
  assertEquals(args[0], "issue");
  assertEquals(args[1], "comment");
  assertEquals(args[2], "77");
  assertStringIncludes(args.join(" "), "org/myrepo");
  // The body carries the crash detail (exit code / signal name).
  const body = args.at(-1)!;
  assertStringIncludes(body, "137");
  assertStringIncludes(body, "SIGKILL");
});

// ============================================================================
// notifyCrashViaIssueComment — per-streak dedup marker (Issue #343)
// ============================================================================

Deno.test("crash notification - a marked report updates the existing comment", async () => {
  const config = testConfig("/tmp");
  const marker = "<!-- VIBE_CONTAINER_ESCALATION:worker_run:1000 -->";
  const ghCalls: string[][] = [];

  const result = await notifyCrashViaIssueComment(
    config,
    testParams({ repo: "org/myrepo", issueNumber: 77, dedupMarker: marker }),
    (args) => {
      ghCalls.push(args);
      return Promise.resolve();
    },
    () =>
      Promise.resolve(
        JSON.stringify([
          { id: 11, body: "unrelated chatter" },
          { id: 22, body: `${marker}\n\nthe previous report` },
        ]),
      ),
  );

  assertEquals(result.ok, true);
  assertEquals(ghCalls.length, 1);
  const args = ghCalls[0]!;
  // Edited in place, not filed again.
  assertEquals(args[0], "api");
  assertEquals(args[1], "--method");
  assertEquals(args[2], "PATCH");
  assertEquals(args[3], "repos/org/myrepo/issues/comments/22");
  // The updated body carries the marker so the next update finds it too.
  assertStringIncludes(args.at(-1)!, marker);
});

Deno.test("crash notification - an unmatched marker posts a new comment", async () => {
  const config = testConfig("/tmp");
  const marker = "<!-- VIBE_CONTAINER_ESCALATION:worker_run:2000 -->";
  const ghCalls: string[][] = [];

  await notifyCrashViaIssueComment(
    config,
    testParams({ repo: "org/myrepo", issueNumber: 77, dedupMarker: marker }),
    (args) => {
      ghCalls.push(args);
      return Promise.resolve();
    },
    () => Promise.resolve(JSON.stringify([{ id: 11, body: "unrelated" }])),
  );

  assertEquals(ghCalls.length, 1);
  assertEquals(ghCalls[0]![0], "issue");
  assertEquals(ghCalls[0]![1], "comment");
  assertStringIncludes(ghCalls[0]!.at(-1)!, marker);
});

Deno.test("crash notification - a failed dedup lookup still delivers the report", async () => {
  const config = testConfig("/tmp");
  const ghCalls: string[][] = [];

  // A lookup we could not perform must never swallow the escalation — a
  // duplicate report is recoverable, a lost one is not.
  await notifyCrashViaIssueComment(
    config,
    testParams({
      repo: "org/myrepo",
      issueNumber: 77,
      dedupMarker: "<!-- VIBE_CONTAINER_ESCALATION:worker_run:3000 -->",
    }),
    (args) => {
      ghCalls.push(args);
      return Promise.resolve();
    },
    () => Promise.reject(new Error("gh api exploded")),
  );

  assertEquals(ghCalls.length, 1);
  assertEquals(ghCalls[0]![0], "issue");
  assertEquals(ghCalls[0]![1], "comment");
});

Deno.test("crash notification - no marker means no lookup and no change in behaviour", async () => {
  const config = testConfig("/tmp");
  const ghCalls: string[][] = [];
  let lookups = 0;

  await notifyCrashViaIssueComment(
    config,
    testParams({ repo: "org/myrepo", issueNumber: 77 }),
    (args) => {
      ghCalls.push(args);
      return Promise.resolve();
    },
    () => {
      lookups++;
      return Promise.resolve("[]");
    },
  );

  assertEquals(lookups, 0);
  assertEquals(ghCalls.length, 1);
  assertEquals(ghCalls[0]![0], "issue");
});

Deno.test("crash notification - issue comment swallows gh runner failure", async () => {
  const config = testConfig("/tmp");
  // A throwing runner must never propagate — cleanup must not be blocked.
  const result = await notifyCrashViaIssueComment(
    config,
    testParams(),
    () => Promise.reject(new Error("gh exploded")),
  );
  assertEquals(result.ok, true);
});

// ============================================================================
// notifyCrashViaWebhook — delivery path (Issue #3043)
// ============================================================================

Deno.test("crash notification - webhook suppressed when no URL configured", async () => {
  const config = testConfig("/tmp"); // webhookUrl undefined
  const fetchCalls: Array<{ url: string | URL | Request; init?: RequestInit }> =
    [];
  const result = await notifyCrashViaWebhook(
    config,
    testParams(),
    (url, init) => {
      fetchCalls.push({ url, init });
      return Promise.resolve(new Response(null, { status: 200 }));
    },
  );
  assertEquals(result.ok, true);
  // Guard suppresses delivery — no fetch is made.
  assertEquals(fetchCalls.length, 0);
});

Deno.test("crash notification - webhook POSTs expected payload when URL configured", async () => {
  const config: CrashNotificationConfig = {
    ...testConfig("/tmp"),
    webhookUrl: "https://hooks.example.com/crash",
  };
  const fetchCalls: Array<{ url: string | URL | Request; init?: RequestInit }> =
    [];
  const result = await notifyCrashViaWebhook(
    config,
    testParams({ repo: "org/myrepo", issueNumber: 88, exitCode: 143 }),
    (url, init) => {
      fetchCalls.push({ url, init });
      return Promise.resolve(new Response(null, { status: 200 }));
    },
  );
  assertEquals(result.ok, true);
  assertEquals(fetchCalls.length, 1);
  const call = fetchCalls[0]!;
  assertEquals(call.url, "https://hooks.example.com/crash");
  assertEquals(call.init?.method, "POST");
  assertEquals(
    (call.init?.headers as Record<string, string>)["Content-Type"],
    "application/json",
  );
  // Payload shape carries the crash detail.
  const payload = JSON.parse(call.init?.body as string);
  assertEquals(payload.worker_id, "test-worker");
  assertEquals(payload.exit_code, 143);
  assertEquals(payload.signal, "SIGTERM");
  assertEquals(payload.repo, "org/myrepo");
  assertEquals(payload.issue, "88");
});

Deno.test("crash notification - webhook swallows fetch failure", async () => {
  const config: CrashNotificationConfig = {
    ...testConfig("/tmp"),
    webhookUrl: "https://hooks.example.com/crash",
  };
  // A throwing fetch must never propagate — cleanup must not be blocked.
  const result = await notifyCrashViaWebhook(
    config,
    testParams(),
    () => Promise.reject(new Error("network down")),
  );
  assertEquals(result.ok, true);
});

// ============================================================================
// Defaults
// ============================================================================

Deno.test("crash notification - defaults have expected values", () => {
  assertEquals(CRASH_NOTIFICATION_DEFAULTS.cooldownSeconds, 600);
  assertEquals(CRASH_NOTIFICATION_DEFAULTS.logTailMaxBytes, 50000);
});
