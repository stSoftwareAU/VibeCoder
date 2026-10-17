/** Reconcile observed estimated API-equivalent spend without zeroing unknowns. */
import {
  type FollowOnEvent,
  type InvocationEvent,
  type LifecycleEvent,
  readLifecycleLedger,
} from "./lifecycle_ledger.ts";
import {
  type AssignmentLifecycleOutcome,
  classifyLifecycleOutcome,
  lifecycleEventsAtCutoff,
} from "./lifecycle_outcomes.ts";

export interface LifecycleSpend {
  estimatedApiEquivalentUsd: number | null;
  wastedEstimatedApiEquivalentUsd: number | null;
  partial: boolean;
  wastedPartial: boolean;
  unknownUsageCount: number;
  unknownPricingCount: number;
}
interface Breakdown {
  totals: LifecycleSpend;
  byRole: Record<string, LifecycleSpend>;
  byAttempt: Record<string, LifecycleSpend>;
  byFollowOn: Record<string, LifecycleSpend>;
}
export interface AssignmentReconciliation extends Breakdown {
  assignmentId: string;
  repo: string;
  cohort: string;
  outcome: AssignmentLifecycleOutcome;
}
export interface CohortReconciliation extends Breakdown {
  cohort: string;
  assignmentCount: number;
  successCount: number;
}
export interface LifecycleReconciliation {
  assignments: AssignmentReconciliation[];
  cohorts: CohortReconciliation[];
}
interface Portion {
  amount: number;
  unknownUsage: boolean;
  unknownPricing: boolean;
}
interface Bucket {
  amount: number;
  wastedAmount: number;
  unknownUsageCount: number;
  unknownPricingCount: number;
  wastedPartial: boolean;
}
function bucket(): Bucket {
  return {
    amount: 0,
    wastedAmount: 0,
    unknownUsageCount: 0,
    unknownPricingCount: 0,
    wastedPartial: false,
  };
}
function add(target: Bucket, portion: Portion, wasted: boolean): void {
  target.amount += portion.amount;
  target.unknownUsageCount += Number(portion.unknownUsage);
  target.unknownPricingCount += Number(portion.unknownPricing);
  if (wasted) {
    target.wastedAmount += portion.amount;
    target.wastedPartial ||= portion.unknownUsage || portion.unknownPricing;
  }
}
function spend(value: Bucket): LifecycleSpend {
  const partial = value.unknownUsageCount + value.unknownPricingCount > 0;
  return {
    estimatedApiEquivalentUsd: value.amount === 0 && partial
      ? null
      : value.amount,
    wastedEstimatedApiEquivalentUsd:
      value.wastedAmount === 0 && value.wastedPartial
        ? null
        : value.wastedAmount,
    partial,
    wastedPartial: value.wastedPartial,
    unknownUsageCount: value.unknownUsageCount,
    unknownPricingCount: value.unknownPricingCount,
  };
}
function accumulate(
  map: Map<string, Bucket>,
  key: string,
  portion: Portion,
  wasted: boolean,
): void {
  const value = map.get(key) ?? bucket();
  add(value, portion, wasted);
  map.set(key, value);
}
function serialise(map: Map<string, Bucket>): Record<string, LifecycleSpend> {
  return Object.fromEntries(
    [...map].sort(([a], [b]) => a.localeCompare(b)).map((
      [key, value],
    ) => [key, spend(value)]),
  );
}
function accumulator() {
  const total = bucket();
  const roles = new Map<string, Bucket>();
  const attempts = new Map<string, Bucket>();
  const followOns = new Map<string, Bucket>();
  return {
    add(
      event: InvocationEvent | FollowOnEvent,
      rolePortions: Map<string, Portion>,
      wasted: boolean,
      followOn?: string,
    ) {
      const portions = [...rolePortions.values()];
      const portion = {
        amount: portions.reduce((sum, part) => sum + part.amount, 0),
        unknownUsage: event.usage !== "known" ||
          portions.some((part) => part.unknownUsage),
        unknownPricing: event.pricing !== "known" ||
          portions.some((part) => part.unknownPricing),
      };
      add(total, portion, wasted);
      for (const [role, part] of rolePortions) {
        accumulate(roles, role, part, wasted);
      }
      const attemptKey = event.kind === "follow_on"
        ? `${event.prNumber ?? "unknown"}:${event.followOn}:${
          event.cycle ?? event.runId
        }:${event.attempt}`
        : `${event.runId}:${event.attempt}`;
      accumulate(attempts, attemptKey, portion, wasted);
      if (followOn !== undefined) {
        accumulate(followOns, followOn, portion, wasted);
      }
    },
    finish(): Breakdown {
      return {
        totals: spend(total),
        byRole: serialise(roles),
        byAttempt: serialise(attempts),
        byFollowOn: serialise(followOns),
      };
    },
  };
}
function portions(
  event: InvocationEvent | FollowOnEvent,
): Map<string, Portion> {
  const result = new Map<string, Portion>();
  if (
    event.kind === "invocation" && event.usage === "known" &&
    event.models?.length
  ) {
    for (const model of event.models) {
      const portion = result.get(model.role) ??
        { amount: 0, unknownUsage: false, unknownPricing: false };
      // The ledger schema forbids an estimate when model pricing is unknown.
      const known = model.estimatedApiEquivalentUsd !== undefined;
      portion.amount += known ? model.estimatedApiEquivalentUsd! : 0;
      portion.unknownPricing ||= !known;
      result.set(model.role, portion);
    }
  } else {
    const known = event.usage === "known" && event.pricing === "known" &&
      event.estimatedApiEquivalentUsd !== undefined;
    result.set(
      event.kind === "invocation" ? event.role : "follow-on (unattributed)",
      {
        amount: known ? event.estimatedApiEquivalentUsd! : 0,
        unknownUsage: event.usage !== "known",
        unknownPricing: event.pricing !== "known" ||
          (event.usage === "known" &&
            event.estimatedApiEquivalentUsd === undefined),
      },
    );
  }
  return result;
}

