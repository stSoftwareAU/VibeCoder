/**
 * Infrastructure-vs-code triage for red CI checks (Issue #2914).
 *
 * A PR whose only red checks are `cancelled` — or a `failure` whose
 * Actions job never actually started (zero steps, e.g. an Actions budget
 * refusal) — used to be invisible to the CI-fix scan: `findFailedCiChecks`
 * only ever looked at checks whose conclusion was `failure`, so a
 * cancelled check was never re-run and never diagnosed, and the PR sat
 * stuck forever. And a zero-step `failure` was handed to the CI-fix agent
 * with no log to read, which cannot fix it.
 *
 * This module classifies each red check as infrastructure (cancelled, or
 * a failure that never started) or code (a genuine failure), and re-runs
 * the infrastructure ones' workflow runs directly. A head that keeps coming
 * back cancelled is re-run again on every scan rather than left for a person
 * (Issue #4304). A workflow GitHub permanently refuses is recorded by repo
 * and run id and skipped on later scans (Issue #4497).
 *
 * The once-per-head record is kept fleet-wide, not per host (Issue
 * #2919): it used to live in a marker file in each host's own state
 * volume, invisible to any other host, so two accounts each re-ran the
 * same cancelled run once — the bound Issue #2914 added held only
 * per-host. The record now lives on the pull request itself, as a
 * `vibe-ci-infra-rerun` marker (`lib/ci_fix_attempt_markers.ts`), the same
 * move Issue #1879 made for the CI-fix attempt cap.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import type { CheckRunEntry } from "./pr_maintenance.ts";
import {
  buildCiInfraRerunMarker,
  buildCiRerunRefusalMarker,
  type FleetCiFixMarkers,
  isCiRerunRefused,
  isInfraRerunRecordedAt,
} from "./ci_fix_attempt_markers.ts";
import { replyToComment } from "./pr_comments.ts";
import {
  isDownstreamOfRedJob,
  type JobNeedsMap,
} from "./workflow_job_needs.ts";
import type { Logger } from "../types.ts";
import { parseCheckSuiteId } from "./github_actions_log_fetcher.ts";

/** Red conclusions the CI-fix scan reads, beyond the historical `failure` only. */
export const RED_CHECK_CONCLUSIONS = ["failure", "cancelled"] as const;

/** A red check classified as infrastructure, not code. */
export interface InfrastructureCheck {
  /** The check run id. */
  id: number;
  /** The check name. */
  name: string;
  /** Why it was classified as infrastructure. */
  reason: "cancelled" | "never-started" | "aggregator";
  /** The Actions workflow run id behind the check, when it could be resolved. */
  runId: number | null;
}

/** Shape of the fields read off `gh api repos/{repo}/actions/jobs/{id}`. */
interface ActionsJob {
  runId: number | null;
  steps: unknown;
}

