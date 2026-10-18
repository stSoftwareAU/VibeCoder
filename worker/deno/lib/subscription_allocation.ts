/** Conservative subscription allocation using mature issue cohorts (Issue #3646). */
import {
  type ArmRole,
  assignExperimentArm,
  type ExperimentArm,
  isExcludedModel,
  validateExperimentArms,
} from "./fleet_experiment_arms.ts";
import { agentProviderById } from "./agent_provider.ts";
import { lookupModelPricing } from "./token_usage.ts";
import type {
  AssignmentRecord,
  ExperimentReport,
  Interval,
} from "./fleet_experiment_report.ts";

export interface AllocationArm extends ExperimentArm {
  reviewer: ArmRole;
}
export interface AllocationPolicy {
  seed: string;
  autoRouting: boolean;
  ledgerPaths: string[];
  arms: AllocationArm[];
  providers: Record<
    string,
    { estimatedBudgetUsd: number; maxParallelism: number }
  >;
  hosts: Record<
    string,
    { providers: string[]; capacity: number; weight: number }
  >;
  controlFloor: number;
  explorationFloor: number;
  maxShift: number;
  minMatureMerged: number;
  minClusters: number;
  minDecisionSeconds: number;
  maxReviewRate: number;
  maxFailureRate: number;
  maxPendingFraction: number;
  maxLatencyHours: number;
  minRelativeGain: number;
  maxIssueCostUsd: number;
  maxClusterIssues: number;
  errorBudget: number;
  windowDays: number;
  horizonDays: number;
  capacityPath?: string;
}
export interface AllocationState {
  version: 1;
  policyKey: string;
  weights: Record<string, number>;
  baselineWeights: Record<string, number>;
  paused: boolean;
  dryRunAt: string | null;
  decisionCount: number;
  lastDecisionAt: number;
  evidenceKey: string;
}
export interface AllocationPlan {
  action: "hold" | "shift" | "rollback" | "paused";
  reason: string;
  weights: Record<string, number>;
  effectiveSamples: Record<string, number>;
  matureMerged: Record<string, number>;
  metrics: Record<
    string,
    {
      mergedPerHostDay: number;
      idleFraction: number;
      quotaSaturation: number;
      meanHoursToMerge: number;
    }
  >;
  intervals: Record<string, Interval>;
  nextState: AllocationState;
}
export interface AllocationProviderStatus {
  subscription: boolean;
  available: boolean;
  inFlight: number;
  spentUsd: number;
  costKnown: boolean;
  hostSpentUsd?: number;
}
export interface AllocationCapacityEvidence {
  observedAt: string;
  correlatedOutage: boolean;
  arms: Record<
    string,
    {
      hostDays: number;
      availableSlotSeconds: number;
      idleSlotSeconds: number;
      quotaBlockedSlotSeconds: number;
    }
  >;
}
function policyKey(policy: AllocationPolicy): string {
  return JSON.stringify({ ...policy, autoRouting: false });
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`subscription_allocation.${name} must be an object`);
  }
  return value as Record<string, unknown>;
}
function positive(value: unknown, name: string, fallback?: number): number {
  const number = value ?? fallback;
  if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) {
    throw new Error(`subscription_allocation.${name} must be positive`);
  }
  return number;
}
function count(value: unknown, name: string, fallback?: number): number {
  const number = positive(value, name, fallback);
  if (!Number.isInteger(number)) {
    throw new Error(`subscription_allocation.${name} must be an integer`);
  }
  return number;
}
function fraction(value: unknown, name: string, fallback: number): number {
  const number = positive(value, name, fallback);
  if (number >= 1) {
    throw new Error(`subscription_allocation.${name} must be below one`);
  }
  return number;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`subscription_allocation.${name} must be non-empty text`);
  }
  return value;
}
function keys(
  input: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new Error(
        `subscription_allocation: unknown key ${JSON.stringify(key)}`,
      );
    }
  }
}

