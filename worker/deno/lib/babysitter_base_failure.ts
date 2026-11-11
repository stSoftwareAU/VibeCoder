/**
 * Base-branch failure check for the fleet PR babysitter's failed-CI repair
 * (Issue #4921).
 *
 * CI-fix defers a failure that is already red on the base branch with the same
 * signature (Issue #4680, `prompts/ci_fix/prompt.md` "Base-branch failures").
 * The babysitter is a second path onto the same red pull request, so it applies
 * the same classification before it starts a repair: when every failing check
 * is verified as the base's own failure, no repair starts, because a copy of
 * the base's fix in each open pull request collides with the others and with
 * the base's own fix. Once the base is fixed, the babysitter's ordinary base
 * merge brings the fix in.
 *
 * Every other reading repairs exactly as before. Unknown or unverifiable
 * evidence is never a deferral: a failed read, a commit status, a
 * dependency-audit check (fixed in each pull request, Issue #3141), a green or
 * missing or stale base run, an unreadable or different base log.
 *
 * A repair whose stopping check is green on the base is still only a repair:
 * green on the current base alone does not prove that a base fix landed.
 *
 * Uses Australian English throughout.
 */

import {
  type BaseBranchCheckEvidence,
  readBaseBranchCheck,
  readCheckIdentity,
} from "./ci_base_branch_check.ts";
import { compareBaseFailure } from "./ci_base_failure_signature.ts";
import { isDependencyAuditCheck } from "./dependency_audit_check.ts";
import { fetchGithubActionsLogExcerpt } from "./github_actions_log_fetcher.ts";

/** One failing check the base branch is red for as well. */
export interface BaseRedCheck {
  name: string;
  baseRunId: number;
}

/** What the babysitter does with a failed-CI pull request. */
export type BaseFailureDecision =
  /** Every failing check is the base's own failure: start no repair. */
  | { kind: "defer"; checks: BaseRedCheck[] }
  /**
   * Repair as usual; `reason` says which reading stopped the deferral.
   * `repairCheck` names the first check that was not verified as a matching
   * base failure. A green current-base run is not evidence of a landed fix.
   */
  | {
    kind: "repair";
    reason: string;
    repairCheck?: { name: string; headRunId: number };
  };

/** Inputs for {@link classifyBaseRedFailures}. */
export interface ClassifyBaseRedFailuresOptions {
  repo: string;
  /** The pull request's head commit, whose check runs are read. */
  headSha: string;
  /** The pull request's base branch. */
  baseRef: string;
  /** The pull request's status rollup, so a failing commit status is seen. */
  rollup: ReadonlyArray<{ state?: string; conclusion?: string }>;
  ghFn: (args: string[]) => Promise<string>;
  /** Test seam for the Actions log fetcher (default: the real one). */
  actionsLogFn?: typeof fetchGithubActionsLogExcerpt;
}

interface FailingRun {
  id: number;
  name: string;
}

const HEAD_SHA = /^[0-9a-f]{40}$/;

