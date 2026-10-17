/**
 * Tests for the fleet experiment report (Issue #3645).
 *
 * Each test builds hand-made ledger events with buildLifecycleEvent, so every
 * event is validated, then drives the real report functions over them.
 *
 * Australian English spelling used throughout.
 */

import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertStringIncludes,
} from "@std/assert";
import {
  type ExperimentArm,
} from "../lib/fleet_experiment_arms.ts";
import {
  type AssignmentRecord,
  type ArmSummary,
  buildAssignmentRecords,
  buildExperimentReport,
  experimentRecordsCsv,
  type ExperimentOptions,
  type ExperimentReport,
  formatExperimentReport,
} from "../lib/fleet_experiment_report.ts";
import {
  buildLifecycleEvent,
  type LifecycleEvent,
  type LifecycleEventInput,
  validateLifecycleEvent,
} from "../lib/lifecycle_ledger.ts";

/** The report's reference time: a Saturday. */
const NOW = new Date("2026-10-17T00:00:00.000Z");

/** Milliseconds in one day. */
const DAY_MS = 86_400_000;

/** Milliseconds in one hour. */
const HOUR_MS = 3_600_000;

/** The two active arms the tests compare. */
const ARMS: ExperimentArm[] = [
  {
    id: "sonnet-haiku",
    label: "Sonnet manager + Haiku executor",
    manager: { provider: "claude", model: "sonnet" },
    executor: { provider: "claude", model: "haiku" },
    control: true,
    weight: 1,
    status: "active",
  },
  {
    id: "codex-test",
    label: "Codex test candidate",
    manager: { provider: "codex", model: "astra" },
    executor: { provider: "codex", model: "sol" },
    control: false,
    weight: 1,
    status: "active",
  },
];

/** The default options, with a small bootstrap so the tests stay fast. */
function options(overrides: Partial<ExperimentOptions> = {}): ExperimentOptions {
  return {
    now: NOW,
    windowDays: 30,
    horizonDays: 14,
    arms: ARMS,
    bootstrapSamples: 200,
    minPerArm: 1,
    ...overrides,
  };
}

/** An ISO timestamp, the given number of days and hours before NOW. */
function ago(days: number, hours = 0): string {
  return new Date(NOW.getTime() - days * DAY_MS + hours * HOUR_MS)
    .toISOString();
}

/** A lowercase UUID for test issue `id`. */
function uuid(id: number): string {
  return `00000000-0000-4000-8000-${id.toString(16).padStart(12, "0")}`;
}

/** Build one validated event. */
function event(input: LifecycleEventInput): LifecycleEvent {
  return buildLifecycleEvent(input);
}

/** An assignment for issue `id` into `cohort`, on `host`. */
function assignment(
  id: number,
  cohort: string,
  assignedAt: string,
  host = "host-a",
  repo = "acme/alpha",
): LifecycleEvent {
  return event({
    kind: "assignment",
    assignmentId: uuid(id),
    runId: `run-${id}`,
    host,
    repo,
    issueNumber: id,
    recordedAt: assignedAt,
    assignedAt,
    cohort,
    reused: false,
    treatment: {
      roles: [
        { role: "manager", provider: "claude", model: "sonnet" },
        { role: "executor", provider: "claude", model: "haiku" },
      ],
    },
  });
}

/** An outcome for issue `id`. */
function outcome(
  id: number,
  name: "pr_opened" | "quality_green" | "review_approved" | "merged" | "failed" | "pending",
  recordedAt: string,
  host = "host-a",
  repo = "acme/alpha",
): LifecycleEvent {
  return event({
    kind: "outcome",
    assignmentId: uuid(id),
    runId: `run-${id}`,
    host,
    repo,
    issueNumber: id,
    recordedAt,
    outcome: name,
  });
}

/** The three outcomes that make a merge verified, then the merge itself. */
function verifiedMerge(id: number, mergedAt: string): LifecycleEvent[] {
  return [
    outcome(id, "pr_opened", mergedAt),
    outcome(id, "quality_green", mergedAt),
    outcome(id, "review_approved", mergedAt),
    outcome(id, "merged", mergedAt),
  ];
}

