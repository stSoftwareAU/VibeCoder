/** File-backed allocation recommendations and opt-in issue routing (Issue #3646). */
import type { ExternalOrchestrationSettings, WorkerConfig } from "../types.ts";
import { resolveAgentStateDir } from "./agent_state_dir.ts";
import { atomicWrite } from "./file_utils.ts";
import { withFileLock } from "./file_lock.ts";
import {
  type LifecycleEvent,
  readLifecycleLedger,
} from "./lifecycle_ledger.ts";
import { lifecycleEventsAtCutoff } from "./lifecycle_outcomes.ts";
import { reconcileLifecycleEvents } from "./lifecycle_reconcile.ts";
import {
  buildAssignmentRecords,
  buildExperimentReport,
} from "./fleet_experiment_report.ts";
import {
  classifyProviderBilling,
  isFixedPriceSubscription,
} from "./provider_billing.ts";
import { resolveAutomaticProviderStatus } from "./provider_auto_runtime.ts";
import { getHostname } from "./worker_identity.ts";
import { liveSlotHolds } from "./live_slot_holds.ts";
import {
  type AllocationCapacityEvidence,
  type AllocationPlan,
  type AllocationProviderStatus,
  initialAllocationState,
  recommendAllocation,
  selectAllocationArm,
  validateAllocationState,
} from "./subscription_allocation.ts";

