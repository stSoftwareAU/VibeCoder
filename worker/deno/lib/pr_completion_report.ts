/** Read-only accounting for unattended fleet PR completion (Issue #4658). */

import type { AuditEntry } from "./audit_entry.ts";

export type PrState = "open" | "merged" | "closed";
export type PrActionKind =
  | "implementation"
  | "repair"
  | "review"
  | "dismissal"
  | "merge"
  | "unknown";

export interface PrCompletionRecord {
  repo: string;
  number: number;
  createdAt: string;
  baseRef: string;
  defaultBranch: string;
  headRef: string;
  headSha: string;
  state: PrState;
  mergedAt: string | null;
  closedAt?: string | null;
  observedAt?: string;
  host?: string;
  milestone?: boolean;
  rollupRoot?: string;
  ownerGated?: boolean;
  ownerGateVerified?: boolean;
  eligible?: boolean;
  actionsComplete: boolean;
}

export interface TrustedPrAction {
  actionId: string;
  runId: string;
  component: string;
  repo: string;
  prNumber: number;
  headSha?: string;
  kind: PrActionKind;
  timestamp: string;
  outcome: "confirmed" | "failed" | "unknown";
  actor: "fleet" | "human" | "unknown";
  verified: boolean;
  actorLogin?: string;
}

export interface PrCompletionInput {
  cohort: { start: string; end: string; observedAt: string };
  prs: PrCompletionRecord[];
  actions: TrustedPrAction[];
  blockers: Array<{
    repo: string;
    prNumber: number;
    blocker: string;
    startedAt: string;
    endedAt: string | null;
  }>;
  ciRuns: Array<{
    repo: string;
    prNumber: number;
    runId: string;
    durationMinutes: number | null;
  }>;
  regressions: Array<{
    repo: string;
    prNumber: number;
    detectedAt: string;
    resolved: boolean;
  }>;
  deployments: Array<{
    component: string;
    revision?: string;
    policyFingerprint?: string;
    observedAt: string;
  }>;
  expectedDeployment: {
    components: string[];
    revision: string;
    policyFingerprint: string;
    maxHeartbeatAgeHours: number;
  };
  rollout?: {
    verifiedAt: string;
    strandedPrs: Array<{
      repo: string;
      prNumber: number;
      eligible: boolean;
      rediscovered: boolean;
      processed: boolean;
    }>;
  };
}

export interface PrCompletionReport {
  cohort: {
    start: string;
    end: string;
    observedAt: string;
    prCount: number;
    duplicateObservations: number;
    mergedPrs: number;
    openPrs: number;
    ageingOpenPrs: number;
    closedUnmergedPrs: number;
    ownerGatedPrs: number;
  };
  completion: {
    eligiblePrs: number;
    unattendedWithin24Hours: number | null;
    unattendedMerged: number;
    humanAssistedMerged: number;
    unknownMerged: number;
  };
  timings: {
    medianMergeHours: number | null;
    p90MergeHours: number | null;
  };
  delivery: {
    defaultBranchChanges: number;
    milestonePrs: number;
    intermediateRollupPrs: number;
    reviewRounds: number;
    fixRounds: number;
    ciRuns: number;
    ciMinutes: number | null;
    ciRunsPerDeliveredChange: number | null;
    ciMinutesPerDeliveredChange: number | null;
  };
  waiting: {
    observedAt: string;
    intervals: Record<string, { count: number; seconds: number }>;
    openIntervals: number;
  };
  regressions: {
    observed: number;
    unresolved: number;
    attributed: number;
    unattributed: number;
  };
  deployment: {
    status: "verified" | "degraded";
    observedAt: string;
    expectedComponents: string[];
    missingComponents: string[];
    staleComponents: string[];
    mismatchedComponents: string[];
    mixedRevisions: string[];
    mixedPolicies: string[];
  };
  rollout: {
    eligibleStrandedPrs: number;
    rediscoveredPrs: number;
    processedPrs: number;
    notRediscoveredPrs: number;
  };
  targetEvaluation: {
    status: "pending" | "met" | "not_met" | "unavailable";
    target: 0.9;
    windowStart: string | null;
    windowEnd: string | null;
    eligiblePrs: number;
    unattendedWithin24Hours: number | null;
  };
  coverage: {
    unknownPrHistory: number;
    unlinkedActions: number;
    unknownCiDurations: number;
    excludedPrs: number;
    incompleteObservationWindow: boolean;
  };
}

