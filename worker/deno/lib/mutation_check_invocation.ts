/**
 * The diff-scoped mutation check invocation, shared by the PR-raise gate in the
 * issue completion phase (Issue #3393) and the review-fix run (Issue #3750).
 *
 * Both callers apply the same rules: a repository that opts out
 * (`skip_mutation_check`) is not checked, an unwired runner is not applicable,
 * the budget comes from the repository's `mutation_check_budget_seconds`, and
 * a diff or runner that cannot answer fails closed. Only the diff differs: the
 * whole PR against its base for the completion phase, or the lines one
 * review-fix run added for a review-fix run.
 */

import { getRepoConfig } from "./repo_config.ts";
import { resolveRepoCredentials } from "./repo_credentials.ts";
import {
  DEFAULT_MUTATION_BUDGET_SECONDS,
  type MutationCheckResult,
} from "./mutation_gate.ts";
import type { MutationRunInput } from "./mutation_runner.ts";
import type { Logger, RepoConfig, Result } from "../types.ts";

/** Upper bound on `mutation_check_budget_seconds` (Issue #3393). */
export const MAX_MUTATION_BUDGET_SECONDS = 3600;

/**
 * Resolve the mutation gate's wall-clock budget from the per-repo
 * `mutation_check_budget_seconds` value (Issue #3393). A missing value is the
 * default; a value that is not a positive integer no greater than
 * {@link MAX_MUTATION_BUDGET_SECONDS} is refused loudly through `warn` and
 * the default applies, as the other untrusted per-repo numbers do.
 */
export function resolveMutationBudgetSeconds(
  raw: string,
  warn: (message: string, context?: Record<string, unknown>) => void,
): number {
  if (raw === "") return DEFAULT_MUTATION_BUDGET_SECONDS;
  const parsed = Number(raw);
  if (
    !Number.isInteger(parsed) || parsed <= 0 ||
    parsed > MAX_MUTATION_BUDGET_SECONDS
  ) {
    warn(
      "Ignoring invalid mutation_check_budget_seconds — using the default",
      { value: raw, default: DEFAULT_MUTATION_BUDGET_SECONDS },
    );
    return DEFAULT_MUTATION_BUDGET_SECONDS;
  }
  return parsed;
}

export interface MutationCheckInvocation {
  repo: string;
  repoPath: string;
  repoConfigs: Record<string, RepoConfig> | undefined;
  /** The wired runner (`WorkerDeps.quality.runMutationCheck`); absent → not applicable. */
  runner:
    | ((input: MutationRunInput) => Promise<MutationCheckResult>)
    | undefined;
  /** Collects the unified=0 diff whose added lines are mutated; an error result fails closed. */
  collectDiff: () => Promise<Result<string>>;
  logger: Pick<Logger, "info" | "warn">;
}

/**
 * Run the diff-scoped mutation check for one repository and return its
 * verdict input. The caller judges the result with `evaluateMutationGate`.
 */
export async function invokeMutationCheck(
  opts: MutationCheckInvocation,
): Promise<MutationCheckResult> {
  const { repo, repoPath, repoConfigs, runner, collectDiff, logger } = opts;
  if (getRepoConfig(repoConfigs, repo, "skipMutationCheck") === "true") {
    logger.info("mutation check skipped by skip_mutation_check", { repo });
    return {
      kind: "not_applicable",
      reason: "skipped by skip_mutation_check",
    };
  }
  if (!runner) {
    logger.warn("Mutation runner not wired — mutation check not applicable");
    return {
      kind: "not_applicable",
      reason: "mutation runner not wired",
    };
  }
  const budgetSeconds = resolveMutationBudgetSeconds(
    getRepoConfig(repoConfigs, repo, "mutationCheckBudgetSeconds"),
    (message, context) => logger.warn(message, context),
  );
  const diff = await collectDiff();
  if (!diff.ok) {
    return { kind: "error", reason: diff.error.message };
  }
  // The quality gate's child gets the credentials this repository
  // declared, and its tests need them here too or the baseline fails
  // before mutation. A failed mint is not run without them: that would
  // block the PR on a fault that is not its code.
  const credentials = await resolveRepoCredentials(
    repo,
    repoConfigs?.[repo]?.qualityCredentials,
  );
  if (!credentials.ok) {
    logger.warn(
      "Could not resolve quality_credentials for the mutation check",
      { repo, error: credentials.error.message },
    );
    return {
      kind: "not_applicable",
      reason:
        `the repository's quality_credentials could not be resolved (${credentials.error.message})`,
    };
  }
  try {
    return await runner({
      repoPath,
      diff: diff.value,
      budgetSeconds,
      credentialEnv: credentials.value.env,
    });
  } catch (error) {
    return {
      kind: "error",
      reason: `mutation runner failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
