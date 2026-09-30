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
 * Uses Australian English throughout (behaviour, organisation).
 */

import type { CheckRunEntry } from "./pr_maintenance.ts";
import { sanitiseRepoName } from "./pr_ci_checks.ts";
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
  reason: "cancelled" | "never-started";
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
 */
export async function classifyRedChecks(opts: {
  repo: string;
  checks: CheckRunEntry[];
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Logger;
}): Promise<
  {
    code: CheckRunEntry[];
    infrastructure: InfrastructureCheck[];
    codeRunIds: Set<number>;
  }
> {
  const { repo, checks, ghCommandFn, logger } = opts;
  const code: CheckRunEntry[] = [];
  const infrastructure: InfrastructureCheck[] = [];
  const codeRunIds = new Set<number>();

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
