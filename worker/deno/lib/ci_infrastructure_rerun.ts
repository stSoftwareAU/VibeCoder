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
 * the infrastructure ones' workflow runs directly — at most once per PR
 * head commit, so a rerun that keeps coming back cancelled escalates to a
 * human instead of looping forever.
 *
 * The once-per-head bound is recorded fleet-wide, not per host (Issue
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
  type FleetCiFixMarkers,
  isInfraRerunRecordedAt,
} from "./ci_fix_attempt_markers.ts";
import { replyToComment } from "./pr_comments.ts";
import {
  isDownstreamOfRedJob,
  type JobNeedsMap,
} from "./workflow_job_needs.ts";
import type { Logger } from "../types.ts";

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
 * it, and re-running it here would race that push. Bounded by a marker
 * file per repo/PR/head, written only after at least one rerun succeeds,
 * so a rerun GitHub itself refused is retried on the next scan rather
 * than silently given up on.
 *
 * @returns The workflow run ids that were re-run.
 */
export async function rerunInfrastructureChecks(opts: {
  repo: string;
  prNumber: number;
  headSha: string | undefined;
  infrastructure: InfrastructureCheck[];
  codeRunIds: ReadonlySet<number>;
  stateDir: string;
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Logger;
}): Promise<number[]> {
  const {
    repo,
    prNumber,
    headSha,
    infrastructure,
    codeRunIds,
    stateDir,
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

  const markerPath = `${stateDir}/${
    sanitiseRepoName(repo)
  }_pr${prNumber}_${headSha.toLowerCase()}.infra-rerun`;

  let alreadyRerun = true;
  try {
    await Deno.stat(markerPath);
  } catch {
    alreadyRerun = false;
  }
  if (alreadyRerun) {
    logger.warn(
      `${repo}#${prNumber} head ${headSha} was already re-run once for ` +
        `cancelled/never-started checks and is still red — a human needs ` +
        `to look (Issue #2914)`,
      { repo, prNumber, headSha },
    );
    return [];
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
      logger.warn(
        `Could not re-run workflow run ${runId} on ${repo}#${prNumber}: ` +
          `${message} (Issue #2914)`,
        { repo, prNumber, runId },
      );
    }
  }

  if (rerun.length > 0) {
    try {
      await Deno.mkdir(stateDir, { recursive: true });
      await Deno.writeTextFile(markerPath, new Date().toISOString());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        `Could not write the infra-rerun marker for ${repo}#${prNumber} ` +
          `at '${markerPath}': ${message} — a repeat scan may re-run this ` +
          `head again (Issue #2914)`,
        { repo, prNumber, markerPath },
      );
    }
  }

  return rerun;
}