/** An invocation for issue `id`, with an optional estimated USD. */
function invocation(
  id: number,
  opts: {
    role?: "manager" | "executor";
    attempt?: number;
    result?: "success" | "failure" | "timeout" | "usage_limited";
    usd?: number;
    model?: string;
    assignmentId?: string;
    host?: string;
    repo?: string;
    recordedAt?: string;
  } = {},
): LifecycleEvent {
  return event({
    kind: "invocation",
    assignmentId: opts.assignmentId ?? uuid(id),
    runId: `run-${id}`,
    host: opts.host ?? "host-a",
    repo: opts.repo ?? "acme/alpha",
    issueNumber: id,
    recordedAt: opts.recordedAt ?? ago(0),
    role: opts.role ?? "manager",
    attempt: opts.attempt ?? 1,
    provider: "claude",
    model: opts.model ?? "sonnet",
    result: opts.result ?? "success",
    ...(opts.usd === undefined
      ? {}
      : { usage: "known", pricing: "known", estimatedApiEquivalentUsd: opts.usd }),
  });
}

/** A follow-on run for issue `id`. */
function followOn(
  id: number,
  followOnKind: "retry" | "pr_feedback",
  attempt: number,
  usd?: number,
): LifecycleEvent {
  return event({
    kind: "follow_on",
    assignmentId: uuid(id),
    runId: `run-${id}`,
    host: "host-a",
    repo: "acme/alpha",
    issueNumber: id,
    recordedAt: ago(0),
    followOn: followOnKind,
    attempt,
    ...(usd === undefined ? {} : { estimatedApiEquivalentUsd: usd }),
  });
}

/** Find one arm's summary, failing the test when it is absent. */
function armOf(report: ExperimentReport, id: string): ArmSummary {
  const found = report.arms.find((arm) => arm.armId === id);
  assert(found !== undefined, `arm ${id} is missing from the report`);
  return found;
}

/** Find one record by issue number, failing the test when it is absent. */
function recordFor(records: readonly AssignmentRecord[], id: number): AssignmentRecord {
  const found = records.find((record) => record.assignmentId === uuid(id));
  assert(found !== undefined, `record for issue ${id} is missing`);
  return found;
}

Deno.test("fleet experiment report - a merge with all three outcomes counts as merged", () => {
  const events = [
    assignment(1, "sonnet-haiku", ago(5)),
    ...verifiedMerge(1, ago(2)),
  ];
  const report = buildExperimentReport(events, options());
  const record = recordFor(report.records, 1);
  assertEquals(record.status, "merged");
  assertEquals(record.timeToMergeHours, 72);
  const control = armOf(report, "sonnet-haiku");
  assertEquals(control.merged, 1);
  assertEquals(control.mergedUnverified, 0);
});

Deno.test("fleet experiment report - a merge without review approval is unverified, not success", () => {
  const events = [
    assignment(1, "sonnet-haiku", ago(5)),
    outcome(1, "quality_green", ago(4)),
    outcome(1, "merged", ago(3)),
  ];
  const report = buildExperimentReport(events, options());
  assertEquals(recordFor(report.records, 1).status, "merged_unverified");
  const control = armOf(report, "sonnet-haiku");
  assertEquals(control.merged, 0);
  assertEquals(control.mergedUnverified, 1);
  assert(report.warnings.some((warning) => warning.code === "unverified-merge"));
});

Deno.test("fleet experiment report - a pending assignment inside the horizon is immature and excluded", () => {
  const events = [
    assignment(1, "sonnet-haiku", ago(2)),
    outcome(1, "pr_opened", ago(2)),
  ];
  const report = buildExperimentReport(events, options({ horizonDays: 14 }));
  const record = recordFor(report.records, 1);
  assertEquals(record.mature, false);
  assertEquals(record.censored, true);
  const control = armOf(report, "sonnet-haiku");
  assertEquals(control.pending, 1);
  assertEquals(control.mature, 0);
  assertEquals(control.mergeRate, null);
  assertEquals(control.mergedPerUsd, null);
  assertEquals(control.censoredAtHorizon, 0);
});

