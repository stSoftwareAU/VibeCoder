import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  buildPrCompletionReport,
  fingerprintWorkerReviewPolicy,
  type PrCompletionInput,
  type PrCompletionRecord,
} from "../lib/pr_completion_report.ts";
import type { WorkerConfig } from "../types.ts";

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
  kind:
    | "implementation"
    | "repair"
    | "milestone"
    | "review"
    | "dismissal"
    | "merge",
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
    outcome: "confirmed" as const,
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

Deno.test("failed fleet attempts do not obscure confirmed delivery or satisfy evidence", () => {
  const failed = {
    ...action(1, "failed", "merge", "fleet"),
    outcome: "failed" as const,
  };
  const report = buildPrCompletionReport(input({
    prs: [pr(1), pr(2)],
    actions: [
      action(1, "push", "implementation", "fleet"),
      failed,
      action(1, "merge", "merge", "fleet"),
      action(2, "push2", "implementation", "fleet"),
      { ...failed, prNumber: 2, actionId: "failed2" },
    ],
    rollout: { verifiedAt: "2026-10-15T00:00:00Z", strandedPrs: [] },
  }));
  assertEquals(report.completion.unattendedMerged, 1);
  assertEquals(report.completion.unknownMerged, 1);
  assertEquals(report.targetEvaluation.unattendedWithin24Hours, 0.5);
});

