/**
 * Tests for backlog & throughput observability (Issue #2405).
 *
 * Exercises the trend/projection maths against fixture issue sets.
 */

import { assertEquals } from "@std/assert";
import {
  classifyFindingLabels,
  computeAgeBuckets,
  computeBacklogTrend,
  computeClearRate,
  type FindingIssue,
  formatBacklogReport,
  isOpenAt,
  openCountAt,
  projectDrainDays,
  summariseBacklog,
} from "../lib/backlog_throughput.ts";

/** Fixed reference instant for deterministic age maths. */
const NOW = new Date("2026-05-29T00:00:00Z");
const NOW_MS = NOW.getTime();
const DAY = 86_400_000;

function daysAgo(n: number): string {
  return new Date(NOW_MS - n * DAY).toISOString();
}

function finding(overrides: Partial<FindingIssue>): FindingIssue {
  return {
    repo: "org/repo",
    number: 1,
    state: "open",
    severity: "medium",
    category: "security",
    createdAt: daysAgo(10),
    closedAt: null,
    ...overrides,
  };
}

// --- classifyFindingLabels ---

Deno.test("classifyFindingLabels - security finding with severity", () => {
  const c = classifyFindingLabels(["security", "severity:high"]);
  assertEquals(c, { isFinding: true, category: "security", severity: "high" });
});

Deno.test("classifyFindingLabels - supply-chain takes precedence", () => {
  const c = classifyFindingLabels([
    "security",
    "supply-chain-readiness",
    "severity:low",
  ]);
  assertEquals(c.category, "supply-chain");
  assertEquals(c.severity, "low");
  assertEquals(c.isFinding, true);
});

Deno.test("classifyFindingLabels - quarantine label classified as supply-chain", () => {
  const c = classifyFindingLabels(["supply-chain:quarantine-missing"]);
  assertEquals(c.category, "supply-chain");
});

Deno.test("classifyFindingLabels - severity defaults to unknown", () => {
  const c = classifyFindingLabels(["security"]);
  assertEquals(c.severity, "unknown");
});

Deno.test("classifyFindingLabels - non-finding labels rejected", () => {
  const c = classifyFindingLabels(["bug", "enhancement"]);
  assertEquals(c, { isFinding: false, category: null, severity: "unknown" });
});

Deno.test("classifyFindingLabels - case-insensitive matching", () => {
  const c = classifyFindingLabels(["Security", "Severity:High"]);
  assertEquals(c.category, "security");
  assertEquals(c.severity, "high");
});

// --- isOpenAt / openCountAt ---

Deno.test("isOpenAt - still-open issue is open now", () => {
  const f = finding({ createdAt: daysAgo(5), closedAt: null });
  assertEquals(isOpenAt(f, NOW_MS), true);
});

Deno.test("isOpenAt - not yet created is not open", () => {
  const f = finding({ createdAt: daysAgo(-3), closedAt: null });
  assertEquals(isOpenAt(f, NOW_MS), false);
});

Deno.test("isOpenAt - closed before instant is not open", () => {
  const f = finding({ createdAt: daysAgo(10), closedAt: daysAgo(2) });
  assertEquals(isOpenAt(f, NOW_MS), false);
});

Deno.test("isOpenAt - was open in the past before it closed", () => {
  const f = finding({ createdAt: daysAgo(10), closedAt: daysAgo(2) });
  // 5 days ago it was created (10d) but not yet closed (2d) → open.
  assertEquals(isOpenAt(f, NOW_MS - 5 * DAY), true);
});

Deno.test("openCountAt - counts only those open at the instant", () => {
  const issues = [
    finding({ number: 1, createdAt: daysAgo(20), closedAt: null }),
    finding({ number: 2, createdAt: daysAgo(20), closedAt: daysAgo(3) }),
    finding({ number: 3, createdAt: daysAgo(1), closedAt: null }),
  ];
  // Now: #1 and #3 open (#2 closed 3d ago).
  assertEquals(openCountAt(issues, NOW_MS), 2);
  // 7 days ago: #1 open, #2 open (closed 3d ago, still open then), #3 not created.
  assertEquals(openCountAt(issues, NOW_MS - 7 * DAY), 2);
});

// --- computeAgeBuckets ---

Deno.test("computeAgeBuckets - buckets by age boundaries", () => {
  const open = [
    finding({ number: 1, createdAt: daysAgo(2) }), // fresh
    finding({ number: 2, createdAt: daysAgo(7) }), // recent (>=7)
    finding({ number: 3, createdAt: daysAgo(30) }), // recent (<=30)
    finding({ number: 4, createdAt: daysAgo(45) }), // stale
  ];
  assertEquals(computeAgeBuckets(open, NOW_MS), {
    fresh: 1,
    recent: 2,
    stale: 1,
  });
});

// --- computeClearRate ---