Deno.test("fleet experiment report - a pending assignment past the horizon is mature, censored and counted", () => {
  const events = [
    assignment(1, "sonnet-haiku", ago(20)),
    outcome(1, "pr_opened", ago(20)),
    assignment(2, "sonnet-haiku", ago(5)),
    ...verifiedMerge(2, ago(3)),
  ];
  const report = buildExperimentReport(events, options({ horizonDays: 14 }));
  const control = armOf(report, "sonnet-haiku");
  assertEquals(control.mature, 2);
  assertEquals(control.merged, 1);
  assertEquals(control.mergeRate, 0.5);
  assertEquals(control.censoredAtHorizon, 1);
  assertEquals(control.pending, 0);
});

Deno.test("fleet experiment report - failed retries' cost is included", () => {
  const events = [
    assignment(1, "sonnet-haiku", ago(6)),
    invocation(1, { role: "manager", attempt: 1, result: "failure", usd: 0.4 }),
    invocation(1, { role: "executor", attempt: 2, result: "success", usd: 0.6 }),
    followOn(1, "retry", 2, 0.1),
    outcome(1, "failed", ago(5)),
  ];
  const report = buildExperimentReport(events, options());
  const record = recordFor(report.records, 1);
  assertAlmostEquals(record.costUsd, 1.1, 1e-9);
  assertEquals(record.invocations, 2);
  assertEquals(record.failedInvocations, 1);
  assertEquals(record.followOns, 1);
  assertEquals(record.status, "failed");
  assertAlmostEquals(armOf(report, "sonnet-haiku").costUsd, 1.1, 1e-9);
});

Deno.test("fleet experiment report - an unknown cost is counted, not zero, and raises missing-cost", () => {
  const events = [
    assignment(1, "sonnet-haiku", ago(5)),
    invocation(1, { role: "manager", usd: 0.5 }),
    invocation(1, { role: "executor" }),
    ...verifiedMerge(1, ago(2)),
  ];
  const report = buildExperimentReport(events, options());
  const record = recordFor(report.records, 1);
  assertAlmostEquals(record.costUsd, 0.5, 1e-9);
  assertEquals(record.costUnknownCount, 1);
  assertEquals(armOf(report, "sonnet-haiku").costUnknownAssignments, 1);
  const warning = report.warnings.find((item) => item.code === "missing-cost");
  assertEquals(warning?.arm, "sonnet-haiku");
});

Deno.test("fleet experiment report - a later fallback assignment does not change the cohort (intention to treat)", () => {
  const events = [
    assignment(1, "sonnet-haiku", ago(5), "host-a"),
    // A fallback to another cohort and host, recorded later.
    assignment(1, "codex-test", ago(4), "host-b", "acme/alpha"),
    ...verifiedMerge(1, ago(2)),
  ];
  const report = buildExperimentReport(events, options());
  const record = recordFor(report.records, 1);
  assertEquals(record.cohort, "sonnet-haiku");
  assertEquals(record.assignedAt, ago(5));
  assertEquals(record.hosts, ["host-a", "host-b"]);
  assertEquals(armOf(report, "codex-test").assigned, 0);
});

Deno.test("fleet experiment report - an unknown assignment id is counted as unattributed", () => {
  const events = [
    assignment(1, "sonnet-haiku", ago(5)),
    invocation(1, {
      assignmentId: "unknown",
      usd: 0.2,
    }),
    // An orphaned group: outcomes with no assignment event.
    outcome(9, "quality_green", ago(3)),
    outcome(9, "merged", ago(2)),
  ];
  const report = buildExperimentReport(events, options());
  assertEquals(report.records.length, 1);
  assertEquals(
    buildAssignmentRecords(events, options()).unattributedEvents,
    3,
  );
  assert(
    report.warnings.some((warning) => warning.code === "unattributed-events"),
  );
});

