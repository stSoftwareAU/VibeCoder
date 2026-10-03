/**
 * PR body refresh for a fix run (Issue #3089).
 *
 * The PR body is assembled once, at PR creation, from
 * `docs/archive/pr-summaries/pr-summary-<N>.md` (and a handful of other
 * sections — evidence, milestone, the leading degraded-run section, bump
 * note, footer). A review-fix run that
 * rewrites that summary file and pushes new commits never touched the PR
 * body again, so a reviewer reading the description kept seeing the
 * original summary while the diff underneath it changed.
 *
 * This module gives the completion phase's body-assembly logic a second
 * caller: a fix run that pushed only new commits (no PR yet created on this
 * invocation) diffs the summary file against the pre-push head, and when it
 * changed, rebuilds the body the same way PR creation did and pushes the
 * update with `gh pr edit`. It never touches a PR body the worker did not
 * originally author (no {@link WORKER_PR_MARKER_PREFIX} marker), and it
 * never overwrites the body when the summary file was deleted — a missing
 * file is treated as "nothing to refresh", not as "blank the body".
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, Result } from "../types.ts";
import type { runGitCommand as runGitCommandType } from "./git_timeout.ts";
import {
  buildIdempotencyMarker,
  ensurePrReferencesIssue,
  WORKER_PR_MARKER_PREFIX,
} from "./pr_body.ts";
import { buildWorkerFooter } from "./worker_identity.ts";
import { loadPrSummary } from "./pr_summary_loader.ts";
import {
  findBranchEvidenceImages,
  formatBranchEvidenceSection,
} from "./screenshot_validation.ts";
import {
  convertEvidenceImagesToRawUrls,
  findScreenshotReferences,
} from "./pr_evidence.ts";
import { resolveImagePaths } from "./image_path_resolver.ts";
import { MILESTONE_CHILD_BUMP_NOTE } from "./bump_deps.ts";

/** Relative path of the PR summary file inside a repo checkout. */
function prSummaryPath(issueNumber: number): string {
  return `docs/archive/pr-summaries/pr-summary-${issueNumber}.md`;
}

/**
 * Build the PR body text the same way PR creation does.
 *
 * Mirrors the assembly order in `completion_phase.ts`: summary (or the
 * fallback when it is empty), the already-formatted extra sections
 * (evidence, milestone, bump note — concatenated by the caller in creation
 * order), the worker footer, then the idempotency marker. The result is run
 * through `ensureReferences` last, exactly as PR creation runs it through
 * `ensurePrReferencesIssue`.
 */
export function assemblePrBody(input: {
  summaryContent: string;
  issueNumber: number;
  extraSections: string;
  footer: string;
  ensureReferences?: (body: string, issueNumber: number) => string;
}): string {
  const ensureReferences = input.ensureReferences ?? ensurePrReferencesIssue;
  let body = input.summaryContent
    ? input.summaryContent + "\n\n"
    : `## Summary\n\nCloses #${input.issueNumber}.\n\n`;
  body += input.extraSections;
  body += input.footer;
  body += buildIdempotencyMarker(input.issueNumber);
  return ensureReferences(body, input.issueNumber);
}

/**
 * resolveImagePaths + raw-URL conversion at `headSha`, with the same
 * logging completion_phase does.
 *
 * `headSha` undefined (HEAD could not be resolved) skips the raw-URL
 * conversion step and logs the same warning completion_phase logs today —
 * the relative paths are left as-is rather than risk resolving against the
 * wrong commit.
 */
export async function finalisePrBodyImages(
  body: string,
  opts: { repoPath: string; githubRepo: string; headSha: string | undefined },
  logger: Logger,
): Promise<string> {
  const imageResolution = await resolveImagePaths(body, opts.repoPath);
  let result = imageResolution.body;
  for (const rewrite of imageResolution.rewrites) {
    logger.info("Repaired evidence image path", {
      from: rewrite.from,
      to: rewrite.to,
    });
  }
  for (const warning of imageResolution.warnings) {
    logger.warn("Could not resolve evidence image path", {
      path: warning.path,
      reason: warning.reason,
    });
  }

  if (opts.headSha) {
    const conversion = await convertEvidenceImagesToRawUrls(result, {
      repoPath: opts.repoPath,
      githubRepo: opts.githubRepo,
      commitSha: opts.headSha,
    });
    result = conversion.content;
    for (const converted of conversion.conversions) {
      logger.info("Converted evidence image to raw URL", {
        from: converted.from,
        to: converted.to,
      });
    }
  } else {
    logger.warn(
      "Could not resolve HEAD SHA — evidence images left as relative paths",
    );
  }

  return result;
}

