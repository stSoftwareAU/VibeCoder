/**
 * Tests for the diagnose library (Issue #1905).
 *
 * Exercises the formatting layer with mocked data-gathering deps so the
 * tests do not require ps/gh/filesystem access.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import {
  buildMergeHistogram,
  type DiagnoseDeps,
  formatDiagnostics,
  formatDuration,
  formatResetTime,
  gatherDiagnostics,
  parseRateLimit,
  parseSupervisors,
} from "../lib/diagnose.ts";

Deno.test("parseSupervisors - extracts loop.sh rows and detects orphans", () => {
  const psOut = [
    "    1 04-07:38:23     0 /sbin/launchd",
    " 67309    40:23  45911 /bin/bash /repo/loop.sh",
    " 24983 15:32:10      1 /bin/bash /home/user/loop.sh",
    " 99999  01:00:00 88888 /bin/bash unrelated.sh",
    " 12345  01:00:00 11111 grep loop.sh",
  ].join("\n");

  const result = parseSupervisors(psOut);
  assertEquals(result.length, 2);
  assertEquals(result[0]!.pid, 24983);
  assertEquals(result[0]!.orphan, true);
  assertEquals(result[1]!.pid, 67309);
  assertEquals(result[1]!.orphan, false);
});

Deno.test("parseSupervisors - empty input returns empty list", () => {
  assertEquals(parseSupervisors(""), []);
  assertEquals(parseSupervisors("   \n\n   "), []);
});

Deno.test("parseRateLimit - extracts GraphQL and REST quotas", () => {
  const json = JSON.stringify({
    resources: {
      core: { limit: 5000, used: 0, remaining: 5000, reset: 1778515951 },
      graphql: { limit: 5000, used: 57, remaining: 4943, reset: 1778515601 },
    },
  });
  const result = parseRateLimit(json);
  assertEquals(result.graphql?.remaining, 4943);
  assertEquals(result.graphql?.limit, 5000);
  assertEquals(result.rest?.remaining, 5000);
});

Deno.test("parseRateLimit - invalid JSON returns empty info", () => {
  assertEquals(parseRateLimit("not json"), {});
  assertEquals(parseRateLimit(""), {});
});

Deno.test("buildMergeHistogram - bins merge timestamps by UTC hour", () => {
  const now = new Date("2026-05-12T08:30:00Z");
  const timestamps = [
    "2026-05-12T07:15:00Z",
    "2026-05-12T07:45:00Z",
    "2026-05-12T07:55:00Z",
    "2026-05-12T08:05:00Z",
  ];
  const hist = buildMergeHistogram(timestamps, now);
  assertEquals(hist.buckets["12T07"], 3);
  assertEquals(hist.buckets["12T08"], 1);
  assertEquals(hist.total, 4);
});

Deno.test("buildMergeHistogram - drops events outside 24h window", () => {
  const now = new Date("2026-05-12T08:30:00Z");
  const hist = buildMergeHistogram([
    "2026-05-10T00:00:00Z", // > 24h ago
    "2026-05-12T07:30:00Z", // inside
    "2026-05-13T00:00:00Z", // future
  ], now);
  assertEquals(hist.total, 1);
});

Deno.test("buildMergeHistogram - detects largest merge gap", () => {
  // Merges at hours 00,01,02,03,04, then gap, then 20,21,22,23
  const now = new Date("2026-05-11T00:00:00Z");
  const timestamps = [
    "2026-05-10T01:00:00Z",
    "2026-05-10T02:00:00Z",
    "2026-05-10T03:00:00Z",
    "2026-05-10T04:00:00Z",
    "2026-05-10T20:00:00Z",
    "2026-05-10T21:00:00Z",
    "2026-05-10T22:00:00Z",
    "2026-05-10T23:00:00Z",
  ];
  const hist = buildMergeHistogram(timestamps, now);
  assertEquals(hist.largestGapHours >= 9, true);
});

Deno.test("formatResetTime - renders Unix epoch as HH:MM:SSZ", () => {
  assertEquals(formatResetTime(0), "n/a");
  // 2026-05-11T23:11:13Z = 1778541073
  assertEquals(formatResetTime(1778541073), "23:11:13Z");
});

Deno.test("formatDuration - bins seconds into human units", () => {
  assertEquals(formatDuration(30), "30s");
  assertEquals(formatDuration(420), "7m");
  assertEquals(formatDuration(3600), "1h");
  assertEquals(formatDuration(3660), "1h 1m");
  assertEquals(formatDuration(86400 * 7), "7d");
});

Deno.test("formatDiagnostics - renders all sections with mocked data", async () => {
  const data = await runWithMockDeps({
    psSupervisors: () =>
      Promise.resolve(
        [
          " 67309    40:23  45911 /bin/bash /repo/loop.sh",
          " 24983 15:32:10      1 /bin/bash /repo/loop.sh",
        ].join("\n"),
      ),
    readPidFile: () => Promise.resolve("75004\n"),
    isRunning: () => Promise.resolve(true),
    listLogs: () =>
      Promise.resolve([{
        path: "/tmp/worker-75004.log",
        mtime: new Date("2026-05-12T08:20:00Z"),
      }]),
    tailLog: () =>
      Promise.resolve([
        "[2026-05-12T08:19:10Z] Priority 1.9: rate limit hit",
        "[2026-05-12T08:19:11Z] Paused for rate-limit wait",
      ]),
    rateLimitJson: () =>
      Promise.resolve(JSON.stringify({
        resources: {
          graphql: { limit: 5000, remaining: 4943, reset: 1778541073 },
          core: { limit: 5000, remaining: 5000, reset: 1778543176 },
        },
      })),
    rateLimitSignal: () =>
      Promise.resolve({ active: true, remainingSeconds: 2700 }),
    outstandingWork: () => Promise.resolve({ openPRs: 3, openIssues: 6 }),
    recentMergedTimestamps: () =>
      Promise.resolve([
        "2026-05-12T07:00:00Z",
        "2026-05-12T07:15:00Z",
      ]),
  });

  const out = formatDiagnostics(data);
  assertStringIncludes(out, "Vibe-Coder worker diagnostic");
  assertStringIncludes(out, "Supervisors (loop.sh):");
  assertStringIncludes(out, "67309");
  assertStringIncludes(out, "ORPHAN");
  assertStringIncludes(out, "#1901");
  assertStringIncludes(out, "Active PID:    75004");
  assertStringIncludes(out, "Priority 1.9: rate limit hit");
  assertStringIncludes(out, "GraphQL: 4943 / 5000 remaining");
  assertStringIncludes(out, "REST:    5000 / 5000 remaining");
  assertStringIncludes(out, "Signal:  ACTIVE");
  assertStringIncludes(out, "#1903");
  assertStringIncludes(out, "3 open PRs and 6 open self-assigned issues");
  assertStringIncludes(out, "12T07=2");
});

Deno.test("formatDiagnostics - degrades to n/a when probes fail", async () => {
  const data = await runWithMockDeps({
    psSupervisors: () => Promise.reject(new Error("ps failed")),
    readPidFile: () => Promise.resolve(undefined),
    isRunning: () => Promise.resolve(false),
    listLogs: () => Promise.resolve([]),
    tailLog: () => Promise.resolve([]),
    rateLimitJson: () => Promise.reject(new Error("gh failed")),
    rateLimitSignal: () => Promise.resolve(undefined),
    outstandingWork: () => Promise.resolve(undefined),
    recentMergedTimestamps: () => Promise.resolve([]),
  });

  const out = formatDiagnostics(data);
  assertStringIncludes(out, "(none running)");
  assertStringIncludes(out, "Active PID:    n/a");
  assertStringIncludes(out, "Log:           n/a");
  assertStringIncludes(out, "GraphQL: n/a");
  assertStringIncludes(out, "REST:    n/a");
  assertStringIncludes(out, "Worker outstanding work: n/a");
  assertStringIncludes(out, "(no merges in last 24h)");
});

Deno.test("formatDiagnostics - flags a stale PID file when process is gone", async () => {
  const data = await runWithMockDeps({
    readPidFile: () => Promise.resolve("99999"),
    isRunning: () => Promise.resolve(false),
  });
  const out = formatDiagnostics(data);
  assertMatch(out, /Active PID:\s+99999 \(stale — not running\)/);
});

Deno.test("gatherDiagnostics - swallows individual probe failures", async () => {
  const data = await runWithMockDeps({
    psSupervisors: () => Promise.reject(new Error("boom")),
    rateLimitJson: () => Promise.reject(new Error("gh nope")),
  });
  assertEquals(data.supervisors, []);
  assertEquals(data.rateLimit.graphql, undefined);
  // Hostname fallback is still populated
  assertEquals(typeof data.hostname, "string");
});

/**
 * Build a deps object with sensible defaults and overrides for a single test.
 */
async function runWithMockDeps(
  overrides: Partial<DiagnoseDeps>,
): Promise<Awaited<ReturnType<typeof gatherDiagnostics>>> {
  const now = new Date("2026-05-12T08:26:15Z");
  const defaults: DiagnoseDeps = {
    pidFile: "/tmp/.run.pid",
    logDir: "/tmp/logs",
    githubUser: "stsvcbot",
    now: () => now,
    hostname: () => Promise.resolve("host-23"),
    psSupervisors: () => Promise.resolve(""),
    isRunning: () => Promise.resolve(false),
    readPidFile: () => Promise.resolve(undefined),
    listLogs: () => Promise.resolve([]),
    tailLog: () => Promise.resolve([]),
    rateLimitJson: () => Promise.resolve("{}"),
    rateLimitSignal: () => Promise.resolve(undefined),
    outstandingWork: () => Promise.resolve(undefined),
    recentMergedTimestamps: () => Promise.resolve([]),
  };
  return await gatherDiagnostics({ ...defaults, ...overrides });
}