/** Financial/billing fields are deliberately outside the accepted schema. */
export function parseAllocationPolicy(
  raw: unknown,
): AllocationPolicy | undefined {
  if (raw === undefined) return undefined;
  const input = object(raw, "policy");
  keys(input, [
    "seed",
    "auto_routing",
    "ledger_paths",
    "arms",
    "providers",
    "hosts",
    "control_floor",
    "exploration_floor",
    "max_shift",
    "min_mature_merged",
    "min_clusters",
    "min_decision_seconds",
    "max_review_rate",
    "max_failure_rate",
    "max_pending_fraction",
    "max_latency_hours",
    "min_relative_gain",
    "max_issue_cost_usd",
    "max_cluster_issues",
    "error_budget",
    "window_days",
    "horizon_days",
    "capacity_path",
  ]);
  if (
    input.auto_routing !== undefined && typeof input.auto_routing !== "boolean"
  ) throw new Error("subscription_allocation.auto_routing must be boolean");
  if (!Array.isArray(input.arms)) {
    throw new Error("subscription_allocation.arms must be an array");
  }
  const arms = input.arms.map((value): AllocationArm => {
    const arm = object(value, "arm");
    keys(arm, [
      "id",
      "label",
      "manager",
      "executor",
      "control",
      "weight",
      "status",
      "reviewer",
    ]);
    const role = (value: unknown) => {
      const selected = object(value, "role");
      keys(selected, ["provider", "model"]);
      return {
        provider: text(selected.provider, "provider"),
        model: text(selected.model, "model"),
      };
    };
    if (
      typeof arm.control !== "boolean" ||
      !["active", "awaiting-feasibility"].includes(String(arm.status))
    ) throw new Error("subscription_allocation arm control/status is invalid");
    return {
      id: text(arm.id, "id"),
      label: text(arm.label, "label"),
      control: arm.control,
      manager: role(arm.manager),
      executor: role(arm.executor),
      reviewer: arm.reviewer === undefined
        ? { provider: "claude", model: "opus" }
        : role(arm.reviewer),
      weight: positive(arm.weight, "weight", 1),
      status: arm.status as ExperimentArm["status"],
    };
  });
  validateExperimentArms(arms);
  const control = arms.find((arm) => arm.control)!;
  if (
    control.manager.provider !== "claude" ||
    control.manager.model !== "sonnet" ||
    control.executor.provider !== "claude" || control.executor.model !== "haiku"
  ) {
    throw new Error(
      "subscription_allocation control must preserve Sonnet manager / Haiku executor",
    );
  }
  const providers = Object.fromEntries(
    Object.entries(object(input.providers, "providers")).map(([id, value]) => {
      if (!agentProviderById(id)) {
        throw new Error(
          "subscription_allocation provider must name a registered adapter",
        );
      }
      const entry = object(value, "provider");
      keys(entry, ["estimated_budget_usd", "max_parallelism"]);
      return [id, {
        estimatedBudgetUsd: positive(
          entry.estimated_budget_usd,
          "estimated_budget_usd",
        ),
        maxParallelism: count(entry.max_parallelism, "max_parallelism"),
      }];
    }),
  );
  const hosts = Object.fromEntries(
    Object.entries(object(input.hosts, "hosts")).map(([id, value]) => {
      const host = object(value, "host");
      keys(host, ["providers", "capacity", "weight"]);
      if (
        !Array.isArray(host.providers) || host.providers.length === 0 ||
        host.providers.some((id) =>
          typeof id !== "string" || !Object.hasOwn(providers, id)
        )
      ) {
        throw new Error(
          "subscription_allocation host providers must name configured budgets",
        );
      }
      return [id, {
        providers: [...new Set(host.providers)] as string[],
        capacity: count(host.capacity, "capacity"),
        weight: positive(host.weight, "weight", 1),
      }];
    }),
  );
  if (Object.keys(hosts).length === 0) {
    throw new Error("subscription_allocation needs a host assignment");
  }
  for (const [id, provider] of Object.entries(providers)) {
    const reserved = Object.values(hosts).filter((host) =>
      host.providers.includes(id)
    ).reduce((sum, host) => sum + host.capacity, 0);
    if (reserved > provider.maxParallelism) {
      throw new Error(
        `subscription_allocation host capacities exceed ${id} max_parallelism`,
      );
    }
  }
  for (const arm of arms) {
    for (const role of [arm.manager, arm.executor, arm.reviewer]) {
      if (
        !Object.hasOwn(providers, role.provider) ||
        !agentProviderById(role.provider) || isExcludedModel(role.model)
      ) {
        throw new Error(
          "subscription_allocation role has no provider budget or uses an excluded model",
        );
      }
    }
  }
  if (!Array.isArray(input.ledger_paths) || input.ledger_paths.length === 0) {
    throw new Error(
      "subscription_allocation.ledger_paths must name collected evidence",
    );
  }
  const policy: AllocationPolicy = {
    ...(input.capacity_path === undefined
      ? {}
      : { capacityPath: text(input.capacity_path, "capacity_path") }),
    seed: text(input.seed, "seed"),
    autoRouting: input.auto_routing === true,
    ledgerPaths: input.ledger_paths.map((value) => text(value, "ledger_paths")),
    arms,
    providers,
    hosts,
    controlFloor: fraction(input.control_floor, "control_floor", 0.2),
    explorationFloor: fraction(
      input.exploration_floor,
      "exploration_floor",
      0.1,
    ),
    maxShift: fraction(input.max_shift, "max_shift", 0.05),
    minMatureMerged: count(input.min_mature_merged, "min_mature_merged", 30),
    minClusters: count(input.min_clusters, "min_clusters", 10),
    minDecisionSeconds: positive(
      input.min_decision_seconds,
      "min_decision_seconds",
      900,
    ),
    maxReviewRate: fraction(input.max_review_rate, "max_review_rate", 0.2),
    maxFailureRate: fraction(input.max_failure_rate, "max_failure_rate", 0.25),
    maxPendingFraction: fraction(
      input.max_pending_fraction,
      "max_pending_fraction",
      0.5,
    ),
    maxLatencyHours: positive(input.max_latency_hours, "max_latency_hours", 72),
    minRelativeGain: fraction(
      input.min_relative_gain,
      "min_relative_gain",
      0.1,
    ),
    maxIssueCostUsd: positive(
      input.max_issue_cost_usd,
      "max_issue_cost_usd",
      10,
    ),
    maxClusterIssues: count(input.max_cluster_issues, "max_cluster_issues", 24),
    errorBudget: fraction(input.error_budget, "error_budget", 0.01),
    windowDays: positive(input.window_days, "window_days", 30),
    horizonDays: positive(input.horizon_days, "horizon_days", 1),
  };
  if (
    policy.maxShift > 0.1 ||
    policy.controlFloor +
          policy.explorationFloor *
            (arms.filter((arm) => arm.status === "active").length - 1) >= 1
  ) {
    throw new Error(
      "subscription_allocation floors or max_shift would remove stable exploration",
    );
  }
  if (policy.horizonDays >= policy.windowDays) {
    throw new Error(
      "subscription_allocation horizon must be shorter than its reporting window",
    );
  }
  const initial = initialAllocationState(policy);
  for (const arm of arms.filter((arm) => arm.status === "active")) {
    if (
      initial.weights[arm.id]! <
        (arm.control ? policy.controlFloor : policy.explorationFloor)
    ) {
      throw new Error(
        "subscription_allocation initial weights violate exploration floors",
      );
    }
  }
  return policy;
}
export function initialAllocationState(
  policy: AllocationPolicy,
): AllocationState {
  const active = policy.arms.filter((arm) => arm.status === "active");
  const total = active.reduce((sum, arm) => sum + arm.weight, 0);
  const weights = Object.fromEntries(
    active.map((arm) => [arm.id, arm.weight / total]),
  );
  return {
    version: 1,
    policyKey: policyKey(policy),
    weights,
    baselineWeights: { ...weights },
    paused: false,
    dryRunAt: null,
    decisionCount: 0,
    lastDecisionAt: 0,
    evidenceKey: "",
  };
}
/** Reject old or mismatched persisted state; never silently reset a running trial. */
export function validateAllocationState(
  policy: AllocationPolicy,
  raw: unknown,
): AllocationState {
  const record = object(raw, "state");
  keys(record, [
    "version",
    "policyKey",
    "weights",
    "baselineWeights",
    "paused",
    "dryRunAt",
    "decisionCount",
    "lastDecisionAt",
    "evidenceKey",
  ]);
  const value = record as unknown as AllocationState;
  if (
    value.version !== 1 || value.policyKey !== policyKey(policy) ||
    typeof value.paused !== "boolean" ||
    !Number.isSafeInteger(value.decisionCount) || value.decisionCount < 0 ||
    !Number.isFinite(value.lastDecisionAt) ||
    typeof value.evidenceKey !== "string" ||
    (value.dryRunAt !== null && !Number.isFinite(Date.parse(value.dryRunAt)))
  ) {
    throw new Error(
      "subscription_allocation state schema or policy does not match; review and reset explicitly",
    );
  }
  for (const weights of [value.weights, value.baselineWeights]) {
    const entries = Object.entries(object(weights, "weights"));
    const active = policy.arms.filter((arm) => arm.status === "active");
    if (
      entries.length !== active.length || active.some((arm) =>
        typeof weights[arm.id] !== "number" ||
        !Number.isFinite(weights[arm.id]) ||
        weights[arm.id]! <
          (arm.control ? policy.controlFloor : policy.explorationFloor)
      ) || Math.abs(
          entries.reduce((sum, [, number]) =>
            sum + Number(number), 0) - 1,
        ) > 1e-8
    ) throw new Error("subscription_allocation state weights are invalid");
  }
  return value;
}
/** Empirical Bernstein interval with error spent over decision and sample counts. */
function meanInterval(values: number[], delta: number): Interval {
  const n = values.length;
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const variance = n > 1
    ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)
    : 1;
  const log = Math.log(3 / delta);
  const radius = Math.sqrt(2 * variance * log / n) + 3 * log / n;
  return { low: Math.max(0, mean - radius), high: Math.min(1, mean + radius) };
}
function intervalFor(
  records: AssignmentRecord[],
  policy: AllocationPolicy,
  look: number,
  arms: number,
  time: number,
): { interval: Interval; clusters: number } | null {
  const groups = new Map<string, AssignmentRecord[]>();
  for (const record of records) {
    const key = `${record.hosts.join(",")}:${record.assignedAt.slice(0, 10)}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  const clusters = [...groups.values()];
  if (
    clusters.length < policy.minClusters ||
    clusters.some((group) =>
      group.length > policy.maxClusterIssues ||
      group.some((record) => record.costUsd > policy.maxIssueCostUsd)
    )
  ) return null;
  const delta = policy.errorBudget /
    (arms * 2 * (look + 1) * (look + 2) * clusters.length *
      (clusters.length + 1) * (time + 1) * (time + 2));
  const reward = meanInterval(
    clusters.map((group) =>
      group.filter((record) => record.status === "merged").length /
      policy.maxClusterIssues
    ),
    delta,
  );
  const cost = meanInterval(
    clusters.map((group) =>
      group.reduce((sum, record) => sum + record.costUsd, 0) /
      (policy.maxClusterIssues * policy.maxIssueCostUsd)
    ),
    delta,
  );
  return {
    clusters: clusters.length,
    interval: {
      low: reward.low / (cost.high * policy.maxIssueCostUsd),
      high: cost.low > 0
        ? reward.high / (cost.low * policy.maxIssueCostUsd)
        : Infinity,
    },
  };
}
/** Mature outcomes and all observed attempts inform bounded, reversible weight changes. */
export function recommendAllocation(
  policy: AllocationPolicy,
  current: AllocationState,
  report: ExperimentReport,
  capacity?: AllocationCapacityEvidence,
): AllocationPlan {
  const state = validateAllocationState(policy, structuredClone(current));
  const now = Date.parse(report.generatedAt);
  if (!Number.isFinite(now)) {
    throw new Error("subscription_allocation report time is invalid");
  }
  const plan: AllocationPlan = {
    action: "hold",
    reason: "initial randomised control phase: insufficient mature evidence",
    weights: { ...state.weights },
    effectiveSamples: {},
    matureMerged: {},
    metrics: {},
    intervals: {},
    nextState: state,
  };
  const finish = (
    action: AllocationPlan["action"],
    reason: string,
  ): AllocationPlan => {
    plan.action = action;
    plan.reason = reason;
    state.weights = { ...plan.weights };
    return plan;
  };
  if (state.paused) {
    return finish(
      "paused",
      "allocation remains paused until explicit operator reset",
    );
  }
  const active = policy.arms.filter((arm) => arm.status === "active");
  const records = report.records.filter((record) =>
    active.some((arm) => arm.id === record.cohort)
  );
  const mature = records.filter((record) => record.mature);
  if (
    records.some((record) =>
      record.roles && ["manager", "executor"].some((role) => {
        const expected = policy.arms.find((arm) =>
          arm.id === record.cohort
        )![role as "manager" | "executor"];
        const observed = record.roles!.find((treatment) =>
          treatment.role === role
        );
        return !observed || observed.provider !== expected.provider ||
          observed.model !== expected.model;
      })
    )
  ) {
    return finish(
      "hold",
      "recorded treatment differs from its configured arm; use a new cohort ID for a changed treatment",
    );
  }
  for (const arm of active) {
    const sample = records.filter((record) => record.cohort === arm.id).sort((
      left,
      right,
    ) =>
      Date.parse(right.lastObservedAt ?? right.assignedAt) -
      Date.parse(left.lastObservedAt ?? left.assignedAt)
    ).slice(0, Math.max(10, policy.minMatureMerged));
    const matureSample = mature.filter((record) => record.cohort === arm.id);
    plan.matureMerged[arm.id] = matureSample.filter((record) =>
      record.status === "merged"
    ).length;
    plan.effectiveSamples[arm.id] = new Set(matureSample.map((record) =>
      `${record.hosts.join(",")}:${record.assignedAt.slice(0, 10)}`
    )).size;
    if (sample.length === 0) {
      continue;
    }
    const invocations = sample.reduce(
      (sum, record) =>
        sum + record.invocations,
      0,
    );
    const poorQuality = sample.reduce((sum, record) =>
              sum + record.reviewRejections, 0) / sample.length >
        policy.maxReviewRate || sample.reduce((sum, record) =>
              sum + record.gateFailures, 0) / sample.length >
        policy.maxFailureRate;
    const unreliable = invocations > 0 &&
      sample.reduce(
              (sum, record) =>
                sum +
                Math.max(
                  record.failedInvocations,
                  record.quotaLimitedInvocations,
                ),
              0,
            ) / invocations > policy.maxFailureRate;
    if (poorQuality || unreliable) {
      plan.weights = { ...state.baselineWeights };
      state.paused = true;
      return finish(
        "rollback",
        `quality or reliability regression in ${arm.id}; restored initial weights and paused routing`,
      );
    }
  }
  if (
    report.warnings.some((warning) =>
      warning.code !== "low-sample" &&
      !(warning.code === "unequal-exposure" &&
        Object.keys(state.weights).some((id) =>
          Math.abs(state.weights[id]! - state.baselineWeights[id]!) > 1e-9
        ))
    ) || records.some((record) =>
      record.costUnknownCount > 0 || record.usesExcludedModel
    )
  ) {
    return finish(
      "hold",
      "incomplete, excluded or biased evidence prevents allocation changes",
    );
  }
  if (
    records.length > 0 &&
    records.filter((record) => record.censored).length / records.length >
      policy.maxPendingFraction
  ) return finish("hold", "pending/censored exposure is too large");
  const evidenceKey = JSON.stringify(
    records.map(
      (record) => [
        record.assignmentId,
        record.cohort,
        record.mature,
        record.status,
        record.costUsd,
        record.invocations,
        record.reviewRejections,
      ],
    ),
  );
  if (
    evidenceKey === state.evidenceKey ||
    now - state.lastDecisionAt < policy.minDecisionSeconds * 1000
  ) {
    return finish(
      "hold",
      "unchanged evidence or decision cadence; weights retained",
    );
  }
  for (const arm of active) {
    const sample = mature.filter((record) => record.cohort === arm.id);
    if (
      sample.filter((record) => record.status === "merged").length <
        policy.minMatureMerged
    ) return plan;
    const bound = intervalFor(
      sample,
      policy,
      state.decisionCount,
      active.length,
      now,
    );
    if (!bound) {
      return finish(
        "hold",
        "insufficient independent clusters or an observation exceeds the declared bounds",
      );
    }
    plan.effectiveSamples[arm.id] = bound.clusters;
    plan.intervals[arm.id] = bound.interval;
  }
  const control = active.find((arm) => arm.control)!;
  const controlRecords = mature.filter((record) =>
    record.cohort === control.id
  );
  const mergeRate = (sample: AssignmentRecord[]) =>
    sample.filter((record) => record.status === "merged").length /
    sample.length;
  const latency = (sample: AssignmentRecord[]) => {
    const merged = sample.filter((record) => record.status === "merged");
    return merged.reduce(
      (sum, record) => sum + (record.timeToMergeHours ?? Infinity),
      0,
    ) / merged.length;
  };
  if (
    !capacity || capacity.correlatedOutage ||
    !Number.isFinite(Date.parse(capacity.observedAt)) ||
    Date.parse(capacity.observedAt) > now ||
    now - Date.parse(capacity.observedAt) > 3_600_000 || active.some((arm) => {
      const metrics = capacity.arms[arm.id];
      return !metrics || !Number.isFinite(metrics.hostDays) ||
        metrics.hostDays <= 0 ||
        !Number.isFinite(metrics.availableSlotSeconds) ||
        metrics.availableSlotSeconds <= 0 ||
        !Number.isFinite(metrics.idleSlotSeconds) ||
        metrics.idleSlotSeconds < 0 ||
        !Number.isFinite(metrics.quotaBlockedSlotSeconds) ||
        metrics.quotaBlockedSlotSeconds < 0 ||
        metrics.idleSlotSeconds + metrics.quotaBlockedSlotSeconds >
          metrics.availableSlotSeconds;
    })
  ) {
    return finish(
      "hold",
      "fresh measured host-day, idle and quota evidence is required; correlated outages pause comparisons",
    );
  }
  const capacityOf = (id: string) => capacity.arms[id]!;
  const throughput = (id: string) =>
    mature.filter((record) =>
      record.cohort === id && record.status === "merged"
    ).length / capacityOf(id).hostDays;
  const idle = (id: string) =>
    capacityOf(id).idleSlotSeconds / capacityOf(id).availableSlotSeconds;
  const saturated = (id: string) =>
    capacityOf(id).quotaBlockedSlotSeconds /
    capacityOf(id).availableSlotSeconds;
  for (const arm of active) {
    plan.metrics[arm.id] = {
      mergedPerHostDay: throughput(arm.id),
      idleFraction: idle(arm.id),
      quotaSaturation: saturated(arm.id),
      meanHoursToMerge: latency(
        mature.filter((record) => record.cohort === arm.id),
      ),
    };
  }
  const candidates = active.filter((arm) =>
    !arm.control &&
    active.every((other) =>
      other.id === arm.id ||
      plan.intervals[arm.id]!.low >
        plan.intervals[other.id]!.high * (1 + policy.minRelativeGain)
    )
  ).filter((arm) => {
    const sample = mature.filter((record) => record.cohort === arm.id);
    return throughput(arm.id) >= throughput(control.id) &&
      idle(arm.id) <= idle(control.id) + 0.05 &&
      saturated(arm.id) <= policy.maxFailureRate &&
      mergeRate(sample) >= mergeRate(controlRecords) - 0.05 &&
      latency(sample) <= policy.maxLatencyHours &&
      latency(sample) <= latency(controlRecords) * 1.25;
  });
  state.decisionCount++;
  state.lastDecisionAt = now;
  state.evidenceKey = evidenceKey;
  if (candidates.length !== 1) {
    return finish(
      "hold",
      "uncertainty overlaps or throughput/latency guardrails prevent a shift",
    );
  }
  const winner = candidates[0]!;
  let remaining = policy.maxShift;
  for (const arm of active.filter((arm) => arm.id !== winner.id)) {
    const floor = arm.control ? policy.controlFloor : policy.explorationFloor;
    const transfer = Math.min(
      remaining,
      Math.max(0, plan.weights[arm.id]! - floor),
    );
    if (transfer <= 1e-12) continue;
    plan.weights[arm.id]! -= transfer;
    plan.weights[winner.id]! += transfer;
    remaining -= transfer;
  }
  if (remaining === policy.maxShift) {
    return finish("hold", "control and exploration floors already bind");
  }
  return finish(
    "shift",
    `gradual shift toward ${winner.id}; estimated API-equivalent efficiency is separated under the declared cluster assumptions`,
  );
}
/** Routing is a separate, explicit opt-in; budgets and live capacity are admission guards. */
export async function selectAllocationArm(
  policy: AllocationPolicy,
  state: AllocationState,
  repo: string,
  issue: number,
  hostId: string,
  statuses: Record<string, AllocationProviderStatus>,
): Promise<string | null> {
  if (!policy.autoRouting) return null;
  validateAllocationState(policy, state);
  if (!state.dryRunAt) {
    throw new Error(
      "subscription_allocation requires a recorded dry-run before automatic routing",
    );
  }
  const host = policy.hosts[hostId];
  if (!host) {
    throw new Error(
      `subscription_allocation has no capacity assignment for host ${
        JSON.stringify(hostId)
      }`,
    );
  }
  const eligible = (arm: AllocationArm) =>
    [arm.manager, arm.executor, arm.reviewer].every((role) => {
      const status = statuses[role.provider];
      const budget = policy.providers[role.provider];
      const totalHostWeight = Object.values(policy.hosts).filter((assigned) =>
        assigned.providers.includes(role.provider)
      ).reduce((sum, assigned) => sum + assigned.weight, 0);
      const hostBudget = budget!.estimatedBudgetUsd * host.weight /
        totalHostWeight;
      return lookupModelPricing(role.model) !== null &&
        host.providers.includes(role.provider) &&
        status?.subscription === true && status.available && status.costKnown &&
        Number.isFinite(status.spentUsd) &&
        status.spentUsd + policy.maxIssueCostUsd * (status.inFlight + 1) <=
          budget!.estimatedBudgetUsd &&
        (status.hostSpentUsd ?? status.spentUsd) +
              policy.maxIssueCostUsd * (status.inFlight + 1) <= hostBudget &&
        status.inFlight < Math.min(host.capacity, budget!.maxParallelism);
    });
  const control = policy.arms.find((arm) => arm.control)!;
  if (state.paused) return eligible(control) ? control.id : null;
  const arms = policy.arms.map((arm) => ({
    ...arm,
    weight: state.weights[arm.id] ?? arm.weight,
  }));
  const allowed = new Set(
    arms.filter((arm) => arm.status === "active" && eligible(arm)).map((arm) =>
      arm.id
    ),
  );
  if (allowed.size === 0) return null;
  return await assignExperimentArm(
    `${policy.seed}:${state.decisionCount}`,
    repo,
    issue,
    arms,
    allowed,
  );
}