/** Inputs for {@link syncPrBodyFromSummary}. */
export interface SyncPrBodyInput {
  /** `owner/repo`. */
  repo: string;
  /** PR number to refresh. */
  prNumber: number;
  /** Checkout of the PR head, after the push. */
  repoPath: string;
  /** Branch head before this fix run, or undefined when it could not be resolved. */
  beforeSha: string | undefined;
  /** Configured worker name (may be empty). */
  workerName: string;
  /** GitHub username used as the footer fallback. */
  githubUser: string;
  /** Canonical run id for this worker invocation. */
  runId?: string;
}

/** Collaborators {@link syncPrBodyFromSummary} needs — all injectable for testing. */
export interface SyncPrBodyDeps {
  /** Runs a `gh` command; throws on a non-zero exit. */
  runGhCommand: (args: string[]) => Promise<string>;
  /** Runs a `git` command. */
  runGitCommand: typeof runGitCommandType;
  logger: Logger;
}

/** Outcome of a sync attempt. */
export type SyncPrBodyOutcome =
  | { status: "updated"; issueNumber: number }
  | { status: "skipped"; reason: string };

/** The `gh pr view --json body,files` shape this module reads. */
interface PrViewJson {
  body: string;
  files: Array<{ path: string }>;
}

/** The worker-issue number a PR body's marker names, or undefined if absent. */
function issueNumberFromMarker(body: string): number | undefined {
  const start = body.indexOf(WORKER_PR_MARKER_PREFIX);
  if (start === -1) return undefined;
  const rest = body.slice(start + WORKER_PR_MARKER_PREFIX.length);
  const match = rest.match(/^(\d+) -->/);
  if (!match) return undefined;
  const issueNumber = Number(match[1]);
  return Number.isSafeInteger(issueNumber) ? issueNumber : undefined;
}

