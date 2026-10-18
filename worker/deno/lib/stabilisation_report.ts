/** Bounded operational analysis over the existing lifecycle ledger, never routing. */
import { LIFECYCLE_ROLES } from "./lifecycle_ledger.ts";
import type {
  AssignmentEvent,
  GateEvent,
  LifecycleEvent,
  OutcomeEvent,
} from "./lifecycle_ledger.ts";
import {
  classifyLifecycleOutcome,
  lifecycleEventsAtCutoff,
} from "./lifecycle_outcomes.ts";
import {
  type LifecycleSpend,
  reconcileLifecycleEvents,
} from "./lifecycle_reconcile.ts";
export interface StabilisationEvidence {
  start: string;
  end: string;
  source: string;
  historyComplete: boolean;
  missing: string[];
  deliveries: Array<
    {
      repo: string;
      issueNumber: number;
      prNumber: number;
      accepted: boolean;
      baseBranch: string;
      defaultBranch: string;
      mergedAt: string;
    }
  >;
  rootCauses: Array<
    { eventKey: string; category: string; processGenerated: boolean }
  >;
  safeguards: Array<
    {
      id: string;
      source: "observed" | "synthetic";
      failuresPrevented: number | null;
      extraChecks: number | null;
      extraModelCalls: number | null;
      extraSeconds: number | null;
      residualRecurrence: number | null;
    }
  >;
}

type IssueState =
  | "delivered"
  | "milestone_only"
  | "pending"
  | "failed"
  | "missing_evidence";
interface IssueRow {
  repo: string;
  issueNumber: number;
  state: IssueState;
  deliverySeconds: number | null;
  spend: LifecycleSpend;
}
interface FirstPassCounts {
  passed: number;
  failed: number;
  unknown: number;
}
function knownTarget(
  row: StabilisationEvidence["deliveries"][number],
): boolean {
  return typeof row.baseBranch === "string" && row.baseBranch.length > 0 &&
    typeof row.defaultBranch === "string" && row.defaultBranch.length > 0;
}

function sumSpend(
  events: readonly LifecycleEvent[],
  complete: boolean,
): LifecycleSpend {
  return sumBuckets(
    reconcileLifecycleEvents(events).assignments.map((row) => row.totals),
    complete,
  );
}
function sumBuckets(
  values: readonly LifecycleSpend[],
  complete: boolean,
): LifecycleSpend {
  const partial = !complete || values.some((value) => value.partial);
  const known = values.reduce(
    (sum, value) => sum + (value.estimatedApiEquivalentUsd ?? 0),
    0,
  );
  const wasted = values.reduce(
    (sum, value) => sum + (value.wastedEstimatedApiEquivalentUsd ?? 0),
    0,
  );
  const wastedPartial = !complete ||
    values.some((value) => value.wastedPartial);
  return {
    estimatedApiEquivalentUsd: partial && known === 0 ? null : known,
    wastedEstimatedApiEquivalentUsd: wastedPartial && wasted === 0
      ? null
      : wasted,
    partial,
    wastedPartial,
    unknownUsageCount: values.reduce(
      (sum, value) => sum + value.unknownUsageCount,
      0,
    ),
    unknownPricingCount: values.reduce(
      (sum, value) => sum + value.unknownPricingCount,
      0,
    ),
  };
}
function identity(event: LifecycleEvent): string {
  return `${event.repo.toLowerCase()}#${
    event.issueNumber ?? `unknown:${event.assignmentId}`
  }`;
}
function firstPass(
  events: readonly LifecycleEvent[],
  gate: string,
): "passed" | "failed" | "unknown" {
  const first = events.filter((event): event is GateEvent =>
    // Ledger validation allows `gate` only on GateEvent; this field selects it.
    (event as Partial<GateEvent>).gate === gate &&
    (event as Partial<GateEvent>).result !== "skipped"
  )
    .sort((a, b) =>
      Date.parse(a.recordedAt) - Date.parse(b.recordedAt) ||
      Number(a.result === "pass") - Number(b.result === "pass")
    )[0];
  if (first?.result === "pass") return "passed";
  if (first?.result === "fail") return "failed";
  return "unknown";
}
function deployments(events: readonly LifecycleEvent[]) {
  const rows = events.filter((event): event is AssignmentEvent =>
    event.kind === "assignment"
  ).map((event) => ({
    host: event.host,
    workerVersion: event.treatment.workerVersion ?? null,
    workerCommit: event.treatment.workerCommit ?? null,
    roles: LIFECYCLE_ROLES.map((name) => {
      const role = event.treatment.roles.find((role) => role.role === name);
      return {
        role: name,
        provider: role?.provider ?? null,
        model: role?.model ?? null,
        effort: role?.effort ?? null,
      };
    }),
  }));
  return [...new Map(rows.map((row) => [JSON.stringify(row), row])).values()];
}