/**
 * Public analysis API: retain the original cohort, dedupe replayed event keys,
 * and count distinct invocation and follow-on records from their producers.
 * Legacy events without usage/pricing telemetry remain explicitly unknown.
 */
export function reconcileLifecycleEvents(
  input: readonly LifecycleEvent[],
  cutoff?: string,
): LifecycleReconciliation {
  const events = lifecycleEventsAtCutoff(input, cutoff);
  const groups = new Map<string, LifecycleEvent[]>();
  for (const event of events) {
    const key = `${event.repo}:${event.assignmentId}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  const cohorts = new Map<
    string,
    {
      sums: ReturnType<typeof accumulator>;
      assignmentCount: number;
      successCount: number;
    }
  >();
  const assignments: AssignmentReconciliation[] = [];
  for (const [, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const first = group[0]!;
    const assigned = group.filter((event) => event.kind === "assignment").sort((
      a,
      b,
    ) => Date.parse(a.assignedAt) - Date.parse(b.assignedAt));
    const cohort = assigned[0]?.cohort ?? "unknown";
    if (assigned.some((event) => event.cohort !== cohort)) {
      throw new Error(
        `Conflicting lifecycle cohorts for ${first.repo}:${first.assignmentId}`,
      );
    }
    const outcome = classifyLifecycleOutcome(group, cutoff);
    const cohortRow = cohorts.get(cohort) ??
      { sums: accumulator(), assignmentCount: 0, successCount: 0 };
    cohortRow.assignmentCount++;
    cohortRow.successCount += Number(outcome.success);
    cohorts.set(cohort, cohortRow);
    const sums = accumulator();
    const costs = group.filter((event) =>
      event.kind === "invocation" || event.kind === "follow_on"
    );
    const closed = new Set(
      outcome.prs.filter((pr) => pr.state === "closed_unmerged").map((pr) =>
        pr.prNumber
      ),
    );
    for (const event of costs) {
      const followOn = event.kind === "follow_on" ? event : undefined;
      const failed = event.kind === "invocation" && event.result !== "success";
      const wasted = failed || outcome.state === "closed_unmerged" ||
        (followOn?.prNumber !== undefined && closed.has(followOn.prNumber));
      const rolePortions = portions(event);
      sums.add(event, rolePortions, wasted, followOn?.followOn);
      cohortRow.sums.add(event, rolePortions, wasted, followOn?.followOn);
    }
    assignments.push({
      assignmentId: first.assignmentId,
      repo: first.repo,
      cohort,
      outcome,
      ...sums.finish(),
    });
  }
  return {
    assignments,
    cohorts: [...cohorts].sort(([a], [b]) => a.localeCompare(b)).map((
      [cohort, value],
    ) => ({
      cohort,
      assignmentCount: value.assignmentCount,
      successCount: value.successCount,
      ...value.sums.finish(),
    })),
  };
}

/** Read the caller's host-ledger paths; unreadable or corrupt input stays loud. */
export async function reconcileLifecycleFiles(
  paths: readonly string[],
  cutoff?: string,
): Promise<LifecycleReconciliation> {
  const events = await Promise.all(paths.map(readLifecycleLedger));
  return reconcileLifecycleEvents(events.flat(), cutoff);
}
