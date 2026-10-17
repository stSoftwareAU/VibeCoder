/**
 * Synthetic lifecycle history for rehearsing the fleet experiment
 * (Issue #3645, part of milestone #3644).
 *
 * Generates ledger events for a population of issues, so the report and its
 * verdict can be exercised before the real experiment runs. Every random draw
 * comes from one seeded mulberry32 stream, and each arm is chosen with the same
 * assignment function the experiment uses. The same options always give the
 * same history.
 *
 * Every event is built through buildLifecycleEvent, so it validates against the
 * ledger's allowlist.
 *
 * Australian English spelling used throughout.
 */

import {
  assignExperimentArm,
  type ExperimentArm,
  validateExperimentArms,
} from "./fleet_experiment_arms.ts";
import { mulberry32 } from "./fleet_experiment_report.ts";
import {
  buildLifecycleEvent,
  type LifecycleEvent,
  type LifecycleEventInput,
} from "./lifecycle_ledger.ts";

/** Milliseconds in one day. */
const DAY_MS = 86_400_000;

/** Milliseconds in one hour. */
const HOUR_MS = 3_600_000;

/** Issue sizes drawn for the covariates. */
const SIZES = ["small", "medium", "large"] as const;

/** Issue types drawn for the covariates. */
const TYPES = ["bug", "enhancement", "docs"] as const;

/** Issue priorities drawn for the covariates. */
const PRIORITIES = ["top-priority", "work-on", "low-priority"] as const;

/** One arm's behaviour in the synthetic population. */
export interface SyntheticArmSpec {
  arm: ExperimentArm;
  /** Probability that an issue under this arm is merged. */
  mergeProbability: number;
  /** Estimated API-equivalent USD for the manager invocation. */
  managerCostUsd: number;
  /** Estimated API-equivalent USD for the executor invocation. */
  executorCostUsd: number;
}

/** Options for generating a synthetic history. */
export interface SyntheticHistoryOptions {
  /** Seeds the PRNG for everything except the arm draw. */
  seed: number;
  /** The experiment seed passed to assignExperimentArm. */
  experimentSeed: string;
  /** How many issues to generate, numbered 1..issues. */
  issues: number;
  /** The reference time. Nothing is recorded after it. */
  now: Date;
  /** The assignment time is spread over this many days before `now`. */
  days: number;
  /** The arms, with their behaviour. Every arm is validated. */
  arms: readonly SyntheticArmSpec[];
  repos: readonly string[];
  hosts: readonly string[];
  /** Fraction of issues (the most recently assigned) left pending with an open PR. */
  pendingShare: number;
  /** Fraction of invocations with usage and pricing unknown and no USD. Default 0. */
  unknownCostShare?: number;
}

/** A generated history: the ledger events and the covariates by issue. */
export interface SyntheticHistory {
  events: LifecycleEvent[];
  /** Covariates keyed `${repo}#${issueNumber}`. */
  covariates: Record<string, Record<string, string>>;
}

/** The random draws for one issue, taken before any events are built. */
interface IssueDraft {
  issueNumber: number;
  repo: string;
  host: string;
  assignmentId: string;
  assignedMs: number;
  armSpec: SyntheticArmSpec;
  merges: boolean;
  hours: number;
  covariates: Record<string, string>;
  managerUnknown: boolean;
  executorUnknown: boolean;
  retryUnknown: boolean;
}

/** Raise when a value is outside its allowed range. */
function requireFraction(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a fraction between 0 and 1`);
  }
}

/** Raise when a value is not a finite, non-negative number. */
function requireNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number of zero or more`);
  }
}

/** Read a list entry the caller has already bounded. */
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError(`index ${index} is outside the list`);
  }
  return value;
}

/** Pick one entry of a non-empty list with the PRNG. */
function pick<T>(values: readonly T[], random: () => number): T {
  return at(values, Math.min(values.length - 1, Math.floor(random() * values.length)));
}

