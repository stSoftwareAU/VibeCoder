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
 * A repair whose stopping check is green on the base is a repair too, but it
 * carries that check's name in `baseGreen`, so the repair may merge the base and
 * bring the base's fix in (Issue #4943). No other repair reading carries it.
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
   * `baseGreen` is set only when that reading is a failing check whose
   * base-branch run is `green` (Issue #4943). It then holds that one check's
   * name, as a one-element list. The walk visits the failing checks in the order
   * GitHub lists them and passes over each check that is red on the base with
   * the same failure; it stops at the first check that is not, and only a green
   * stop sets `baseGreen`. So a green check after a different failure, a
   * dependency audit, an unreadable log or a base run that is missing, stale or
   * unavailable is never named. `baseGreen` is undefined for every other reading.
   */
  | { kind: "repair"; reason: string; baseGreen?: string[] };

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
function repair(reason: string): BaseFailureDecision {
  return { kind: "repair", reason };
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
        baseGreen: [run.name],
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