/** Look up the Actions job behind a check id, or null if it cannot be resolved. */
async function lookupActionsJob(
  repo: string,
  checkId: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<ActionsJob | null> {
  if (!Number.isInteger(checkId) || checkId <= 0) return null;
  try {
    const raw = await ghCommandFn([
      "api",
      `repos/${repo}/actions/jobs/${checkId}`,
    ]);
    const parsed = JSON.parse(raw) as { run_id?: unknown; steps?: unknown };
    const runId = Number.isInteger(parsed.run_id) &&
        (parsed.run_id as number) > 0
      ? parsed.run_id as number
      : null;
    return { runId, steps: parsed.steps };
  } catch {
    return null;
  }
}

/**
 * Classify a repo's red checks into infrastructure and code.
 *
 * A `cancelled` check is always infrastructure — GitHub does not run a
 * cancelled job's steps, so there is nothing to diagnose. A `failure`
 * check is infrastructure only when its Actions job resolved and reported
 * zero steps (it never actually started); any other shape, including a
 * lookup that could not resolve the job at all, keeps it on the CI-fix
 * route so a real failure is never dropped on a guess.
 *
 * A second pass then catches an `if: always()` aggregator (e.g. `CI
 * Required Checks`) that ran and failed for real: when `jobNeeds` is
 * given and the aggregator's redness is explained entirely by jobs this
 * pass has already put in `infrastructure` — and not by any other check
 * still in `code` — it is moved to `infrastructure` too. Without this,
 * the aggregator's run id "protects" the cancelled job's run from
 * {@link rerunInfrastructureChecks} while the #1878 aggregator filter
 * drops the aggregator itself from the CI-fix lane — stranding the PR
 * with neither a rerun nor a fix.
 *
 * `codeRunIds` is rebuilt from what is still in `code` once the pass is
 * done, rather than deleted from as each aggregator is reclassified: a
 * run id is shared by every check on that Actions run, so dropping it as
 * soon as *one* check on the run turns out to be the aggregator would
 * also strip the protection of a genuine, non-aggregator failure that
 * happens to share the same run — re-running a run the CI-fix fix-push
 * is about to restart (PR #2918 review).
 */
export async function classifyRedChecks(opts: {
  repo: string;
  checks: CheckRunEntry[];
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Logger;
  /** `needs:` topology, when a clone was available (Issue #2914 follow-up). */
  jobNeeds?: JobNeedsMap | null;
}): Promise<
  {
    code: CheckRunEntry[];
    infrastructure: InfrastructureCheck[];
    codeRunIds: Set<number>;
  }
> {
  const { repo, checks, ghCommandFn, logger, jobNeeds = null } = opts;
  let code: CheckRunEntry[] = [];
  const infrastructure: InfrastructureCheck[] = [];
  const codeRunIds = new Set<number>();
  const codeRunIdByName = new Map<string, number>();

  for (const check of checks) {
    if (check.conclusion !== "cancelled" && check.conclusion !== "failure") {
      // Defensive — the caller is expected to pass only red conclusions.
      code.push(check);
      continue;
    }

    const job = await lookupActionsJob(repo, check.id, ghCommandFn);

    if (check.conclusion === "cancelled") {
      if (job === null) {
        logger.warn(
          `Could not resolve the Actions job behind cancelled check ` +
            `'${check.name}' on ${repo} — re-running it is not possible ` +
            `without a run id (Issue #2914)`,
          { repo, checkId: check.id, checkName: check.name },
        );
      }
      infrastructure.push({
        id: check.id,
        name: check.name,
        reason: "cancelled",
        runId: job?.runId ?? null,
      });
      continue;
    }

    // conclusion === "failure"
    if (job !== null && Array.isArray(job.steps) && job.steps.length === 0) {
      infrastructure.push({
        id: check.id,
        name: check.name,
        reason: "never-started",
        runId: job.runId,
      });
      continue;
    }

    if (job === null) {
      // Routine for a check that is not an Actions job (or whose job
      // lookup failed transiently) — not a fault, just logged for
      // traceability, and the check still goes to CI-fix as before.
      logger.info(
        `Could not resolve the Actions job behind failing check ` +
          `'${check.name}' on ${repo} — routing to CI-fix as usual ` +
          `(Issue #2914)`,
        { repo, checkId: check.id, checkName: check.name },
      );
    }
    code.push(check);
    if (job?.runId !== null && job?.runId !== undefined) {
      codeRunIds.add(job.runId);
      codeRunIdByName.set(check.name, job.runId);
    }
  }

  // Second pass: an aggregator in `code` whose redness traces only to
  // `infrastructure` jobs (never to another `code` job) is infrastructure
  // too. `otherCodeNames` excludes the check itself so a self-loop in the
  // `needs:` graph can never explain its own redness.
  if (jobNeeds !== null && infrastructure.length > 0 && code.length > 0) {
    const infraNames = infrastructure.map((c) => c.name);
    const remaining: CheckRunEntry[] = [];
    for (const check of code) {
      const otherCodeNames = code
        .filter((c) => c.name !== check.name)
        .map((c) => c.name);
      const downstreamOfInfra = isDownstreamOfRedJob(
        check.name,
        infraNames,
        jobNeeds,
      );
      const downstreamOfOtherCode = otherCodeNames.length > 0 &&
        isDownstreamOfRedJob(check.name, otherCodeNames, jobNeeds);
      if (downstreamOfInfra && !downstreamOfOtherCode) {
        infrastructure.push({
          id: check.id,
          name: check.name,
          reason: "aggregator",
          runId: codeRunIdByName.get(check.name) ?? null,
        });
        continue;
      }
      remaining.push(check);
    }
    code = remaining;

    // Rebuild codeRunIds from what actually remains as code: a run id is
    // shared by every check on that run, so a run id is only dropped once
    // no check still in `code` maps to it.
    codeRunIds.clear();
    for (const check of code) {
      const runId = codeRunIdByName.get(check.name);
      if (runId !== undefined) codeRunIds.add(runId);
    }
  }

  return { code, infrastructure, codeRunIds };
}

const FORTY_HEX = /^[0-9a-f]{40}$/i;

/**
 * Re-run the workflow runs behind a PR's infrastructure checks, at most
 * once per head commit (Issue #2914).
 *
 * A run that also carries a real code failure (its id is in
 * `codeRunIds`) is left alone — the CI-fix agent's fix-push re-triggers
 * it, and re-running it here would race that push. Each head gets one
 * `vibe-ci-infra-rerun` marker comment on the pull request itself (Issue
 * #2919), posted only after at least one rerun succeeds. GitHub's explicit
 * `This workflow run cannot be retried` refusal is recorded separately by
 * repo and run id, so later scans skip that run regardless of head.
 *
 * @returns The workflow run ids that were re-run.
 */
export async function rerunInfrastructureChecks(opts: {
  repo: string;
  prNumber: number;
  headSha: string | undefined;
  infrastructure: InfrastructureCheck[];
  codeRunIds: ReadonlySet<number>;
  fleetMarkers: FleetCiFixMarkers;
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Logger;
}): Promise<number[]> {
  const {
    repo,
    prNumber,
    headSha,
    infrastructure,
    codeRunIds,
    fleetMarkers,
    ghCommandFn,
    logger,
  } = opts;

  if (infrastructure.length === 0) return [];

  if (headSha === undefined || !FORTY_HEX.test(headSha)) {
    logger.warn(
      `Cannot re-run infrastructure checks on ${repo}#${prNumber} — no ` +
        `valid 40-character head sha (Issue #2914)`,
      { repo, prNumber, headSha },
    );
    return [];
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    logger.warn(
      `Cannot re-run infrastructure checks on ${repo} — PR number is not ` +
        `a positive integer (Issue #2914)`,
      { repo, prNumber },
    );
    return [];
  }

  // Issue #2919: the once-per-head bound binds on the PR's fleet-authored
  // markers. When they could not be read — the comment thread failed, or
  // the fleet identity is unresolved — re-running anyway would defeat the
  // bound, so this scan stands down and the next one retries.
  if (!fleetMarkers.fleetResolved) {
    logger.error(
      `Cannot re-run infrastructure checks on ${repo}#${prNumber} — the ` +
        `fleet-wide infra-rerun bound cannot be evaluated (unreadable ` +
        `comments or unresolved fleet identity); retrying on the next scan ` +
        `(Issue #2919)`,
      { repo, prNumber, headSha },
    );
    return [];
  }

  // Issue #4304: a head already re-run and still cancelled or never
  // started is re-run again rather than left for a person — a rerun costs
  // no agent time, and the run clears once the runner or Actions budget is
  // back. The marker only dedups the comment: one per head.
  const alreadyRecorded = isInfraRerunRecordedAt(fleetMarkers, headSha);
  if (alreadyRecorded) {
    logger.info(
      `${repo}#${prNumber} head ${headSha} was already re-run for ` +
        `cancelled/never-started checks and is still red — re-running it ` +
        `again (Issue #4304)`,
      { repo, prNumber, headSha },
    );
  }

  const seen = new Set<number>();
  const candidates: number[] = [];
  for (const check of infrastructure) {
    if (check.runId === null) {
      logger.warn(
        `Infrastructure check '${check.name}' on ${repo}#${prNumber} has ` +
          `no resolvable run id — cannot re-run it (Issue #2914)`,
        { repo, prNumber, checkName: check.name },
      );
      continue;
    }
    if (codeRunIds.has(check.runId)) {
      logger.info(
        `Skipping re-run of run ${check.runId} on ${repo}#${prNumber} — ` +
          `it also carries a real code failure, left for the CI-fix ` +
          `fix-push (Issue #2914)`,
        { repo, prNumber, runId: check.runId },
      );
      continue;
    }
    if (seen.has(check.runId)) continue;
    seen.add(check.runId);
    candidates.push(check.runId);
  }

  const rerun: number[] = [];
  for (const runId of candidates) {
    if (isCiRerunRefused(fleetMarkers, repo, runId)) {
      logger.info(
        `Skipping permanently refused workflow run ${runId} on ${repo} ` +
          `(Issue #4497)`,
        { repo, prNumber, runId },
      );
      continue;
    }
    try {
      await ghCommandFn(["run", "rerun", String(runId), "--repo", repo]);
      rerun.push(runId);
      logger.info(
        `Re-ran workflow run ${runId} on ${repo}#${prNumber} — cancelled ` +
          `or never started, treated as infrastructure not code ` +
          `(Issue #2914)`,
        { repo, prNumber, runId },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("This workflow run cannot be retried")) {
        logger.warn(
          `GitHub permanently refused workflow run ${runId} on ${repo}#${prNumber}: ` +
            `${message} (Issue #4497)`,
          { repo, prNumber, runId },
        );
        const marker = buildCiRerunRefusalMarker({ repo, runId });
        const posted = await replyToComment(
          repo,
          prNumber,
          marker,
          ghCommandFn,
        );
        if (!posted.ok) {
          logger.error(
            `Could not persist permanent rerun refusal for ${repo} run ${runId}: ` +
              `${posted.error.message} (Issue #4497)`,
            { repo, prNumber, runId },
          );
        }
        continue;
      }
      logger.warn(
        `Could not re-run workflow run ${runId} on ${repo}#${prNumber}: ` +
          `${message} (Issue #2914)`,
        { repo, prNumber, runId },
      );
    }
  }

  if (rerun.length > 0 && !alreadyRecorded) {
    // Issue #2919: the record lives on the pull request, not in this
    // host's state volume, so every fleet host reads the same bound.
    const marker = buildCiInfraRerunMarker({ head: headSha.toLowerCase() });
    const posted = await replyToComment(
      repo,
      prNumber,
      marker,
      ghCommandFn,
    );
    if (!posted.ok) {
      logger.error(
        `Could not post the infra-rerun marker for ${repo}#${prNumber} ` +
          `head ${headSha}: ${posted.error.message} — a repeat scan may ` +
          `re-run this head again (Issue #2919)`,
        { repo, prNumber, headSha },
      );
    }
  }

  return rerun;
}

/**
 * Re-run the failed jobs of the Actions run behind one check (Issue #4304).
 *
 * The CI-fix lane used to end a run that changed nothing by asking someone
 * to "please re-run the failing check". The worker does that itself: the
 * check id is the Actions job id, the job names its run, and
 * `gh run rerun <run> --failed` re-runs exactly the jobs that failed. A
 * repeat failure arrives as a fresh check run, so the CI-fix scan picks it
 * up again and the fleet-wide attempt cap — not a person — bounds the loop.
 *
 * A `suite-<id>` startup failure has no job. Resolve its workflow by suite
 * id and re-run the whole workflow, not `--failed` jobs. Its id need not
 * change, so the scanner and processor use the fleet-wide repair cap.
 *
 * A transient lookup or re-run failure is logged and retried next scan. The
 * explicit permanent refusal is recorded in the PR comment thread and not
 * retried; inability to read refusal markers stands the rerun down.
 *
 * @returns The run id that was re-run, or `null` when nothing was re-run.
 */
export async function rerunFailedJobsOfCheck(opts: {
  repo: string;
  prNumber: number;
  checkId: string;
  fleetMarkers: FleetCiFixMarkers;
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Logger;
}): Promise<{
  runId: number | null;
  outcome:
    | "rerun"
    | "permanent-refusal"
    | "already-refused"
    | "transient-failure"
    | "unresolved";
}> {
  const { repo, prNumber, checkId, fleetMarkers, ghCommandFn, logger } = opts;
  if (!fleetMarkers.fleetResolved) {
    logger.error(
      `Cannot re-run workflow for ${repo}#${prNumber} — permanent refusal ` +
        `state is unreadable or the fleet identity is unresolved (Issue #4497)`,
      { repo, prNumber, checkId },
    );
    return { runId: null, outcome: "transient-failure" };
  }
  const suiteId = parseCheckSuiteId(checkId);
  let runId: number | null = null;
  if (suiteId !== null) {
    try {
      const response = JSON.parse(
        await ghCommandFn([
          "api",
          `repos/${repo}/actions/runs?check_suite_id=${suiteId}`,
        ]),
      );
      const runs: unknown = response?.workflow_runs;
      if (Array.isArray(runs)) {
        const run = runs.find((entry) => entry?.check_suite_id === suiteId);
        if (Number.isSafeInteger(run?.id) && run.id > 0) runId = run.id;
      }
    } catch {
      // The suite remains eligible for repair; the fleet-wide cap bounds it.
    }
  } else {
    const job = await lookupActionsJob(repo, Number(checkId), ghCommandFn);
    runId = job?.runId ?? null;
  }
  if (runId === null) {
    logger.warn(
      `Could not resolve the Actions run behind check ${checkId} on ${repo} ` +
        `— the failing check was not re-run; the next scan retries ` +
        `(Issue #4304)`,
      { repo, checkId },
    );
    return { runId: null, outcome: "unresolved" };
  }
  if (isCiRerunRefused(fleetMarkers, repo, runId)) {
    logger.info(
      `Skipping permanently refused workflow run ${runId} on ${repo} ` +
        `(Issue #4497)`,
      { repo, prNumber, checkId, runId },
    );
    return { runId, outcome: "already-refused" };
  }
  try {
    await ghCommandFn([
      "run",
      "rerun",
      String(runId),
      ...(suiteId === null ? ["--failed"] : []),
      "--repo",
      repo,
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("This workflow run cannot be retried")) {
      logger.warn(
        `GitHub permanently refused workflow run ${runId} on ${repo}#${prNumber}: ` +
          `${message} (Issue #4497)`,
        { repo, prNumber, checkId, runId },
      );
      const posted = await replyToComment(
        repo,
        prNumber,
        buildCiRerunRefusalMarker({ repo, runId }),
        ghCommandFn,
      );
      if (!posted.ok) {
        logger.error(
          `Could not persist permanent rerun refusal for ${repo} run ${runId}: ` +
            `${posted.error.message} (Issue #4497)`,
          { repo, prNumber, checkId, runId },
        );
      }
      return { runId, outcome: "permanent-refusal" };
    }
    logger.warn(
      `Could not re-run workflow ${runId} on ${repo}: ` +
        `${message} — the next scan retries (Issue #4304)`,
      { repo, checkId, runId },
    );
    return { runId, outcome: "transient-failure" };
  }
  logger.info(
    `Re-ran workflow ${runId} on ${repo} after a CI-fix ` +
      `run that changed nothing (Issue #4304)`,
    { repo, checkId, runId },
  );
  return { runId, outcome: "rerun" };
}
