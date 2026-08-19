/**
 * Fail-loud strip of an untrusted `work-on` label at pickup (Issue #3575).
 *
 * The work-on collector (`collect_work_on_candidates.ts`) verifies that the
 * `work-on` label was added by a trusted author (`wasLabelAddedByAllowedAuthor`)
 * and, when it was not, silently skips the issue. That silence is the bug: an
 * issue that a worker (or any untrusted actor) self-labelled `work-on` looks
 * queued but is never picked up, and it can sit that way indefinitely — the
 * production case being NEAT-AI#3489, which sat ~25 h appearing queued.
 *
 * This helper turns that silent skip into a loud, self-correcting action: when
 * the most-recent `work-on` add is positively confirmed to come from an
 * untrusted author, strip the label and post exactly one explanatory comment so
 * the false "queued" state cannot persist.
 *
 * Fail-closed on uncertainty: if the label's most-recent adder cannot be
 * determined (timeline read failed, no `labeled` event), the helper does
 * nothing — it must never strip a label it could not confirm was untrusted, so
 * a transient API failure can never remove a human's genuine `work-on`.
 *
 * Every step is best-effort and non-fatal — a read/comment/remove failure is
 * logged and swallowed so a scan is never aborted. A hidden marker in the
 * comment body makes a re-scan idempotent (no duplicate comment) even if the
 * label removal fails and the issue is re-examined next scan.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../types.ts";
import type { TimelineCache } from "./timeline_cache.ts";
import { defaultLogger } from "./logger.ts";
import { getLabelLastAddInfoComplete } from "./issue_query.ts";

type GhFn = (args: string[]) => Promise<string>;

/**
 * Build the hidden marker embedded in the explanatory comment so a re-scan can
 * detect a prior strip and skip re-commenting. Exported for testing.
 */
export function buildUntrustedWorkOnMarker(issueNumber: number): string {
  return `<!-- untrusted-work-on-stripped: ${issueNumber} -->`;
}

/**
 * Build the explanatory comment body posted when an untrusted `work-on` label
 * is stripped. Exported for testing.
 */
export function buildUntrustedWorkOnComment(opts: {
  issueNumber: number;
  workOnLabel: string;
  addedBy: string;
}): string {
  const { issueNumber, workOnLabel, addedBy } = opts;
  return (
    `## \`${workOnLabel}\` removed — added by an untrusted author\n\n` +
    `**Why:** the \`${workOnLabel}\` label on this issue was applied by ` +
    `\`${addedBy}\`, who is not on the worker's trusted-author allowlist. The ` +
    `worker ignores an untrusted \`${workOnLabel}\` label, so the issue looked ` +
    `queued but would never have been picked up. The label has been removed so ` +
    `this false "queued" state cannot persist silently.\n\n` +
    `**Next step:** if this issue should be worked on, a trusted author must ` +
    `re-apply the \`${workOnLabel}\` label.\n\n` +
    `${buildUntrustedWorkOnMarker(issueNumber)}`
  );
}

/** Whether `login` is a trusted author (allowed and not a fleet worker). */
function isTrustedAdder(
  login: string,
  allowedAuthors: string[],
  fleetWorkerLogins: string[],
): boolean {
  const lower = login.toLowerCase();
  if (fleetWorkerLogins.some((a) => a.toLowerCase() === lower)) return false;
  return allowedAuthors.some((a) => a.toLowerCase() === lower);
}

/**
 * Strip an untrusted `work-on` label and post one explanatory comment, when the
 * most-recent adder is positively confirmed untrusted.
 *
 * @returns true when the label was removed; false when nothing was done
 *   (adder unconfirmed, adder actually trusted, or every step failed).
 */
export async function stripUntrustedWorkOnLabel(opts: {
  repo: string;
  issueNumber: number;
  workOnLabel: string;
  allowedAuthors: string[];
  fleetWorkerLogins?: string[];
  ghFn: GhFn;
  cache?: TimelineCache;
  logger?: Logger;
}): Promise<boolean> {
  const {
    repo,
    issueNumber,
    workOnLabel,
    allowedAuthors,
    ghFn,
    cache,
  } = opts;
  const logger = opts.logger ?? defaultLogger;
  const fleetWorkerLogins = opts.fleetWorkerLogins ?? [];

  // Determine the most-recent adder. Fail closed: if we cannot positively
  // identify who added the label, do nothing — a transient timeline-read
  // failure must never cause a genuine `work-on` to be stripped.
  //
  // Issue #3709 (SEC-c41e97b60238): use the exhaustive, partial-refusing read
  // — the same source of truth as the sibling trust gate. The page-1-only
  // `getLabelLastAddInfo` could name a stale adder on a busy issue (>100
  // timeline events), and this decision both removes a label and names that
  // actor in a public comment.
  let addInfo: { addedAt: number; addedBy: string } | null;
  try {
    addInfo = await getLabelLastAddInfoComplete(
      repo,
      issueNumber,
      workOnLabel,
      ghFn,
      cache,
    );
  } catch (err) {
    logger.warn(
      "stripUntrustedWorkOnLabel: could not read label add info (non-fatal)",
      {
        repo,
        issueNumber,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return false;
  }
  if (addInfo === null) {
    // No verifiable adder — cannot confirm untrusted, so leave the label alone.
    return false;
  }

  // Defensive: if the confirmed adder is actually trusted there is nothing to
  // fail loud about (the caller reached here on a `false` trust result, but the
  // check keeps this helper correct in isolation).
  if (isTrustedAdder(addInfo.addedBy, allowedAuthors, fleetWorkerLogins)) {
    return false;
  }

  // Post exactly one explanatory comment (fail loud) before removing the label,
  // so the reason is always recorded first. Dedup on the hidden marker so a
  // re-scan (e.g. after a failed removal) does not re-comment.
  const marker = buildUntrustedWorkOnMarker(issueNumber);
  let alreadyCommented = false;
  try {
    const raw = await ghFn([
      "api",
      `repos/${repo}/issues/${issueNumber}/comments`,
    ]);
    alreadyCommented = raw.includes(marker);
  } catch (err) {
    // Treat an unreadable comment thread as "not yet commented" and proceed —
    // a duplicate comment is a lesser evil than a silent false-queued issue.
    logger.warn(
      "stripUntrustedWorkOnLabel: could not read comments for dedup (non-fatal)",
      {
        repo,
        issueNumber,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }

  if (!alreadyCommented) {
    const body = buildUntrustedWorkOnComment({
      issueNumber,
      workOnLabel,
      addedBy: addInfo.addedBy,
    });
    try {
      await ghFn([
        "issue",
        "comment",
        String(issueNumber),
        "--repo",
        repo,
        "--body",
        body,
      ]);
    } catch (err) {
      logger.warn(
        "stripUntrustedWorkOnLabel: failed to post explanatory comment (non-fatal)",
        {
          repo,
          issueNumber,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  // Remove the untrusted label — the actual fix that clears the false-queued
  // state.
  try {
    await ghFn([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--remove-label",
      workOnLabel,
    ]);
    logger.warn("Stripped untrusted work-on label at pickup", {
      repo,
      issueNumber,
      addedBy: addInfo.addedBy,
      label: workOnLabel,
    });
    return true;
  } catch (err) {
    logger.warn(
      "stripUntrustedWorkOnLabel: failed to remove label (non-fatal)",
      {
        repo,
        issueNumber,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return false;
  }
}
