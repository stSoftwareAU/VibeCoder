import { assert, assertEquals } from "@std/assert";
import {
  buildPrCompletionReport,
  fingerprintReviewPolicy,
  type PrCompletionInput,
  type PrCompletionRecord,
} from "../lib/pr_completion_report.ts";

const start = "2026-10-01T00:00:00.000Z";
const end = "2026-11-01T00:00:00.000Z";
const observedAt = "2026-11-02T00:00:00.000Z";

function pr(
  number: number,
  extra: Partial<PrCompletionRecord> = {},
): PrCompletionRecord {
  return {
    repo: "org/repo",
    number,
    createdAt: "2026-10-20T00:00:00.000Z",
    baseRef: "main",
    defaultBranch: "main",
    headRef: `issue-${number}`,
    headSha: `sha-${number}`,
    state: "merged",
    mergedAt: "2026-10-20T02:00:00.000Z",
    actionsComplete: true,
    ...extra,
  };
}

function action(
  number: number,
  actionId: string,
  kind: "implementation" | "repair" | "review" | "dismissal" | "merge",
  actor: "fleet" | "human" | "unknown",
) {
  return {
    actionId,
    runId: `run-${actionId}`,
    component: "worker",
    repo: "org/repo",
    prNumber: number,
    headSha: `sha-${number}`,
    kind,
    timestamp: "2026-10-20T01:00:00.000Z",
    outcome: "confirmed",
    actor,
    verified: actor !== "unknown",
  };
}

function input(overrides: Partial<PrCompletionInput> = {}): PrCompletionInput {
  return {
    cohort: { start, end, observedAt },
    prs: [],
    actions: [],
    blockers: [],
    ciRuns: [],
    regressions: [],
    deployments: [],
    expectedDeployment: {
      components: ["worker", "reviewer", "babysitter"],
      revision: "abcdef0123456789",
      policyFingerprint: "a".repeat(64),
      maxHeartbeatAgeHours: 2,
    },
    ...overrides,
  };
}

Deno.test("PR completion report deduplicates hosts and separates trusted outcomes", () => {
  const report = buildPrCompletionReport(input({
    prs: [
      pr(1),
      pr(1, { host: "host-b" }),
      pr(2),
      pr(3, { state: "open", mergedAt: null }),
      pr(4, { state: "closed", mergedAt: null }),
      pr(5, { baseRef: "milestone/release", rollupRoot: "org/repo#6" }),
      pr(6, { baseRef: "main", rollupRoot: "org/repo#6" }),
      pr(7, {
        state: "open",
        mergedAt: null,
        ownerGated: true,
        ownerGateVerified: true,
      }),
    ] as PrCompletionInput["prs"],
    actions: [
      action(1, "a1", "implementation", "fleet"),
      action(1, "a2", "repair", "human"),
      action(1, "a3", "merge", "fleet"),
      action(2, "a4", "implementation", "fleet"),
      action(2, "a5", "merge", "fleet"),
      action(5, "a6", "implementation", "fleet"),
      action(6, "a7", "merge", "fleet"),
    ] as PrCompletionInput["actions"],
    ciRuns: [
      { repo: "org/repo", prNumber: 6, runId: "ci-1", durationMinutes: 10 },
      {
        repo: "org/repo",
        prNumber: 5,
        runId: "ci-intermediate",
        durationMinutes: 30,
      },
    ],
  }));

  assertEquals(report.cohort.prCount, 7);
  assertEquals(report.cohort.duplicateObservations, 1);
  assertEquals(report.cohort.mergedPrs, 4);
  assertEquals(report.cohort.openPrs, 2);
  assertEquals(report.cohort.closedUnmergedPrs, 1);
  assertEquals(report.cohort.ownerGatedPrs, 1);
  assertEquals(report.completion.unattendedMerged, 1);
  assertEquals(report.completion.humanAssistedMerged, 1);
  assertEquals(report.completion.unknownMerged, 2);
  assertEquals(report.delivery.defaultBranchChanges, 3);
  assertEquals(report.delivery.milestonePrs, 1);
  assertEquals(report.delivery.intermediateRollupPrs, 1);
  assertEquals(report.timings.medianMergeHours, 2);
  assertEquals(report.timings.p90MergeHours, 2);
  assertEquals(report.delivery.ciRuns, 1);
  assertEquals(report.delivery.ciMinutes, 10);
  assertEquals(report.delivery.ciMinutesPerDeliveredChange, 10 / 3);
});

Deno.test("user identity does not disqualify verified automation; unknown history stays unknown", () => {
  const report = buildPrCompletionReport(input({
    prs: [pr(10), pr(11)],
    actions: [
      {
        ...action(10, "user-account", "implementation", "fleet"),
        actorLogin: "owner",
      },
      {
        ...action(10, "merge-user-account", "merge", "fleet"),
        actorLogin: "owner",
      },
    ] as PrCompletionInput["actions"],
  }));
  assertEquals(report.completion.unattendedMerged, 1);
  assertEquals(report.completion.unknownMerged, 1);
});

