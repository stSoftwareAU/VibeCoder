/**
 * Acceptance tests for the fleet experiment, run on a synthetic history
 * (Issue #3645).
 *
 * The synthetic history gives the control a cheaper price for the same merge
 * probability as a candidate arm, so the report should separate the two. Each
 * test drives the real generator and the real report.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  CONTROL_ARM_ID,
  type ExperimentArm,
} from "../lib/fleet_experiment_arms.ts";
import {
  type ArmSummary,
  buildExperimentReport,
  type ExperimentOptions,
  type ExperimentReport,
} from "../lib/fleet_experiment_report.ts";
import {
  generateSyntheticHistory,
  type SyntheticArmSpec,
  type SyntheticHistoryOptions,
} from "../lib/fleet_experiment_synthetic.ts";
import { validateLifecycleEvent } from "../lib/lifecycle_ledger.ts";

/** The reference time for the synthetic history. */
const NOW = new Date("2026-10-17T00:00:00.000Z");

/** The incumbent control: Sonnet manager, Haiku executor. */
const CONTROL: ExperimentArm = {
  id: CONTROL_ARM_ID,
  label: "Sonnet manager + Haiku executor",
  manager: { provider: "claude", model: "sonnet" },
  executor: { provider: "claude", model: "haiku" },
  control: true,
  weight: 1,
  status: "active",
};

/** A candidate with unequal model prices: the same merge rate, dearer roles. */
const CANDIDATE: ExperimentArm = {
  id: "codex-test",
  label: "Codex test candidate",
  manager: { provider: "codex", model: "astra" },
  executor: { provider: "codex", model: "sol" },
  control: false,
  weight: 1,
  status: "active",
};

/** The arm specs: the same merge probability, with a control that is cheaper. */
const SPECS: SyntheticArmSpec[] = [
  {
    arm: CONTROL,
    mergeProbability: 0.6,
    managerCostUsd: 0.6,
    executorCostUsd: 0.15,
  },
  {
    arm: CANDIDATE,
    mergeProbability: 0.6,
    managerCostUsd: 1.5,
    executorCostUsd: 0.6,
  },
];

/** The arms the report compares. */
const ARMS: ExperimentArm[] = [CONTROL, CANDIDATE];

/** Synthetic history options for a population of `issues` issues. */
function historyOptions(
  overrides: Partial<SyntheticHistoryOptions> = {},
): SyntheticHistoryOptions {
  return {
    seed: 7,
    experimentSeed: "exp-3645",
    issues: 400,
    now: NOW,
    days: 60,
    arms: SPECS,
    repos: ["acme/alpha", "acme/beta", "acme/gamma"],
    hosts: ["host-a", "host-b"],
    pendingShare: 0.1,
    ...overrides,
  };
}

/** Report options that cover the whole synthetic window. */
function reportOptions(
  overrides: Partial<ExperimentOptions> = {},
): ExperimentOptions {
  return {
    now: NOW,
    windowDays: 61,
    horizonDays: 14,
    arms: ARMS,
    bootstrapSamples: 200,
    ...overrides,
  };
}

/** Find one arm's summary, failing the test when it is absent. */
function armOf(report: ExperimentReport, id: string): ArmSummary {
  const found = report.arms.find((arm) => arm.armId === id);
  assert(found !== undefined, `arm ${id} is missing from the report`);
  return found;
}

Deno.test("fleet experiment synthetic - running twice gives identical events and report", async () => {
  const first = await generateSyntheticHistory(historyOptions());
  const second = await generateSyntheticHistory(historyOptions());
  assertEquals(second, first);
  assertEquals(
    buildExperimentReport(second.events, reportOptions()),
    buildExperimentReport(first.events, reportOptions()),
  );
});

Deno.test("fleet experiment synthetic - every generated event validates against the ledger", async () => {
  const { events } = await generateSyntheticHistory(historyOptions());
  assert(events.length > 0);
  for (const event of events) {
    validateLifecycleEvent(event);
  }
});

Deno.test("fleet experiment synthetic - pending issues are never counted as merged", async () => {
  const { events } = await generateSyntheticHistory(historyOptions());
  const report = buildExperimentReport(events, reportOptions());

  const pendingIds = new Set(
    report.records
      .filter((record) => record.status === "pending")
      .map((record) => record.assignmentId),
  );
  // round(400 * 0.1) issues are left pending with an open PR.
  assertEquals(pendingIds.size, 40);

  const mergeOutcomeIds = new Set(
    events
      .filter((event) => event.kind === "outcome" && event.outcome === "merged")
      .map((event) => event.assignmentId),
  );
  for (const id of pendingIds) {
    assert(!mergeOutcomeIds.has(id), `pending assignment ${id} has a merge`);
  }
  assertEquals(
    report.records.filter((record) => record.status === "merged").length,
    mergeOutcomeIds.size,
  );
});

Deno.test("fleet experiment synthetic - the cheaper control has more merged per USD than the candidate", async () => {
  const { events } = await generateSyntheticHistory(historyOptions());
  const report = buildExperimentReport(events, reportOptions());
  const control = armOf(report, CONTROL_ARM_ID);
  const candidate = armOf(report, "codex-test");
  assert(control.mergedPerUsd !== null, "control has no merged per USD");
  assert(candidate.mergedPerUsd !== null, "candidate has no merged per USD");
  assert(control.mergedPerUsd > candidate.mergedPerUsd);
});

Deno.test("fleet experiment synthetic - a large sample with a clear price gap gives the control as leading arm", async () => {
  const { events } = await generateSyntheticHistory(historyOptions());
  const report = buildExperimentReport(events, reportOptions());
  assertEquals(report.verdict.kind, "leading-arm");
  assertEquals(report.verdict.arm, CONTROL_ARM_ID);
});

Deno.test("fleet experiment synthetic - a small sample gives no decision with a low-sample warning", async () => {
  const { events } = await generateSyntheticHistory(
    historyOptions({ issues: 30 }),
  );
  const report = buildExperimentReport(
    events,
    reportOptions({ minPerArm: 20 }),
  );
  assertEquals(report.verdict.kind, "no-decision");
  assert(report.warnings.some((warning) => warning.code === "low-sample"));
});

Deno.test("fleet experiment synthetic - unknown costs raise a missing-cost warning", async () => {
  const { events } = await generateSyntheticHistory(
    historyOptions({ unknownCostShare: 0.2 }),
  );
  const report = buildExperimentReport(events, reportOptions());
  assert(report.warnings.some((warning) => warning.code === "missing-cost"));
});