const keyOf = (repo: string, number: number) => `${repo}#${number}`;

/** Convert only PR-linked journal entries; the caller supplies chain integrity. */
export function prActionsFromAuditJournal(
  entries: readonly AuditEntry[],
  chainVerified: boolean,
): TrustedPrAction[] {
  return entries.flatMap((entry) => {
    if (
      !entry.actionId || !entry.repo || !entry.prNumber || !entry.actionKind
    ) return [];
    return [{
      actionId: entry.actionId,
      runId: entry.runId,
      component: entry.component ?? "unknown",
      repo: entry.repo,
      prNumber: entry.prNumber,
      kind: entry.actionKind,
      timestamp: entry.timestamp,
      outcome: entry.outcome === "success" ? "confirmed" : "failed",
      actor: chainVerified ? "fleet" : "unknown",
      verified: chainVerified,
    }];
  });
}

function timestamp(value: string, field: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || !/^\d{4}-\d\d-\d\dT.*Z$/.test(value)) {
    throw new Error(`${field} must be an ISO timestamp in UTC (Z)`);
  }
  return time;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2
    ? values[mid]!
    : (values[mid - 1]! + values[mid]!) / 2;
}

function percentile90(values: number[]): number | null {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  return values[Math.ceil(values.length * 0.9) - 1]!;
}

function deploymentReport(
  input: PrCompletionInput,
): PrCompletionReport["deployment"] {
  const { expectedDeployment: expected, cohort } = input;
  if (
    !Number.isFinite(expected.maxHeartbeatAgeHours) ||
    expected.maxHeartbeatAgeHours <= 0
  ) {
    throw new Error("expectedDeployment.maxHeartbeatAgeHours must be positive");
  }
  const observedAt = timestamp(cohort.observedAt, "cohort.observedAt");
  const byComponent = new Map<string, typeof input.deployments>();
  for (const deployment of input.deployments) {
    timestamp(deployment.observedAt, "deployment.observedAt");
    const rows = byComponent.get(deployment.component) ?? [];
    rows.push(deployment);
    byComponent.set(deployment.component, rows);
  }
  const missingComponents = expected.components.filter((component) =>
    !byComponent.has(component)
  ).sort();
  const staleComponents: string[] = [];
  const mismatchedComponents: string[] = [];
  const mixedRevisions: string[] = [];
  const mixedPolicies: string[] = [];
  for (const component of expected.components) {
    const rows = byComponent.get(component) ?? [];
    if (!rows.length) continue;
    const latest = rows.reduce((a, b) =>
      timestamp(a.observedAt, "deployment.observedAt") >
          timestamp(b.observedAt, "deployment.observedAt")
        ? a
        : b
    );
    if (
      observedAt - timestamp(latest.observedAt, "deployment.observedAt") >
        expected.maxHeartbeatAgeHours * 3_600_000
    ) staleComponents.push(component);
    if (
      latest.revision !== expected.revision ||
      latest.policyFingerprint !== expected.policyFingerprint
    ) mismatchedComponents.push(component);
    if (new Set(rows.map((row) => row.revision)).size > 1) {
      mixedRevisions.push(component);
    }
    if (new Set(rows.map((row) => row.policyFingerprint)).size > 1) {
      mixedPolicies.push(component);
    }
  }
  return {
    status: missingComponents.length || staleComponents.length ||
        mismatchedComponents.length || mixedRevisions.length ||
        mixedPolicies.length
      ? "degraded"
      : "verified",
    observedAt: cohort.observedAt,
    expectedComponents: [...expected.components].sort(),
    missingComponents,
    staleComponents: staleComponents.sort(),
    mismatchedComponents: mismatchedComponents.sort(),
    mixedRevisions: mixedRevisions.sort(),
    mixedPolicies: mixedPolicies.sort(),
  };
}

