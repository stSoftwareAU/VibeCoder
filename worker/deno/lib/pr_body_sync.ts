/**
 * PR body refresh for a fix run (Issue #3089).
 *
 * The PR body is assembled once, at PR creation, from
 * `docs/archive/pr-summaries/pr-summary-<N>.md` (and a handful of other
 * sections — evidence, milestone, the leading degraded-run section, bump
 * note, footer). The degraded-run section is re-derived at sync time from the
 * current issue and summary, never copied forward (Issue #3350). A
 * review-fix run that rewrites that summary file and pushes new commits never
 * touched the PR body again, so a reviewer reading the description kept
 * seeing the original summary while the diff underneath it changed.
 *
 * This module gives the completion phase's body-assembly logic a second
 * caller: a fix run that pushed only new commits (no PR yet created on this
 * invocation) rebuilds the body from the summary file and pushes the update
 * with `gh pr edit`, but only when the summary actually changed. Staleness
 * is decided by a digest of the summary content the live body was built
 * from, recorded inside the body itself (see {@link PR_SUMMARY_DIGEST_PREFIX}).
 * Comparing that recorded digest against the summary at HEAD survives any
 * number of missed syncs — a human push, a run that ended on a path with no
 * sync call, or a processor that never called this module — unlike diffing
 * against a single pre-push SHA, which only catches a change made by *this*
 * run (Issue #3315). A body built before this change carries no digest
 * marker; for that legacy shape the before-push-SHA diff this module always
 * used is still how staleness is decided. It never touches a PR body the
 * worker did not originally author (no {@link WORKER_PR_MARKER_PREFIX}
 * marker), and it never overwrites the body when the summary file was
 * deleted — a missing file is treated as "nothing to refresh", not as
 * "blank the body".
 *
 * The rebuilt body also carries over the hidden sub-agent tier marker (Issue
 * #3403) the live body carries, so a review-fix refresh keeps attributing
 * the PR to the tier of the issue run that opened it rather than silently
 * dropping the marker.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { IssueSubAgentTier, Logger, Result } from "../types.ts";
import type { runGitCommand as runGitCommandType } from "./git_timeout.ts";
import {
  buildIdempotencyMarker,
  buildSubAgentTierMarker,
  ensurePrReferencesIssue,
  neutraliseSubAgentTierMarkers,
  subAgentTierFromBody,
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
import { rederiveDegradedSection } from "./degraded_delivery.ts";
import {
  buildMissingCriteriaPrNote,
  findMissingCriteria,
  withholdIssueClose,
} from "./missing_criterion_close_guard.ts";

/** Relative path of the PR summary file inside a repo checkout. */
function prSummaryPath(issueNumber: number): string {
  return `docs/archive/pr-summaries/pr-summary-${issueNumber}.md`;
}

/**
 * Marker prefix recording the SHA-256 digest of the summary content a PR
 * body was assembled from (Issue #3315). Followed by 64 lowercase hex
 * characters and `" -->`.
 */
export const PR_SUMMARY_DIGEST_PREFIX = '<!-- vibe-pr-summary sha256="';