/** A version-4 UUID in lowercase hex, drawn from the PRNG. */
function uuidV4(random: () => number): string {
  const hex = Array.from({ length: 16 }, (_, index) => {
    let byte = Math.floor(random() * 256);
    if (index === 6) byte = (byte & 0x0f) | 0x40;
    if (index === 8) byte = (byte & 0x3f) | 0x80;
    return byte.toString(16).padStart(2, "0");
  }).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** An ISO-8601 UTC timestamp for a whole-millisecond instant. */
function iso(ms: number): string {
  return new Date(Math.floor(ms)).toISOString();
}

/**
 * Generate a synthetic history for the fleet experiment.
 *
 * Each issue is assigned an arm with assignExperimentArm. Its assignment time
 * is spread over the last `days` days. The most recently assigned
 * `pendingShare` of issues stay pending with an open PR. The rest are merged
 * with the arm's merge probability, and the others fail and are retried once.
 *
 * @param opts - The generation options.
 * @returns The events and the covariates.
 * @throws {RangeError} When an option is out of range.
 * @throws {ExperimentArmError} When the arms are refused.
 */
export async function generateSyntheticHistory(
  opts: SyntheticHistoryOptions,
): Promise<SyntheticHistory> {
  validateExperimentArms(opts.arms.map((spec) => spec.arm));
  if (!Number.isInteger(opts.issues) || opts.issues < 1) {
    throw new RangeError("issues must be a positive integer");
  }
  requireNonNegative(opts.days, "days");
  if (opts.days <= 0) throw new RangeError("days must be above zero");
  if (opts.repos.length === 0 || opts.hosts.length === 0) {
    throw new RangeError("repos and hosts must not be empty");
  }
  requireFraction(opts.pendingShare, "pendingShare");
  const unknownCostShare = opts.unknownCostShare ?? 0;
  requireFraction(unknownCostShare, "unknownCostShare");
  for (const spec of opts.arms) {
    requireFraction(spec.mergeProbability, `mergeProbability for ${spec.arm.id}`);
    requireNonNegative(spec.managerCostUsd, `managerCostUsd for ${spec.arm.id}`);
    requireNonNegative(spec.executorCostUsd, `executorCostUsd for ${spec.arm.id}`);
  }
  const armsById = new Map(opts.arms.map((spec) => [spec.arm.id, spec]));
  const arms = opts.arms.map((spec) => spec.arm);

  const random = mulberry32(opts.seed);
  const nowMs = opts.now.getTime();
  const windowMs = opts.days * DAY_MS;

  const drafts: IssueDraft[] = [];
  for (let issueNumber = 1; issueNumber <= opts.issues; issueNumber++) {
    const repo = pick(opts.repos, random);
    const host = pick(opts.hosts, random);
    const assignedMs = Math.floor(nowMs - random() * windowMs);
    const assignmentId = uuidV4(random);
    const covariates = {
      size: pick(SIZES, random),
      type: pick(TYPES, random),
      priority: pick(PRIORITIES, random),
    };
    const armId = await assignExperimentArm(
      opts.experimentSeed,
      repo,
      issueNumber,
      arms,
    );
    const armSpec = armsById.get(armId);
    if (armSpec === undefined) {
      throw new Error(`no synthetic spec for assigned arm ${armId}`);
    }
    drafts.push({
      issueNumber,
      repo,
      host,
      assignmentId,
      assignedMs,
      armSpec,
      merges: random() < armSpec.mergeProbability,
      hours: 1 + random() * 47,
      covariates,
      managerUnknown: random() < unknownCostShare,
      executorUnknown: random() < unknownCostShare,
      retryUnknown: random() < unknownCostShare,
    });
  }

  drafts.sort((a, b) =>
    a.assignedMs - b.assignedMs || a.issueNumber - b.issueNumber
  );
  const pendingCount = Math.round(opts.issues * opts.pendingShare);
  const firstPending = drafts.length - pendingCount;

  const events: LifecycleEvent[] = [];
  const covariates: Record<string, Record<string, string>> = {};
  for (const [index, draft] of drafts.entries()) {
    const inputs = eventsFor(draft, index >= firstPending, nowMs);
    for (const input of inputs) events.push(buildLifecycleEvent(input));
    covariates[`${draft.repo}#${draft.issueNumber}`] = draft.covariates;
  }
  return { events, covariates };
}

/** Build the ledger inputs for one issue. */
function eventsFor(
  draft: IssueDraft,
  pending: boolean,
  nowMs: number,
): LifecycleEventInput[] {
  const { armSpec } = draft;
  const runId = `synthetic-run-${draft.issueNumber}`;
  const identity = {
    assignmentId: draft.assignmentId,
    runId,
    host: draft.host,
    repo: draft.repo,
    issueNumber: draft.issueNumber,
  };
  const assignedAt = iso(draft.assignedMs);
  const outcomeAt = (fraction: number): string =>
    iso(Math.min(nowMs, draft.assignedMs + fraction * draft.hours * HOUR_MS));

  const inputs: LifecycleEventInput[] = [
    {
      kind: "assignment",
      ...identity,
      recordedAt: assignedAt,
      assignedAt,
      cohort: armSpec.arm.id,
      reused: false,
      treatment: {
        roles: [
          {
            role: "manager",
            provider: armSpec.arm.manager.provider,
            model: armSpec.arm.manager.model,
          },
          {
            role: "executor",
            provider: armSpec.arm.executor.provider,
            model: armSpec.arm.executor.model,
          },
        ],
      },
    },
    invocation({
      identity,
      recordedAt: assignedAt,
      role: "manager",
      attempt: 1,
      provider: armSpec.arm.manager.provider,
      model: armSpec.arm.manager.model,
      result: "success",
      costUsd: armSpec.managerCostUsd,
      costUnknown: draft.managerUnknown,
    }),
    invocation({
      identity,
      recordedAt: assignedAt,
      role: "executor",
      attempt: 1,
      provider: armSpec.arm.executor.provider,
      model: armSpec.arm.executor.model,
      result: "success",
      costUsd: armSpec.executorCostUsd,
      costUnknown: draft.executorUnknown,
    }),
  ];

  if (pending) {
    inputs.push(outcome(identity, "pr_opened", outcomeAt(0.2)));
  } else if (draft.merges) {
    inputs.push(
      outcome(identity, "pr_opened", outcomeAt(0.2)),
      outcome(identity, "quality_green", outcomeAt(0.5)),
      outcome(identity, "review_approved", outcomeAt(0.8)),
      outcome(identity, "merged", outcomeAt(1)),
    );
  } else {
    inputs.push(outcome(identity, "failed", outcomeAt(1)));
    inputs.push(
      invocation({
        identity,
        recordedAt: assignedAt,
        role: "executor",
        attempt: 2,
        provider: armSpec.arm.executor.provider,
        model: armSpec.arm.executor.model,
        result: "failure",
        costUsd: armSpec.executorCostUsd,
        costUnknown: draft.retryUnknown,
      }),
    );
  }
  return inputs;
}

/** The fields every synthetic event shares. */
interface EventIdentity {
  assignmentId: string;
  runId: string;
  host: string;
  repo: string;
  issueNumber: number;
}

/** Build one invocation input, with its USD omitted when the cost is unknown. */
function invocation(params: {
  identity: EventIdentity;
  recordedAt: string;
  role: "manager" | "executor";
  attempt: number;
  provider: string;
  model: string;
  result: "success" | "failure";
  costUsd: number;
  costUnknown: boolean;
}): LifecycleEventInput {
  const { identity, costUnknown } = params;
  return {
    kind: "invocation",
    ...identity,
    recordedAt: params.recordedAt,
    role: params.role,
    attempt: params.attempt,
    provider: params.provider,
    model: params.model,
    result: params.result,
    usage: costUnknown ? "unknown" : "known",
    pricing: costUnknown ? "unknown" : "known",
    ...(costUnknown ? {} : { estimatedApiEquivalentUsd: params.costUsd }),
  };
}

/** Build one outcome input. */
function outcome(
  identity: EventIdentity,
  name:
    | "pr_opened"
    | "quality_green"
    | "review_approved"
    | "merged"
    | "failed",
  recordedAt: string,
): LifecycleEventInput {
  return { kind: "outcome", ...identity, recordedAt, outcome: name };
}