export class AllocationAdmissionError extends Error {
  constructor() {
    super(
      "subscription_allocation has no eligible fixed-subscription arm within quota, budget and capacity",
    );
  }
}
function statePath(config: WorkerConfig): string {
  const root = resolveAgentStateDir(config.workDir);
  if (!root) {
    throw new Error(
      "subscription_allocation has no durable agent state directory",
    );
  }
  return `${root}/subscription-allocation/state-v1.json`;
}
async function save(path: string, value: unknown): Promise<void> {
  const written = await atomicWrite({
    targetFile: path,
    content: JSON.stringify(value) + "\n",
  });
  if (!written.ok) throw written.error;
}
export interface AllocationEvaluation {
  plan: AllocationPlan;
  stateFile: string;
  events: LifecycleEvent[];
}
/** Default evaluation records a dry-run receipt; applying weights requires explicit opt-in. */
export async function evaluateSubscriptionAllocation(
  config: WorkerConfig,
  options: { apply?: boolean; reset?: boolean; now?: Date } = {},
): Promise<AllocationEvaluation> {
  const policy = config.subscriptionAllocation;
  if (!policy) throw new Error("subscription_allocation is not configured");
  if (options.apply && !policy.autoRouting) {
    throw new Error(
      "subscription_allocation auto_routing must be explicitly enabled before applying changes",
    );
  }
  const now = options.now ?? new Date();
  const events = lifecycleEventsAtCutoff(
    (await Promise.all(policy.ledgerPaths.map(async (path) => {
      const stat = await Deno.stat(path);
      if (!stat.isFile) {
        throw new Error(
          `subscription_allocation ledger is not a file: ${path}`,
        );
      }
      return await readLifecycleLedger(path);
    }))).flat(),
    now.toISOString(),
  );
  const reportOptions = {
    now,
    windowDays: policy.windowDays,
    horizonDays: policy.horizonDays,
    arms: policy.arms,
  };
  const roster = buildAssignmentRecords(events, reportOptions).records.filter(
    (record) => policy.arms.some((arm) => arm.id === record.cohort),
  );
  const assignmentKeys = new Set(
    roster.map((record) => `${record.repo}:${record.assignmentId}`),
  );
  const issueKeys = new Set(
    roster.map((record) => `${record.repo}:${record.issueNumber}`),
  );
  const trialEvents = events.filter((event) =>
    assignmentKeys.has(`${event.repo}:${event.assignmentId}`) ||
    (event.assignmentId === "unknown" &&
      issueKeys.has(`${event.repo}:${event.issueNumber}`))
  );
  const report = buildExperimentReport(trialEvents, reportOptions);
  const capacity: AllocationCapacityEvidence | undefined = policy.capacityPath
    ? JSON.parse(await Deno.readTextFile(policy.capacityPath))
    : undefined;
  const path = statePath(config);
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
    recursive: true,
    mode: 0o700,
  });
  return await withFileLock(`${path}.lock`, async () => {
    let current = initialAllocationState(policy);
    if (!options.reset) {
      try {
        current = validateAllocationState(
          policy,
          JSON.parse(await Deno.readTextFile(path)),
        );
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    if (options.apply && !current.dryRunAt) {
      throw new Error(
        "subscription_allocation requires a recorded dry-run before automatic changes",
      );
    }
    const plan = recommendAllocation(policy, current, report, capacity);
    if (options.apply) await save(path, plan.nextState);
    else await save(path, { ...current, dryRunAt: now.toISOString() });
    return { plan, stateFile: path, events: trialEvents };
  });
}
export interface IssueAllocationSelection {
  cohort: string;
  external: boolean;
  settings: ExternalOrchestrationSettings;
}
/** Refresh after terminal outcomes and scan cycles without changing their result. */
export async function refreshSubscriptionAllocation(
  config: WorkerConfig,
  log: (message: string) => void,
): Promise<AllocationPlan | undefined> {
  if (!config.subscriptionAllocation?.autoRouting) return undefined;
  try {
    const { plan } = await evaluateSubscriptionAllocation(config, {
      apply: true,
    });
    log(`[subscription-allocation] ${plan.action}: ${plan.reason}`);
    return plan;
  } catch {
    // Admission still validates the evidence and durable state before a new run.
    log(
      "[subscription-allocation] refresh held: evidence or durable state requires operator attention",
    );
    return undefined;
  }
}
/** Recompute before admission, without changing issue discovery. */
export async function resolveIssueAllocation(
  config: WorkerConfig,
  repo: string,
  issueNumber: number,
): Promise<IssueAllocationSelection | undefined> {
  const policy = config.subscriptionAllocation;
  if (
    !policy?.autoRouting ||
    config.repoConfig?.[repo]?.externalOrchestration === false
  ) return undefined;
  if (
    config.issueExecutorSplit !== true ||
    config.repoConfig?.[repo]?.issueExecutorSplit === false
  ) {
    throw new Error(
      "subscription_allocation control requires issue_executor_split; disable automatic routing to retain a different native configuration",
    );
  }
  const hostId = getHostname();
  const host = policy.hosts[hostId];
  if (!host || config.maxConcurrentIssues > host.capacity) {
    throw new Error(
      `subscription_allocation host ${hostId} capacity does not cover max_concurrent_issues`,
    );
  }
  if (
    host.providers.some((provider) =>
      !config.enabledAgentProviders.includes(provider)
    )
  ) {
    throw new Error(
      "subscription_allocation host providers must be provisioned in agent_providers",
    );
  }
  const evaluation = await evaluateSubscriptionAllocation(config, {
    apply: true,
  });
  const now = Date.now();
  const window = evaluation.events.filter((event) =>
    Date.parse(event.recordedAt) >= now - policy.windowDays * 86_400_000
  );
  const statuses: Record<string, AllocationProviderStatus> = {};
  for (const provider of host.providers) {
    const bill = classifyProviderBilling(provider, { workDir: config.workDir });
    const quota = await resolveAutomaticProviderStatus(provider, {
      workDir: config.workDir,
      env: (key) => Deno.env.get(key),
      now,
    });
    // Follow-on costs do not name a provider. Charge them conservatively to
    // each provider's admission budget; the issue-efficiency report counts them once.
    const relevant = window.filter((event) =>
      event.kind === "assignment" || event.kind === "follow_on" ||
      (event.kind === "invocation" && event.provider === provider)
    );
    const sums = reconcileLifecycleEvents(relevant).assignments.map((row) =>
      row.totals
    );
    const hostSums = reconcileLifecycleEvents(
      relevant.filter((event) => event.host === hostId),
    ).assignments.map((row) => row.totals);
    statuses[provider] = {
      subscription: isFixedPriceSubscription(bill),
      available: quota.availability === "available",
      inFlight: liveSlotHolds().filter((hold) =>
        hold.repo !== repo || hold.issueNumber !== issueNumber
      ).length,
      costKnown: sums.every((sum) =>
        !sum.partial
      ),
      spentUsd: sums.reduce(
        (total, sum) => total + (sum.estimatedApiEquivalentUsd ?? 0),
        0,
      ),
      hostSpentUsd: hostSums.reduce(
        (total, sum) => total + (sum.estimatedApiEquivalentUsd ?? 0),
        0,
      ),
    };
  }
  const cohort = await selectAllocationArm(
    policy,
    evaluation.plan.nextState,
    repo,
    issueNumber,
    hostId,
    statuses,
  );
  if (!cohort) throw new AllocationAdmissionError();
  const arm = policy.arms.find((arm) => arm.id === cohort)!;
  return {
    cohort,
    external: !arm.control,
    settings: {
      manager: arm.manager,
      executor: arm.executor,
      reviewer: { ...arm.reviewer, effort: "high" },
      maxConcurrency: 1,
      maxCostUsd: policy.maxIssueCostUsd,
    },
  };
}