Deno.test("fleet experiment report - a Fable model raises excluded-model", () => {
  const events = [
    assignment(1, "sonnet-haiku", ago(5)),
    invocation(1, { model: "fable-4", usd: 0.3 }),
    ...verifiedMerge(1, ago(2)),
  ];
  const report = buildExperimentReport(events, options());
  assertEquals(recordFor(report.records, 1).usesExcludedModel, true);
  assert(report.warnings.some((warning) => warning.code === "excluded-model"));
});

Deno.test("fleet experiment report - an unconfigured cohort raises unknown-arm", () => {
  const events = [
    assignment(1, "unassigned", ago(5)),
    ...verifiedMerge(1, ago(2)),
  ];
  const report = buildExperimentReport(events, options());
  const summary = armOf(report, "unassigned");
  assertEquals(summary.known, false);
  const warning = report.warnings.find((item) => item.code === "unknown-arm");
  assertEquals(warning?.arm, "unassigned");
});

Deno.test("fleet experiment report - biased assignment fires on a skewed covariate", () => {
  const events: LifecycleEvent[] = [];
  const covariates: Record<string, Record<string, string>> = {};
  for (let id = 1; id <= 24; id++) {
    const cohort = id <= 12 ? "sonnet-haiku" : "codex-test";
    events.push(assignment(id, cohort, ago(5)));
    events.push(outcome(id, "pr_opened", ago(5)));
    // Control is all large; the candidate is all small, so the pool is half and half.
    covariates[`acme/alpha#${id}`] = { size: cohort === "sonnet-haiku" ? "large" : "small" };
  }
  const report = buildExperimentReport(events, options({ minPerArm: 10, covariates }));
  const warning = report.warnings.find((item) =>
    item.code === "biased-assignment" && item.arm === "sonnet-haiku"
  );
  assert(warning !== undefined);
  assertStringIncludes(warning.message, '"size"');
});

Deno.test("fleet experiment report - biased assignment does not fire on a balanced covariate", () => {
  const events: LifecycleEvent[] = [];
  const covariates: Record<string, Record<string, string>> = {};
  for (let id = 1; id <= 24; id++) {
    const cohort = id <= 12 ? "sonnet-haiku" : "codex-test";
    events.push(assignment(id, cohort, ago(5)));
    events.push(outcome(id, "pr_opened", ago(5)));
    // Each arm holds the same half-and-half mix of sizes.
    covariates[`acme/alpha#${id}`] = { size: id % 2 === 0 ? "large" : "small" };
  }
  const report = buildExperimentReport(events, options({ minPerArm: 10, covariates }));
  assertEquals(
    report.warnings.filter((item) => item.code === "biased-assignment").length,
    0,
  );
});

Deno.test("fleet experiment report - unequal exposure fires when one arm takes most assignments", () => {
  const events: LifecycleEvent[] = [];
  for (let id = 1; id <= 20; id++) {
    const cohort = id <= 18 ? "sonnet-haiku" : "codex-test";
    events.push(assignment(id, cohort, ago(5)));
  }
  const report = buildExperimentReport(events, options());
  assert(
    report.warnings.some((warning) =>
      warning.code === "unequal-exposure" && warning.arm === "sonnet-haiku"
    ),
  );
});

Deno.test("fleet experiment report - low sample fires below the per-arm minimum", () => {
  const events = [
    assignment(1, "sonnet-haiku", ago(5)),
    ...verifiedMerge(1, ago(2)),
    assignment(2, "sonnet-haiku", ago(4)),
    ...verifiedMerge(2, ago(2)),
  ];
  const report = buildExperimentReport(events, options({ minPerArm: 10 }));
  assert(
    report.warnings.some((warning) =>
      warning.code === "low-sample" && warning.arm === "sonnet-haiku"
    ),
  );
});

Deno.test("fleet experiment report - a small sample gives no decision", () => {
  const events = [
    assignment(1, "sonnet-haiku", ago(5)),
    ...verifiedMerge(1, ago(2)),
  ];
  const report = buildExperimentReport(events, options({ minPerArm: 10 }));
  assertEquals(report.verdict.kind, "no-decision");
  assertStringIncludes(report.verdict.reason, "sonnet-haiku");
});