/** The `## Milestone` paragraph from an existing PR body, carried over verbatim. */
function extractMilestoneSection(body: string): string {
  const match = body.match(/\n## Milestone\n[^\n]*\n/);
  return match ? match[0] : "";
}

/** The bump-skip note from an existing PR body, carried over verbatim. */
function extractBumpSkipNote(body: string): string {
  return body.includes(MILESTONE_CHILD_BUMP_NOTE)
    ? `\n${MILESTONE_CHILD_BUMP_NOTE}\n`
    : "";
}

/**
 * The leading degraded-run section PR creation prepends (Issue #2562).
 *
 * It exists only on the live body — the summary file does not carry it — so
 * a rebuild that starts from the summary would otherwise drop it. Only a
 * block that opens the body counts; a later mention is the summary quoting
 * the phrase.
 */
function extractDegradedRunSection(body: string): string {
  const heading = "## ⚠️ Degraded run —";
  const start = body.indexOf(heading);
  if (start === -1) return "";
  if (body.slice(0, start).trim().length > 0) return "";
  const from = body.slice(start);
  const next = from.indexOf("\n## ");
  const block = (next === -1 ? from : from.slice(0, next)).trimEnd();
  return `${block}\n\n`;
}

/**
 * Refresh a PR's body from its (possibly rewritten) summary file.
 *
 * A review-fix run rewrites `docs/archive/pr-summaries/pr-summary-<N>.md`
 * and pushes new commits, but the PR itself keeps the body PR creation
 * wrote. This re-runs the same assembly PR creation does and pushes the
 * result with `gh pr edit`, but only when all of the following hold:
 *
 * - the PR carries the worker's own marker (never overwrite a body the
 *   worker did not author);
 * - a before-push SHA is available to diff against;
 * - the summary file actually changed since that SHA;
 * - the summary file was not deleted by that change (a deleted summary
 *   means "nothing to refresh", not "blank the body"); and
 * - the freshly assembled body actually differs from what is live.
 */
export async function syncPrBodyFromSummary(
  input: SyncPrBodyInput,
  deps: SyncPrBodyDeps,
): Promise<Result<SyncPrBodyOutcome>> {
  const { logger } = deps;

  if (!Number.isInteger(input.prNumber) || input.prNumber <= 0) {
    return {
      ok: false,
      error: new Error(`Invalid PR number: ${input.prNumber}`),
    };
  }

  // The CI processor passes workDir ?? "" — an empty path would make git
  // and the summary read run against the worker's own cwd.
  if (input.repoPath.trim().length === 0) {
    return {
      ok: false,
      error: new Error(
        `No checkout path for PR #${input.prNumber} — cannot read its summary file`,
      ),
    };
  }

  let view: PrViewJson;
  try {
    const raw = await deps.runGhCommand([
      "pr",
      "view",
      String(input.prNumber),
      "--repo",
      input.repo,
      "--json",
      "body,files",
    ]);
    view = JSON.parse(raw) as PrViewJson;
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `Failed to read PR #${input.prNumber}: ${(err as Error).message}`,
      ),
    };
  }

  const issueNumber = issueNumberFromMarker(view.body ?? "");
  if (issueNumber === undefined) {
    return {
      ok: true,
      value: { status: "skipped", reason: "no worker marker" },
    };
  }

  if (!input.beforeSha) {
    logger.warn(
      "No before-push SHA available — skipping PR body sync (Issue #3089)",
    );
    return {
      ok: true,
      value: { status: "skipped", reason: "no before-push sha" },
    };
  }

  const summaryRelPath = prSummaryPath(issueNumber);
  const diffResult = await deps.runGitCommand(
    ["diff", "--name-only", input.beforeSha, "HEAD", "--", summaryRelPath],
    { cwd: input.repoPath },
  );
  if (!diffResult.ok) {
    return {
      ok: false,
      error: new Error(
        `Failed to diff ${summaryRelPath}: ${diffResult.error.message}`,
      ),
    };
  }
  if (diffResult.value.stdout.trim().length === 0) {
    return {
      ok: true,
      value: { status: "skipped", reason: "summary unchanged" },
    };
  }

  const summaryResult = await loadPrSummary(input.repoPath, issueNumber);
  if (!summaryResult.ok) {
    return { ok: false, error: summaryResult.error };
  }
  if (summaryResult.value.source === "not_found") {
    return {
      ok: true,
      value: { status: "skipped", reason: "summary file deleted" },
    };
  }

  const changedFiles = (view.files ?? []).map((f) => f.path);
  const summaryContent = summaryResult.value.content;

  let extraSections = "";
  const branchEvidence = findBranchEvidenceImages(changedFiles);
  if (
    branchEvidence.length > 0 &&
    findScreenshotReferences(summaryContent).length === 0
  ) {
    extraSections += formatBranchEvidenceSection(branchEvidence);
  }
  extraSections += extractMilestoneSection(view.body ?? "");
  extraSections += extractBumpSkipNote(view.body ?? "");

  const footer = buildWorkerFooter({
    workerName: input.workerName,
    githubUser: input.githubUser,
    runId: input.runId,
  });

  let body = assemblePrBody({
    summaryContent,
    issueNumber,
    extraSections,
    footer,
  });

  const headShaResult = await deps.runGitCommand(
    ["rev-parse", "HEAD"],
    { cwd: input.repoPath },
  );
  const headSha = headShaResult.ok
    ? headShaResult.value.stdout.trim()
    : undefined;

  body = await finalisePrBodyImages(
    body,
    { repoPath: input.repoPath, githubRepo: input.repo, headSha },
    logger,
  );
  body = extractDegradedRunSection(view.body ?? "") + body;

  if (body.trim() === (view.body ?? "").trim()) {
    return {
      ok: true,
      value: { status: "skipped", reason: "body already current" },
    };
  }

  let tmpPath: string | undefined;
  try {
    tmpPath = await Deno.makeTempFile({
      prefix: "pr-body-sync-",
      suffix: ".md",
    });
    await Deno.writeTextFile(tmpPath, body);
    await deps.runGhCommand([
      "pr",
      "edit",
      String(input.prNumber),
      "--repo",
      input.repo,
      "--body-file",
      tmpPath,
    ]);
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `Failed to update PR #${input.prNumber} body: ${
          (err as Error).message
        }`,
      ),
    };
  } finally {
    if (tmpPath) {
      try {
        await Deno.remove(tmpPath);
      } catch (e) {
        logger.warn("Could not remove PR body temp file", {
          path: tmpPath,
          error: (e as Error).message,
        });
      }
    }
  }

  logger.info("Refreshed PR body from the rewritten summary (Issue #3089)", {
    repo: input.repo,
    prNumber: input.prNumber,
    issueNumber,
  });
  return { ok: true, value: { status: "updated", issueNumber } };
}

/**
 * Call {@link syncPrBodyFromSummary} (or an injected stand-in) and log the
 * outcome, without ever failing the caller's run (Issue #3089).
 *
 * Shared by the three fix-run processors (feedback, CI, merge-conflict) so
 * each one does not duplicate the "call, then log success or failure"
 * boilerplate.
 */
export async function runPrBodySync(
  input: SyncPrBodyInput,
  deps: SyncPrBodyDeps,
  syncFn: typeof syncPrBodyFromSummary = syncPrBodyFromSummary,
): Promise<void> {
  const syncResult = await syncFn(input, deps);
  if (!syncResult.ok) {
    deps.logger.warn("PR body sync failed (Issue #3089)", {
      prNumber: input.prNumber,
      error: syncResult.error.message,
    });
  } else {
    deps.logger.info("PR body sync", {
      prNumber: input.prNumber,
      ...syncResult.value,
    });
  }
}