/** Repair, with the reason carried so the log names why nothing was deferred. */
function repair(
  reason: string,
  repairCheck?: { name: string; headRunId: number },
): BaseFailureDecision {
  return repairCheck === undefined
    ? { kind: "repair", reason }
    : { kind: "repair", reason, repairCheck };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the head's check runs and return the failing ones, or the reason they
 * cannot all be accounted for.
 */
async function readFailingRuns(
  repo: string,
  headSha: string,
  ghFn: (args: string[]) => Promise<string>,
): Promise<FailingRun[] | string> {
  let raw: string;
  try {
    raw = await ghFn([
      "api",
      `repos/${repo}/commits/${headSha}/check-runs?per_page=100`,
      "--jq",
      "{total: .total_count, runs: [.check_runs[] | {id, name, conclusion}]}",
    ]);
  } catch (error: unknown) {
    return `the head's check runs could not be read: ${message(error)}`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    return `the head's check runs were not JSON: ${message(error)}`;
  }
  const body = parsed as { total?: unknown; runs?: unknown } | null;
  if (
    body === null || typeof body !== "object" || !Array.isArray(body.runs) ||
    typeof body.total !== "number"
  ) {
    return "the head's check runs had an unexpected shape";
  }
  // A page that omits runs could hide a failing one this cannot classify.
  if (body.total > body.runs.length) {
    return "the head has more check runs than one page holds";
  }
  const failing: FailingRun[] = [];
  for (const run of body.runs as Array<Record<string, unknown>>) {
    if (run.conclusion !== "failure") continue;
    if (typeof run.id !== "number" || typeof run.name !== "string") {
      return "a failing check run had no id or name";
    }
    failing.push({ id: run.id, name: run.name });
  }
  return failing;
}

/**
 * Decide whether a failed-CI pull request is red only for the base branch's own
 * failure.
 *
 * @param options - The pull request, its rollup and the `gh` runner.
 * @returns `defer` only when every failing check is verified red on the base
 *   with the same failure; `repair` for every other reading.
 */
export async function classifyBaseRedFailures(
  options: ClassifyBaseRedFailuresOptions,
): Promise<BaseFailureDecision> {
  const { repo, headSha, baseRef, rollup, ghFn } = options;
  if (baseRef.trim().length === 0) {
    return repair("the pull request has no base");
  }
  if (!HEAD_SHA.test(headSha)) return repair("the head is not a full SHA");
  // A failing commit status is not a check run: nothing to compare it with.
  if (rollup.some((c) => c.state === "FAILURE" || c.state === "ERROR")) {
    return repair("a commit status failed, which has no base run to compare");
  }

  const failing = await readFailingRuns(repo, headSha, ghFn);
  if (typeof failing === "string") return repair(failing);
  if (failing.length === 0) return repair("no failing check run was found");

  const matched: BaseRedCheck[] = [];
  for (const run of failing) {
    const identity = await readCheckIdentity({
      repo,
      checkRunId: String(run.id),
      checkName: run.name,
      ghCommandFn: ghFn,
    });
    if (!identity.ok) return repair(identity.error.message);
    // Fail closed: a check whose own log cannot be read has no failure to compare.
    const log = await (options.actionsLogFn ?? fetchGithubActionsLogExcerpt)({
      repo,
      checkRunId: String(run.id),
      checkName: run.name,
      ghFn,
    });
    if (log.kind !== "excerpt") {
      return repair(
        `the failing log of "${run.name}" was not readable: ${
          log.kind === "error" ? log.error : log.reason
        }`,
      );
    }
    if (isDependencyAuditCheck(run.name, log.excerpt)) {
      return repair(`"${run.name}" is a dependency audit, fixed in each PR`);
    }
    const evidence: BaseBranchCheckEvidence = await readBaseBranchCheck({
      repo,
      branch: baseRef,
      failing: identity.value,
      ghCommandFn: ghFn,
    });
    if (evidence.state === "green") {
      return {
        kind: "repair",
        reason: `the base's run of "${run.name}" is green, not red`,
        repairCheck: { name: run.name, headRunId: run.id },
      };
    }
    if (evidence.state !== "red") {
      return repair(
        `the base's run of "${run.name}" is ${evidence.state}, not red`,
      );
    }
    const comparison = await compareBaseFailure({
      repo,
      checkName: run.name,
      baseCheckRunId: evidence.runId,
      failureText: log.excerpt,
      ghFn,
      ...(options.actionsLogFn !== undefined
        ? { actionsLogFn: options.actionsLogFn }
        : {}),
    });
    if (comparison.state !== "same") {
      return repair(
        comparison.state === "different"
          ? `the base's log for "${run.name}" shows a different failure`
          : `the base's log for "${run.name}" was not comparable: ${comparison.reason}`,
      );
    }
    matched.push({ name: run.name, baseRunId: evidence.runId });
  }
  return { kind: "defer", checks: matched };
}

/**
 * Confirm that a failing PR check was the same failure on the PR's merge-base
 * and is now green on a newer base commit. A green base run by itself is the
 * normal result when the PR caused the failure, so it never authorises a merge.
 */
export async function confirmBaseFailureFixed(options: {
  repo: string;
  baseRef: string;
  headSha: string;
  checkRunId: string;
  checkName: string;
  ghFn: (args: string[]) => Promise<string>;
  actionsLogFn?: typeof fetchGithubActionsLogExcerpt;
}): Promise<{ confirmed: boolean; reason: string }> {
  const { repo, baseRef, headSha, checkRunId, checkName, ghFn } = options;
  if (!HEAD_SHA.test(headSha)) {
    return { confirmed: false, reason: "PR head is not a full SHA" };
  }

  const identity = await readCheckIdentity({
    repo,
    checkRunId,
    checkName,
    ghCommandFn: ghFn,
  });
  if (!identity.ok) {
    return { confirmed: false, reason: identity.error.message };
  }
  let checkHeadSha: string;
  try {
    checkHeadSha = (await ghFn([
      "api",
      `repos/${repo}/check-runs/${checkRunId}`,
      "--jq",
      ".head_sha",
    ])).trim();
  } catch (error) {
    return {
      confirmed: false,
      reason: `could not read the PR check head: ${message(error)}`,
    };
  }
  if (checkHeadSha !== headSha) {
    return {
      confirmed: false,
      reason: "PR check belongs to a different head revision",
    };
  }
  const headFailure = await (options.actionsLogFn ??
    fetchGithubActionsLogExcerpt)({
    repo,
    checkRunId,
    checkName,
    ghFn,
  });
  if (headFailure.kind !== "excerpt") {
    return {
      confirmed: false,
      reason: `PR failure log is not comparable: ${
        headFailure.kind === "error" ? headFailure.error : headFailure.reason
      }`,
    };
  }

  const current = await readBaseBranchCheck({
    repo,
    branch: baseRef,
    failing: identity.value,
    ghCommandFn: ghFn,
  });
  if (current.state !== "green") {
    return {
      confirmed: false,
      reason: `current base check is ${current.state}, not green`,
    };
  }

  let mergeBaseSha: string;
  try {
    mergeBaseSha = (await ghFn([
      "api",
      `repos/${repo}/compare/${current.sha}...${headSha}`,
      "--jq",
      ".merge_base_commit.sha",
    ])).trim();
  } catch (error) {
    return {
      confirmed: false,
      reason: `could not read PR merge-base: ${message(error)}`,
    };
  }
  if (!HEAD_SHA.test(mergeBaseSha)) {
    return {
      confirmed: false,
      reason: "PR comparison returned no full merge-base SHA",
    };
  }
  if (current.sha === mergeBaseSha) {
    return {
      confirmed: false,
      reason: "base has no commit newer than the PR merge-base",
    };
  }

  const historical = await readBaseBranchCheck({
    repo,
    branch: mergeBaseSha,
    failing: identity.value,
    ghCommandFn: ghFn,
  });
  if (historical.state !== "red") {
    return {
      confirmed: false,
      reason: `merge-base check is ${historical.state}, not red`,
    };
  }
  const comparison = await compareBaseFailure({
    repo,
    checkName,
    baseCheckRunId: historical.runId,
    failureText: headFailure.excerpt,
    ghFn,
    ...(options.actionsLogFn !== undefined
      ? { actionsLogFn: options.actionsLogFn }
      : {}),
  });
  if (comparison.state !== "same") {
    return {
      confirmed: false,
      reason: comparison.state === "different"
        ? "PR failure differs from the merge-base failure"
        : `merge-base failure is not comparable: ${comparison.reason}`,
    };
  }
  return {
    confirmed: true,
    reason: `check "${checkName}" failed with the same signature at ${mergeBaseSha} and is green on newer base ${current.sha}`,
  };
}