Deno.test("PR completion report deduplicates repeated observations and separates trusted outcomes", () => {
  const report = buildPrCompletionReport(input({
    prs: [
      pr(1),
      pr(1, { observedAt: "2026-10-30T00:00:00.000Z" }),
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
      pr(8, {
        state: "open",
        mergedAt: null,
        ownerGated: true,
        ownerGateVerified: false,
      }),
    ] as PrCompletionInput["prs"],
    actions: [
      action(1, "a1", "implementation", "fleet"),
      action(1, "a2", "repair", "human"),
      action(1, "a3", "merge", "fleet"),
      action(1, "a8", "review", "fleet"),
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

  assertEquals(report.cohort.prCount, 8);
  assertEquals(report.cohort.duplicateObservations, 1);
  assertEquals(report.cohort.mergedPrs, 4);
  assertEquals(report.cohort.openPrs, 3);
  assertEquals(report.cohort.closedUnmergedPrs, 1);
  assertEquals(report.cohort.ownerGatedPrs, 1);
  assertEquals(report.cohort.unverifiedOwnerGateLabels, 1);
  assertEquals(report.completion.eligiblePrs, 7);
  assertEquals(report.completion.unattendedMerged, 1);
  assertEquals(report.completion.humanAssistedMerged, 1);
  assertEquals(report.completion.unknownMerged, 2);
  assertEquals(report.delivery.defaultBranchChanges, 3);
  assertEquals(report.delivery.milestonePrs, 1);
  assertEquals(report.delivery.intermediateRollupPrs, 1);
  assertEquals(report.delivery.reviewRounds, 1);
  assertEquals(report.delivery.fixRounds, 1);
  assertEquals(report.timings.medianMergeHours, 2);
  assertEquals(report.timings.p90MergeHours, 2);
  assertEquals(report.delivery.ciRuns, 1);
  assertEquals(report.delivery.ciMinutes, 10);
  assertEquals(report.delivery.ciMinutesPerDeliveredChange, 10 / 3);
});

Deno.test("a login-looking field cannot change an action's actor; unknown stays unknown", () => {
  // Extra keys are ignored: the actor and verification decide, never a login.
  // The cast admits keys the type does not declare, as unexpected input would.
  const report = buildPrCompletionReport(input({
    prs: [pr(10), pr(11)],
    actions: [
      {
        ...action(10, "fleet-impl", "implementation", "fleet"),
        actorLogin: "owner",
      },
      { ...action(10, "fleet-merge", "merge", "fleet"), actorLogin: "owner" },
      {
        ...action(11, "unknown-impl", "implementation", "unknown"),
        login: "owner",
        actorLogin: "owner",
      },
      {
        ...action(11, "unknown-merge", "merge", "unknown"),
        login: "owner",
        actorLogin: "owner",
      },
    ] as unknown as PrCompletionInput["actions"],
  }));
  assertEquals(report.completion.unattendedMerged, 1);
  assertEquals(report.completion.unknownMerged, 1);
  assertEquals(report.completion.humanAssistedMerged, 0);
});

Deno.test("CI accounting deduplicates shared evidence and keeps workflow and job units separate", () => {
  const sharedWorkflow = {
    repo: "org/repo",
    prNumber: 6,
    runId: "run-6",
    attempt: 2,
    kind: "workflow_run" as const,
    durationMinutes: 5,
    durationSeconds: 300,
  };
  const report = buildPrCompletionReport(input({
    prs: [pr(6)],
    actions: [
      action(6, "implementation-6", "implementation", "fleet"),
      action(6, "merge-6", "merge", "fleet"),
    ],
    ciRuns: [
      sharedWorkflow,
      { ...sharedWorkflow, prNumber: 6 },
      {
        repo: "org/repo",
        prNumber: 6,
        runId: "check-6",
        kind: "check_run",
        durationMinutes: 2,
      },
      {
        repo: "org/repo",
        prNumber: 6,
        runId: "job-6",
        kind: "job",
        workflowRunId: "run-6",
        attempt: 2,
        durationMinutes: 1,
        durationSeconds: 60,
      },
      {
        repo: "org/repo",
        prNumber: 6,
        runId: "job-7",
        kind: "job",
        workflowRunId: "run-6",
        attempt: 2,
        durationMinutes: 2,
        durationSeconds: 120,
      },
    ],
  }));
  assertEquals(report.delivery.ciWorkflowRuns, 1);
  assertEquals(report.delivery.ciChecks, 1);
  assertEquals(report.delivery.ciJobs, 2);
  assertEquals(report.delivery.ciRuns, 1);
  assertEquals(report.delivery.ciMinutes, 5);
  assertEquals(report.delivery.ciJobMinutes, 3);
});

Deno.test("truncated repositories are echoed in coverage, default to none, and must be a list", () => {
  assertEquals(buildPrCompletionReport(input()).coverage.truncatedRepos, []);
  const report = buildPrCompletionReport(
    input({ truncatedRepos: ["org/repo"] }),
  );
  assertEquals(report.coverage.truncatedRepos, ["org/repo"]);
  assertThrows(
    () =>
      buildPrCompletionReport(
        input({ truncatedRepos: "org/repo" as unknown as string[] }),
      ),
    Error,
    "truncatedRepos must be a list of repositories",
  );
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
    cohort: {
      start: "2026-10-20T00:00:00.000Z",
      end: "2026-11-03T00:00:00.000Z",
      observedAt: "2026-10-25T00:00:00.000Z",
    },
    deployments: ["worker", "reviewer", "babysitter"].map((component) => ({
      component,
      revision: "abcdef0123456789",
      policyFingerprint,
      observedAt: "2026-10-25T00:00:00.000Z",
    })),
    rollout: {
      verifiedAt: "2026-10-20T00:00:00.000Z",
      discoveryEvidenceComplete: true,
      strandedPrs: [
        {
          repo: "org/repo",
          prNumber: 30,
          eligible: true,
          discovered: true,
          eligibilityConfirmed: true,
          processed: false,
        },
        {
          repo: "org/repo",
          prNumber: 31,
          eligible: true,
          discovered: false,
          eligibilityConfirmed: false,
          processed: false,
        },
        {
          repo: "org/repo",
          prNumber: 32,
          eligible: false,
          discovered: false,
          eligibilityConfirmed: false,
          processed: false,
        },
      ],
    },
  }));
  assertEquals(report.rollout.eligibleStrandedPrs, 2);
  assertEquals(report.rollout.discoveredPrs, 1);
  assertEquals(report.rollout.rediscoveredPrs, 1);
  assertEquals(report.rollout.processedPrs, 0);
  assertEquals(report.rollout.notRediscoveredPrs, 1);
  assertEquals(report.rollout.unknownDiscoveryPrs, 0);
  assertEquals(report.targetEvaluation.status, "pending");
});

Deno.test("a snapshot persisted with the old rediscovered shape reads discovery as unknown, not as rediscovered", () => {
  // Round-trip through JSON, as a --write-snapshot file is read back by --input.
  // The old shape has `rediscovered` and no `discovered` or discoveryEvidenceComplete.
  const persisted = JSON.parse(JSON.stringify({
    ...targetInput({
      observedAt: "2026-11-04T00:00:00.000Z",
      discoveryComplete: true,
    }),
    rollout: {
      verifiedAt: "2026-10-20T00:00:00.000Z",
      strandedPrs: [
        {
          repo: "org/repo",
          prNumber: 30,
          eligible: true,
          rediscovered: true,
          processed: true,
        },
        {
          repo: "org/repo",
          prNumber: 31,
          eligible: true,
          rediscovered: false,
          processed: false,
        },
      ],
    },
  })) as PrCompletionInput;
  const report = buildPrCompletionReport(persisted);
  assertEquals(report.rollout.eligibleStrandedPrs, 2);
  assertEquals(report.rollout.discoveredPrs, 0);
  assertEquals(report.rollout.rediscoveredPrs, 0);
  assertEquals(report.rollout.notRediscoveredPrs, 0);
  assertEquals(report.rollout.unknownDiscoveryPrs, 2);
  // Discovery is unknown, so the target is unavailable rather than met.
  assertEquals(report.targetEvaluation.status, "unavailable");
});

Deno.test("the 90 percent target is evaluated only after verified deployment and fourteen days", () => {
  const policyFingerprint = "a".repeat(64);
  const report = buildPrCompletionReport(input({
    cohort: {
      start: "2026-10-20T00:00:00.000Z",
      end: "2026-11-03T00:00:00.000Z",
      observedAt: "2026-11-04T00:00:00.000Z",
    },
    prs: [
      pr(40, {
        createdAt: "2026-10-21T00:00:00.000Z",
        mergedAt: "2026-10-21T02:00:00.000Z",
      }),
    ],
    actions: [
      action(40, "impl-40", "implementation", "fleet"),
      action(40, "merge-40", "merge", "fleet"),
    ] as PrCompletionInput["actions"],
    deployments: ["worker", "reviewer", "babysitter"].map((component) => ({
      hostId: "host-a",
      component,
      revision: "abcdef0123456789",
      policyFingerprint,
      observedAt: "2026-11-04T00:00:00.000Z",
    })),
    expectedDeployment: {
      ...input().expectedDeployment,
      inventory: ["worker", "reviewer", "babysitter"].map((component) => ({
        hostId: "host-a",
        component,
      })),
      inventoryComplete: true,
    },
    rollout: {
      verifiedAt: "2026-10-20T00:00:00.000Z",
      discoveryEvidenceComplete: true,
      strandedPrs: [],
    },
  }));
  assertEquals(report.targetEvaluation.status, "met");
  assertEquals(report.targetEvaluation.unattendedWithin24Hours, 1);
  assertEquals(report.delivery.ciMinutes, null);
  assertEquals(report.delivery.ciRunsPerDeliveredChange, null);
  assertEquals(report.coverage.deliveredChangesWithoutCiData, 1);
});

Deno.test("deployment inventory reports missing and stale components as degraded", () => {
  const report = buildPrCompletionReport(input({
    deployments: [{
      component: "worker",
      revision: "old",
      policyFingerprint: "b".repeat(64),
      observedAt: "2026-10-01T00:00:00.000Z",
    }],
  }));
  assertEquals(report.deployment.status, "degraded");
  assertEquals(report.deployment.missingComponents, ["babysitter", "reviewer"]);
  assertEquals(report.deployment.missingHostComponents, ["inventory"]);
  assertEquals(report.deployment.mismatchedComponents, ["worker"]);
  assertEquals(report.deployment.staleComponents, ["worker"]);
});

Deno.test("the target is unavailable after its window when deployment or discovery evidence is incomplete", () => {
  const report = buildPrCompletionReport(input({
    cohort: {
      start: "2026-10-20T00:00:00.000Z",
      end: "2026-11-04T00:00:00.000Z",
      observedAt: "2026-11-04T00:00:00.000Z",
    },
    rollout: { verifiedAt: "2026-10-20T00:00:00.000Z", strandedPrs: [] },
  }));
  assertEquals(report.targetEvaluation.status, "unavailable");
});

/**
 * A rollout input whose target operands are set one at a time. Otherwise it is
 * ready: one PR created and merged inside the window with fleet evidence, and
 * every expected component deployed on one host, unless `deployedComponents`
 * leaves some out.
 */
function targetInput(options: {
  observedAt: string;
  discoveryComplete: boolean;
  deployedComponents?: string[];
  prs?: PrCompletionInput["prs"];
}): PrCompletionInput {
  const components = ["worker", "reviewer", "babysitter"];
  return input({
    cohort: {
      start: "2026-10-20T00:00:00.000Z",
      end: "2026-11-03T00:00:00.000Z",
      observedAt: options.observedAt,
    },
    prs: options.prs ?? [
      pr(40, {
        createdAt: "2026-10-21T00:00:00.000Z",
        mergedAt: "2026-10-21T02:00:00.000Z",
      }),
    ],
    actions: [
      action(40, "impl-40", "implementation", "fleet"),
      action(40, "merge-40", "merge", "fleet"),
    ] as PrCompletionInput["actions"],
    deployments: (options.deployedComponents ?? components).map((
      component,
    ) => ({
      hostId: "host-a",
      component,
      revision: "abcdef0123456789",
      policyFingerprint: "a".repeat(64),
      observedAt: options.observedAt,
    })),
    expectedDeployment: {
      ...input().expectedDeployment,
      inventory: components.map((component) => ({
        hostId: "host-a",
        component,
      })),
      inventoryComplete: true,
    },
    rollout: {
      verifiedAt: "2026-10-20T00:00:00.000Z",
      discoveryEvidenceComplete: options.discoveryComplete,
      strandedPrs: [],
    },
  });
}

Deno.test("the target is unavailable after its window when discovery evidence is incomplete, deployment verified", () => {
  const report = buildPrCompletionReport(targetInput({
    observedAt: "2026-11-04T00:00:00.000Z",
    discoveryComplete: false,
  }));
  assertEquals(report.deployment.status, "verified");
  // The one PR is unattended, so only the incomplete discovery makes this unavailable.
  assertEquals(report.targetEvaluation.eligiblePrs, 1);
  assertEquals(report.targetEvaluation.unattendedWithin24Hours, 1);
  assertEquals(report.targetEvaluation.status, "unavailable");
});

Deno.test("the target is unavailable after its window when deployment is degraded, discovery complete", () => {
  const report = buildPrCompletionReport(targetInput({
    observedAt: "2026-11-04T00:00:00.000Z",
    deployedComponents: ["worker", "reviewer"],
    discoveryComplete: true,
  }));
  assertEquals(report.deployment.status, "degraded");
  // The one PR is unattended, so only the degraded deployment makes this unavailable.
  assertEquals(report.targetEvaluation.eligiblePrs, 1);
  assertEquals(report.targetEvaluation.unattendedWithin24Hours, 1);
  assertEquals(report.targetEvaluation.status, "unavailable");
});

Deno.test("the target is pending while its window is open, even with deployment verified and discovery complete", () => {
  const report = buildPrCompletionReport(targetInput({
    observedAt: "2026-10-25T00:00:00.000Z",
    discoveryComplete: true,
  }));
  assertEquals(report.deployment.status, "verified");
  assertEquals(report.targetEvaluation.status, "pending");
});

Deno.test("the target is met or not met once window, deployment and discovery are all satisfied", () => {
  const met = buildPrCompletionReport(targetInput({
    observedAt: "2026-11-04T00:00:00.000Z",
    discoveryComplete: true,
  }));
  assertEquals(met.deployment.status, "verified");
  assertEquals(met.targetEvaluation.unattendedWithin24Hours, 1);
  assertEquals(met.targetEvaluation.status, "met");

  // A second eligible PR that is still open halves the unattended share.
  const notMet = buildPrCompletionReport(targetInput({
    observedAt: "2026-11-04T00:00:00.000Z",
    discoveryComplete: true,
    prs: [
      pr(40, {
        createdAt: "2026-10-21T00:00:00.000Z",
        mergedAt: "2026-10-21T02:00:00.000Z",
      }),
      pr(41, {
        createdAt: "2026-10-21T00:00:00.000Z",
        state: "open",
        mergedAt: null,
      }),
    ],
  }));
  assertEquals(notMet.deployment.status, "verified");
  assertEquals(notMet.targetEvaluation.eligiblePrs, 2);
  assertEquals(notMet.targetEvaluation.unattendedWithin24Hours, 0.5);
  assertEquals(notMet.targetEvaluation.status, "not_met");
});

Deno.test("per-host deployment inventory does not let a fresh host mask a stale host", () => {
  const report = buildPrCompletionReport(input({
    deployments: [
      {
        hostId: "host-a",
        component: "worker",
        revision: "abcdef0123456789",
        policyFingerprint: "a".repeat(64),
        observedAt,
      },
      {
        hostId: "host-b",
        component: "worker",
        revision: "abcdef0123456789",
        policyFingerprint: "a".repeat(64),
        observedAt: "2026-11-01T20:00:00.000Z",
      },
      {
        component: "worker",
        revision: "abcdef0123456789",
        policyFingerprint: "a".repeat(64),
        observedAt,
      },
    ],
    expectedDeployment: {
      ...input().expectedDeployment,
      components: ["worker"],
      inventory: [
        { hostId: "host-a", component: "worker" },
        { hostId: "host-b", component: "worker" },
      ],
    },
  }));
  assertEquals(report.deployment.status, "degraded");
  assertEquals(report.deployment.staleHostComponents, ["host-b/worker"]);
  assertEquals(report.deployment.missingHostComponents, []);
});

Deno.test("deployment report exposes mixed revision and policy observations", () => {
  const report = buildPrCompletionReport(input({
    deployments: [
      {
        component: "worker",
        revision: "abcdef0123456789",
        policyFingerprint: "a".repeat(64),
        observedAt: "2026-11-01T23:00:00.000Z",
      },
      {
        component: "worker",
        revision: "old",
        policyFingerprint: "b".repeat(64),
        observedAt,
      },
      {
        component: "reviewer",
        revision: "abcdef0123456789",
        policyFingerprint: "a".repeat(64),
        observedAt,
      },
      {
        component: "babysitter",
        revision: "abcdef0123456789",
        policyFingerprint: "a".repeat(64),
        observedAt,
      },
    ],
  }));
  assertEquals(report.deployment.mixedRevisions, ["worker"]);
  assertEquals(report.deployment.mixedPolicies, ["worker"]);
});

/** A worker config with the settings the policy fingerprint reads, plus overrides. */
function workerConfig(overrides: Record<string, unknown> = {}): WorkerConfig {
  return {
    repos: ["org/repo"],
    issueExecutorSplit: true,
    issueSubAgentTier: "sonnet",
    issueReviewerAgents: true,
    externalOrchestration: false,
    repoConfig: {
      "org/repo": { issueExecutorSplit: false, skipAutoMerge: false },
    },
    ...overrides,
  } as unknown as WorkerConfig;
}

Deno.test("policy fingerprint changes with each allowlisted setting and not with any other", async () => {
  const base = await fingerprintWorkerReviewPolicy(workerConfig());
  assert(/^[0-9a-f]{64}$/.test(base), "the fingerprint is SHA-256 hex");
  const included: Array<[string, Record<string, unknown>]> = [
    ["issueExecutorSplit", { issueExecutorSplit: false }],
    ["issueSubAgentTier", { issueSubAgentTier: "haiku" }],
    ["issueReviewerAgents", { issueReviewerAgents: false }],
    ["externalOrchestration", { externalOrchestration: true }],
    ["repos", { repos: ["org/repo", "org/other"] }],
    [
      "repoConfig skipAutoMerge",
      {
        repoConfig: {
          "org/repo": { issueExecutorSplit: false, skipAutoMerge: true },
        },
      },
    ],
    [
      "repoConfig issueExecutorSplit",
      {
        repoConfig: {
          "org/repo": { issueExecutorSplit: true, skipAutoMerge: false },
        },
      },
    ],
  ];
  for (const [name, overrides] of included) {
    assert(
      await fingerprintWorkerReviewPolicy(workerConfig(overrides)) !== base,
      `${name} must change the fingerprint`,
    );
  }
  const unrelated: Array<[string, Record<string, unknown>]> = [
    ["a top-level credential", { githubToken: "secret" }],
    [
      "an unrelated repository setting",
      {
        repoConfig: {
          "org/repo": {
            issueExecutorSplit: false,
            skipAutoMerge: false,
            qualityCommand: "deno task quality",
          },
        },
      },
    ],
  ];
  for (const [name, overrides] of unrelated) {
    assertEquals(
      await fingerprintWorkerReviewPolicy(workerConfig(overrides)),
      base,
      `${name} must not change the fingerprint`,
    );
  }
});

Deno.test("deployment fingerprints cover resolved repository policy for every component", async () => {
  const config = {
    repos: ["org/repo"],
    issueExecutorSplit: true,
    issueSubAgentTier: "sonnet",
    issueReviewerAgents: true,
    externalOrchestration: false,
    repoConfig: { "org/repo": { issueExecutorSplit: false } },
  } as unknown as import("../types.ts").WorkerConfig;
  const first = await fingerprintWorkerReviewPolicy(config);
  config.repoConfig!["org/repo"]!.issueExecutorSplit = true;
  const second = await fingerprintWorkerReviewPolicy(config);
  assert(first !== second);
  assertEquals(first.length, 64);
  assertEquals(second.length, 64);
});

Deno.test("a verified human repair at an earlier head still counts; the head SHA does not unlink it", () => {
  // The repair and the first implementation were recorded at the old head; the
  // merge is at the final head. The human repair must still mark the merge.
  const report = buildPrCompletionReport(input({
    prs: [pr(60, { headSha: "sha-final" })],
    actions: [
      {
        ...action(60, "impl-old", "implementation", "fleet"),
        headSha: "sha-old",
      },
      { ...action(60, "repair-human", "repair", "human"), headSha: "sha-old" },
      { ...action(60, "merge-final", "merge", "fleet"), headSha: "sha-final" },
    ] as PrCompletionInput["actions"],
  }));
  assertEquals(report.completion.humanAssistedMerged, 1);
  assertEquals(report.completion.unattendedMerged, 0);
  assertEquals(report.completion.unknownMerged, 0);
  assertEquals(report.coverage.unlinkedActions, 0);
});

Deno.test("an action for a PR outside the cohort is counted as unlinked", () => {
  const report = buildPrCompletionReport(input({
    prs: [pr(61)],
    actions: [
      action(62, "orphan", "merge", "fleet"),
    ] as PrCompletionInput["actions"],
  }));
  assertEquals(report.coverage.unlinkedActions, 1);
});

Deno.test("target evaluation is unavailable with no eligible PRs and not met below ninety percent", () => {
  const policyFingerprint = "a".repeat(64);
  const deployments = ["worker", "reviewer", "babysitter"].map((component) => ({
    hostId: "host-a",
    component,
    revision: "abcdef0123456789",
    policyFingerprint,
    observedAt: "2026-11-04T00:00:00Z",
  }));
  const expectedDeployment = {
    ...input().expectedDeployment,
    inventory: ["worker", "reviewer", "babysitter"].map((component) => ({
      hostId: "host-a",
      component,
    })),
    inventoryComplete: true,
  };
  const rollout = {
    verifiedAt: "2026-10-20T00:00:00Z",
    discoveryEvidenceComplete: true,
    strandedPrs: [],
  };
  const window = {
    start: "2026-10-20T00:00:00.000Z",
    end: "2026-11-03T00:00:00.000Z",
    observedAt: "2026-11-04T00:00:00.000Z",
  };
  // No PR was created inside the fourteen-day window.
  const unavailable = buildPrCompletionReport(input({
    cohort: window,
    deployments,
    expectedDeployment,
    rollout,
  }));
  assertEquals(unavailable.targetEvaluation.status, "unavailable");
  assertEquals(unavailable.targetEvaluation.eligiblePrs, 0);
  assertEquals(unavailable.targetEvaluation.unattendedWithin24Hours, null);

  // One eligible PR that is still open, so it is not unattended and not met.
  const notMet = buildPrCompletionReport(input({
    cohort: window,
    prs: [pr(63, {
      state: "open",
      mergedAt: null,
      createdAt: "2026-10-21T00:00:00.000Z",
    })],
    deployments,
    expectedDeployment,
    rollout,
  }));
  assertEquals(notMet.targetEvaluation.status, "not_met");
  assertEquals(notMet.targetEvaluation.eligiblePrs, 1);
  assertEquals(notMet.targetEvaluation.unattendedWithin24Hours, 0);
});

Deno.test("invalid inputs are refused with the specific message, each otherwise valid", () => {
  // Each case changes exactly one thing from a valid one-PR, one-action input.
  const valid = () =>
    input({
      prs: [pr(50)],
      actions: [
        action(50, "a1", "merge", "fleet"),
      ] as PrCompletionInput["actions"],
    });
  const cases: Array<[string, () => PrCompletionInput, string]> = [
    [
      "bad repo",
      () => input({ prs: [pr(50, { repo: "bad" })] }),
      "PR repo must be owner/name",
    ],
    [
      "zero number",
      () => input({ prs: [pr(0)] }),
      "PR org/repo number must be positive",
    ],
    [
      "unsupported PR state",
      () =>
        input({
          prs: [
            pr(
              50,
              { state: "draft" } as unknown as Partial<PrCompletionRecord>,
            ),
          ],
        }),
      "PR org/repo#50 has an unsupported state",
    ],
    [
      "merged without mergedAt",
      () => input({ prs: [pr(50, { mergedAt: null })] }),
      "merged PR org/repo#50 is missing mergedAt",
    ],
    [
      "merged before created",
      () => input({ prs: [pr(50, { mergedAt: "2026-10-19T23:00:00.000Z" })] }),
      "merged PR org/repo#50 merged before creation",
    ],
    [
      "unsupported action kind",
      () =>
        input({
          prs: [pr(50)],
          actions: [{
            ...action(50, "a1", "merge", "fleet"),
            kind: "deploy",
          }] as unknown as PrCompletionInput["actions"],
        }),
      "PR action a1 has an unsupported kind",
    ],
    [
      "unsupported actor",
      () =>
        input({
          prs: [pr(50)],
          actions: [{
            ...action(50, "a1", "merge", "fleet"),
            actor: "bot",
          }] as unknown as PrCompletionInput["actions"],
        }),
      "PR action a1 has an unsupported actor",
    ],
    [
      "unsupported outcome",
      () =>
        input({
          prs: [pr(50)],
          actions: [{
            ...action(50, "a1", "merge", "fleet"),
            outcome: "maybe",
          }] as unknown as PrCompletionInput["actions"],
        }),
      "PR action a1 has an unsupported outcome",
    ],
    [
      "action without an id",
      () =>
        input({
          prs: [pr(50)],
          actions: [{
            ...action(50, "", "merge", "fleet"),
          }] as PrCompletionInput["actions"],
        }),
      "PR action requires actionId, runId, repo and component",
    ],
    [
      "non-boolean verified",
      () =>
        input({
          prs: [pr(50)],
          actions: [{
            ...action(50, "a1", "merge", "fleet"),
            verified: "yes",
          }] as unknown as PrCompletionInput["actions"],
        }),
      "PR action a1.verified must be a boolean",
    ],
    [
      "invalid CI duration",
      () =>
        input({
          prs: [pr(50)],
          ciRuns: [{
            repo: "org/repo",
            prNumber: 50,
            runId: "ci-1",
            durationMinutes: -1,
          }],
        }),
      "CI run ci-1 has an invalid duration",
    ],
    [
      "blocker ended before it started",
      () =>
        input({
          prs: [pr(50)],
          blockers: [{
            repo: "org/repo",
            prNumber: 50,
            blocker: "required-ci",
            startedAt: "2026-10-20T05:00:00Z",
            endedAt: "2026-10-20T04:00:00Z",
          }],
        }),
      "blocker ended before it started",
    ],
    [
      "bad policy fingerprint",
      () => {
        const base = valid();
        return {
          ...base,
          expectedDeployment: {
            ...base.expectedDeployment,
            policyFingerprint: "xyz",
          },
        };
      },
      "expectedDeployment.policyFingerprint must be a SHA-256 fingerprint",
    ],
    [
      "bad deployment component",
      () =>
        input({
          deployments: [{
            component: "Worker!",
            observedAt: "2026-10-20T00:00:00Z",
          }],
        }),
      "deployment.component must be a component identifier",
    ],
    [
      "non-positive heartbeat age",
      () => {
        const base = valid();
        return {
          ...base,
          expectedDeployment: {
            ...base.expectedDeployment,
            maxHeartbeatAgeHours: 0,
          },
        };
      },
      "expectedDeployment.maxHeartbeatAgeHours must be positive",
    ],
  ];
  for (const [name, build, message] of cases) {
    assertThrows(
      () => buildPrCompletionReport(build()),
      Error,
      message,
      `refusal case: ${name}`,
    );
  }
  // The unmodified input builds, so each refusal comes from its one change.
  assertEquals(buildPrCompletionReport(valid()).cohort.prCount, 1);
});

Deno.test("of two observations of one PR the later one wins, in either input order", () => {
  const earlierOpen = pr(70, {
    state: "open",
    mergedAt: null,
    observedAt: "2026-10-21T00:00:00.000Z",
  });
  const laterMerged = pr(70, { observedAt: "2026-10-22T00:00:00.000Z" });
  for (const prs of [[earlierOpen, laterMerged], [laterMerged, earlierOpen]]) {
    const report = buildPrCompletionReport(input({ prs }));
    assertEquals(report.cohort.mergedPrs, 1);
    assertEquals(report.cohort.openPrs, 0);
    assertEquals(report.cohort.prCount, 1);
    assertEquals(report.cohort.duplicateObservations, 1);
  }
  // The reverse: merged first, then a later observation that is closed.
  const earlierMerged = pr(71, { observedAt: "2026-10-21T00:00:00.000Z" });
  const laterClosed = pr(71, {
    state: "closed",
    mergedAt: null,
    observedAt: "2026-10-22T00:00:00.000Z",
  });
  for (
    const prs of [[earlierMerged, laterClosed], [laterClosed, earlierMerged]]
  ) {
    const report = buildPrCompletionReport(input({ prs }));
    assertEquals(report.cohort.mergedPrs, 0);
    assertEquals(report.cohort.closedUnmergedPrs, 1);
  }
});

Deno.test("excludedPrs counts the winning observation of each PR once", () => {
  const report = buildPrCompletionReport(input({
    prs: [
      pr(72, { eligible: false, observedAt: "2026-10-21T00:00:00.000Z" }),
      pr(72, { eligible: true, observedAt: "2026-10-22T00:00:00.000Z" }),
      pr(73, { eligible: true, observedAt: "2026-10-21T00:00:00.000Z" }),
      pr(73, { eligible: false, observedAt: "2026-10-22T00:00:00.000Z" }),
    ],
  }));
  assertEquals(report.coverage.excludedPrs, 1);
});

Deno.test("open PRs from before the cohort are published, defaulting to none, and must be a count", () => {
  assertEquals(
    buildPrCompletionReport(input()).coverage.openPrsBeforeCohort,
    0,
  );
  const report = buildPrCompletionReport(
    input({ openPrsBeforeCohort: 3, prs: [pr(74)] }),
  );
  assertEquals(report.coverage.openPrsBeforeCohort, 3);
  // The in-window figure is unchanged by the pre-cohort count.
  assertEquals(report.delivery.defaultBranchChanges, 1);
  for (const bad of [-1, 1.5, Number.NaN]) {
    assertThrows(
      () => buildPrCompletionReport(input({ openPrsBeforeCohort: bad })),
      Error,
      "openPrsBeforeCohort must be a non-negative integer",
    );
  }
});