/**
 * Active-issue window: any observation in [start,end] includes that issue's
 * entire supplied history through end. Thus earlier retries stay in its cost;
 * later delivery cannot turn a pending issue into an in-window success.
 * Read-only delivery snapshots supply facts schema-1 ledgers never recorded
 * (acceptance and target branch). Missing facts remain missing, not inferred.
 */
export function buildStabilisationReport(
  input: readonly LifecycleEvent[],
  evidence: StabilisationEvidence,
) {
  const start = Date.parse(evidence.start), end = Date.parse(evidence.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error("Invalid stabilisation observation window");
  }
  const atCutoff = lifecycleEventsAtCutoff(input, evidence.end);
  // Follow-on producers intentionally carry the assignment but no issue number.
  const assignmentIssues = new Map(
    atCutoff.filter((event): event is AssignmentEvent =>
      event.kind === "assignment"
    ).map(
      (event) => [
        `${event.repo.toLowerCase()}:${event.assignmentId}`,
        event.issueNumber,
      ],
    ),
  );
  const bounded: LifecycleEvent[] = atCutoff.map((event) => ({
    ...event,
    issueNumber: event.issueNumber ??
      assignmentIssues.get(`${event.repo.toLowerCase()}:${event.assignmentId}`),
  }));
  // Kind-specific keys are enforced by validateLifecycleEvent. Reading the
  // optional outcome field therefore needs no redundant kind test.
  const merged = bounded.filter((event): event is OutcomeEvent =>
    (event as Partial<OutcomeEvent>).outcome === "merged"
  );
  const receipts = evidence.deliveries.filter((row) =>
    row.accepted === true &&
    merged.some((event) =>
      event.repo.toLowerCase() === row.repo.toLowerCase() &&
      event.prNumber === row.prNumber &&
      Date.parse(event.recordedAt) === Date.parse(row.mergedAt)
    )
  );
  const active = new Set(
    bounded.filter((event) => Date.parse(event.recordedAt) >= start).map(
      identity,
    ),
  );
  // Matching receipts retain old child work even when target evidence is missing.
  for (const row of receipts) {
    // The matched ledger receipt already passed the upper cutoff.
    if (Date.parse(row.mergedAt) >= start) {
      active.add(`${row.repo.toLowerCase()}#${row.issueNumber}`);
    }
  }
  const events = bounded.filter((event) => active.has(identity(event)));
  const groups = new Map<string, LifecycleEvent[]>();
  for (const event of events) {
    const key = identity(event);
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  const missing = new Set(evidence.missing);
  if (!evidence.historyComplete) {
    missing.add(
      "Ledger history/host coverage is incomplete; full cost and elapsed delivery remain unknown.",
    );
  }
  const firstPassCounts = {
    quality: { passed: 0, failed: 0, unknown: 0 } as FirstPassCounts,
    review: { passed: 0, failed: 0, unknown: 0 } as FirstPassCounts,
  };
  const issues: IssueRow[] = [];
  for (
    const [, group] of [...groups].sort(([a], [b]) =>
      a.localeCompare(b, undefined, { numeric: true })
    )
  ) {
    const first = group[0]!;
    if (first.issueNumber === undefined) {
      missing.add(
        "Calls without issue attribution remain in spend and are excluded from delivery counts.",
      );
      continue;
    }
    const merges = merged.filter((event) =>
      identity(event) === identity(first)
    );
    const issueReceipts = receipts.filter((row) =>
      row.repo.toLowerCase() === first.repo.toLowerCase() &&
      row.issueNumber === first.issueNumber
    );
    const snapshots = issueReceipts.filter(knownTarget);
    const defaultMerges = snapshots.filter((row) =>
      row.baseBranch === row.defaultBranch &&
      Date.parse(row.mergedAt) >= start &&
      classifyLifecycleOutcome(
        bounded.filter((event) =>
          event.repo.toLowerCase() === row.repo.toLowerCase() &&
          (event as Partial<GateEvent>).prNumber === row.prNumber
        ),
        evidence.end,
      ).success
    );
    const delivery = defaultMerges.sort((a, b) =>
      Date.parse(a.mergedAt) - Date.parse(b.mergedAt)
    )[0];
    const milestone = snapshots.some((row) =>
      row.baseBranch !== row.defaultBranch
    );
    const current = classifyLifecycleOutcome(group, evidence.end);
    const failedAt = Math.max(
      -Infinity,
      ...group.filter((event) =>
        ["failed", "timeout", "closed_unmerged"].includes(
          (event as Partial<OutcomeEvent>).outcome ?? "",
        )
      ).map((event) =>
        Date.parse(event.recordedAt)
      ),
    );
    const resumedAt = Math.max(
      -Infinity,
      ...group.filter((event) =>
        event.kind === "assignment" || event.kind === "invocation" ||
        (event as Partial<OutcomeEvent>).outcome === "pr_opened"
      ).map((event) => Date.parse(event.recordedAt)),
    );
    const failed = failedAt > -Infinity && failedAt >= resumedAt &&
      (current.state === "closed_unmerged" || current.prs.length === 0);
    const state: IssueState = delivery
      ? "delivered"
      : milestone
      ? "milestone_only"
      : merges.length || issueReceipts.length
      ? "missing_evidence"
      : failed
      ? "failed"
      : "pending";
    if (state === "missing_evidence") {
      missing.add(
        "A merged PR lacks accepted target/default-branch identity or pre-merge gate evidence.",
      );
    }
    const assigned = group.filter((event): event is AssignmentEvent =>
      event.kind === "assignment"
    ).map((event) => Date.parse(event.assignedAt));
    const began = Math.min(...assigned);
    const deliveredAt = Date.parse(delivery?.mergedAt ?? "");
    const deliverySeconds = evidence.historyComplete && deliveredAt >= began
      ? (deliveredAt - began) / 1000
      : null;
    issues.push({
      repo: first.repo,
      issueNumber: first.issueNumber,
      state,
      deliverySeconds,
      spend: sumSpend(group, evidence.historyComplete),
    });
    firstPassCounts.quality[firstPass(group, "quality")]++;
    firstPassCounts.review[firstPass(group, "review")]++;
  }
  const costs = events.filter((event) => event.kind === "invocation");
  const followOns: Record<string, number> = {};
  for (const event of events) {
    if (event.kind === "follow_on") {
      followOns[event.followOn] = (followOns[event.followOn] ?? 0) + 1;
    }
  }
  const eventKeys = new Set(events.map((event) => event.eventKey));
  const causes = new Map<
    string,
    { category: string; count: number; processGenerated: number }
  >();
  const seenCauses = new Set<string>();
  for (const cause of evidence.rootCauses) {
    if (
      !eventKeys.has(cause.eventKey) ||
      seenCauses.has(`${cause.eventKey}:${cause.category}`)
    ) {
      continue;
    }
    seenCauses.add(`${cause.eventKey}:${cause.category}`);
    const row = causes.get(cause.category) ??
      { category: cause.category, count: 0, processGenerated: 0 };
    row.count++;
    row.processGenerated += Number(cause.processGenerated);
    causes.set(cause.category, row);
  }
  if (
    costs.some((event) =>
      event.result !== "success" &&
      !evidence.rootCauses.some((cause) => cause.eventKey === event.eventKey)
    )
  ) {
    missing.add(
      "Some failed invocations have no observed root-cause category; no category is inferred from prose.",
    );
  }
  const builds = deployments(events);
  if (
    builds.length === 0 ||
    builds.some((row) =>
      !row.workerCommit || row.roles.some((role) => role.model === null)
    )
  ) {
    missing.add(
      "Deployed worker build or effective role configuration is missing for some observed work.",
    );
  }
  const spend = sumSpend(events, evidence.historyComplete);
  const deliveredIssues =
    issues.filter((row) => row.state === "delivered").length;
  const blockingReviewHeads = new Set(
    events.filter((event) =>
      (event as Partial<GateEvent>).gate === "review" &&
      (event as Partial<GateEvent>).result === "fail"
    ).map((event) =>
      `${event.repo}#${
        (event as Partial<GateEvent>).prNumber ?? "unknown"
      }:${event.runId}`
    ),
  ).size;
  const byRole = new Map<string, LifecycleSpend[]>();
  for (const row of reconcileLifecycleEvents(events).assignments) {
    for (const [role, value] of Object.entries(row.byRole)) {
      const values = byRole.get(role) ?? [];
      values.push(value);
      byRole.set(role, values);
    }
  }
  const spendByRole = Object.fromEntries(
    [...byRole].sort(([a], [b]) => a.localeCompare(b)).map((
      [role, values],
    ) => [role, sumBuckets(values, evidence.historyComplete)]),
  );
  const attempts = new Set(
    costs.map((event) =>
      `${event.repo}:${event.assignmentId}:${event.runId}:${event.attempt}`
    ),
  ).size;
  return {
    window: { start: evidence.start, end: evidence.end },
    source: evidence.source,
    coverage: {
      activeIssues: issues.length,
      events: events.length,
      historyComplete: evidence.historyComplete,
    },
    issues,
    deliveredIssues,
    spend,
    estimatedApiEquivalentUsdPerDeliveredIssue:
      deliveredIssues > 0 && !spend.partial
        ? spend.estimatedApiEquivalentUsd! / deliveredIssues
        : null,
    attempts,
    spendByRole,
    calls: costs.length,
    unattributedCalls:
      costs.filter((event) => event.issueNumber === undefined).length,
    failedInvocations:
      costs.filter((event) => event.result !== "success").length,
    followOns,
    firstPass: firstPassCounts,
    blockingReviewHeads,
    blockingReviewRounds: null,
    deployments: builds,
    rootCauses: [...causes.values()].sort((a, b) =>
      a.category.localeCompare(b.category)
    ),
    safeguards: evidence.safeguards.map((row) => ({
      ...row,
      failuresPrevented: row.failuresPrevented ?? null,
      extraChecks: row.extraChecks ?? null,
      extraModelCalls: row.extraModelCalls ?? null,
      extraSeconds: row.extraSeconds ?? null,
      residualRecurrence: row.residualRecurrence ?? null,
      observedBenefit: row.source === "synthetic"
        ? "not_live_evidence"
        : row.failuresPrevented === 0
        ? "none_observed"
        : (row.failuresPrevented ?? 0) > 0
        ? "observed_preventions"
        : "unknown",
      netBenefit: "unknown",
    })),
    failureRate: null,
    comparativeWinner: null,
    missing: [...missing].sort(),
    limitations: [
      "Estimated API-equivalent USD is not a subscription bill; partial spend is a lower bound.",
      "Cost per delivered issue includes all observed active-cohort attempts, pending/failed work and follow-ons once; invocation calls and follow-ons are separate observations.",
      "Polling review states identifies blocking heads, not independent review rounds; full rounds are unknown.",
      "Raw attempt counts have no total-attempt denominator. Unmatched windows and synthetic preventions establish neither causality nor a winner.",
      "Safeguard checks/calls/time and recurrence are supplied observations, not additional spend; prevented failures alone do not establish net benefit.",
    ],
  };
}
