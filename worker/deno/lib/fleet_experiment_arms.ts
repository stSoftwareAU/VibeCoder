/**
 * Randomised arm definitions and assignment for the fleet experiment
 * (Issue #3645, part of milestone #3644).
 *
 * Each issue is assigned to one experiment arm before any work starts. The
 * draw is a pure function of a seed, the repository and the issue number, so
 * the same issue always lands in the same arm. The assignment is recorded
 * before work begins and is never re-drawn, so an intention-to-treat analysis
 * survives fallbacks to another model or host.
 *
 * Fable models are excluded from every arm and from every fallback.
 *
 * Australian English spelling used throughout.
 */

/** A provider and model pair for one agent role. */
export interface ArmRole {
  provider: string;
  model: string;
}

/** One experiment arm: a manager and executor treatment with an allocation weight. */
export interface ExperimentArm {
  /** Cohort label, matching the lifecycle ledger label pattern. */
  id: string;
  /** Human text, for example "Sonnet manager + Haiku executor". */
  label: string;
  manager: ArmRole;
  executor: ArmRole;
  /** Whether this is the incumbent control arm. Exactly one arm is control. */
  control: boolean;
  /** Relative allocation weight. Must be finite and above zero. */
  weight: number;
  /** Only active arms receive new assignments. */
  status: "active" | "awaiting-feasibility";
}

/** The id of the incumbent control arm. */
export const CONTROL_ARM_ID = "sonnet-haiku";

/**
 * The arms the fleet experiment runs by default.
 *
 * The control is Sonnet manager with Haiku executor, the incumbent. There are
 * no Opus-manager arms, as the incumbent control is Sonnet plus Haiku and the
 * Opus arms were dropped. The Astra and Sol candidates await a feasibility
 * check: subscription-only feasibility is tracked in #3647, and Astra and Sol
 * CLI availability is not assumed here.
 */
export const DEFAULT_EXPERIMENT_ARMS: readonly ExperimentArm[] = [
  {
    id: CONTROL_ARM_ID,
    label: "Sonnet manager + Haiku executor",
    manager: { provider: "claude", model: "sonnet" },
    executor: { provider: "claude", model: "haiku" },
    control: true,
    weight: 1,
    status: "active",
  },
  {
    // Awaiting #3647: subscription-only feasibility is not yet established.
    id: "astra-sol",
    label: "Astra manager + Sol executor",
    manager: { provider: "codex", model: "astra" },
    executor: { provider: "codex", model: "sol" },
    control: false,
    weight: 1,
    status: "awaiting-feasibility",
  },
  {
    // Awaiting #3647: subscription-only feasibility is not yet established.
    id: "astra-haiku",
    label: "Astra manager + Haiku executor",
    manager: { provider: "codex", model: "astra" },
    executor: { provider: "claude", model: "haiku" },
    control: false,
    weight: 1,
    status: "awaiting-feasibility",
  },
];

/** Arm ids must match this pattern. */
const ARM_ID_PATTERN = /^[a-z0-9._-]{1,64}$/;

/** Any model whose name contains "fable", in any case. */
const EXCLUDED_MODEL_PATTERN = /fable/i;

/**
 * Raised when an arm configuration is refused.
 *
 * `rule` names the rule that refused the configuration.
 */
export class ExperimentArmError extends Error {
  readonly rule: string;

  constructor(rule: string, detail: string) {
    super(`Experiment arm rule ${rule} refused: ${detail}`);
    this.name = "ExperimentArmError";
    this.rule = rule;
  }
}

/**
 * Whether a model is excluded from every experiment arm and fallback.
 *
 * @param model - The model name, if known.
 * @returns True when the model is a Fable model.
 */
export function isExcludedModel(model: string | undefined): boolean {
  return model !== undefined && EXCLUDED_MODEL_PATTERN.test(model);
}

/**
 * Check an arm configuration against every rule, refusing the first breach.
 *
 * @param arms - The configured arms.
 * @throws {ExperimentArmError} When a rule is broken.
 */
export function validateExperimentArms(arms: readonly ExperimentArm[]): void {
  if (arms.length === 0) {
    throw new ExperimentArmError("empty", "no arms are configured");
  }

  const ids = new Set<string>();
  for (const arm of arms) {
    if (ids.has(arm.id)) {
      throw new ExperimentArmError(
        "duplicate-id",
        "an arm id appears more than once",
      );
    }
    ids.add(arm.id);
  }

  for (const arm of arms) {
    if (!ARM_ID_PATTERN.test(arm.id)) {
      throw new ExperimentArmError(
        "invalid-id",
        "an arm id must match [a-z0-9._-] and be at most 64 characters",
      );
    }
  }

  const controls = arms.filter((arm) => arm.control);
  const control = controls[0];
  if (controls.length !== 1 || control === undefined) {
    throw new ExperimentArmError(
      "control-count",
      "exactly one arm must be the control",
    );
  }
  if (control.status !== "active") {
    throw new ExperimentArmError(
      "control-inactive",
      "the control must be active",
    );
  }

  for (const arm of arms) {
    if (
      isExcludedModel(arm.manager.model) || isExcludedModel(arm.executor.model)
    ) {
      throw new ExperimentArmError(
        "excluded-model",
        "Fable models are excluded from every arm",
      );
    }
  }

  for (const arm of arms) {
    if (!(Number.isFinite(arm.weight) && arm.weight > 0)) {
      throw new ExperimentArmError(
        "invalid-weight",
        "an arm weight must be a finite number above zero",
      );
    }
  }
}

/**
 * Map the SHA-256 of `${seed}:${repo}#${issueNumber}` to [0, 1).
 *
 * The first six bytes form a 48-bit integer, divided by 2^48.
 *
 * @param seed - The experiment seed.
 * @param repo - The repository, `owner/name`.
 * @param issueNumber - The issue number.
 * @returns A value in [0, 1).
 */
async function unitInterval(
  seed: string,
  repo: string,
  issueNumber: number,
): Promise<number> {
  const data = new TextEncoder().encode(`${seed}:${repo}#${issueNumber}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  let value = 0;
  for (let index = 0; index < 6; index++) {
    value = value * 256 + (digest[index] ?? 0);
  }
  return value / 2 ** 48;
}

/**
 * Assign an issue to one active arm, deterministically.
 *
 * The same seed, repository and issue number always return the same arm.
 * Only arms with status "active" are chosen, in proportion to their weights.
 *
 * @param seed - The experiment seed.
 * @param repo - The repository, `owner/name`.
 * @param issueNumber - The issue number.
 * @param arms - The configured arms, validated before the draw.
 * @returns The chosen arm's id.
 * @throws {ExperimentArmError} When the arm configuration is refused.
 */
export async function assignExperimentArm(
  seed: string,
  repo: string,
  issueNumber: number,
  arms: readonly ExperimentArm[],
): Promise<string> {
  validateExperimentArms(arms);
  const active = arms.filter((arm) => arm.status === "active");
  const total = active.reduce((sum, arm) => sum + arm.weight, 0);
  const target = (await unitInterval(seed, repo, issueNumber)) * total;

  let cumulative = 0;
  for (const arm of active) {
    cumulative += arm.weight;
    if (target < cumulative) return arm.id;
  }
  // Floating-point slack can leave the target a whisker past the total, so the
  // last active arm takes it. Validation makes the control active, so the
  // fallback to the control id can only apply if the list were somehow empty.
  return active[active.length - 1]?.id ?? CONTROL_ARM_ID;
}