/** Lowercase hex SHA-256 digest of `summaryContent`, encoded as UTF-8. */
export async function prSummaryDigest(summaryContent: string): Promise<string> {
  const bytes = new TextEncoder().encode(summaryContent);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The HTML-comment marker recording `digest` inside a PR body. */
export function buildSummaryDigestMarker(digest: string): string {
  return `${PR_SUMMARY_DIGEST_PREFIX}${digest}" -->`;
}

/**
 * The digest a PR body's marker records, or undefined when the body carries
 * none.
 *
 * Reads the LAST occurrence: the summary content opening the body may quote
 * an earlier sync's marker verbatim, and the real marker for this body
 * always follows the footer. Uses a fixed-width `{64}` quantifier rather
 * than a greedy/backtracking one.
 */
export function summaryDigestFromBody(body: string): string | undefined {
  const pattern = new RegExp(
    `${
      PR_SUMMARY_DIGEST_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }([0-9a-f]{64})" -->`,
    "g",
  );
  let last: string | undefined;
  for (const match of body.matchAll(pattern)) {
    last = match[1];
  }
  return last;
}

/**
 * Build the PR body text the same way PR creation does.
 *
 * Mirrors the assembly order in `completion_phase.ts`: summary (or the
 * fallback when it is empty — run through {@link neutraliseSubAgentTierMarkers}
 * either way, Issue #3403), the already-formatted extra sections
 * (evidence, milestone, bump note — concatenated by the caller in creation
 * order), the worker footer, the idempotency marker, the summary-digest
 * marker (Issue #3315) recording `input.summaryDigest` so a later sync can
 * tell whether the summary has moved on without needing a pre-push SHA, then
 * — when `input.subAgentTier` is defined — the sub-agent tier marker (Issue
 * #3403). The result is run through `ensureReferences` last, exactly as PR
 * creation runs it through `ensurePrReferencesIssue`.
 *
 * Issue #3177: a summary whose `## Acceptance Criteria` block marks any
 * criterion `missing` does not close the issue. Its closing keywords for the
 * issue become `Part of #N`, a `## Not closing #N` section names the missing
 * criteria, and `ensureReferences` is skipped so no `Closes #N` is appended.
 */
export function assemblePrBody(input: {
  summaryContent: string;
  issueNumber: number;
  extraSections: string;
  footer: string;
  /** SHA-256 digest (hex) of `summaryContent`, recorded in the body (Issue #3315). */
  summaryDigest: string;
  /**
   * The sub-agent tier the issue run that is assembling this body resolved
   * (Issue #3403). `undefined` only for a legacy PR body that never carried
   * one — every other caller must state the tier it ran with.
   */
  subAgentTier: IssueSubAgentTier | undefined;
  ensureReferences?: (body: string, issueNumber: number) => string;
}): string {
  const ensureReferences = input.ensureReferences ?? ensurePrReferencesIssue;
  // Issue #3403: neutralise any marker the summary quotes verbatim before it
  // is embedded, so a summary documenting the feature can never be read back
  // as a second, real tier marker.
  const summaryContent = neutraliseSubAgentTierMarkers(input.summaryContent);
  let body = summaryContent
    ? summaryContent + "\n\n"
    : `## Summary\n\nCloses #${input.issueNumber}.\n\n`;
  const missing = findMissingCriteria(input.summaryContent);
  if (missing.length > 0) {
    body = withholdIssueClose(body, input.issueNumber) +
      buildMissingCriteriaPrNote(input.issueNumber, missing) + "\n";
  }
  body += input.extraSections;
  body += input.footer;
  body += buildIdempotencyMarker(input.issueNumber);
  body += "\n" + buildSummaryDigestMarker(input.summaryDigest);
  if (input.subAgentTier !== undefined) {
    body += "\n" + buildSubAgentTierMarker(input.subAgentTier);
  }
  if (missing.length > 0) return body;
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
  /**
   * Branch head before this fix run, or undefined when it could not be
   * resolved. Only used when the live body carries no summary-digest marker
   * (Issue #3315) — a legacy body built before that marker existed. When the
   * body carries a digest marker, staleness is decided by comparing that
   * recorded digest against the summary at HEAD, and this field is ignored.
   */
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

/** The `gh pr view --json body,files,headRefOid` shape this module reads. */
interface PrViewJson {
  body: string;
  files: Array<{ path: string }>;
  /** The PR's current head SHA on the remote, used to detect a stale checkout. */
  headRefOid: string;
}

/**
 * The worker-issue number a PR body's marker names, or undefined if absent.
 *
 * Reads the LAST valid occurrence, consistent with {@link
 * summaryDigestFromBody}: the summary content opening the body may quote an
 * earlier sync's marker verbatim (or a non-numeric placeholder such as
 * `vibe-worker-issue-N`), and the real marker for this body always follows
 * the footer. An invalid occurrence (non-numeric, or overflowing a safe
 * integer) is skipped rather than stopping the search — the body's own
 * marker can still be found after it (PR #3353 review).
 */
function issueNumberFromMarker(body: string): number | undefined {
  const pattern = new RegExp(
    `${
      WORKER_PR_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }(\\d+) -->`,
    "g",
  );
  let last: number | undefined;
  for (const match of body.matchAll(pattern)) {
    const issueNumber = Number(match[1]);
    if (Number.isSafeInteger(issueNumber)) last = issueNumber;
  }
  return last;
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
 * this only locates it; the caller re-derives its content from current state
 * rather than copying it forward (Issue #3350). Only a block that opens the
 * body counts; a later mention is the summary quoting the phrase.
 */
function extractDegradedRunSection(body: string): string {
  const heading = "## ⚠️ Degraded run —";
  const start = body.indexOf(heading);
  if (start === -1) return "";
  if (body.slice(0, start).trim().length > 0) return "";
  // Stop at the next heading of any level. Archived summaries open with an
  // H1 (`# PR Summary — …`) before `## Summary`, and cutting only at `\n## `
  // carried that title — and one more copy of it on every later sync.
  const lines = body.slice(start).split("\n");
  let end = lines.length;
  for (let i = 1; i < lines.length; i++) {
    if (/^#{1,6} /.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  const block = lines.slice(0, end).join("\n").trimEnd();
  return block ? `${block}\n\n` : "";
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
 * - the summary file was not deleted (a deleted summary means "nothing to
 *   refresh", not "blank the body");
 * - the summary actually changed:
 *   - when the live body carries a summary-digest marker (Issue #3315), that
 *     recorded digest differs from the digest of the summary at HEAD; or
 *   - for a legacy body with no digest marker, a before-push SHA is
 *     available and `git diff` shows the summary file changed since it;
 * - this checkout's `HEAD` matches the PR's remote `headRefOid`, or
 *   `headRefOid` is an ancestor of `HEAD` (PR #3353 review, round 2) — a
 *   caller that only measured "nothing left unpushed" has not shown this
 *   checkout is current, only that it is not ahead, so a concurrent run that
 *   pushed a newer head must not be overwritten by a rebuild from this
 *   (older) checkout's summary. `headRefOid` being an ancestor rather than
 *   equal means GitHub's API has not yet caught up with this run's own
 *   verified push — not that someone else pushed — so that case still
 *   proceeds; and
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
      "body,files,headRefOid",
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

  const recordedDigest = summaryDigestFromBody(view.body ?? "");

  if (recordedDigest === undefined) {
    // Legacy body, built before the summary-digest marker existed (Issue
    // #3315): fall back to the original before-push-SHA diff.
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
  const currentDigest = await prSummaryDigest(summaryContent);

  if (recordedDigest !== undefined && recordedDigest === currentDigest) {
    return {
      ok: true,
      value: { status: "skipped", reason: "summary unchanged" },
    };
  }

  // PR #3353 review: a caller that measured "nothing left unpushed" has only
  // shown this checkout is not AHEAD of the remote — it can still be
  // BEHIND. A concurrent CI-fix or merge-conflict run can push a newer head
  // (with its own, newer summary) while this checkout's HEAD is still the
  // one it started from. Confirm this checkout is actually the PR's current
  // remote head before rebuilding the body from its local summary file, so
  // a stale checkout never overwrites a newer sync with superseded content.
  const headShaResult = await deps.runGitCommand(
    ["rev-parse", "HEAD"],
    { cwd: input.repoPath },
  );
  if (!headShaResult.ok) {
    return {
      ok: false,
      error: new Error(
        `Failed to resolve local HEAD for PR #${input.prNumber}: ${headShaResult.error.message}`,
      ),
    };
  }
  const headSha = headShaResult.value.stdout.trim();
  if (headSha !== view.headRefOid) {
    // GitHub updates a PR's headRefOid asynchronously after a push (PR #3353
    // review, round 2): a caller that just pushed and verified it on the
    // remote (verifyPushLanded) can still see the PRE-push SHA here for a
    // short window. That is not the same case this check exists to catch —
    // a concurrent run that pushed something NEWER. Tell them apart by
    // ancestry: when the PR's reported head is an ancestor of this
    // checkout's HEAD, they are the same lineage and GitHub simply has not
    // caught up yet, so the sync may proceed. Only a head that is actually
    // behind or diverged — not an ancestor — means someone else pushed.
    const ancestorResult = await deps.runGitCommand(
      ["merge-base", "--is-ancestor", view.headRefOid, headSha],
      { cwd: input.repoPath },
    );
    const remoteHeadIsStaleCopyOfOurs = ancestorResult.ok &&
      ancestorResult.value.code === 0;
    if (!remoteHeadIsStaleCopyOfOurs) {
      logger.warn(
        "Checkout HEAD does not match the PR's remote head — skipping body sync to avoid overwriting a newer push (PR #3353 review)",
        {
          repo: input.repo,
          prNumber: input.prNumber,
          headSha,
          remoteHead: view.headRefOid,
        },
      );
      return {
        ok: true,
        value: { status: "skipped", reason: "checkout is not the PR head" },
      };
    }
    logger.info(
      "PR's reported head lags behind this checkout's own verified push — proceeding (PR #3353 review, round 2)",
      {
        repo: input.repo,
        prNumber: input.prNumber,
        headSha,
        remoteHead: view.headRefOid,
      },
    );
  }

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

  // Issue #3403: carry over the tier marker the PR was created with, so a
  // review-fix refresh never drops the attribution a later outcome needs.
  // A legacy body with no marker (never carried a tier) gets none added.
  let body = assemblePrBody({
    summaryContent,
    issueNumber,
    extraSections,
    footer,
    summaryDigest: currentDigest,
    subAgentTier: subAgentTierFromBody(view.body ?? ""),
  });

  body = await finalisePrBodyImages(
    body,
    { repoPath: input.repoPath, githubRepo: input.repo, headSha },
    logger,
  );

  // Issue #3350: re-derive the degraded-run section from the current issue and
  // summary. Copying the live one forward left a banner that had become false
  // (for example "states no acceptance criteria") uncorrectable.
  const liveDegraded = extractDegradedRunSection(view.body ?? "");
  if (liveDegraded) {
    let issueBody: string;
    try {
      const raw = await deps.runGhCommand([
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        input.repo,
        "--json",
        "body",
      ]);
      const parsed = JSON.parse(raw) as { body?: unknown };
      if (typeof parsed.body !== "string") {
        throw new Error("issue body missing from gh output");
      }
      issueBody = parsed.body;
    } catch (err) {
      return {
        ok: false,
        error: new Error(
          `Failed to read issue #${issueNumber} to re-derive the degraded-run section of PR #${input.prNumber}: ${
            (err as Error).message
          }`,
        ),
      };
    }
    const rederived = rederiveDegradedSection({
      liveSection: liveDegraded,
      issueBody,
      prBody: body,
    });
    if (rederived !== liveDegraded) {
      logger.info("Re-derived the degraded-run section (Issue #3350)", {
        repo: input.repo,
        prNumber: input.prNumber,
        issueNumber,
        dropped: rederived === "",
      });
    }
    body = rederived + body;
  }

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