Deno.test("fleet experiment report - CSV quotes fields with commas and quotes, and joins hosts with semicolons", () => {
  const events = [
    assignment(1, "sonnet-haiku", ago(5), "host-a"),
    assignment(1, "sonnet-haiku", ago(4), "host-b"),
    ...verifiedMerge(1, ago(2)),
  ];
  const covariates = { "acme/alpha#1": { size: 'a,"b"' } };
  const report = buildExperimentReport(events, options({ covariates }));
  const csv = experimentRecordsCsv(report.records);
  const lines = csv.trimEnd().split("\n");
  assertEquals(lines.length, 2);
  assert(lines[0]?.startsWith("assignmentId,cohort,"));
  const expectedCovariates = JSON.stringify(report.records[0]?.covariates)
    .replaceAll('"', '""');
  assertStringIncludes(lines[1] ?? "", `"${expectedCovariates}"`);
  assertStringIncludes(lines[1] ?? "", "host-a;host-b");
});

Deno.test("fleet experiment report - the window excludes old assignments", () => {
  const events = [
    assignment(1, "sonnet-haiku", ago(40)),
    ...verifiedMerge(1, ago(38)),
    assignment(2, "sonnet-haiku", ago(5)),
    ...verifiedMerge(2, ago(3)),
  ];
  const report = buildExperimentReport(events, options({ windowDays: 30 }));
  assertEquals(report.records.map((record) => record.assignmentId), [uuid(2)]);
});

Deno.test("fleet experiment report - weekly rows bucket by Monday in UTC", () => {
  // NOW is a Saturday, so the week of 2026-10-12 starts that Monday.
  const events = [
    // Sunday 2026-10-11, in the week that started Monday 2026-10-05.
    assignment(1, "sonnet-haiku", "2026-10-11T23:00:00.000Z"),
    outcome(1, "pr_opened", "2026-10-11T23:30:00.000Z"),
    // Monday 2026-10-12, in the week that starts 2026-10-12.
    assignment(2, "sonnet-haiku", "2026-10-12T01:00:00.000Z"),
    ...verifiedMerge(2, "2026-10-12T03:00:00.000Z"),
    assignment(3, "sonnet-haiku", "2026-10-12T20:00:00.000Z"),
    outcome(3, "pr_opened", "2026-10-12T20:30:00.000Z"),
  ];
  const report = buildExperimentReport(events, options({ windowDays: 30 }));
  assertEquals(
    report.weekly.map((row) => [row.weekStart, row.arm, row.assigned, row.merged]),
    [
      ["2026-10-05", "sonnet-haiku", 1, 0],
      ["2026-10-12", "sonnet-haiku", 2, 1],
    ],
  );
});

Deno.test("fleet experiment report - the same events and options give an identical report", () => {
  const events = [
    assignment(1, "sonnet-haiku", ago(5)),
    ...verifiedMerge(1, ago(2)),
    assignment(2, "codex-test", ago(6)),
    invocation(2, { role: "manager", usd: 0.7 }),
  ];
  const first = buildExperimentReport(events, options());
  const second = buildExperimentReport(events, options());
  assertEquals(second, first);
});

Deno.test("fleet experiment report - every built event validates against the ledger", () => {
  const events = [
    assignment(1, "sonnet-haiku", ago(5)),
    ...verifiedMerge(1, ago(2)),
  ];
  for (const item of events) {
    validateLifecycleEvent(item);
  }
});

Deno.test("fleet experiment report - the formatted text carries the USD-only header and a verdict", () => {
  const events = [
    assignment(1, "sonnet-haiku", ago(5)),
    ...verifiedMerge(1, ago(2)),
  ];
  const text = formatExperimentReport(
    buildExperimentReport(events, options({ minPerArm: 10 })),
  );
  assertStringIncludes(text, "Estimated API-equivalent USD only — not billing");
  assertStringIncludes(text, "| sonnet-haiku |");
  assertStringIncludes(text, "Verdict: no-decision");
});