Deno.test("report keeps zero denominators unavailable and exposes waiting and regressions", () => {
  const report = buildPrCompletionReport(input({
    prs: [pr(20, { state: "open", mergedAt: null })],
    blockers: [{
      repo: "org/repo",
      prNumber: 20,
      blocker: "required-ci",
      startedAt: "2026-10-20T00:00:00Z",
      endedAt: null,
    }],
    regressions: [{
      repo: "org/repo",
      prNumber: 99,
      detectedAt: "2026-10-21T00:00:00Z",
      resolved: false,
    }],
  }));
  assertEquals(
    buildPrCompletionReport(input()).completion.unattendedWithin24Hours,
    null,
  );
  assertEquals(report.timings.medianMergeHours, null);
  assertEquals(report.waiting.openIntervals, 1);
  assertEquals(report.regressions.unattributed, 1);
  assert(report.coverage.unknownPrHistory >= 1);
});

Deno.test("report marks a cohort window incomplete when observation precedes its end", () => {
  const report = buildPrCompletionReport(input({
    cohort: { start, end, observedAt: "2026-10-25T00:00:00.000Z" },
  }));
  assertEquals(report.coverage.incompleteObservationWindow, true);
});

Deno.test("rollout check separates eligibility, rediscovery and processing before the target window", () => {
  const policyFingerprint = "a".repeat(64);
  const report = buildPrCompletionReport(input({
    cohort: { start: "2026-10-20T00:00:00.000Z", end: "2026-11-03T00:00:00.000Z", observedAt: "2026-10-25T00:00:00.000Z" },
    deployments: ["worker", "reviewer", "babysitter"].map((component) => ({ component, revision: "abcdef0123456789", policyFingerprint, observedAt: "2026-10-25T00:00:00.000Z" })),
    rollout: {
      verifiedAt: "2026-10-20T00:00:00.000Z",
      strandedPrs: [
        { repo: "org/repo", prNumber: 30, eligible: true, rediscovered: true, processed: false },
        { repo: "org/repo", prNumber: 31, eligible: true, rediscovered: false, processed: false },
        { repo: "org/repo", prNumber: 32, eligible: false, rediscovered: false, processed: false },
      ],
    },
  }));
  assertEquals(report.rollout.eligibleStrandedPrs, 2);
  assertEquals(report.rollout.rediscoveredPrs, 1);
  assertEquals(report.rollout.processedPrs, 0);
  assertEquals(report.rollout.notRediscoveredPrs, 1);
  assertEquals(report.targetEvaluation.status, "pending");
});

Deno.test("the 90 percent target is evaluated only after verified deployment and fourteen days", () => {
  const policyFingerprint = "a".repeat(64);
  const report = buildPrCompletionReport(input({
    cohort: { start: "2026-10-20T00:00:00.000Z", end: "2026-11-03T00:00:00.000Z", observedAt: "2026-11-04T00:00:00.000Z" },
    prs: [pr(40, { createdAt: "2026-10-21T00:00:00.000Z", mergedAt: "2026-10-21T02:00:00.000Z" })],
    actions: [action(40, "impl-40", "implementation", "fleet"), action(40, "merge-40", "merge", "fleet")] as PrCompletionInput["actions"],
    deployments: ["worker", "reviewer", "babysitter"].map((component) => ({ component, revision: "abcdef0123456789", policyFingerprint, observedAt: "2026-11-04T00:00:00.000Z" })),
    rollout: { verifiedAt: "2026-10-20T00:00:00.000Z", strandedPrs: [] },
  }));
  assertEquals(report.targetEvaluation.status, "met");
  assertEquals(report.targetEvaluation.unattendedWithin24Hours, 1);
});

Deno.test("deployment inventory reports missing and stale components as degraded", () => {
  const report = buildPrCompletionReport(input({
    deployments: [{
      component: "worker",
      revision: "old",
      policyFingerprint: "b".repeat(64),
      observedAt,
    }],
  }));
  assertEquals(report.deployment.status, "degraded");
  assertEquals(report.deployment.missingComponents, ["babysitter", "reviewer"]);
  assertEquals(report.deployment.mismatchedComponents, ["worker"]);
});

Deno.test("policy fingerprint includes only the resolved policy allowlist", async () => {
  const first = await fingerprintReviewPolicy(
    { issue_executor_split: true, token: "secret-one" } as Record<
      string,
      string | number | boolean
    >,
  );
  const second = await fingerprintReviewPolicy(
    { issue_executor_split: true, token: "secret-two" } as Record<
      string,
      string | number | boolean
    >,
  );
  assertEquals(first, second);
  assertEquals(first === await fingerprintReviewPolicy({ issue_executor_split: false }), false);
  assertEquals(
    await fingerprintReviewPolicy({ issue_executor_split: false }),
    await fingerprintReviewPolicy(
      { issue_executor_split: false, token: "secret" } as Record<
        string,
        string | number | boolean
      >,
    ),
  );
});
