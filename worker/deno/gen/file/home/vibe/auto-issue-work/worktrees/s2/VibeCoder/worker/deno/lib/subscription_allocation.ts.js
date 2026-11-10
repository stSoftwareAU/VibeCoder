/** Conservative subscription allocation using mature issue cohorts (Issue #3646). */ import { assignExperimentArm, isExcludedModel, validateExperimentArms } from "./fleet_experiment_arms.ts";
import { agentProviderById } from "./agent_provider.ts";
import { lookupModelPricing } from "./token_usage.ts";
function policyKey(policy) {
  return JSON.stringify({
    ...policy,
    autoRouting: false
  });
}
function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`subscription_allocation.${name} must be an object`);
  }
  return value;
}
function positive(value, name, fallback) {
  const number = value ?? fallback;
  if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) {
    throw new Error(`subscription_allocation.${name} must be positive`);
  }
  return number;
}
function count(value, name, fallback) {
  const number = positive(value, name, fallback);
  if (!Number.isInteger(number)) {
    throw new Error(`subscription_allocation.${name} must be an integer`);
  }
  return number;
}
function fraction(value, name, fallback) {
  const number = positive(value, name, fallback);
  if (number >= 1) {
    throw new Error(`subscription_allocation.${name} must be below one`);
  }
  return number;
}
function text(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`subscription_allocation.${name} must be non-empty text`);
  }
  return value;
}
function keys(input, allowed) {
  for (const key of Object.keys(input)){
    if (!allowed.includes(key)) {
      throw new Error(`subscription_allocation: unknown key ${JSON.stringify(key)}`);
    }
  }
}
/** Financial/billing fields are deliberately outside the accepted schema. */ export function parseAllocationPolicy(raw) {
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
    "capacity_path"
  ]);
  if (input.auto_routing !== undefined && typeof input.auto_routing !== "boolean") throw new Error("subscription_allocation.auto_routing must be boolean");
  if (!Array.isArray(input.arms)) {
    throw new Error("subscription_allocation.arms must be an array");
  }
  const arms = input.arms.map((value)=>{
    const arm = object(value, "arm");
    keys(arm, [
      "id",
      "label",
      "manager",
      "executor",
      "control",
      "weight",
      "status",
      "reviewer"
    ]);
    const role = (value)=>{
      const selected = object(value, "role");
      keys(selected, [
        "provider",
        "model"
      ]);
      return {
        provider: text(selected.provider, "provider"),
        model: text(selected.model, "model")
      };
    };
    if (typeof arm.control !== "boolean" || ![
      "active",
      "awaiting-feasibility"
    ].includes(String(arm.status))) throw new Error("subscription_allocation arm control/status is invalid");
    return {
      id: text(arm.id, "id"),
      label: text(arm.label, "label"),
      control: arm.control,
      manager: role(arm.manager),
      executor: role(arm.executor),
      reviewer: arm.reviewer === undefined ? {
        provider: "claude",
        model: "opus"
      } : role(arm.reviewer),
      weight: positive(arm.weight, "weight", 1),
      status: arm.status
    };
  });
  validateExperimentArms(arms);
  const control = arms.find((arm)=>arm.control);
  if (control.manager.provider !== "claude" || control.manager.model !== "sonnet" || control.executor.provider !== "claude" || control.executor.model !== "haiku") {
    throw new Error("subscription_allocation control must preserve Sonnet manager / Haiku executor");
  }
  const providers = Object.fromEntries(Object.entries(object(input.providers, "providers")).map(([id, value])=>{
    if (!agentProviderById(id)) {
      throw new Error("subscription_allocation provider must name a registered adapter");
    }
    const entry = object(value, "provider");
    keys(entry, [
      "estimated_budget_usd",
      "max_parallelism"
    ]);
    return [
      id,
      {
        estimatedBudgetUsd: positive(entry.estimated_budget_usd, "estimated_budget_usd"),
        maxParallelism: count(entry.max_parallelism, "max_parallelism")
      }
    ];
  }));
  const hosts = Object.fromEntries(Object.entries(object(input.hosts, "hosts")).map(([id, value])=>{
    const host = object(value, "host");
    keys(host, [
      "providers",
      "capacity",
      "weight"
    ]);
    if (!Array.isArray(host.providers) || host.providers.length === 0 || host.providers.some((id)=>typeof id !== "string" || !Object.hasOwn(providers, id))) {
      throw new Error("subscription_allocation host providers must name configured budgets");
    }
    return [
      id,
      {
        providers: [
          ...new Set(host.providers)
        ],
        capacity: count(host.capacity, "capacity"),
        weight: positive(host.weight, "weight", 1)
      }
    ];
  }));
  if (Object.keys(hosts).length === 0) {
    throw new Error("subscription_allocation needs a host assignment");
  }
  for (const [id, provider] of Object.entries(providers)){
    const reserved = Object.values(hosts).filter((host)=>host.providers.includes(id)).reduce((sum, host)=>sum + host.capacity, 0);
    if (reserved > provider.maxParallelism) {
      throw new Error(`subscription_allocation host capacities exceed ${id} max_parallelism`);
    }
  }
  for (const arm of arms){
    for (const role of [
      arm.manager,
      arm.executor,
      arm.reviewer
    ]){
      if (!Object.hasOwn(providers, role.provider) || !agentProviderById(role.provider) || isExcludedModel(role.model)) {
        throw new Error("subscription_allocation role has no provider budget or uses an excluded model");
      }
    }
  }
  if (!Array.isArray(input.ledger_paths) || input.ledger_paths.length === 0) {
    throw new Error("subscription_allocation.ledger_paths must name collected evidence");
  }
  const policy = {
    ...input.capacity_path === undefined ? {} : {
      capacityPath: text(input.capacity_path, "capacity_path")
    },
    seed: text(input.seed, "seed"),
    autoRouting: input.auto_routing === true,
    ledgerPaths: input.ledger_paths.map((value)=>text(value, "ledger_paths")),
    arms,
    providers,
    hosts,
    controlFloor: fraction(input.control_floor, "control_floor", 0.2),
    explorationFloor: fraction(input.exploration_floor, "exploration_floor", 0.1),
    maxShift: fraction(input.max_shift, "max_shift", 0.05),
    minMatureMerged: count(input.min_mature_merged, "min_mature_merged", 30),
    minClusters: count(input.min_clusters, "min_clusters", 10),
    minDecisionSeconds: positive(input.min_decision_seconds, "min_decision_seconds", 900),
    maxReviewRate: fraction(input.max_review_rate, "max_review_rate", 0.2),
    maxFailureRate: fraction(input.max_failure_rate, "max_failure_rate", 0.25),
    maxPendingFraction: fraction(input.max_pending_fraction, "max_pending_fraction", 0.5),
    maxLatencyHours: positive(input.max_latency_hours, "max_latency_hours", 72),
    minRelativeGain: fraction(input.min_relative_gain, "min_relative_gain", 0.1),
    maxIssueCostUsd: positive(input.max_issue_cost_usd, "max_issue_cost_usd", 10),
    maxClusterIssues: count(input.max_cluster_issues, "max_cluster_issues", 24),
    errorBudget: fraction(input.error_budget, "error_budget", 0.01),
    windowDays: positive(input.window_days, "window_days", 30),
    horizonDays: positive(input.horizon_days, "horizon_days", 1)
  };
  if (policy.maxShift > 0.1 || policy.controlFloor + policy.explorationFloor * (arms.filter((arm)=>arm.status === "active").length - 1) >= 1) {
    throw new Error("subscription_allocation floors or max_shift would remove stable exploration");
  }
  if (policy.horizonDays >= policy.windowDays) {
    throw new Error("subscription_allocation horizon must be shorter than its reporting window");
  }
  const initial = initialAllocationState(policy);
  for (const arm of arms.filter((arm)=>arm.status === "active")){
    if (initial.weights[arm.id] < (arm.control ? policy.controlFloor : policy.explorationFloor)) {
      throw new Error("subscription_allocation initial weights violate exploration floors");
    }
  }
  return policy;
}
export function initialAllocationState(policy) {
  const active = policy.arms.filter((arm)=>arm.status === "active");
  const total = active.reduce((sum, arm)=>sum + arm.weight, 0);
  const weights = Object.fromEntries(active.map((arm)=>[
      arm.id,
      arm.weight / total
    ]));
  return {
    version: 1,
    policyKey: policyKey(policy),
    weights,
    baselineWeights: {
      ...weights
    },
    paused: false,
    dryRunAt: null,
    decisionCount: 0,
    lastDecisionAt: 0,
    evidenceKey: ""
  };
}
/** Reject old or mismatched persisted state; never silently reset a running trial. */ export function validateAllocationState(policy, raw) {
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
    "evidenceKey"
  ]);
  const value = record;
  if (value.version !== 1 || value.policyKey !== policyKey(policy) || typeof value.paused !== "boolean" || !Number.isSafeInteger(value.decisionCount) || value.decisionCount < 0 || !Number.isFinite(value.lastDecisionAt) || typeof value.evidenceKey !== "string" || value.dryRunAt !== null && !Number.isFinite(Date.parse(value.dryRunAt))) {
    throw new Error("subscription_allocation state schema or policy does not match; review and reset explicitly");
  }
  for (const weights of [
    value.weights,
    value.baselineWeights
  ]){
    const entries = Object.entries(object(weights, "weights"));
    const active = policy.arms.filter((arm)=>arm.status === "active");
    if (entries.length !== active.length || active.some((arm)=>typeof weights[arm.id] !== "number" || !Number.isFinite(weights[arm.id]) || weights[arm.id] < (arm.control ? policy.controlFloor : policy.explorationFloor)) || Math.abs(entries.reduce((sum, [, number])=>sum + Number(number), 0) - 1) > 1e-8) throw new Error("subscription_allocation state weights are invalid");
  }
  return value;
}
/** Empirical Bernstein interval with error spent over decision and sample counts. */ function meanInterval(values, delta) {
  const n = values.length;
  const mean = values.reduce((sum, value)=>sum + value, 0) / n;
  const variance = n > 1 ? values.reduce((sum, value)=>sum + (value - mean) ** 2, 0) / (n - 1) : 1;
  const log = Math.log(3 / delta);
  const radius = Math.sqrt(2 * variance * log / n) + 3 * log / n;
  return {
    low: Math.max(0, mean - radius),
    high: Math.min(1, mean + radius)
  };
}
function intervalFor(records, policy, look, arms, time) {
  const groups = new Map();
  for (const record of records){
    const key = `${record.hosts.join(",")}:${record.assignedAt.slice(0, 10)}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  const clusters = [
    ...groups.values()
  ];
  if (clusters.length < policy.minClusters || clusters.some((group)=>group.length > policy.maxClusterIssues || group.some((record)=>record.costUsd > policy.maxIssueCostUsd))) return null;
  const delta = policy.errorBudget / (arms * 2 * (look + 1) * (look + 2) * clusters.length * (clusters.length + 1) * (time + 1) * (time + 2));
  const reward = meanInterval(clusters.map((group)=>group.filter((record)=>record.status === "merged").length / policy.maxClusterIssues), delta);
  const cost = meanInterval(clusters.map((group)=>group.reduce((sum, record)=>sum + record.costUsd, 0) / (policy.maxClusterIssues * policy.maxIssueCostUsd)), delta);
  return {
    clusters: clusters.length,
    interval: {
      low: reward.low / (cost.high * policy.maxIssueCostUsd),
      high: cost.low > 0 ? reward.high / (cost.low * policy.maxIssueCostUsd) : Infinity
    }
  };
}
/** Mature outcomes and all observed attempts inform bounded, reversible weight changes. */ export function recommendAllocation(policy, current, report, capacity) {
  const state = validateAllocationState(policy, structuredClone(current));
  const now = Date.parse(report.generatedAt);
  if (!Number.isFinite(now)) {
    throw new Error("subscription_allocation report time is invalid");
  }
  const plan = {
    action: "hold",
    reason: "initial randomised control phase: insufficient mature evidence",
    weights: {
      ...state.weights
    },
    effectiveSamples: {},
    matureMerged: {},
    metrics: {},
    intervals: {},
    nextState: state
  };
  const finish = (action, reason)=>{
    plan.action = action;
    plan.reason = reason;
    state.weights = {
      ...plan.weights
    };
    return plan;
  };
  if (state.paused) {
    return finish("paused", "allocation remains paused until explicit operator reset");
  }
  const active = policy.arms.filter((arm)=>arm.status === "active");
  const records = report.records.filter((record)=>active.some((arm)=>arm.id === record.cohort));
  const mature = records.filter((record)=>record.mature);
  if (records.some((record)=>record.roles && [
      "manager",
      "executor"
    ].some((role)=>{
      const expected = policy.arms.find((arm)=>arm.id === record.cohort)[role];
      const observed = record.roles.find((treatment)=>treatment.role === role);
      return !observed || observed.provider !== expected.provider || observed.model !== expected.model;
    }))) {
    return finish("hold", "recorded treatment differs from its configured arm; use a new cohort ID for a changed treatment");
  }
  for (const arm of active){
    const sample = records.filter((record)=>record.cohort === arm.id).sort((left, right)=>Date.parse(right.lastObservedAt ?? right.assignedAt) - Date.parse(left.lastObservedAt ?? left.assignedAt)).slice(0, Math.max(10, policy.minMatureMerged));
    const matureSample = mature.filter((record)=>record.cohort === arm.id);
    plan.matureMerged[arm.id] = matureSample.filter((record)=>record.status === "merged").length;
    plan.effectiveSamples[arm.id] = new Set(matureSample.map((record)=>`${record.hosts.join(",")}:${record.assignedAt.slice(0, 10)}`)).size;
    if (sample.length === 0) {
      continue;
    }
    const invocations = sample.reduce((sum, record)=>sum + record.invocations, 0);
    const poorQuality = sample.reduce((sum, record)=>sum + record.reviewRejections, 0) / sample.length > policy.maxReviewRate || sample.reduce((sum, record)=>sum + record.gateFailures, 0) / sample.length > policy.maxFailureRate;
    const unreliable = invocations > 0 && sample.reduce((sum, record)=>sum + Math.max(record.failedInvocations, record.quotaLimitedInvocations), 0) / invocations > policy.maxFailureRate;
    if (poorQuality || unreliable) {
      plan.weights = {
        ...state.baselineWeights
      };
      state.paused = true;
      return finish("rollback", `quality or reliability regression in ${arm.id}; restored initial weights and paused routing`);
    }
  }
  if (report.warnings.some((warning)=>warning.code !== "low-sample" && !(warning.code === "unequal-exposure" && Object.keys(state.weights).some((id)=>Math.abs(state.weights[id] - state.baselineWeights[id]) > 1e-9))) || records.some((record)=>record.costUnknownCount > 0 || record.usesExcludedModel)) {
    return finish("hold", "incomplete, excluded or biased evidence prevents allocation changes");
  }
  if (records.length > 0 && records.filter((record)=>record.censored).length / records.length > policy.maxPendingFraction) return finish("hold", "pending/censored exposure is too large");
  const evidenceKey = JSON.stringify(records.map((record)=>[
      record.assignmentId,
      record.cohort,
      record.mature,
      record.status,
      record.costUsd,
      record.invocations,
      record.reviewRejections
    ]));
  if (evidenceKey === state.evidenceKey || now - state.lastDecisionAt < policy.minDecisionSeconds * 1000) {
    return finish("hold", "unchanged evidence or decision cadence; weights retained");
  }
  for (const arm of active){
    const sample = mature.filter((record)=>record.cohort === arm.id);
    if (sample.filter((record)=>record.status === "merged").length < policy.minMatureMerged) return plan;
    const bound = intervalFor(sample, policy, state.decisionCount, active.length, now);
    if (!bound) {
      return finish("hold", "insufficient independent clusters or an observation exceeds the declared bounds");
    }
    plan.effectiveSamples[arm.id] = bound.clusters;
    plan.intervals[arm.id] = bound.interval;
  }
  const control = active.find((arm)=>arm.control);
  const controlRecords = mature.filter((record)=>record.cohort === control.id);
  const mergeRate = (sample)=>sample.filter((record)=>record.status === "merged").length / sample.length;
  const latency = (sample)=>{
    const merged = sample.filter((record)=>record.status === "merged");
    return merged.reduce((sum, record)=>sum + (record.timeToMergeHours ?? Infinity), 0) / merged.length;
  };
  if (!capacity || capacity.correlatedOutage || !Number.isFinite(Date.parse(capacity.observedAt)) || Date.parse(capacity.observedAt) > now || now - Date.parse(capacity.observedAt) > 3_600_000 || active.some((arm)=>{
    const metrics = capacity.arms[arm.id];
    return !metrics || !Number.isFinite(metrics.hostDays) || metrics.hostDays <= 0 || !Number.isFinite(metrics.availableSlotSeconds) || metrics.availableSlotSeconds <= 0 || !Number.isFinite(metrics.idleSlotSeconds) || metrics.idleSlotSeconds < 0 || !Number.isFinite(metrics.quotaBlockedSlotSeconds) || metrics.quotaBlockedSlotSeconds < 0 || metrics.idleSlotSeconds + metrics.quotaBlockedSlotSeconds > metrics.availableSlotSeconds;
  })) {
    return finish("hold", "fresh measured host-day, idle and quota evidence is required; correlated outages pause comparisons");
  }
  const capacityOf = (id)=>capacity.arms[id];
  const throughput = (id)=>mature.filter((record)=>record.cohort === id && record.status === "merged").length / capacityOf(id).hostDays;
  const idle = (id)=>capacityOf(id).idleSlotSeconds / capacityOf(id).availableSlotSeconds;
  const saturated = (id)=>capacityOf(id).quotaBlockedSlotSeconds / capacityOf(id).availableSlotSeconds;
  for (const arm of active){
    plan.metrics[arm.id] = {
      mergedPerHostDay: throughput(arm.id),
      idleFraction: idle(arm.id),
      quotaSaturation: saturated(arm.id),
      meanHoursToMerge: latency(mature.filter((record)=>record.cohort === arm.id))
    };
  }
  const candidates = active.filter((arm)=>!arm.control && active.every((other)=>other.id === arm.id || plan.intervals[arm.id].low > plan.intervals[other.id].high * (1 + policy.minRelativeGain))).filter((arm)=>{
    const sample = mature.filter((record)=>record.cohort === arm.id);
    return throughput(arm.id) >= throughput(control.id) && idle(arm.id) <= idle(control.id) + 0.05 && saturated(arm.id) <= policy.maxFailureRate && mergeRate(sample) >= mergeRate(controlRecords) - 0.05 && latency(sample) <= policy.maxLatencyHours && latency(sample) <= latency(controlRecords) * 1.25;
  });
  state.decisionCount++;
  state.lastDecisionAt = now;
  state.evidenceKey = evidenceKey;
  if (candidates.length !== 1) {
    return finish("hold", "uncertainty overlaps or throughput/latency guardrails prevent a shift");
  }
  const winner = candidates[0];
  let remaining = policy.maxShift;
  for (const arm of active.filter((arm)=>arm.id !== winner.id)){
    const floor = arm.control ? policy.controlFloor : policy.explorationFloor;
    const transfer = Math.min(remaining, Math.max(0, plan.weights[arm.id] - floor));
    if (transfer <= 1e-12) continue;
    plan.weights[arm.id] -= transfer;
    plan.weights[winner.id] += transfer;
    remaining -= transfer;
  }
  if (remaining === policy.maxShift) {
    return finish("hold", "control and exploration floors already bind");
  }
  return finish("shift", `gradual shift toward ${winner.id}; estimated API-equivalent efficiency is separated under the declared cluster assumptions`);
}
/** Routing is a separate, explicit opt-in; budgets and live capacity are admission guards. */ export async function selectAllocationArm(policy, state, repo, issue, hostId, statuses) {
  if (!policy.autoRouting) return null;
  validateAllocationState(policy, state);
  if (!state.dryRunAt) {
    throw new Error("subscription_allocation requires a recorded dry-run before automatic routing");
  }
  const host = policy.hosts[hostId];
  if (!host) {
    throw new Error(`subscription_allocation has no capacity assignment for host ${JSON.stringify(hostId)}`);
  }
  const eligible = (arm)=>[
      arm.manager,
      arm.executor,
      arm.reviewer
    ].every((role)=>{
      const status = statuses[role.provider];
      const budget = policy.providers[role.provider];
      const totalHostWeight = Object.values(policy.hosts).filter((assigned)=>assigned.providers.includes(role.provider)).reduce((sum, assigned)=>sum + assigned.weight, 0);
      const hostBudget = budget.estimatedBudgetUsd * host.weight / totalHostWeight;
      return lookupModelPricing(role.model) !== null && host.providers.includes(role.provider) && status?.subscription === true && status.available && status.costKnown && Number.isFinite(status.spentUsd) && status.spentUsd + policy.maxIssueCostUsd * (status.inFlight + 1) <= budget.estimatedBudgetUsd && (status.hostSpentUsd ?? status.spentUsd) + policy.maxIssueCostUsd * (status.inFlight + 1) <= hostBudget && status.inFlight < Math.min(host.capacity, budget.maxParallelism);
    });
  const control = policy.arms.find((arm)=>arm.control);
  if (state.paused) return eligible(control) ? control.id : null;
  const arms = policy.arms.map((arm)=>({
      ...arm,
      weight: state.weights[arm.id] ?? arm.weight
    }));
  const allowed = new Set(arms.filter((arm)=>arm.status === "active" && eligible(arm)).map((arm)=>arm.id));
  if (allowed.size === 0) return null;
  return await assignExperimentArm(`${policy.seed}:${state.decisionCount}`, repo, issue, arms, allowed);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9zdWJzY3JpcHRpb25fYWxsb2NhdGlvbi50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKiogQ29uc2VydmF0aXZlIHN1YnNjcmlwdGlvbiBhbGxvY2F0aW9uIHVzaW5nIG1hdHVyZSBpc3N1ZSBjb2hvcnRzIChJc3N1ZSAjMzY0NikuICovXG5pbXBvcnQge1xuICB0eXBlIEFybVJvbGUsXG4gIGFzc2lnbkV4cGVyaW1lbnRBcm0sXG4gIHR5cGUgRXhwZXJpbWVudEFybSxcbiAgaXNFeGNsdWRlZE1vZGVsLFxuICB2YWxpZGF0ZUV4cGVyaW1lbnRBcm1zLFxufSBmcm9tIFwiLi9mbGVldF9leHBlcmltZW50X2FybXMudHNcIjtcbmltcG9ydCB7IGFnZW50UHJvdmlkZXJCeUlkIH0gZnJvbSBcIi4vYWdlbnRfcHJvdmlkZXIudHNcIjtcbmltcG9ydCB7IGxvb2t1cE1vZGVsUHJpY2luZyB9IGZyb20gXCIuL3Rva2VuX3VzYWdlLnRzXCI7XG5pbXBvcnQgdHlwZSB7XG4gIEFzc2lnbm1lbnRSZWNvcmQsXG4gIEV4cGVyaW1lbnRSZXBvcnQsXG4gIEludGVydmFsLFxufSBmcm9tIFwiLi9mbGVldF9leHBlcmltZW50X3JlcG9ydC50c1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEFsbG9jYXRpb25Bcm0gZXh0ZW5kcyBFeHBlcmltZW50QXJtIHtcbiAgcmV2aWV3ZXI6IEFybVJvbGU7XG59XG5leHBvcnQgaW50ZXJmYWNlIEFsbG9jYXRpb25Qb2xpY3kge1xuICBzZWVkOiBzdHJpbmc7XG4gIGF1dG9Sb3V0aW5nOiBib29sZWFuO1xuICBsZWRnZXJQYXRoczogc3RyaW5nW107XG4gIGFybXM6IEFsbG9jYXRpb25Bcm1bXTtcbiAgcHJvdmlkZXJzOiBSZWNvcmQ8XG4gICAgc3RyaW5nLFxuICAgIHsgZXN0aW1hdGVkQnVkZ2V0VXNkOiBudW1iZXI7IG1heFBhcmFsbGVsaXNtOiBudW1iZXIgfVxuICA+O1xuICBob3N0czogUmVjb3JkPFxuICAgIHN0cmluZyxcbiAgICB7IHByb3ZpZGVyczogc3RyaW5nW107IGNhcGFjaXR5OiBudW1iZXI7IHdlaWdodDogbnVtYmVyIH1cbiAgPjtcbiAgY29udHJvbEZsb29yOiBudW1iZXI7XG4gIGV4cGxvcmF0aW9uRmxvb3I6IG51bWJlcjtcbiAgbWF4U2hpZnQ6IG51bWJlcjtcbiAgbWluTWF0dXJlTWVyZ2VkOiBudW1iZXI7XG4gIG1pbkNsdXN0ZXJzOiBudW1iZXI7XG4gIG1pbkRlY2lzaW9uU2Vjb25kczogbnVtYmVyO1xuICBtYXhSZXZpZXdSYXRlOiBudW1iZXI7XG4gIG1heEZhaWx1cmVSYXRlOiBudW1iZXI7XG4gIG1heFBlbmRpbmdGcmFjdGlvbjogbnVtYmVyO1xuICBtYXhMYXRlbmN5SG91cnM6IG51bWJlcjtcbiAgbWluUmVsYXRpdmVHYWluOiBudW1iZXI7XG4gIG1heElzc3VlQ29zdFVzZDogbnVtYmVyO1xuICBtYXhDbHVzdGVySXNzdWVzOiBudW1iZXI7XG4gIGVycm9yQnVkZ2V0OiBudW1iZXI7XG4gIHdpbmRvd0RheXM6IG51bWJlcjtcbiAgaG9yaXpvbkRheXM6IG51bWJlcjtcbiAgY2FwYWNpdHlQYXRoPzogc3RyaW5nO1xufVxuZXhwb3J0IGludGVyZmFjZSBBbGxvY2F0aW9uU3RhdGUge1xuICB2ZXJzaW9uOiAxO1xuICBwb2xpY3lLZXk6IHN0cmluZztcbiAgd2VpZ2h0czogUmVjb3JkPHN0cmluZywgbnVtYmVyPjtcbiAgYmFzZWxpbmVXZWlnaHRzOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+O1xuICBwYXVzZWQ6IGJvb2xlYW47XG4gIGRyeVJ1bkF0OiBzdHJpbmcgfCBudWxsO1xuICBkZWNpc2lvbkNvdW50OiBudW1iZXI7XG4gIGxhc3REZWNpc2lvbkF0OiBudW1iZXI7XG4gIGV2aWRlbmNlS2V5OiBzdHJpbmc7XG59XG5leHBvcnQgaW50ZXJmYWNlIEFsbG9jYXRpb25QbGFuIHtcbiAgYWN0aW9uOiBcImhvbGRcIiB8IFwic2hpZnRcIiB8IFwicm9sbGJhY2tcIiB8IFwicGF1c2VkXCI7XG4gIHJlYXNvbjogc3RyaW5nO1xuICB3ZWlnaHRzOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+O1xuICBlZmZlY3RpdmVTYW1wbGVzOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+O1xuICBtYXR1cmVNZXJnZWQ6IFJlY29yZDxzdHJpbmcsIG51bWJlcj47XG4gIG1ldHJpY3M6IFJlY29yZDxcbiAgICBzdHJpbmcsXG4gICAge1xuICAgICAgbWVyZ2VkUGVySG9zdERheTogbnVtYmVyO1xuICAgICAgaWRsZUZyYWN0aW9uOiBudW1iZXI7XG4gICAgICBxdW90YVNhdHVyYXRpb246IG51bWJlcjtcbiAgICAgIG1lYW5Ib3Vyc1RvTWVyZ2U6IG51bWJlcjtcbiAgICB9XG4gID47XG4gIGludGVydmFsczogUmVjb3JkPHN0cmluZywgSW50ZXJ2YWw+O1xuICBuZXh0U3RhdGU6IEFsbG9jYXRpb25TdGF0ZTtcbn1cbmV4cG9ydCBpbnRlcmZhY2UgQWxsb2NhdGlvblByb3ZpZGVyU3RhdHVzIHtcbiAgc3Vic2NyaXB0aW9uOiBib29sZWFuO1xuICBhdmFpbGFibGU6IGJvb2xlYW47XG4gIGluRmxpZ2h0OiBudW1iZXI7XG4gIHNwZW50VXNkOiBudW1iZXI7XG4gIGNvc3RLbm93bjogYm9vbGVhbjtcbiAgaG9zdFNwZW50VXNkPzogbnVtYmVyO1xufVxuZXhwb3J0IGludGVyZmFjZSBBbGxvY2F0aW9uQ2FwYWNpdHlFdmlkZW5jZSB7XG4gIG9ic2VydmVkQXQ6IHN0cmluZztcbiAgY29ycmVsYXRlZE91dGFnZTogYm9vbGVhbjtcbiAgYXJtczogUmVjb3JkPFxuICAgIHN0cmluZyxcbiAgICB7XG4gICAgICBob3N0RGF5czogbnVtYmVyO1xuICAgICAgYXZhaWxhYmxlU2xvdFNlY29uZHM6IG51bWJlcjtcbiAgICAgIGlkbGVTbG90U2Vjb25kczogbnVtYmVyO1xuICAgICAgcXVvdGFCbG9ja2VkU2xvdFNlY29uZHM6IG51bWJlcjtcbiAgICB9XG4gID47XG59XG5mdW5jdGlvbiBwb2xpY3lLZXkocG9saWN5OiBBbGxvY2F0aW9uUG9saWN5KTogc3RyaW5nIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHsgLi4ucG9saWN5LCBhdXRvUm91dGluZzogZmFsc2UgfSk7XG59XG5mdW5jdGlvbiBvYmplY3QodmFsdWU6IHVua25vd24sIG5hbWU6IHN0cmluZyk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09IFwib2JqZWN0XCIgfHwgQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYHN1YnNjcmlwdGlvbl9hbGxvY2F0aW9uLiR7bmFtZX0gbXVzdCBiZSBhbiBvYmplY3RgKTtcbiAgfVxuICByZXR1cm4gdmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG59XG5mdW5jdGlvbiBwb3NpdGl2ZSh2YWx1ZTogdW5rbm93biwgbmFtZTogc3RyaW5nLCBmYWxsYmFjaz86IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IG51bWJlciA9IHZhbHVlID8/IGZhbGxiYWNrO1xuICBpZiAodHlwZW9mIG51bWJlciAhPT0gXCJudW1iZXJcIiB8fCAhTnVtYmVyLmlzRmluaXRlKG51bWJlcikgfHwgbnVtYmVyIDw9IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYHN1YnNjcmlwdGlvbl9hbGxvY2F0aW9uLiR7bmFtZX0gbXVzdCBiZSBwb3NpdGl2ZWApO1xuICB9XG4gIHJldHVybiBudW1iZXI7XG59XG5mdW5jdGlvbiBjb3VudCh2YWx1ZTogdW5rbm93biwgbmFtZTogc3RyaW5nLCBmYWxsYmFjaz86IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IG51bWJlciA9IHBvc2l0aXZlKHZhbHVlLCBuYW1lLCBmYWxsYmFjayk7XG4gIGlmICghTnVtYmVyLmlzSW50ZWdlcihudW1iZXIpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBzdWJzY3JpcHRpb25fYWxsb2NhdGlvbi4ke25hbWV9IG11c3QgYmUgYW4gaW50ZWdlcmApO1xuICB9XG4gIHJldHVybiBudW1iZXI7XG59XG5mdW5jdGlvbiBmcmFjdGlvbih2YWx1ZTogdW5rbm93biwgbmFtZTogc3RyaW5nLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbnVtYmVyID0gcG9zaXRpdmUodmFsdWUsIG5hbWUsIGZhbGxiYWNrKTtcbiAgaWYgKG51bWJlciA+PSAxKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBzdWJzY3JpcHRpb25fYWxsb2NhdGlvbi4ke25hbWV9IG11c3QgYmUgYmVsb3cgb25lYCk7XG4gIH1cbiAgcmV0dXJuIG51bWJlcjtcbn1cbmZ1bmN0aW9uIHRleHQodmFsdWU6IHVua25vd24sIG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwic3RyaW5nXCIgfHwgIXZhbHVlLnRyaW0oKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgc3Vic2NyaXB0aW9uX2FsbG9jYXRpb24uJHtuYW1lfSBtdXN0IGJlIG5vbi1lbXB0eSB0ZXh0YCk7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufVxuZnVuY3Rpb24ga2V5cyhcbiAgaW5wdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICBhbGxvd2VkOiByZWFkb25seSBzdHJpbmdbXSxcbik6IHZvaWQge1xuICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhpbnB1dCkpIHtcbiAgICBpZiAoIWFsbG93ZWQuaW5jbHVkZXMoa2V5KSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgc3Vic2NyaXB0aW9uX2FsbG9jYXRpb246IHVua25vd24ga2V5ICR7SlNPTi5zdHJpbmdpZnkoa2V5KX1gLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbn1cblxuLyoqIEZpbmFuY2lhbC9iaWxsaW5nIGZpZWxkcyBhcmUgZGVsaWJlcmF0ZWx5IG91dHNpZGUgdGhlIGFjY2VwdGVkIHNjaGVtYS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUFsbG9jYXRpb25Qb2xpY3koXG4gIHJhdzogdW5rbm93bixcbik6IEFsbG9jYXRpb25Qb2xpY3kgfCB1bmRlZmluZWQge1xuICBpZiAocmF3ID09PSB1bmRlZmluZWQpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IGlucHV0ID0gb2JqZWN0KHJhdywgXCJwb2xpY3lcIik7XG4gIGtleXMoaW5wdXQsIFtcbiAgICBcInNlZWRcIixcbiAgICBcImF1dG9fcm91dGluZ1wiLFxuICAgIFwibGVkZ2VyX3BhdGhzXCIsXG4gICAgXCJhcm1zXCIsXG4gICAgXCJwcm92aWRlcnNcIixcbiAgICBcImhvc3RzXCIsXG4gICAgXCJjb250cm9sX2Zsb29yXCIsXG4gICAgXCJleHBsb3JhdGlvbl9mbG9vclwiLFxuICAgIFwibWF4X3NoaWZ0XCIsXG4gICAgXCJtaW5fbWF0dXJlX21lcmdlZFwiLFxuICAgIFwibWluX2NsdXN0ZXJzXCIsXG4gICAgXCJtaW5fZGVjaXNpb25fc2Vjb25kc1wiLFxuICAgIFwibWF4X3Jldmlld19yYXRlXCIsXG4gICAgXCJtYXhfZmFpbHVyZV9yYXRlXCIsXG4gICAgXCJtYXhfcGVuZGluZ19mcmFjdGlvblwiLFxuICAgIFwibWF4X2xhdGVuY3lfaG91cnNcIixcbiAgICBcIm1pbl9yZWxhdGl2ZV9nYWluXCIsXG4gICAgXCJtYXhfaXNzdWVfY29zdF91c2RcIixcbiAgICBcIm1heF9jbHVzdGVyX2lzc3Vlc1wiLFxuICAgIFwiZXJyb3JfYnVkZ2V0XCIsXG4gICAgXCJ3aW5kb3dfZGF5c1wiLFxuICAgIFwiaG9yaXpvbl9kYXlzXCIsXG4gICAgXCJjYXBhY2l0eV9wYXRoXCIsXG4gIF0pO1xuICBpZiAoXG4gICAgaW5wdXQuYXV0b19yb3V0aW5nICE9PSB1bmRlZmluZWQgJiYgdHlwZW9mIGlucHV0LmF1dG9fcm91dGluZyAhPT0gXCJib29sZWFuXCJcbiAgKSB0aHJvdyBuZXcgRXJyb3IoXCJzdWJzY3JpcHRpb25fYWxsb2NhdGlvbi5hdXRvX3JvdXRpbmcgbXVzdCBiZSBib29sZWFuXCIpO1xuICBpZiAoIUFycmF5LmlzQXJyYXkoaW5wdXQuYXJtcykpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJzdWJzY3JpcHRpb25fYWxsb2NhdGlvbi5hcm1zIG11c3QgYmUgYW4gYXJyYXlcIik7XG4gIH1cbiAgY29uc3QgYXJtcyA9IGlucHV0LmFybXMubWFwKCh2YWx1ZSk6IEFsbG9jYXRpb25Bcm0gPT4ge1xuICAgIGNvbnN0IGFybSA9IG9iamVjdCh2YWx1ZSwgXCJhcm1cIik7XG4gICAga2V5cyhhcm0sIFtcbiAgICAgIFwiaWRcIixcbiAgICAgIFwibGFiZWxcIixcbiAgICAgIFwibWFuYWdlclwiLFxuICAgICAgXCJleGVjdXRvclwiLFxuICAgICAgXCJjb250cm9sXCIsXG4gICAgICBcIndlaWdodFwiLFxuICAgICAgXCJzdGF0dXNcIixcbiAgICAgIFwicmV2aWV3ZXJcIixcbiAgICBdKTtcbiAgICBjb25zdCByb2xlID0gKHZhbHVlOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBzZWxlY3RlZCA9IG9iamVjdCh2YWx1ZSwgXCJyb2xlXCIpO1xuICAgICAga2V5cyhzZWxlY3RlZCwgW1wicHJvdmlkZXJcIiwgXCJtb2RlbFwiXSk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBwcm92aWRlcjogdGV4dChzZWxlY3RlZC5wcm92aWRlciwgXCJwcm92aWRlclwiKSxcbiAgICAgICAgbW9kZWw6IHRleHQoc2VsZWN0ZWQubW9kZWwsIFwibW9kZWxcIiksXG4gICAgICB9O1xuICAgIH07XG4gICAgaWYgKFxuICAgICAgdHlwZW9mIGFybS5jb250cm9sICE9PSBcImJvb2xlYW5cIiB8fFxuICAgICAgIVtcImFjdGl2ZVwiLCBcImF3YWl0aW5nLWZlYXNpYmlsaXR5XCJdLmluY2x1ZGVzKFN0cmluZyhhcm0uc3RhdHVzKSlcbiAgICApIHRocm93IG5ldyBFcnJvcihcInN1YnNjcmlwdGlvbl9hbGxvY2F0aW9uIGFybSBjb250cm9sL3N0YXR1cyBpcyBpbnZhbGlkXCIpO1xuICAgIHJldHVybiB7XG4gICAgICBpZDogdGV4dChhcm0uaWQsIFwiaWRcIiksXG4gICAgICBsYWJlbDogdGV4dChhcm0ubGFiZWwsIFwibGFiZWxcIiksXG4gICAgICBjb250cm9sOiBhcm0uY29udHJvbCxcbiAgICAgIG1hbmFnZXI6IHJvbGUoYXJtLm1hbmFnZXIpLFxuICAgICAgZXhlY3V0b3I6IHJvbGUoYXJtLmV4ZWN1dG9yKSxcbiAgICAgIHJldmlld2VyOiBhcm0ucmV2aWV3ZXIgPT09IHVuZGVmaW5lZFxuICAgICAgICA/IHsgcHJvdmlkZXI6IFwiY2xhdWRlXCIsIG1vZGVsOiBcIm9wdXNcIiB9XG4gICAgICAgIDogcm9sZShhcm0ucmV2aWV3ZXIpLFxuICAgICAgd2VpZ2h0OiBwb3NpdGl2ZShhcm0ud2VpZ2h0LCBcIndlaWdodFwiLCAxKSxcbiAgICAgIHN0YXR1czogYXJtLnN0YXR1cyBhcyBFeHBlcmltZW50QXJtW1wic3RhdHVzXCJdLFxuICAgIH07XG4gIH0pO1xuICB2YWxpZGF0ZUV4cGVyaW1lbnRBcm1zKGFybXMpO1xuICBjb25zdCBjb250cm9sID0gYXJtcy5maW5kKChhcm0pID0+IGFybS5jb250cm9sKSE7XG4gIGlmIChcbiAgICBjb250cm9sLm1hbmFnZXIucHJvdmlkZXIgIT09IFwiY2xhdWRlXCIgfHxcbiAgICBjb250cm9sLm1hbmFnZXIubW9kZWwgIT09IFwic29ubmV0XCIgfHxcbiAgICBjb250cm9sLmV4ZWN1dG9yLnByb3ZpZGVyICE9PSBcImNsYXVkZVwiIHx8IGNvbnRyb2wuZXhlY3V0b3IubW9kZWwgIT09IFwiaGFpa3VcIlxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcInN1YnNjcmlwdGlvbl9hbGxvY2F0aW9uIGNvbnRyb2wgbXVzdCBwcmVzZXJ2ZSBTb25uZXQgbWFuYWdlciAvIEhhaWt1IGV4ZWN1dG9yXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBwcm92aWRlcnMgPSBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgT2JqZWN0LmVudHJpZXMob2JqZWN0KGlucHV0LnByb3ZpZGVycywgXCJwcm92aWRlcnNcIikpLm1hcCgoW2lkLCB2YWx1ZV0pID0+IHtcbiAgICAgIGlmICghYWdlbnRQcm92aWRlckJ5SWQoaWQpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBcInN1YnNjcmlwdGlvbl9hbGxvY2F0aW9uIHByb3ZpZGVyIG11c3QgbmFtZSBhIHJlZ2lzdGVyZWQgYWRhcHRlclwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgZW50cnkgPSBvYmplY3QodmFsdWUsIFwicHJvdmlkZXJcIik7XG4gICAgICBrZXlzKGVudHJ5LCBbXCJlc3RpbWF0ZWRfYnVkZ2V0X3VzZFwiLCBcIm1heF9wYXJhbGxlbGlzbVwiXSk7XG4gICAgICByZXR1cm4gW2lkLCB7XG4gICAgICAgIGVzdGltYXRlZEJ1ZGdldFVzZDogcG9zaXRpdmUoXG4gICAgICAgICAgZW50cnkuZXN0aW1hdGVkX2J1ZGdldF91c2QsXG4gICAgICAgICAgXCJlc3RpbWF0ZWRfYnVkZ2V0X3VzZFwiLFxuICAgICAgICApLFxuICAgICAgICBtYXhQYXJhbGxlbGlzbTogY291bnQoZW50cnkubWF4X3BhcmFsbGVsaXNtLCBcIm1heF9wYXJhbGxlbGlzbVwiKSxcbiAgICAgIH1dO1xuICAgIH0pLFxuICApO1xuICBjb25zdCBob3N0cyA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICBPYmplY3QuZW50cmllcyhvYmplY3QoaW5wdXQuaG9zdHMsIFwiaG9zdHNcIikpLm1hcCgoW2lkLCB2YWx1ZV0pID0+IHtcbiAgICAgIGNvbnN0IGhvc3QgPSBvYmplY3QodmFsdWUsIFwiaG9zdFwiKTtcbiAgICAgIGtleXMoaG9zdCwgW1wicHJvdmlkZXJzXCIsIFwiY2FwYWNpdHlcIiwgXCJ3ZWlnaHRcIl0pO1xuICAgICAgaWYgKFxuICAgICAgICAhQXJyYXkuaXNBcnJheShob3N0LnByb3ZpZGVycykgfHwgaG9zdC5wcm92aWRlcnMubGVuZ3RoID09PSAwIHx8XG4gICAgICAgIGhvc3QucHJvdmlkZXJzLnNvbWUoKGlkKSA9PlxuICAgICAgICAgIHR5cGVvZiBpZCAhPT0gXCJzdHJpbmdcIiB8fCAhT2JqZWN0Lmhhc093bihwcm92aWRlcnMsIGlkKVxuICAgICAgICApXG4gICAgICApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwic3Vic2NyaXB0aW9uX2FsbG9jYXRpb24gaG9zdCBwcm92aWRlcnMgbXVzdCBuYW1lIGNvbmZpZ3VyZWQgYnVkZ2V0c1wiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcmV0dXJuIFtpZCwge1xuICAgICAgICBwcm92aWRlcnM6IFsuLi5uZXcgU2V0KGhvc3QucHJvdmlkZXJzKV0gYXMgc3RyaW5nW10sXG4gICAgICAgIGNhcGFjaXR5OiBjb3VudChob3N0LmNhcGFjaXR5LCBcImNhcGFjaXR5XCIpLFxuICAgICAgICB3ZWlnaHQ6IHBvc2l0aXZlKGhvc3Qud2VpZ2h0LCBcIndlaWdodFwiLCAxKSxcbiAgICAgIH1dO1xuICAgIH0pLFxuICApO1xuICBpZiAoT2JqZWN0LmtleXMoaG9zdHMpLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcInN1YnNjcmlwdGlvbl9hbGxvY2F0aW9uIG5lZWRzIGEgaG9zdCBhc3NpZ25tZW50XCIpO1xuICB9XG4gIGZvciAoY29uc3QgW2lkLCBwcm92aWRlcl0gb2YgT2JqZWN0LmVudHJpZXMocHJvdmlkZXJzKSkge1xuICAgIGNvbnN0IHJlc2VydmVkID0gT2JqZWN0LnZhbHVlcyhob3N0cykuZmlsdGVyKChob3N0KSA9PlxuICAgICAgaG9zdC5wcm92aWRlcnMuaW5jbHVkZXMoaWQpXG4gICAgKS5yZWR1Y2UoKHN1bSwgaG9zdCkgPT4gc3VtICsgaG9zdC5jYXBhY2l0eSwgMCk7XG4gICAgaWYgKHJlc2VydmVkID4gcHJvdmlkZXIubWF4UGFyYWxsZWxpc20pIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYHN1YnNjcmlwdGlvbl9hbGxvY2F0aW9uIGhvc3QgY2FwYWNpdGllcyBleGNlZWQgJHtpZH0gbWF4X3BhcmFsbGVsaXNtYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIGZvciAoY29uc3QgYXJtIG9mIGFybXMpIHtcbiAgICBmb3IgKGNvbnN0IHJvbGUgb2YgW2FybS5tYW5hZ2VyLCBhcm0uZXhlY3V0b3IsIGFybS5yZXZpZXdlcl0pIHtcbiAgICAgIGlmIChcbiAgICAgICAgIU9iamVjdC5oYXNPd24ocHJvdmlkZXJzLCByb2xlLnByb3ZpZGVyKSB8fFxuICAgICAgICAhYWdlbnRQcm92aWRlckJ5SWQocm9sZS5wcm92aWRlcikgfHwgaXNFeGNsdWRlZE1vZGVsKHJvbGUubW9kZWwpXG4gICAgICApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwic3Vic2NyaXB0aW9uX2FsbG9jYXRpb24gcm9sZSBoYXMgbm8gcHJvdmlkZXIgYnVkZ2V0IG9yIHVzZXMgYW4gZXhjbHVkZWQgbW9kZWxcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgaWYgKCFBcnJheS5pc0FycmF5KGlucHV0LmxlZGdlcl9wYXRocykgfHwgaW5wdXQubGVkZ2VyX3BhdGhzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwic3Vic2NyaXB0aW9uX2FsbG9jYXRpb24ubGVkZ2VyX3BhdGhzIG11c3QgbmFtZSBjb2xsZWN0ZWQgZXZpZGVuY2VcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IHBvbGljeTogQWxsb2NhdGlvblBvbGljeSA9IHtcbiAgICAuLi4oaW5wdXQuY2FwYWNpdHlfcGF0aCA9PT0gdW5kZWZpbmVkXG4gICAgICA/IHt9XG4gICAgICA6IHsgY2FwYWNpdHlQYXRoOiB0ZXh0KGlucHV0LmNhcGFjaXR5X3BhdGgsIFwiY2FwYWNpdHlfcGF0aFwiKSB9KSxcbiAgICBzZWVkOiB0ZXh0KGlucHV0LnNlZWQsIFwic2VlZFwiKSxcbiAgICBhdXRvUm91dGluZzogaW5wdXQuYXV0b19yb3V0aW5nID09PSB0cnVlLFxuICAgIGxlZGdlclBhdGhzOiBpbnB1dC5sZWRnZXJfcGF0aHMubWFwKCh2YWx1ZSkgPT4gdGV4dCh2YWx1ZSwgXCJsZWRnZXJfcGF0aHNcIikpLFxuICAgIGFybXMsXG4gICAgcHJvdmlkZXJzLFxuICAgIGhvc3RzLFxuICAgIGNvbnRyb2xGbG9vcjogZnJhY3Rpb24oaW5wdXQuY29udHJvbF9mbG9vciwgXCJjb250cm9sX2Zsb29yXCIsIDAuMiksXG4gICAgZXhwbG9yYXRpb25GbG9vcjogZnJhY3Rpb24oXG4gICAgICBpbnB1dC5leHBsb3JhdGlvbl9mbG9vcixcbiAgICAgIFwiZXhwbG9yYXRpb25fZmxvb3JcIixcbiAgICAgIDAuMSxcbiAgICApLFxuICAgIG1heFNoaWZ0OiBmcmFjdGlvbihpbnB1dC5tYXhfc2hpZnQsIFwibWF4X3NoaWZ0XCIsIDAuMDUpLFxuICAgIG1pbk1hdHVyZU1lcmdlZDogY291bnQoaW5wdXQubWluX21hdHVyZV9tZXJnZWQsIFwibWluX21hdHVyZV9tZXJnZWRcIiwgMzApLFxuICAgIG1pbkNsdXN0ZXJzOiBjb3VudChpbnB1dC5taW5fY2x1c3RlcnMsIFwibWluX2NsdXN0ZXJzXCIsIDEwKSxcbiAgICBtaW5EZWNpc2lvblNlY29uZHM6IHBvc2l0aXZlKFxuICAgICAgaW5wdXQubWluX2RlY2lzaW9uX3NlY29uZHMsXG4gICAgICBcIm1pbl9kZWNpc2lvbl9zZWNvbmRzXCIsXG4gICAgICA5MDAsXG4gICAgKSxcbiAgICBtYXhSZXZpZXdSYXRlOiBmcmFjdGlvbihpbnB1dC5tYXhfcmV2aWV3X3JhdGUsIFwibWF4X3Jldmlld19yYXRlXCIsIDAuMiksXG4gICAgbWF4RmFpbHVyZVJhdGU6IGZyYWN0aW9uKGlucHV0Lm1heF9mYWlsdXJlX3JhdGUsIFwibWF4X2ZhaWx1cmVfcmF0ZVwiLCAwLjI1KSxcbiAgICBtYXhQZW5kaW5nRnJhY3Rpb246IGZyYWN0aW9uKFxuICAgICAgaW5wdXQubWF4X3BlbmRpbmdfZnJhY3Rpb24sXG4gICAgICBcIm1heF9wZW5kaW5nX2ZyYWN0aW9uXCIsXG4gICAgICAwLjUsXG4gICAgKSxcbiAgICBtYXhMYXRlbmN5SG91cnM6IHBvc2l0aXZlKGlucHV0Lm1heF9sYXRlbmN5X2hvdXJzLCBcIm1heF9sYXRlbmN5X2hvdXJzXCIsIDcyKSxcbiAgICBtaW5SZWxhdGl2ZUdhaW46IGZyYWN0aW9uKFxuICAgICAgaW5wdXQubWluX3JlbGF0aXZlX2dhaW4sXG4gICAgICBcIm1pbl9yZWxhdGl2ZV9nYWluXCIsXG4gICAgICAwLjEsXG4gICAgKSxcbiAgICBtYXhJc3N1ZUNvc3RVc2Q6IHBvc2l0aXZlKFxuICAgICAgaW5wdXQubWF4X2lzc3VlX2Nvc3RfdXNkLFxuICAgICAgXCJtYXhfaXNzdWVfY29zdF91c2RcIixcbiAgICAgIDEwLFxuICAgICksXG4gICAgbWF4Q2x1c3Rlcklzc3VlczogY291bnQoaW5wdXQubWF4X2NsdXN0ZXJfaXNzdWVzLCBcIm1heF9jbHVzdGVyX2lzc3Vlc1wiLCAyNCksXG4gICAgZXJyb3JCdWRnZXQ6IGZyYWN0aW9uKGlucHV0LmVycm9yX2J1ZGdldCwgXCJlcnJvcl9idWRnZXRcIiwgMC4wMSksXG4gICAgd2luZG93RGF5czogcG9zaXRpdmUoaW5wdXQud2luZG93X2RheXMsIFwid2luZG93X2RheXNcIiwgMzApLFxuICAgIGhvcml6b25EYXlzOiBwb3NpdGl2ZShpbnB1dC5ob3Jpem9uX2RheXMsIFwiaG9yaXpvbl9kYXlzXCIsIDEpLFxuICB9O1xuICBpZiAoXG4gICAgcG9saWN5Lm1heFNoaWZ0ID4gMC4xIHx8XG4gICAgcG9saWN5LmNvbnRyb2xGbG9vciArXG4gICAgICAgICAgcG9saWN5LmV4cGxvcmF0aW9uRmxvb3IgKlxuICAgICAgICAgICAgKGFybXMuZmlsdGVyKChhcm0pID0+IGFybS5zdGF0dXMgPT09IFwiYWN0aXZlXCIpLmxlbmd0aCAtIDEpID49IDFcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJzdWJzY3JpcHRpb25fYWxsb2NhdGlvbiBmbG9vcnMgb3IgbWF4X3NoaWZ0IHdvdWxkIHJlbW92ZSBzdGFibGUgZXhwbG9yYXRpb25cIixcbiAgICApO1xuICB9XG4gIGlmIChwb2xpY3kuaG9yaXpvbkRheXMgPj0gcG9saWN5LndpbmRvd0RheXMpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcInN1YnNjcmlwdGlvbl9hbGxvY2F0aW9uIGhvcml6b24gbXVzdCBiZSBzaG9ydGVyIHRoYW4gaXRzIHJlcG9ydGluZyB3aW5kb3dcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IGluaXRpYWwgPSBpbml0aWFsQWxsb2NhdGlvblN0YXRlKHBvbGljeSk7XG4gIGZvciAoY29uc3QgYXJtIG9mIGFybXMuZmlsdGVyKChhcm0pID0+IGFybS5zdGF0dXMgPT09IFwiYWN0aXZlXCIpKSB7XG4gICAgaWYgKFxuICAgICAgaW5pdGlhbC53ZWlnaHRzW2FybS5pZF0hIDxcbiAgICAgICAgKGFybS5jb250cm9sID8gcG9saWN5LmNvbnRyb2xGbG9vciA6IHBvbGljeS5leHBsb3JhdGlvbkZsb29yKVxuICAgICkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcInN1YnNjcmlwdGlvbl9hbGxvY2F0aW9uIGluaXRpYWwgd2VpZ2h0cyB2aW9sYXRlIGV4cGxvcmF0aW9uIGZsb29yc1wiLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHBvbGljeTtcbn1cbmV4cG9ydCBmdW5jdGlvbiBpbml0aWFsQWxsb2NhdGlvblN0YXRlKFxuICBwb2xpY3k6IEFsbG9jYXRpb25Qb2xpY3ksXG4pOiBBbGxvY2F0aW9uU3RhdGUge1xuICBjb25zdCBhY3RpdmUgPSBwb2xpY3kuYXJtcy5maWx0ZXIoKGFybSkgPT4gYXJtLnN0YXR1cyA9PT0gXCJhY3RpdmVcIik7XG4gIGNvbnN0IHRvdGFsID0gYWN0aXZlLnJlZHVjZSgoc3VtLCBhcm0pID0+IHN1bSArIGFybS53ZWlnaHQsIDApO1xuICBjb25zdCB3ZWlnaHRzID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgIGFjdGl2ZS5tYXAoKGFybSkgPT4gW2FybS5pZCwgYXJtLndlaWdodCAvIHRvdGFsXSksXG4gICk7XG4gIHJldHVybiB7XG4gICAgdmVyc2lvbjogMSxcbiAgICBwb2xpY3lLZXk6IHBvbGljeUtleShwb2xpY3kpLFxuICAgIHdlaWdodHMsXG4gICAgYmFzZWxpbmVXZWlnaHRzOiB7IC4uLndlaWdodHMgfSxcbiAgICBwYXVzZWQ6IGZhbHNlLFxuICAgIGRyeVJ1bkF0OiBudWxsLFxuICAgIGRlY2lzaW9uQ291bnQ6IDAsXG4gICAgbGFzdERlY2lzaW9uQXQ6IDAsXG4gICAgZXZpZGVuY2VLZXk6IFwiXCIsXG4gIH07XG59XG4vKiogUmVqZWN0IG9sZCBvciBtaXNtYXRjaGVkIHBlcnNpc3RlZCBzdGF0ZTsgbmV2ZXIgc2lsZW50bHkgcmVzZXQgYSBydW5uaW5nIHRyaWFsLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlQWxsb2NhdGlvblN0YXRlKFxuICBwb2xpY3k6IEFsbG9jYXRpb25Qb2xpY3ksXG4gIHJhdzogdW5rbm93bixcbik6IEFsbG9jYXRpb25TdGF0ZSB7XG4gIGNvbnN0IHJlY29yZCA9IG9iamVjdChyYXcsIFwic3RhdGVcIik7XG4gIGtleXMocmVjb3JkLCBbXG4gICAgXCJ2ZXJzaW9uXCIsXG4gICAgXCJwb2xpY3lLZXlcIixcbiAgICBcIndlaWdodHNcIixcbiAgICBcImJhc2VsaW5lV2VpZ2h0c1wiLFxuICAgIFwicGF1c2VkXCIsXG4gICAgXCJkcnlSdW5BdFwiLFxuICAgIFwiZGVjaXNpb25Db3VudFwiLFxuICAgIFwibGFzdERlY2lzaW9uQXRcIixcbiAgICBcImV2aWRlbmNlS2V5XCIsXG4gIF0pO1xuICBjb25zdCB2YWx1ZSA9IHJlY29yZCBhcyB1bmtub3duIGFzIEFsbG9jYXRpb25TdGF0ZTtcbiAgaWYgKFxuICAgIHZhbHVlLnZlcnNpb24gIT09IDEgfHwgdmFsdWUucG9saWN5S2V5ICE9PSBwb2xpY3lLZXkocG9saWN5KSB8fFxuICAgIHR5cGVvZiB2YWx1ZS5wYXVzZWQgIT09IFwiYm9vbGVhblwiIHx8XG4gICAgIU51bWJlci5pc1NhZmVJbnRlZ2VyKHZhbHVlLmRlY2lzaW9uQ291bnQpIHx8IHZhbHVlLmRlY2lzaW9uQ291bnQgPCAwIHx8XG4gICAgIU51bWJlci5pc0Zpbml0ZSh2YWx1ZS5sYXN0RGVjaXNpb25BdCkgfHxcbiAgICB0eXBlb2YgdmFsdWUuZXZpZGVuY2VLZXkgIT09IFwic3RyaW5nXCIgfHxcbiAgICAodmFsdWUuZHJ5UnVuQXQgIT09IG51bGwgJiYgIU51bWJlci5pc0Zpbml0ZShEYXRlLnBhcnNlKHZhbHVlLmRyeVJ1bkF0KSkpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwic3Vic2NyaXB0aW9uX2FsbG9jYXRpb24gc3RhdGUgc2NoZW1hIG9yIHBvbGljeSBkb2VzIG5vdCBtYXRjaDsgcmV2aWV3IGFuZCByZXNldCBleHBsaWNpdGx5XCIsXG4gICAgKTtcbiAgfVxuICBmb3IgKGNvbnN0IHdlaWdodHMgb2YgW3ZhbHVlLndlaWdodHMsIHZhbHVlLmJhc2VsaW5lV2VpZ2h0c10pIHtcbiAgICBjb25zdCBlbnRyaWVzID0gT2JqZWN0LmVudHJpZXMob2JqZWN0KHdlaWdodHMsIFwid2VpZ2h0c1wiKSk7XG4gICAgY29uc3QgYWN0aXZlID0gcG9saWN5LmFybXMuZmlsdGVyKChhcm0pID0+IGFybS5zdGF0dXMgPT09IFwiYWN0aXZlXCIpO1xuICAgIGlmIChcbiAgICAgIGVudHJpZXMubGVuZ3RoICE9PSBhY3RpdmUubGVuZ3RoIHx8IGFjdGl2ZS5zb21lKChhcm0pID0+XG4gICAgICAgIHR5cGVvZiB3ZWlnaHRzW2FybS5pZF0gIT09IFwibnVtYmVyXCIgfHxcbiAgICAgICAgIU51bWJlci5pc0Zpbml0ZSh3ZWlnaHRzW2FybS5pZF0pIHx8XG4gICAgICAgIHdlaWdodHNbYXJtLmlkXSEgPFxuICAgICAgICAgIChhcm0uY29udHJvbCA/IHBvbGljeS5jb250cm9sRmxvb3IgOiBwb2xpY3kuZXhwbG9yYXRpb25GbG9vcilcbiAgICAgICkgfHwgTWF0aC5hYnMoXG4gICAgICAgICAgZW50cmllcy5yZWR1Y2UoKHN1bSwgWywgbnVtYmVyXSkgPT5cbiAgICAgICAgICAgIHN1bSArIE51bWJlcihudW1iZXIpLCAwKSAtIDEsXG4gICAgICAgICkgPiAxZS04XG4gICAgKSB0aHJvdyBuZXcgRXJyb3IoXCJzdWJzY3JpcHRpb25fYWxsb2NhdGlvbiBzdGF0ZSB3ZWlnaHRzIGFyZSBpbnZhbGlkXCIpO1xuICB9XG4gIHJldHVybiB2YWx1ZTtcbn1cbi8qKiBFbXBpcmljYWwgQmVybnN0ZWluIGludGVydmFsIHdpdGggZXJyb3Igc3BlbnQgb3ZlciBkZWNpc2lvbiBhbmQgc2FtcGxlIGNvdW50cy4gKi9cbmZ1bmN0aW9uIG1lYW5JbnRlcnZhbCh2YWx1ZXM6IG51bWJlcltdLCBkZWx0YTogbnVtYmVyKTogSW50ZXJ2YWwge1xuICBjb25zdCBuID0gdmFsdWVzLmxlbmd0aDtcbiAgY29uc3QgbWVhbiA9IHZhbHVlcy5yZWR1Y2UoKHN1bSwgdmFsdWUpID0+IHN1bSArIHZhbHVlLCAwKSAvIG47XG4gIGNvbnN0IHZhcmlhbmNlID0gbiA+IDFcbiAgICA/IHZhbHVlcy5yZWR1Y2UoKHN1bSwgdmFsdWUpID0+IHN1bSArICh2YWx1ZSAtIG1lYW4pICoqIDIsIDApIC8gKG4gLSAxKVxuICAgIDogMTtcbiAgY29uc3QgbG9nID0gTWF0aC5sb2coMyAvIGRlbHRhKTtcbiAgY29uc3QgcmFkaXVzID0gTWF0aC5zcXJ0KDIgKiB2YXJpYW5jZSAqIGxvZyAvIG4pICsgMyAqIGxvZyAvIG47XG4gIHJldHVybiB7IGxvdzogTWF0aC5tYXgoMCwgbWVhbiAtIHJhZGl1cyksIGhpZ2g6IE1hdGgubWluKDEsIG1lYW4gKyByYWRpdXMpIH07XG59XG5mdW5jdGlvbiBpbnRlcnZhbEZvcihcbiAgcmVjb3JkczogQXNzaWdubWVudFJlY29yZFtdLFxuICBwb2xpY3k6IEFsbG9jYXRpb25Qb2xpY3ksXG4gIGxvb2s6IG51bWJlcixcbiAgYXJtczogbnVtYmVyLFxuICB0aW1lOiBudW1iZXIsXG4pOiB7IGludGVydmFsOiBJbnRlcnZhbDsgY2x1c3RlcnM6IG51bWJlciB9IHwgbnVsbCB7XG4gIGNvbnN0IGdyb3VwcyA9IG5ldyBNYXA8c3RyaW5nLCBBc3NpZ25tZW50UmVjb3JkW10+KCk7XG4gIGZvciAoY29uc3QgcmVjb3JkIG9mIHJlY29yZHMpIHtcbiAgICBjb25zdCBrZXkgPSBgJHtyZWNvcmQuaG9zdHMuam9pbihcIixcIil9OiR7cmVjb3JkLmFzc2lnbmVkQXQuc2xpY2UoMCwgMTApfWA7XG4gICAgY29uc3QgZ3JvdXAgPSBncm91cHMuZ2V0KGtleSkgPz8gW107XG4gICAgZ3JvdXAucHVzaChyZWNvcmQpO1xuICAgIGdyb3Vwcy5zZXQoa2V5LCBncm91cCk7XG4gIH1cbiAgY29uc3QgY2x1c3RlcnMgPSBbLi4uZ3JvdXBzLnZhbHVlcygpXTtcbiAgaWYgKFxuICAgIGNsdXN0ZXJzLmxlbmd0aCA8IHBvbGljeS5taW5DbHVzdGVycyB8fFxuICAgIGNsdXN0ZXJzLnNvbWUoKGdyb3VwKSA9PlxuICAgICAgZ3JvdXAubGVuZ3RoID4gcG9saWN5Lm1heENsdXN0ZXJJc3N1ZXMgfHxcbiAgICAgIGdyb3VwLnNvbWUoKHJlY29yZCkgPT4gcmVjb3JkLmNvc3RVc2QgPiBwb2xpY3kubWF4SXNzdWVDb3N0VXNkKVxuICAgIClcbiAgKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZGVsdGEgPSBwb2xpY3kuZXJyb3JCdWRnZXQgL1xuICAgIChhcm1zICogMiAqIChsb29rICsgMSkgKiAobG9vayArIDIpICogY2x1c3RlcnMubGVuZ3RoICpcbiAgICAgIChjbHVzdGVycy5sZW5ndGggKyAxKSAqICh0aW1lICsgMSkgKiAodGltZSArIDIpKTtcbiAgY29uc3QgcmV3YXJkID0gbWVhbkludGVydmFsKFxuICAgIGNsdXN0ZXJzLm1hcCgoZ3JvdXApID0+XG4gICAgICBncm91cC5maWx0ZXIoKHJlY29yZCkgPT4gcmVjb3JkLnN0YXR1cyA9PT0gXCJtZXJnZWRcIikubGVuZ3RoIC9cbiAgICAgIHBvbGljeS5tYXhDbHVzdGVySXNzdWVzXG4gICAgKSxcbiAgICBkZWx0YSxcbiAgKTtcbiAgY29uc3QgY29zdCA9IG1lYW5JbnRlcnZhbChcbiAgICBjbHVzdGVycy5tYXAoKGdyb3VwKSA9PlxuICAgICAgZ3JvdXAucmVkdWNlKChzdW0sIHJlY29yZCkgPT4gc3VtICsgcmVjb3JkLmNvc3RVc2QsIDApIC9cbiAgICAgIChwb2xpY3kubWF4Q2x1c3Rlcklzc3VlcyAqIHBvbGljeS5tYXhJc3N1ZUNvc3RVc2QpXG4gICAgKSxcbiAgICBkZWx0YSxcbiAgKTtcbiAgcmV0dXJuIHtcbiAgICBjbHVzdGVyczogY2x1c3RlcnMubGVuZ3RoLFxuICAgIGludGVydmFsOiB7XG4gICAgICBsb3c6IHJld2FyZC5sb3cgLyAoY29zdC5oaWdoICogcG9saWN5Lm1heElzc3VlQ29zdFVzZCksXG4gICAgICBoaWdoOiBjb3N0LmxvdyA+IDBcbiAgICAgICAgPyByZXdhcmQuaGlnaCAvIChjb3N0LmxvdyAqIHBvbGljeS5tYXhJc3N1ZUNvc3RVc2QpXG4gICAgICAgIDogSW5maW5pdHksXG4gICAgfSxcbiAgfTtcbn1cbi8qKiBNYXR1cmUgb3V0Y29tZXMgYW5kIGFsbCBvYnNlcnZlZCBhdHRlbXB0cyBpbmZvcm0gYm91bmRlZCwgcmV2ZXJzaWJsZSB3ZWlnaHQgY2hhbmdlcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWNvbW1lbmRBbGxvY2F0aW9uKFxuICBwb2xpY3k6IEFsbG9jYXRpb25Qb2xpY3ksXG4gIGN1cnJlbnQ6IEFsbG9jYXRpb25TdGF0ZSxcbiAgcmVwb3J0OiBFeHBlcmltZW50UmVwb3J0LFxuICBjYXBhY2l0eT86IEFsbG9jYXRpb25DYXBhY2l0eUV2aWRlbmNlLFxuKTogQWxsb2NhdGlvblBsYW4ge1xuICBjb25zdCBzdGF0ZSA9IHZhbGlkYXRlQWxsb2NhdGlvblN0YXRlKHBvbGljeSwgc3RydWN0dXJlZENsb25lKGN1cnJlbnQpKTtcbiAgY29uc3Qgbm93ID0gRGF0ZS5wYXJzZShyZXBvcnQuZ2VuZXJhdGVkQXQpO1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZShub3cpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwic3Vic2NyaXB0aW9uX2FsbG9jYXRpb24gcmVwb3J0IHRpbWUgaXMgaW52YWxpZFwiKTtcbiAgfVxuICBjb25zdCBwbGFuOiBBbGxvY2F0aW9uUGxhbiA9IHtcbiAgICBhY3Rpb246IFwiaG9sZFwiLFxuICAgIHJlYXNvbjogXCJpbml0aWFsIHJhbmRvbWlzZWQgY29udHJvbCBwaGFzZTogaW5zdWZmaWNpZW50IG1hdHVyZSBldmlkZW5jZVwiLFxuICAgIHdlaWdodHM6IHsgLi4uc3RhdGUud2VpZ2h0cyB9LFxuICAgIGVmZmVjdGl2ZVNhbXBsZXM6IHt9LFxuICAgIG1hdHVyZU1lcmdlZDoge30sXG4gICAgbWV0cmljczoge30sXG4gICAgaW50ZXJ2YWxzOiB7fSxcbiAgICBuZXh0U3RhdGU6IHN0YXRlLFxuICB9O1xuICBjb25zdCBmaW5pc2ggPSAoXG4gICAgYWN0aW9uOiBBbGxvY2F0aW9uUGxhbltcImFjdGlvblwiXSxcbiAgICByZWFzb246IHN0cmluZyxcbiAgKTogQWxsb2NhdGlvblBsYW4gPT4ge1xuICAgIHBsYW4uYWN0aW9uID0gYWN0aW9uO1xuICAgIHBsYW4ucmVhc29uID0gcmVhc29uO1xuICAgIHN0YXRlLndlaWdodHMgPSB7IC4uLnBsYW4ud2VpZ2h0cyB9O1xuICAgIHJldHVybiBwbGFuO1xuICB9O1xuICBpZiAoc3RhdGUucGF1c2VkKSB7XG4gICAgcmV0dXJuIGZpbmlzaChcbiAgICAgIFwicGF1c2VkXCIsXG4gICAgICBcImFsbG9jYXRpb24gcmVtYWlucyBwYXVzZWQgdW50aWwgZXhwbGljaXQgb3BlcmF0b3IgcmVzZXRcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IGFjdGl2ZSA9IHBvbGljeS5hcm1zLmZpbHRlcigoYXJtKSA9PiBhcm0uc3RhdHVzID09PSBcImFjdGl2ZVwiKTtcbiAgY29uc3QgcmVjb3JkcyA9IHJlcG9ydC5yZWNvcmRzLmZpbHRlcigocmVjb3JkKSA9PlxuICAgIGFjdGl2ZS5zb21lKChhcm0pID0+IGFybS5pZCA9PT0gcmVjb3JkLmNvaG9ydClcbiAgKTtcbiAgY29uc3QgbWF0dXJlID0gcmVjb3Jkcy5maWx0ZXIoKHJlY29yZCkgPT4gcmVjb3JkLm1hdHVyZSk7XG4gIGlmIChcbiAgICByZWNvcmRzLnNvbWUoKHJlY29yZCkgPT5cbiAgICAgIHJlY29yZC5yb2xlcyAmJiBbXCJtYW5hZ2VyXCIsIFwiZXhlY3V0b3JcIl0uc29tZSgocm9sZSkgPT4ge1xuICAgICAgICBjb25zdCBleHBlY3RlZCA9IHBvbGljeS5hcm1zLmZpbmQoKGFybSkgPT5cbiAgICAgICAgICBhcm0uaWQgPT09IHJlY29yZC5jb2hvcnRcbiAgICAgICAgKSFbcm9sZSBhcyBcIm1hbmFnZXJcIiB8IFwiZXhlY3V0b3JcIl07XG4gICAgICAgIGNvbnN0IG9ic2VydmVkID0gcmVjb3JkLnJvbGVzIS5maW5kKCh0cmVhdG1lbnQpID0+XG4gICAgICAgICAgdHJlYXRtZW50LnJvbGUgPT09IHJvbGVcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuICFvYnNlcnZlZCB8fCBvYnNlcnZlZC5wcm92aWRlciAhPT0gZXhwZWN0ZWQucHJvdmlkZXIgfHxcbiAgICAgICAgICBvYnNlcnZlZC5tb2RlbCAhPT0gZXhwZWN0ZWQubW9kZWw7XG4gICAgICB9KVxuICAgIClcbiAgKSB7XG4gICAgcmV0dXJuIGZpbmlzaChcbiAgICAgIFwiaG9sZFwiLFxuICAgICAgXCJyZWNvcmRlZCB0cmVhdG1lbnQgZGlmZmVycyBmcm9tIGl0cyBjb25maWd1cmVkIGFybTsgdXNlIGEgbmV3IGNvaG9ydCBJRCBmb3IgYSBjaGFuZ2VkIHRyZWF0bWVudFwiLFxuICAgICk7XG4gIH1cbiAgZm9yIChjb25zdCBhcm0gb2YgYWN0aXZlKSB7XG4gICAgY29uc3Qgc2FtcGxlID0gcmVjb3Jkcy5maWx0ZXIoKHJlY29yZCkgPT4gcmVjb3JkLmNvaG9ydCA9PT0gYXJtLmlkKS5zb3J0KChcbiAgICAgIGxlZnQsXG4gICAgICByaWdodCxcbiAgICApID0+XG4gICAgICBEYXRlLnBhcnNlKHJpZ2h0Lmxhc3RPYnNlcnZlZEF0ID8/IHJpZ2h0LmFzc2lnbmVkQXQpIC1cbiAgICAgIERhdGUucGFyc2UobGVmdC5sYXN0T2JzZXJ2ZWRBdCA/PyBsZWZ0LmFzc2lnbmVkQXQpXG4gICAgKS5zbGljZSgwLCBNYXRoLm1heCgxMCwgcG9saWN5Lm1pbk1hdHVyZU1lcmdlZCkpO1xuICAgIGNvbnN0IG1hdHVyZVNhbXBsZSA9IG1hdHVyZS5maWx0ZXIoKHJlY29yZCkgPT4gcmVjb3JkLmNvaG9ydCA9PT0gYXJtLmlkKTtcbiAgICBwbGFuLm1hdHVyZU1lcmdlZFthcm0uaWRdID0gbWF0dXJlU2FtcGxlLmZpbHRlcigocmVjb3JkKSA9PlxuICAgICAgcmVjb3JkLnN0YXR1cyA9PT0gXCJtZXJnZWRcIlxuICAgICkubGVuZ3RoO1xuICAgIHBsYW4uZWZmZWN0aXZlU2FtcGxlc1thcm0uaWRdID0gbmV3IFNldChtYXR1cmVTYW1wbGUubWFwKChyZWNvcmQpID0+XG4gICAgICBgJHtyZWNvcmQuaG9zdHMuam9pbihcIixcIil9OiR7cmVjb3JkLmFzc2lnbmVkQXQuc2xpY2UoMCwgMTApfWBcbiAgICApKS5zaXplO1xuICAgIGlmIChzYW1wbGUubGVuZ3RoID09PSAwKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgaW52b2NhdGlvbnMgPSBzYW1wbGUucmVkdWNlKFxuICAgICAgKHN1bSwgcmVjb3JkKSA9PlxuICAgICAgICBzdW0gKyByZWNvcmQuaW52b2NhdGlvbnMsXG4gICAgICAwLFxuICAgICk7XG4gICAgY29uc3QgcG9vclF1YWxpdHkgPSBzYW1wbGUucmVkdWNlKChzdW0sIHJlY29yZCkgPT5cbiAgICAgICAgICAgICAgc3VtICsgcmVjb3JkLnJldmlld1JlamVjdGlvbnMsIDApIC8gc2FtcGxlLmxlbmd0aCA+XG4gICAgICAgIHBvbGljeS5tYXhSZXZpZXdSYXRlIHx8IHNhbXBsZS5yZWR1Y2UoKHN1bSwgcmVjb3JkKSA9PlxuICAgICAgICAgICAgICBzdW0gKyByZWNvcmQuZ2F0ZUZhaWx1cmVzLCAwKSAvIHNhbXBsZS5sZW5ndGggPlxuICAgICAgICBwb2xpY3kubWF4RmFpbHVyZVJhdGU7XG4gICAgY29uc3QgdW5yZWxpYWJsZSA9IGludm9jYXRpb25zID4gMCAmJlxuICAgICAgc2FtcGxlLnJlZHVjZShcbiAgICAgICAgICAgICAgKHN1bSwgcmVjb3JkKSA9PlxuICAgICAgICAgICAgICAgIHN1bSArXG4gICAgICAgICAgICAgICAgTWF0aC5tYXgoXG4gICAgICAgICAgICAgICAgICByZWNvcmQuZmFpbGVkSW52b2NhdGlvbnMsXG4gICAgICAgICAgICAgICAgICByZWNvcmQucXVvdGFMaW1pdGVkSW52b2NhdGlvbnMsXG4gICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgMCxcbiAgICAgICAgICAgICkgLyBpbnZvY2F0aW9ucyA+IHBvbGljeS5tYXhGYWlsdXJlUmF0ZTtcbiAgICBpZiAocG9vclF1YWxpdHkgfHwgdW5yZWxpYWJsZSkge1xuICAgICAgcGxhbi53ZWlnaHRzID0geyAuLi5zdGF0ZS5iYXNlbGluZVdlaWdodHMgfTtcbiAgICAgIHN0YXRlLnBhdXNlZCA9IHRydWU7XG4gICAgICByZXR1cm4gZmluaXNoKFxuICAgICAgICBcInJvbGxiYWNrXCIsXG4gICAgICAgIGBxdWFsaXR5IG9yIHJlbGlhYmlsaXR5IHJlZ3Jlc3Npb24gaW4gJHthcm0uaWR9OyByZXN0b3JlZCBpbml0aWFsIHdlaWdodHMgYW5kIHBhdXNlZCByb3V0aW5nYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIGlmIChcbiAgICByZXBvcnQud2FybmluZ3Muc29tZSgod2FybmluZykgPT5cbiAgICAgIHdhcm5pbmcuY29kZSAhPT0gXCJsb3ctc2FtcGxlXCIgJiZcbiAgICAgICEod2FybmluZy5jb2RlID09PSBcInVuZXF1YWwtZXhwb3N1cmVcIiAmJlxuICAgICAgICBPYmplY3Qua2V5cyhzdGF0ZS53ZWlnaHRzKS5zb21lKChpZCkgPT5cbiAgICAgICAgICBNYXRoLmFicyhzdGF0ZS53ZWlnaHRzW2lkXSEgLSBzdGF0ZS5iYXNlbGluZVdlaWdodHNbaWRdISkgPiAxZS05XG4gICAgICAgICkpXG4gICAgKSB8fCByZWNvcmRzLnNvbWUoKHJlY29yZCkgPT5cbiAgICAgIHJlY29yZC5jb3N0VW5rbm93bkNvdW50ID4gMCB8fCByZWNvcmQudXNlc0V4Y2x1ZGVkTW9kZWxcbiAgICApXG4gICkge1xuICAgIHJldHVybiBmaW5pc2goXG4gICAgICBcImhvbGRcIixcbiAgICAgIFwiaW5jb21wbGV0ZSwgZXhjbHVkZWQgb3IgYmlhc2VkIGV2aWRlbmNlIHByZXZlbnRzIGFsbG9jYXRpb24gY2hhbmdlc1wiLFxuICAgICk7XG4gIH1cbiAgaWYgKFxuICAgIHJlY29yZHMubGVuZ3RoID4gMCAmJlxuICAgIHJlY29yZHMuZmlsdGVyKChyZWNvcmQpID0+IHJlY29yZC5jZW5zb3JlZCkubGVuZ3RoIC8gcmVjb3Jkcy5sZW5ndGggPlxuICAgICAgcG9saWN5Lm1heFBlbmRpbmdGcmFjdGlvblxuICApIHJldHVybiBmaW5pc2goXCJob2xkXCIsIFwicGVuZGluZy9jZW5zb3JlZCBleHBvc3VyZSBpcyB0b28gbGFyZ2VcIik7XG4gIGNvbnN0IGV2aWRlbmNlS2V5ID0gSlNPTi5zdHJpbmdpZnkoXG4gICAgcmVjb3Jkcy5tYXAoXG4gICAgICAocmVjb3JkKSA9PiBbXG4gICAgICAgIHJlY29yZC5hc3NpZ25tZW50SWQsXG4gICAgICAgIHJlY29yZC5jb2hvcnQsXG4gICAgICAgIHJlY29yZC5tYXR1cmUsXG4gICAgICAgIHJlY29yZC5zdGF0dXMsXG4gICAgICAgIHJlY29yZC5jb3N0VXNkLFxuICAgICAgICByZWNvcmQuaW52b2NhdGlvbnMsXG4gICAgICAgIHJlY29yZC5yZXZpZXdSZWplY3Rpb25zLFxuICAgICAgXSxcbiAgICApLFxuICApO1xuICBpZiAoXG4gICAgZXZpZGVuY2VLZXkgPT09IHN0YXRlLmV2aWRlbmNlS2V5IHx8XG4gICAgbm93IC0gc3RhdGUubGFzdERlY2lzaW9uQXQgPCBwb2xpY3kubWluRGVjaXNpb25TZWNvbmRzICogMTAwMFxuICApIHtcbiAgICByZXR1cm4gZmluaXNoKFxuICAgICAgXCJob2xkXCIsXG4gICAgICBcInVuY2hhbmdlZCBldmlkZW5jZSBvciBkZWNpc2lvbiBjYWRlbmNlOyB3ZWlnaHRzIHJldGFpbmVkXCIsXG4gICAgKTtcbiAgfVxuICBmb3IgKGNvbnN0IGFybSBvZiBhY3RpdmUpIHtcbiAgICBjb25zdCBzYW1wbGUgPSBtYXR1cmUuZmlsdGVyKChyZWNvcmQpID0+IHJlY29yZC5jb2hvcnQgPT09IGFybS5pZCk7XG4gICAgaWYgKFxuICAgICAgc2FtcGxlLmZpbHRlcigocmVjb3JkKSA9PiByZWNvcmQuc3RhdHVzID09PSBcIm1lcmdlZFwiKS5sZW5ndGggPFxuICAgICAgICBwb2xpY3kubWluTWF0dXJlTWVyZ2VkXG4gICAgKSByZXR1cm4gcGxhbjtcbiAgICBjb25zdCBib3VuZCA9IGludGVydmFsRm9yKFxuICAgICAgc2FtcGxlLFxuICAgICAgcG9saWN5LFxuICAgICAgc3RhdGUuZGVjaXNpb25Db3VudCxcbiAgICAgIGFjdGl2ZS5sZW5ndGgsXG4gICAgICBub3csXG4gICAgKTtcbiAgICBpZiAoIWJvdW5kKSB7XG4gICAgICByZXR1cm4gZmluaXNoKFxuICAgICAgICBcImhvbGRcIixcbiAgICAgICAgXCJpbnN1ZmZpY2llbnQgaW5kZXBlbmRlbnQgY2x1c3RlcnMgb3IgYW4gb2JzZXJ2YXRpb24gZXhjZWVkcyB0aGUgZGVjbGFyZWQgYm91bmRzXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBwbGFuLmVmZmVjdGl2ZVNhbXBsZXNbYXJtLmlkXSA9IGJvdW5kLmNsdXN0ZXJzO1xuICAgIHBsYW4uaW50ZXJ2YWxzW2FybS5pZF0gPSBib3VuZC5pbnRlcnZhbDtcbiAgfVxuICBjb25zdCBjb250cm9sID0gYWN0aXZlLmZpbmQoKGFybSkgPT4gYXJtLmNvbnRyb2wpITtcbiAgY29uc3QgY29udHJvbFJlY29yZHMgPSBtYXR1cmUuZmlsdGVyKChyZWNvcmQpID0+XG4gICAgcmVjb3JkLmNvaG9ydCA9PT0gY29udHJvbC5pZFxuICApO1xuICBjb25zdCBtZXJnZVJhdGUgPSAoc2FtcGxlOiBBc3NpZ25tZW50UmVjb3JkW10pID0+XG4gICAgc2FtcGxlLmZpbHRlcigocmVjb3JkKSA9PiByZWNvcmQuc3RhdHVzID09PSBcIm1lcmdlZFwiKS5sZW5ndGggL1xuICAgIHNhbXBsZS5sZW5ndGg7XG4gIGNvbnN0IGxhdGVuY3kgPSAoc2FtcGxlOiBBc3NpZ25tZW50UmVjb3JkW10pID0+IHtcbiAgICBjb25zdCBtZXJnZWQgPSBzYW1wbGUuZmlsdGVyKChyZWNvcmQpID0+IHJlY29yZC5zdGF0dXMgPT09IFwibWVyZ2VkXCIpO1xuICAgIHJldHVybiBtZXJnZWQucmVkdWNlKFxuICAgICAgKHN1bSwgcmVjb3JkKSA9PiBzdW0gKyAocmVjb3JkLnRpbWVUb01lcmdlSG91cnMgPz8gSW5maW5pdHkpLFxuICAgICAgMCxcbiAgICApIC8gbWVyZ2VkLmxlbmd0aDtcbiAgfTtcbiAgaWYgKFxuICAgICFjYXBhY2l0eSB8fCBjYXBhY2l0eS5jb3JyZWxhdGVkT3V0YWdlIHx8XG4gICAgIU51bWJlci5pc0Zpbml0ZShEYXRlLnBhcnNlKGNhcGFjaXR5Lm9ic2VydmVkQXQpKSB8fFxuICAgIERhdGUucGFyc2UoY2FwYWNpdHkub2JzZXJ2ZWRBdCkgPiBub3cgfHxcbiAgICBub3cgLSBEYXRlLnBhcnNlKGNhcGFjaXR5Lm9ic2VydmVkQXQpID4gM182MDBfMDAwIHx8IGFjdGl2ZS5zb21lKChhcm0pID0+IHtcbiAgICAgIGNvbnN0IG1ldHJpY3MgPSBjYXBhY2l0eS5hcm1zW2FybS5pZF07XG4gICAgICByZXR1cm4gIW1ldHJpY3MgfHwgIU51bWJlci5pc0Zpbml0ZShtZXRyaWNzLmhvc3REYXlzKSB8fFxuICAgICAgICBtZXRyaWNzLmhvc3REYXlzIDw9IDAgfHxcbiAgICAgICAgIU51bWJlci5pc0Zpbml0ZShtZXRyaWNzLmF2YWlsYWJsZVNsb3RTZWNvbmRzKSB8fFxuICAgICAgICBtZXRyaWNzLmF2YWlsYWJsZVNsb3RTZWNvbmRzIDw9IDAgfHxcbiAgICAgICAgIU51bWJlci5pc0Zpbml0ZShtZXRyaWNzLmlkbGVTbG90U2Vjb25kcykgfHxcbiAgICAgICAgbWV0cmljcy5pZGxlU2xvdFNlY29uZHMgPCAwIHx8XG4gICAgICAgICFOdW1iZXIuaXNGaW5pdGUobWV0cmljcy5xdW90YUJsb2NrZWRTbG90U2Vjb25kcykgfHxcbiAgICAgICAgbWV0cmljcy5xdW90YUJsb2NrZWRTbG90U2Vjb25kcyA8IDAgfHxcbiAgICAgICAgbWV0cmljcy5pZGxlU2xvdFNlY29uZHMgKyBtZXRyaWNzLnF1b3RhQmxvY2tlZFNsb3RTZWNvbmRzID5cbiAgICAgICAgICBtZXRyaWNzLmF2YWlsYWJsZVNsb3RTZWNvbmRzO1xuICAgIH0pXG4gICkge1xuICAgIHJldHVybiBmaW5pc2goXG4gICAgICBcImhvbGRcIixcbiAgICAgIFwiZnJlc2ggbWVhc3VyZWQgaG9zdC1kYXksIGlkbGUgYW5kIHF1b3RhIGV2aWRlbmNlIGlzIHJlcXVpcmVkOyBjb3JyZWxhdGVkIG91dGFnZXMgcGF1c2UgY29tcGFyaXNvbnNcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IGNhcGFjaXR5T2YgPSAoaWQ6IHN0cmluZykgPT4gY2FwYWNpdHkuYXJtc1tpZF0hO1xuICBjb25zdCB0aHJvdWdocHV0ID0gKGlkOiBzdHJpbmcpID0+XG4gICAgbWF0dXJlLmZpbHRlcigocmVjb3JkKSA9PlxuICAgICAgcmVjb3JkLmNvaG9ydCA9PT0gaWQgJiYgcmVjb3JkLnN0YXR1cyA9PT0gXCJtZXJnZWRcIlxuICAgICkubGVuZ3RoIC8gY2FwYWNpdHlPZihpZCkuaG9zdERheXM7XG4gIGNvbnN0IGlkbGUgPSAoaWQ6IHN0cmluZykgPT5cbiAgICBjYXBhY2l0eU9mKGlkKS5pZGxlU2xvdFNlY29uZHMgLyBjYXBhY2l0eU9mKGlkKS5hdmFpbGFibGVTbG90U2Vjb25kcztcbiAgY29uc3Qgc2F0dXJhdGVkID0gKGlkOiBzdHJpbmcpID0+XG4gICAgY2FwYWNpdHlPZihpZCkucXVvdGFCbG9ja2VkU2xvdFNlY29uZHMgL1xuICAgIGNhcGFjaXR5T2YoaWQpLmF2YWlsYWJsZVNsb3RTZWNvbmRzO1xuICBmb3IgKGNvbnN0IGFybSBvZiBhY3RpdmUpIHtcbiAgICBwbGFuLm1ldHJpY3NbYXJtLmlkXSA9IHtcbiAgICAgIG1lcmdlZFBlckhvc3REYXk6IHRocm91Z2hwdXQoYXJtLmlkKSxcbiAgICAgIGlkbGVGcmFjdGlvbjogaWRsZShhcm0uaWQpLFxuICAgICAgcXVvdGFTYXR1cmF0aW9uOiBzYXR1cmF0ZWQoYXJtLmlkKSxcbiAgICAgIG1lYW5Ib3Vyc1RvTWVyZ2U6IGxhdGVuY3koXG4gICAgICAgIG1hdHVyZS5maWx0ZXIoKHJlY29yZCkgPT4gcmVjb3JkLmNvaG9ydCA9PT0gYXJtLmlkKSxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuICBjb25zdCBjYW5kaWRhdGVzID0gYWN0aXZlLmZpbHRlcigoYXJtKSA9PlxuICAgICFhcm0uY29udHJvbCAmJlxuICAgIGFjdGl2ZS5ldmVyeSgob3RoZXIpID0+XG4gICAgICBvdGhlci5pZCA9PT0gYXJtLmlkIHx8XG4gICAgICBwbGFuLmludGVydmFsc1thcm0uaWRdIS5sb3cgPlxuICAgICAgICBwbGFuLmludGVydmFsc1tvdGhlci5pZF0hLmhpZ2ggKiAoMSArIHBvbGljeS5taW5SZWxhdGl2ZUdhaW4pXG4gICAgKVxuICApLmZpbHRlcigoYXJtKSA9PiB7XG4gICAgY29uc3Qgc2FtcGxlID0gbWF0dXJlLmZpbHRlcigocmVjb3JkKSA9PiByZWNvcmQuY29ob3J0ID09PSBhcm0uaWQpO1xuICAgIHJldHVybiB0aHJvdWdocHV0KGFybS5pZCkgPj0gdGhyb3VnaHB1dChjb250cm9sLmlkKSAmJlxuICAgICAgaWRsZShhcm0uaWQpIDw9IGlkbGUoY29udHJvbC5pZCkgKyAwLjA1ICYmXG4gICAgICBzYXR1cmF0ZWQoYXJtLmlkKSA8PSBwb2xpY3kubWF4RmFpbHVyZVJhdGUgJiZcbiAgICAgIG1lcmdlUmF0ZShzYW1wbGUpID49IG1lcmdlUmF0ZShjb250cm9sUmVjb3JkcykgLSAwLjA1ICYmXG4gICAgICBsYXRlbmN5KHNhbXBsZSkgPD0gcG9saWN5Lm1heExhdGVuY3lIb3VycyAmJlxuICAgICAgbGF0ZW5jeShzYW1wbGUpIDw9IGxhdGVuY3koY29udHJvbFJlY29yZHMpICogMS4yNTtcbiAgfSk7XG4gIHN0YXRlLmRlY2lzaW9uQ291bnQrKztcbiAgc3RhdGUubGFzdERlY2lzaW9uQXQgPSBub3c7XG4gIHN0YXRlLmV2aWRlbmNlS2V5ID0gZXZpZGVuY2VLZXk7XG4gIGlmIChjYW5kaWRhdGVzLmxlbmd0aCAhPT0gMSkge1xuICAgIHJldHVybiBmaW5pc2goXG4gICAgICBcImhvbGRcIixcbiAgICAgIFwidW5jZXJ0YWludHkgb3ZlcmxhcHMgb3IgdGhyb3VnaHB1dC9sYXRlbmN5IGd1YXJkcmFpbHMgcHJldmVudCBhIHNoaWZ0XCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCB3aW5uZXIgPSBjYW5kaWRhdGVzWzBdITtcbiAgbGV0IHJlbWFpbmluZyA9IHBvbGljeS5tYXhTaGlmdDtcbiAgZm9yIChjb25zdCBhcm0gb2YgYWN0aXZlLmZpbHRlcigoYXJtKSA9PiBhcm0uaWQgIT09IHdpbm5lci5pZCkpIHtcbiAgICBjb25zdCBmbG9vciA9IGFybS5jb250cm9sID8gcG9saWN5LmNvbnRyb2xGbG9vciA6IHBvbGljeS5leHBsb3JhdGlvbkZsb29yO1xuICAgIGNvbnN0IHRyYW5zZmVyID0gTWF0aC5taW4oXG4gICAgICByZW1haW5pbmcsXG4gICAgICBNYXRoLm1heCgwLCBwbGFuLndlaWdodHNbYXJtLmlkXSEgLSBmbG9vciksXG4gICAgKTtcbiAgICBpZiAodHJhbnNmZXIgPD0gMWUtMTIpIGNvbnRpbnVlO1xuICAgIHBsYW4ud2VpZ2h0c1thcm0uaWRdISAtPSB0cmFuc2ZlcjtcbiAgICBwbGFuLndlaWdodHNbd2lubmVyLmlkXSEgKz0gdHJhbnNmZXI7XG4gICAgcmVtYWluaW5nIC09IHRyYW5zZmVyO1xuICB9XG4gIGlmIChyZW1haW5pbmcgPT09IHBvbGljeS5tYXhTaGlmdCkge1xuICAgIHJldHVybiBmaW5pc2goXCJob2xkXCIsIFwiY29udHJvbCBhbmQgZXhwbG9yYXRpb24gZmxvb3JzIGFscmVhZHkgYmluZFwiKTtcbiAgfVxuICByZXR1cm4gZmluaXNoKFxuICAgIFwic2hpZnRcIixcbiAgICBgZ3JhZHVhbCBzaGlmdCB0b3dhcmQgJHt3aW5uZXIuaWR9OyBlc3RpbWF0ZWQgQVBJLWVxdWl2YWxlbnQgZWZmaWNpZW5jeSBpcyBzZXBhcmF0ZWQgdW5kZXIgdGhlIGRlY2xhcmVkIGNsdXN0ZXIgYXNzdW1wdGlvbnNgLFxuICApO1xufVxuLyoqIFJvdXRpbmcgaXMgYSBzZXBhcmF0ZSwgZXhwbGljaXQgb3B0LWluOyBidWRnZXRzIGFuZCBsaXZlIGNhcGFjaXR5IGFyZSBhZG1pc3Npb24gZ3VhcmRzLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNlbGVjdEFsbG9jYXRpb25Bcm0oXG4gIHBvbGljeTogQWxsb2NhdGlvblBvbGljeSxcbiAgc3RhdGU6IEFsbG9jYXRpb25TdGF0ZSxcbiAgcmVwbzogc3RyaW5nLFxuICBpc3N1ZTogbnVtYmVyLFxuICBob3N0SWQ6IHN0cmluZyxcbiAgc3RhdHVzZXM6IFJlY29yZDxzdHJpbmcsIEFsbG9jYXRpb25Qcm92aWRlclN0YXR1cz4sXG4pOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgaWYgKCFwb2xpY3kuYXV0b1JvdXRpbmcpIHJldHVybiBudWxsO1xuICB2YWxpZGF0ZUFsbG9jYXRpb25TdGF0ZShwb2xpY3ksIHN0YXRlKTtcbiAgaWYgKCFzdGF0ZS5kcnlSdW5BdCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwic3Vic2NyaXB0aW9uX2FsbG9jYXRpb24gcmVxdWlyZXMgYSByZWNvcmRlZCBkcnktcnVuIGJlZm9yZSBhdXRvbWF0aWMgcm91dGluZ1wiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgaG9zdCA9IHBvbGljeS5ob3N0c1tob3N0SWRdO1xuICBpZiAoIWhvc3QpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgc3Vic2NyaXB0aW9uX2FsbG9jYXRpb24gaGFzIG5vIGNhcGFjaXR5IGFzc2lnbm1lbnQgZm9yIGhvc3QgJHtcbiAgICAgICAgSlNPTi5zdHJpbmdpZnkoaG9zdElkKVxuICAgICAgfWAsXG4gICAgKTtcbiAgfVxuICBjb25zdCBlbGlnaWJsZSA9IChhcm06IEFsbG9jYXRpb25Bcm0pID0+XG4gICAgW2FybS5tYW5hZ2VyLCBhcm0uZXhlY3V0b3IsIGFybS5yZXZpZXdlcl0uZXZlcnkoKHJvbGUpID0+IHtcbiAgICAgIGNvbnN0IHN0YXR1cyA9IHN0YXR1c2VzW3JvbGUucHJvdmlkZXJdO1xuICAgICAgY29uc3QgYnVkZ2V0ID0gcG9saWN5LnByb3ZpZGVyc1tyb2xlLnByb3ZpZGVyXTtcbiAgICAgIGNvbnN0IHRvdGFsSG9zdFdlaWdodCA9IE9iamVjdC52YWx1ZXMocG9saWN5Lmhvc3RzKS5maWx0ZXIoKGFzc2lnbmVkKSA9PlxuICAgICAgICBhc3NpZ25lZC5wcm92aWRlcnMuaW5jbHVkZXMocm9sZS5wcm92aWRlcilcbiAgICAgICkucmVkdWNlKChzdW0sIGFzc2lnbmVkKSA9PiBzdW0gKyBhc3NpZ25lZC53ZWlnaHQsIDApO1xuICAgICAgY29uc3QgaG9zdEJ1ZGdldCA9IGJ1ZGdldCEuZXN0aW1hdGVkQnVkZ2V0VXNkICogaG9zdC53ZWlnaHQgL1xuICAgICAgICB0b3RhbEhvc3RXZWlnaHQ7XG4gICAgICByZXR1cm4gbG9va3VwTW9kZWxQcmljaW5nKHJvbGUubW9kZWwpICE9PSBudWxsICYmXG4gICAgICAgIGhvc3QucHJvdmlkZXJzLmluY2x1ZGVzKHJvbGUucHJvdmlkZXIpICYmXG4gICAgICAgIHN0YXR1cz8uc3Vic2NyaXB0aW9uID09PSB0cnVlICYmIHN0YXR1cy5hdmFpbGFibGUgJiYgc3RhdHVzLmNvc3RLbm93biAmJlxuICAgICAgICBOdW1iZXIuaXNGaW5pdGUoc3RhdHVzLnNwZW50VXNkKSAmJlxuICAgICAgICBzdGF0dXMuc3BlbnRVc2QgKyBwb2xpY3kubWF4SXNzdWVDb3N0VXNkICogKHN0YXR1cy5pbkZsaWdodCArIDEpIDw9XG4gICAgICAgICAgYnVkZ2V0IS5lc3RpbWF0ZWRCdWRnZXRVc2QgJiZcbiAgICAgICAgKHN0YXR1cy5ob3N0U3BlbnRVc2QgPz8gc3RhdHVzLnNwZW50VXNkKSArXG4gICAgICAgICAgICAgIHBvbGljeS5tYXhJc3N1ZUNvc3RVc2QgKiAoc3RhdHVzLmluRmxpZ2h0ICsgMSkgPD0gaG9zdEJ1ZGdldCAmJlxuICAgICAgICBzdGF0dXMuaW5GbGlnaHQgPCBNYXRoLm1pbihob3N0LmNhcGFjaXR5LCBidWRnZXQhLm1heFBhcmFsbGVsaXNtKTtcbiAgICB9KTtcbiAgY29uc3QgY29udHJvbCA9IHBvbGljeS5hcm1zLmZpbmQoKGFybSkgPT4gYXJtLmNvbnRyb2wpITtcbiAgaWYgKHN0YXRlLnBhdXNlZCkgcmV0dXJuIGVsaWdpYmxlKGNvbnRyb2wpID8gY29udHJvbC5pZCA6IG51bGw7XG4gIGNvbnN0IGFybXMgPSBwb2xpY3kuYXJtcy5tYXAoKGFybSkgPT4gKHtcbiAgICAuLi5hcm0sXG4gICAgd2VpZ2h0OiBzdGF0ZS53ZWlnaHRzW2FybS5pZF0gPz8gYXJtLndlaWdodCxcbiAgfSkpO1xuICBjb25zdCBhbGxvd2VkID0gbmV3IFNldChcbiAgICBhcm1zLmZpbHRlcigoYXJtKSA9PiBhcm0uc3RhdHVzID09PSBcImFjdGl2ZVwiICYmIGVsaWdpYmxlKGFybSkpLm1hcCgoYXJtKSA9PlxuICAgICAgYXJtLmlkXG4gICAgKSxcbiAgKTtcbiAgaWYgKGFsbG93ZWQuc2l6ZSA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIHJldHVybiBhd2FpdCBhc3NpZ25FeHBlcmltZW50QXJtKFxuICAgIGAke3BvbGljeS5zZWVkfToke3N0YXRlLmRlY2lzaW9uQ291bnR9YCxcbiAgICByZXBvLFxuICAgIGlzc3VlLFxuICAgIGFybXMsXG4gICAgYWxsb3dlZCxcbiAgKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxtRkFBbUYsR0FDbkYsU0FFRSxtQkFBbUIsRUFFbkIsZUFBZSxFQUNmLHNCQUFzQixRQUNqQiw2QkFBNkI7QUFDcEMsU0FBUyxpQkFBaUIsUUFBUSxzQkFBc0I7QUFDeEQsU0FBUyxrQkFBa0IsUUFBUSxtQkFBbUI7QUEyRnRELFNBQVMsVUFBVSxNQUF3QjtFQUN6QyxPQUFPLEtBQUssU0FBUyxDQUFDO0lBQUUsR0FBRyxNQUFNO0lBQUUsYUFBYTtFQUFNO0FBQ3hEO0FBQ0EsU0FBUyxPQUFPLEtBQWMsRUFBRSxJQUFZO0VBQzFDLElBQUksQ0FBQyxTQUFTLE9BQU8sVUFBVSxZQUFZLE1BQU0sT0FBTyxDQUFDLFFBQVE7SUFDL0QsTUFBTSxJQUFJLE1BQU0sQ0FBQyx3QkFBd0IsRUFBRSxLQUFLLGtCQUFrQixDQUFDO0VBQ3JFO0VBQ0EsT0FBTztBQUNUO0FBQ0EsU0FBUyxTQUFTLEtBQWMsRUFBRSxJQUFZLEVBQUUsUUFBaUI7RUFDL0QsTUFBTSxTQUFTLFNBQVM7RUFDeEIsSUFBSSxPQUFPLFdBQVcsWUFBWSxDQUFDLE9BQU8sUUFBUSxDQUFDLFdBQVcsVUFBVSxHQUFHO0lBQ3pFLE1BQU0sSUFBSSxNQUFNLENBQUMsd0JBQXdCLEVBQUUsS0FBSyxpQkFBaUIsQ0FBQztFQUNwRTtFQUNBLE9BQU87QUFDVDtBQUNBLFNBQVMsTUFBTSxLQUFjLEVBQUUsSUFBWSxFQUFFLFFBQWlCO0VBQzVELE1BQU0sU0FBUyxTQUFTLE9BQU8sTUFBTTtFQUNyQyxJQUFJLENBQUMsT0FBTyxTQUFTLENBQUMsU0FBUztJQUM3QixNQUFNLElBQUksTUFBTSxDQUFD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
// denoCacheMetadata=2225609919915695902,10337154564109737092