Deno.test("computeClearRate - counts closes within trailing window", () => {
  const issues = [
    finding({ number: 1, closedAt: daysAgo(1) }),
    finding({ number: 2, closedAt: daysAgo(6) }),
    finding({ number: 3, closedAt: daysAgo(10) }), // outside 7d window
    finding({ number: 4, closedAt: null }), // still open
  ];
  const rate = computeClearRate(issues, NOW_MS, 7);
  assertEquals(rate.closedInWindow, 2);
  assertEquals(rate.perDay, 2 / 7);
});

Deno.test("computeClearRate - zero window is safe", () => {
  const rate = computeClearRate([finding({ closedAt: daysAgo(1) })], NOW_MS, 0);
  assertEquals(rate, { closedInWindow: 0, perDay: 0 });
});

// --- computeBacklogTrend ---

Deno.test("computeBacklogTrend - rising backlog", () => {
  // Three opened in the last week, one closed → net rise.
  const issues = [
    finding({ number: 1, createdAt: daysAgo(30), closedAt: null }),
    finding({ number: 2, createdAt: daysAgo(3), closedAt: null }),
    finding({ number: 3, createdAt: daysAgo(2), closedAt: null }),
    finding({ number: 4, createdAt: daysAgo(1), closedAt: null }),
  ];
  const t = computeBacklogTrend(issues, NOW_MS, 7);
  assertEquals(t.previous, 1); // only #1 existed 7d ago
  assertEquals(t.current, 4);
  assertEquals(t.delta, 3);
  assertEquals(t.direction, "rising");
});

Deno.test("computeBacklogTrend - falling backlog", () => {
  const issues = [
    finding({ number: 1, createdAt: daysAgo(30), closedAt: daysAgo(2) }),
    finding({ number: 2, createdAt: daysAgo(30), closedAt: daysAgo(1) }),
    finding({ number: 3, createdAt: daysAgo(30), closedAt: null }),
  ];
  const t = computeBacklogTrend(issues, NOW_MS, 7);
  assertEquals(t.previous, 3);
  assertEquals(t.current, 1);
  assertEquals(t.direction, "falling");
});

Deno.test("computeBacklogTrend - flat backlog", () => {
  const issues = [
    finding({ number: 1, createdAt: daysAgo(30), closedAt: null }),
  ];
  const t = computeBacklogTrend(issues, NOW_MS, 7);
  assertEquals(t.delta, 0);
  assertEquals(t.direction, "flat");
});

// --- projectDrainDays ---

Deno.test("projectDrainDays - normal projection", () => {
  assertEquals(projectDrainDays(10, 2), 5);
});

Deno.test("projectDrainDays - empty backlog drains immediately", () => {
  assertEquals(projectDrainDays(0, 0), 0);
});

Deno.test("projectDrainDays - zero clear-rate never drains", () => {
  assertEquals(projectDrainDays(5, 0), null);
});

// --- summariseBacklog ---

Deno.test("summariseBacklog - groups per repo and totals", () => {
  const issues = [
    finding({ repo: "org/a", number: 1, severity: "high", closedAt: null }),
    finding({
      repo: "org/a",
      number: 2,
      severity: "low",
      closedAt: daysAgo(1),
    }),
    finding({ repo: "org/b", number: 3, severity: "medium", closedAt: null }),
  ];
  const summary = summariseBacklog(issues, { now: NOW, windowDays: 7 });

  assertEquals(summary.repos.length, 2);
  const a = summary.repos.find((r) => r.repo === "org/a")!;
  assertEquals(a.openTotal, 1);
  assertEquals(a.bySeverity.high, 1);
  assertEquals(a.clearRate.closedInWindow, 1);

  assertEquals(summary.total.openTotal, 2); // #1 and #3 open
  assertEquals(summary.total.clearRate.closedInWindow, 1);
});

Deno.test("summariseBacklog - empty input yields zeroed total", () => {
  const summary = summariseBacklog([], { now: NOW });
  assertEquals(summary.repos.length, 0);
  assertEquals(summary.total.openTotal, 0);
  assertEquals(summary.total.drainDays, 0);
});

// --- formatBacklogReport ---

Deno.test("formatBacklogReport - includes key metrics", () => {
  const issues = [
    finding({ repo: "org/a", number: 1, severity: "high", closedAt: null }),
    finding({
      repo: "org/b",
      number: 2,
      severity: "low",
      closedAt: daysAgo(1),
    }),
  ];
  const summary = summariseBacklog(issues, { now: NOW, windowDays: 7 });
  const report = formatBacklogReport(summary);

  assertEquals(report.includes("Security backlog & throughput"), true);
  assertEquals(report.includes("org/a"), true);
  assertEquals(report.includes("TOTAL"), true);
  assertEquals(report.includes("trend:"), true);
  assertEquals(report.includes("drain:"), true);
});

Deno.test("formatBacklogReport - single repo omits redundant total", () => {
  const issues = [finding({ repo: "org/a", number: 1, closedAt: null })];
  const summary = summariseBacklog(issues, { now: NOW, windowDays: 7 });
  const report = formatBacklogReport(summary);
  assertEquals(report.includes("TOTAL"), false);
});