/** Build a dated report. Actor logins are deliberately never consulted. */
export function buildPrCompletionReport(
  input: PrCompletionInput,
): PrCompletionReport {
  const start = timestamp(input.cohort.start, "cohort.start");
  const end = timestamp(input.cohort.end, "cohort.end");
  const observedAt = timestamp(input.cohort.observedAt, "cohort.observedAt");
  if (start >= end || observedAt < start) {
    throw new Error(
      "cohort timestamps must satisfy start < end and observedAt >= start",
    );
  }

  const unique = new Map<string, PrCompletionRecord>();
  let duplicateObservations = 0;
  let excludedPrs = 0;
  for (const pr of input.prs) {
    const createdAt = timestamp(
      pr.createdAt,
      `PR ${pr.repo}#${pr.number}.createdAt`,
    );
    if (createdAt < start || createdAt >= end) continue;
    const key = keyOf(pr.repo, pr.number);
    const previous = unique.get(key);
    if (previous) {
      duplicateObservations++;
      const previousAt = timestamp(
        previous.observedAt ?? previous.createdAt,
        `PR ${key}.observedAt`,
      );
      const currentAt = timestamp(
        pr.observedAt ?? pr.createdAt,
        `PR ${key}.observedAt`,
      );
      if (currentAt > previousAt) unique.set(key, pr);
      continue;
    }
    unique.set(key, pr);
    if (pr.eligible === false) excludedPrs++;
  }
  const prs = [...unique.values()];
  const prMap = new Map(prs.map((pr) => [keyOf(pr.repo, pr.number), pr]));
  const actionIds = new Set<string>();
  let unlinkedActions = 0;
  const actionsByPr = new Map<string, TrustedPrAction[]>();
  for (const action of input.actions) {
    if (actionIds.has(action.actionId)) continue;
    actionIds.add(action.actionId);
    const key = keyOf(action.repo, action.prNumber);
    const pr = prMap.get(key);
    if (!pr || !action.headSha || action.headSha !== pr.headSha) {
      unlinkedActions++;
      continue;
    }
    const rows = actionsByPr.get(key) ?? [];
    rows.push(action);
    actionsByPr.set(key, rows);
  }

  const mergeHours: number[] = [];
  let mergedPrs = 0,
    openPrs = 0,
    ageingOpenPrs = 0,
    closedUnmergedPrs = 0,
    ownerGatedPrs = 0;
  let unattendedMerged = 0,
    humanAssistedMerged = 0,
    unknownMerged = 0,
    eligiblePrs = 0,
    within24 = 0;
  let milestonePrs = 0,
    defaultBranchChanges = 0,
    intermediateRollupPrs = 0,
    reviewRounds = 0,
    fixRounds = 0;
  const deliveredKeys = new Set<string>();
  const pRsByKey = new Map(prs.map((pr) => [keyOf(pr.repo, pr.number), pr]));
  for (const pr of prs) {
    const key = keyOf(pr.repo, pr.number);
    const age = (observedAt - timestamp(pr.createdAt, "PR createdAt")) /
      3_600_000;
    if (pr.state === "merged") {
      mergedPrs++;
      if (!pr.mergedAt) throw new Error(`merged PR ${key} is missing mergedAt`);
      const hours = (timestamp(pr.mergedAt, `PR ${key}.mergedAt`) -
        timestamp(pr.createdAt, `PR ${key}.createdAt`)) / 3_600_000;
      if (hours < 0) throw new Error(`merged PR ${key} merged before creation`);
      mergeHours.push(hours);
    } else if (pr.state === "open") {
      openPrs++;
      if (age >= 24) ageingOpenPrs++;
    } else closedUnmergedPrs++;
    const ownerGated = pr.ownerGated === true && pr.ownerGateVerified === true;
    if (ownerGated) ownerGatedPrs++;
    if (pr.eligible !== false && !ownerGated) eligiblePrs++;

    const actions = actionsByPr.get(key) ?? [];
    for (const action of actions) {
      if (action.kind === "review") reviewRounds++;
      if (action.kind === "repair") fixRounds++;
    }
    if (pr.state === "merged") {
      const verifiedHuman = actions.some((action) =>
        action.verified && action.outcome === "confirmed" &&
        action.actor === "human"
      );
      const historyVerified = pr.actionsComplete &&
        actions.every((action) =>
          action.verified && action.outcome === "confirmed" &&
          action.actor !== "unknown"
        );
      const hasVerifiedMerge = actions.some((action) =>
        action.kind === "merge"
      );
      const hasVerifiedImplementation = actions.some((action) =>
        action.kind === "implementation" || action.kind === "repair"
      );
      const verifiedUnattended = historyVerified && hasVerifiedImplementation &&
        hasVerifiedMerge && !verifiedHuman && actions.every((action) =>
          action.actor === "fleet"
        );
      if (verifiedHuman) humanAssistedMerged++;
      else if (!historyVerified) unknownMerged++;
      else if (verifiedUnattended) {
        unattendedMerged++;
        if (
          pr.eligible !== false && !ownerGated &&
          mergeHours[mergeHours.length - 1]! <= 24
        ) within24++;
      } else unknownMerged++;
    }

    if (pr.milestone === true || pr.baseRef.startsWith("milestone/")) {
      milestonePrs++;
    }
    if (
      pr.state === "merged" && pr.rollupRoot && pr.rollupRoot !== key &&
      pRsByKey.has(pr.rollupRoot)
    ) intermediateRollupPrs++;
    if (
      pr.state === "merged" && pr.baseRef === pr.defaultBranch &&
      pr.milestone !== true
    ) {
      if (
        pr.rollupRoot && pr.rollupRoot !== key && pRsByKey.has(pr.rollupRoot)
      ) {
        // Intermediate syncs are activity, not another delivered change.
      } else {
        const root = pr.rollupRoot ?? key;
        const rootPr = pRsByKey.get(root);
        if (
          !rootPr ||
          rootPr.state === "merged" && rootPr.baseRef === rootPr.defaultBranch
        ) deliveredKeys.add(root);
      }
    }
  }
  for (const pr of prs) {
    if (
      pr.state === "merged" && pr.baseRef === pr.defaultBranch &&
      pr.milestone !== true && pr.rollupRoot &&
      pr.rollupRoot !== keyOf(pr.repo, pr.number)
    ) {
      const root = pRsByKey.get(pr.rollupRoot);
      if (root?.state === "merged" && root.baseRef === root.defaultBranch) {
        deliveredKeys.add(pr.rollupRoot);
      }
    }
  }
  defaultBranchChanges = deliveredKeys.size;

  const ciRows = input.ciRuns.filter((run) =>
    deliveredKeys.has(keyOf(run.repo, run.prNumber))
  );
  const knownCi = ciRows.flatMap((run) =>
    run.durationMinutes !== null && Number.isFinite(run.durationMinutes) &&
      run.durationMinutes >= 0
      ? [run.durationMinutes]
      : []
  );
  const waiting: PrCompletionReport["waiting"] = {
    observedAt: input.cohort.observedAt,
    intervals: {},
    openIntervals: 0,
  };
  for (const blocker of input.blockers) {
    const began = timestamp(blocker.startedAt, "blocker.startedAt");
    const ended = blocker.endedAt === null
      ? observedAt
      : timestamp(blocker.endedAt, "blocker.endedAt");
    if (ended < began) throw new Error("blocker ended before it started");
    if (blocker.endedAt === null) waiting.openIntervals++;
    const aggregate = waiting.intervals[blocker.blocker] ??
      { count: 0, seconds: 0 };
    aggregate.count++;
    aggregate.seconds += (ended - began) / 1000;
    waiting.intervals[blocker.blocker] = aggregate;
  }
  const regressionRows = input.regressions.filter((regression) =>
    timestamp(regression.detectedAt, "regression.detectedAt") >= start &&
    timestamp(regression.detectedAt, "regression.detectedAt") < observedAt
  );
  const attributed =
    regressionRows.filter((row) => prMap.has(keyOf(row.repo, row.prNumber)))
      .length;
  const deployment = deploymentReport(input);
  const incompleteObservationWindow = observedAt < end;
  const stranded = input.rollout?.strandedPrs ?? [];
  const rollout = {
    eligibleStrandedPrs: stranded.filter((pr) => pr.eligible).length,
    rediscoveredPrs:
      stranded.filter((pr) => pr.eligible && pr.rediscovered).length,
    processedPrs: stranded.filter((pr) => pr.eligible && pr.processed).length,
    notRediscoveredPrs:
      stranded.filter((pr) => pr.eligible && !pr.rediscovered).length,
  };
  let targetEvaluation: PrCompletionReport["targetEvaluation"] = {
    status: "pending",
    target: 0.9,
    windowStart: null,
    windowEnd: null,
    eligiblePrs: 0,
    unattendedWithin24Hours: null,
  };
  if (input.rollout) {
    const rolloutStart = timestamp(
      input.rollout.verifiedAt,
      "rollout.verifiedAt",
    );
    const rolloutEnd = rolloutStart + 14 * 86_400_000;
    const startText = new Date(rolloutStart).toISOString();
    const endText = new Date(rolloutEnd).toISOString();
    const evaluationPrs = prs.filter((pr) => {
      const createdAt = timestamp(pr.createdAt, "PR createdAt");
      return createdAt >= rolloutStart && createdAt < rolloutEnd &&
        pr.eligible !== false &&
        !(pr.ownerGated === true && pr.ownerGateVerified === true);
    });
    const successful = evaluationPrs.filter((pr) => {
      if (pr.state !== "merged" || !pr.mergedAt || !pr.actionsComplete) {
        return false;
      }
      const actions = actionsByPr.get(keyOf(pr.repo, pr.number)) ?? [];
      const human = actions.some((action) =>
        action.verified && action.outcome === "confirmed" &&
        action.actor === "human"
      );
      const implementation = actions.some((action) =>
        action.kind === "implementation" || action.kind === "repair"
      );
      const merge = actions.some((action) => action.kind === "merge");
      const verified = actions.length > 0 &&
        actions.every((action) =>
          action.verified && action.outcome === "confirmed" &&
          action.actor === "fleet"
        );
      return !human && verified && implementation && merge &&
        timestamp(pr.mergedAt, "PR mergedAt") -
              timestamp(pr.createdAt, "PR createdAt") <= 86_400_000;
    }).length;
    const ready = deployment.status === "verified" && observedAt >= rolloutEnd;
    targetEvaluation = {
      status: !ready
        ? "pending"
        : evaluationPrs.length === 0
        ? "unavailable"
        : successful / evaluationPrs.length >= 0.9
        ? "met"
        : "not_met",
      target: 0.9,
      windowStart: startText,
      windowEnd: endText,
      eligiblePrs: evaluationPrs.length,
      unattendedWithin24Hours: evaluationPrs.length
        ? successful / evaluationPrs.length
        : null,
    };
  }
  return {
    cohort: {
      ...input.cohort,
      prCount: prs.length,
      duplicateObservations,
      mergedPrs,
      openPrs,
      ageingOpenPrs,
      closedUnmergedPrs,
      ownerGatedPrs,
    },
    completion: {
      eligiblePrs,
      unattendedWithin24Hours: eligiblePrs ? within24 / eligiblePrs : null,
      unattendedMerged,
      humanAssistedMerged,
      unknownMerged,
    },
    timings: {
      medianMergeHours: median([...mergeHours]),
      p90MergeHours: percentile90([...mergeHours]),
    },
    delivery: {
      defaultBranchChanges,
      milestonePrs,
      intermediateRollupPrs,
      reviewRounds,
      fixRounds,
      ciRuns: ciRows.length,
      ciMinutes: knownCi.length === ciRows.length
        ? knownCi.reduce((sum, value) => sum + value, 0)
        : null,
      ciRunsPerDeliveredChange: defaultBranchChanges
        ? ciRows.length / defaultBranchChanges
        : null,
      ciMinutesPerDeliveredChange:
        defaultBranchChanges && knownCi.length === ciRows.length
          ? knownCi.reduce((sum, value) => sum + value, 0) /
            defaultBranchChanges
          : null,
    },
    waiting,
    regressions: {
      observed: regressionRows.length,
      unresolved: regressionRows.filter((row) => !row.resolved).length,
      attributed,
      unattributed: regressionRows.length - attributed,
    },
    deployment,
    rollout,
    targetEvaluation,
    coverage: {
      unknownPrHistory: prs.filter((pr) =>
        !pr.actionsComplete ||
        !(actionsByPr.get(keyOf(pr.repo, pr.number)) ?? []).length
      ).length,
      unlinkedActions,
      unknownCiDurations: ciRows.length - knownCi.length,
      excludedPrs,
      incompleteObservationWindow,
    },
  };
}

/** Format the report as stable, machine-readable JSON. */
export function formatPrCompletionReport(report: PrCompletionReport): string {
  return JSON.stringify(report, null, 2);
}

/** Fingerprint allowlisted resolved review policy settings, never raw config. */
const REVIEW_POLICY_KEYS = new Set([
  "issue_executor_split",
  "issue_sub_agent_tier",
  "issue_reviewer_agents",
  "pr_reviewer_parallel",
  "pr_reviewer_auto_release",
  "skip_auto_merge",
  "resolved_role_policy",
  "external_orchestration",
]);

export async function fingerprintReviewPolicy(
  settings: Record<string, string | number | boolean>,
): Promise<string> {
  const allowed = Object.entries(settings)
    .filter(([key]) => REVIEW_POLICY_KEYS.has(key))
    .sort(([a], [b]) => a.localeCompare(b));
  const bytes = new TextEncoder().encode(JSON.stringify(allowed));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
