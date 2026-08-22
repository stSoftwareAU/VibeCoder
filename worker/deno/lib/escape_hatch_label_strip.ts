/**
 * Strip reserved labels from an escape-hatch follow-up issue (Issue #2824).
 *
 * The escape hatch (Issue #1826) lets Claude hand off genuinely out-of-scope
 * work by opening a **follow-up issue itself** (via `gh issue create`) and
 * naming it in its hand-off message. Because Claude builds the `gh issue
 * create` args, the worker never gets to filter the labels *before* creation —
 * the only deterministic guard is to strip reserved labels from the follow-up
 * issue *after* the fact, once `detectEscapeHatch` surfaces the `issueRef`.
 *
 * This is the escape-hatch sibling of the planning-sub-issue strip (Issue
 * #2822); both delegate to the one {@link stripReservedLabelsFromIssues}
 * helper so the `RESERVED_LABELS` set stays in sync automatically (DRY).
 *
 * **Every path that hands off gets the strip (Issue #3708,
 * SEC-6403af1e8b72).** The escape hatch is documented for PR feedback, CI fix
 * *and* issue work, but for a long time only `pr_feedback_processor.ts` called
 * this module, so the two `gh issue create` paths that run off Claude's own
 * output had no post-hoc guard at all.
 * {@link stripReservedLabelsFromModelFollowUp} is the message-level entry point
 * those paths use: it detects the hand-off in Claude's text itself and then
 * runs the same strip.
 *
 * **Failures are reported, not swallowed (Issue #3708, SEC-3fb85d0e61ca).**
 * Nothing here throws — an unparseable ref or a removal failure never breaks
 * the hand-off — but the outcome comes back as a
 * `Result<ReservedLabelStripSummary, ReservedLabelStripError>` and a failed
 * strip is retried once before being returned as `ok: false`, so the caller
 * fails loud instead of reading a warning as success.
 *
 * **Deliberate escalation is untouched.** The prompt tells Claude to *mention*
 * `needs-human`, not self-apply it; the separate `escalateToHuman` path (Issue
 * #1471) that *adds* `needs-human` to an existing issue is a post-creation add
 * and runs through a different code path. This guard only strips labels Claude
 * self-applied to the follow-up it just created.
 *
 * **Untrusted cross-repo target is constrained (Issue #3074).** The follow-up
 * `issueRef` is extracted from Claude's free-text hand-off message, which is
 * model output and therefore untrusted (OWASP LLM05 improper output handling).
 * A prompt-injection payload could steer Claude to emit an arbitrary
 * `victimOwner/victimRepo#NNN` reference, turning this guard into a
 * label-removal primitive against any repo the worker's token can reach. To
 * close that gap the cross-repo target must be the current repo or an explicit
 * monitored-repo allowlist; an off-allowlist target is logged and skipped
 * before any `removeLabel` mutation. The bare `#NNN` form is always pinned to
 * `currentRepo` and is unaffected.
 *
 * **A bogus number is skipped, not retried (Issue #210).** The reference is
 * model-authored free text, so the *number* can be wrong as well as the repo —
 * NEAT-AI-Lamarck#187 handed off naming `#3952`, a number from another repo's
 * series that does not exist there. The shared strip validates the ref with
 * the single label read it already performs before any mutation: a
 * definitively-absent issue comes back as `summary.unresolved` after one
 * WARNING, so this path never retries it and no caller raises an ERROR about
 * an issue that cannot exist. {@link describeUnresolvedFollowUp} turns that
 * ref into the line the claim-release comment states, so the agent's mistake
 * is visible off the host's log.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { GitHubClient, Logger, Result } from "../types.ts";
import {
  emptyStripSummary,
  type IssueRef,
  type ReservedLabelStripError,
  type ReservedLabelStripSummary,
  stripReservedLabelsFromIssues,
  stripResult,
} from "./reserved_label_strip.ts";
import { detectEscapeHatch } from "./escape_hatch.ts";

/** Outcome of a follow-up strip: what it did, or why it did not complete. */
export type FollowUpStripResult = Result<
  ReservedLabelStripSummary,
  ReservedLabelStripError
>;

/**
 * How many times a failed strip is attempted in total (Issue #3708).
 *
 * The strip re-reads the issue's labels each time and removes only what is
 * still there, so a retry is idempotent. Two attempts covers the transient API
 * error that a single `warn` used to hide, without turning a genuinely broken
 * token into a retry loop.
 */
const STRIP_ATTEMPTS = 2;

/** A parsed escape-hatch follow-up reference. */
export interface ParsedFollowUpRef {
  /** Repository in "owner/repo" form the follow-up issue lives in. */
  repo: string;
  /** The follow-up issue number. */
  issueNumber: number;
}

/**
 * Parse an escape-hatch `issueRef` into `{ repo, issueNumber }`.
 *
 * {@link import("./escape_hatch.ts").detectEscapeHatch} returns either a
 * fully-qualified `owner/repo#NNN` reference (cross-repo) or a bare `#NNN`
 * (same-repo). A bare reference resolves against `currentRepo` — the repo of
 * the run that produced the hand-off.
 *
 * @param issueRef - Reference string such as `owner/repo#123` or `#123`
 * @param currentRepo - Repository in "owner/repo" form used for a bare ref
 * @returns The parsed `{ repo, issueNumber }`, or `undefined` when the ref
 *          cannot be parsed.
 */
export function parseFollowUpIssueRef(
  issueRef: string,
  currentRepo: string,
): ParsedFollowUpRef | undefined {
  const trimmed = issueRef.trim();

  // Cross-repo: owner/repo#NNN
  const full = /^([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+)#(\d+)$/.exec(
    trimmed,
  );
  if (full && full[1] && full[2]) {
    return { repo: full[1], issueNumber: Number(full[2]) };
  }

  // Same-repo: bare #NNN
  const bare = /^#(\d+)$/.exec(trimmed);
  if (bare && bare[1]) {
    return { repo: currentRepo, issueNumber: Number(bare[1]) };
  }

  return undefined;
}

/**
 * The claim-release wording for a follow-up reference that does not exist
 * (Issue #210) — the line a human reads to see the agent's mistake.
 *
 * @param ref - The reference that did not resolve.
 * @param currentRepo - Repository the run was working on.
 */
export function describeUnresolvedFollowUp(
  ref: IssueRef,
  currentRepo: string,
): string {
  return ref.repo.toLowerCase() === currentRepo.toLowerCase()
    ? `follow-up reference #${ref.number} not found in this repo`
    : `follow-up reference ${ref.repo}#${ref.number} not found in ${ref.repo}`;
}

/**
 * Strip every `RESERVED_LABELS` member from an escape-hatch follow-up issue.
 *
 * Parses `issueRef` (same-repo `#NNN` or cross-repo `owner/repo#NNN`), then
 * delegates to {@link stripReservedLabelsFromIssues}. Descriptive labels
 * (`bug`, `enhancement`, `documentation`, …) are preserved.
 *
 * Never throws: an `undefined` ref is a no-op, and an unparseable ref or a
 * failure inside the strip is logged and returned rather than raised — the
 * escape-hatch hand-off result is unaffected. Issue #3708: a failed strip is
 * retried once and then returned as `ok: false` so the caller can fail loud;
 * an allowlist skip is a deliberate refusal, not a failure, and stays `ok`.
 *
 * @param args.issueRef - The follow-up reference from `detectEscapeHatch`
 *                        (`undefined` when none was detected)
 * @param args.currentRepo - Repository in "owner/repo" form for a bare ref
 * @param args.allowedRepos - Optional monitored-repo allowlist (Issue #3074).
 *                            A cross-repo target is only stripped when it is
 *                            `currentRepo` or a member of this list. When
 *                            omitted, only `currentRepo` is permitted — the
 *                            secure default that denies an injected
 *                            attacker-chosen target.
 * @param args.excludeIssueNumber - Optional number in `currentRepo` the run is
 *                                  already working on (Issue #3708). A
 *                                  self-reference is not a follow-up, so it is
 *                                  never stripped — this keeps the issue-work
 *                                  and CI-fix paths, whose text always names
 *                                  their own issue/PR, from removing a
 *                                  human-applied label from it.
 * @param args.ghClient - GitHub client providing `getIssue` + `removeLabel`
 * @param args.logger - Logger for the per-stripped-label WARNING and per-step
 *                      errors
 * @returns What the strip did, or an error carrying that summary
 */
export async function stripReservedLabelsFromFollowUp(args: {
  issueRef: string | undefined;
  currentRepo: string;
  allowedRepos?: string[];
  excludeIssueNumber?: number;
  ghClient: Pick<GitHubClient, "getIssue" | "removeLabel">;
  logger: Logger;
}): Promise<FollowUpStripResult> {
  const {
    issueRef,
    currentRepo,
    allowedRepos,
    excludeIssueNumber,
    ghClient,
    logger,
  } = args;

  if (!issueRef) return { ok: true, value: emptyStripSummary() };

  const parsed = parseFollowUpIssueRef(issueRef, currentRepo);
  if (!parsed) {
    logger.warn(
      "Could not parse escape-hatch follow-up issue reference",
      { issueRef, currentRepo },
    );
    return stripResult({
      ...emptyStripSummary(),
      failures: [{
        stage: "parse",
        error: `Unparseable follow-up reference: ${issueRef}`,
      }],
    });
  }

  // Issue #3708: the issue-work and CI-fix messages are *about* their own
  // issue/PR, so the detector can pick the run's own number as the "follow-up".
  // Stripping there would remove a human-applied `work-on`/`top-priority` from
  // live work — refuse before any mutation. Skipped, not failed: nothing is
  // wrong, there is simply no follow-up to guard.
  if (
    excludeIssueNumber !== undefined &&
    parsed.issueNumber === excludeIssueNumber &&
    parsed.repo.toLowerCase() === currentRepo.toLowerCase()
  ) {
    logger.info(
      "Skipping follow-up label strip: the reference is the issue the run is " +
        "already working on, not a follow-up",
      { repo: parsed.repo, issueNumber: parsed.issueNumber },
    );
    return {
      ok: true,
      value: {
        ...emptyStripSummary(),
        skipped: [{ repo: parsed.repo, number: parsed.issueNumber }],
      },
    };
  }

  // Issue #3074: the cross-repo target is model-supplied (untrusted). Refuse to
  // mutate labels on a repo that is neither the current repo nor on the
  // monitored-repo allowlist, so an injected `owner/repo#NNN` cannot select an
  // arbitrary GitHub issue as the target of a state-changing mutation.
  if (
    parsed.repo !== currentRepo && !(allowedRepos ?? []).includes(parsed.repo)
  ) {
    logger.warn(
      "Skipping escape-hatch follow-up label strip: cross-repo target is not " +
        "the current repo or on the monitored-repo allowlist (non-fatal)",
      { repo: parsed.repo, currentRepo, issueNumber: parsed.issueNumber },
    );
    return {
      ok: true,
      value: {
        ...emptyStripSummary(),
        skipped: [{ repo: parsed.repo, number: parsed.issueNumber }],
      },
    };
  }

  // Issue #3708: retry a failed strip before giving up. Each attempt re-reads
  // the labels and removes only what is still present, so this is idempotent.
  let result: FollowUpStripResult = { ok: true, value: emptyStripSummary() };
  for (let attempt = 1; attempt <= STRIP_ATTEMPTS; attempt++) {
    result = await stripAttempt(parsed, ghClient, logger);
    if (result.ok) return result;
    if (attempt < STRIP_ATTEMPTS) {
      logger.warn("Retrying reserved-label strip on escape-hatch follow-up", {
        repo: parsed.repo,
        issueNumber: parsed.issueNumber,
        attempt,
        error: result.error.message,
      });
    }
  }
  return result;
}

/**
 * One strip attempt, with the underlying helper's own `throw` contained.
 *
 * `stripReservedLabelsFromIssues` returns a `Result` rather than throwing, but
 * this keeps that guarantee local: a future change there can never turn a
 * hand-off into an exception.
 */
async function stripAttempt(
  parsed: ParsedFollowUpRef,
  ghClient: Pick<GitHubClient, "getIssue" | "removeLabel">,
  logger: Logger,
): Promise<FollowUpStripResult> {
  try {
    return await stripReservedLabelsFromIssues({
      repo: parsed.repo,
      issueNumbers: [parsed.issueNumber],
      ghClient,
      logger,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return stripResult({
      ...emptyStripSummary(),
      failures: [{
        repo: parsed.repo,
        issueNumber: parsed.issueNumber,
        stage: "remove",
        error,
      }],
    });
  }
}

/**
 * Detect an escape-hatch hand-off in Claude's own text and strip reserved
 * labels from the follow-up issue it names (Issue #3708, SEC-6403af1e8b72).
 *
 * The message-level entry point for the paths that have no pre-parsed
 * `issueRef` — CI fix (`.pr_response_message`) and issue work (Claude's final
 * output). Detection reuses {@link detectEscapeHatch}, so all three paths agree
 * on what a hand-off looks like; when no hand-off is detected this is a no-op
 * and no GitHub call is made.
 *
 * @param args.message - Claude-authored text that may name a follow-up issue
 * @param args.currentRepo - Repository in "owner/repo" form for a bare ref
 * @param args.loadAllowedRepos - Lazily-resolved monitored-repo allowlist,
 *   consulted only once a hand-off is actually detected so a plain run pays
 *   nothing for it. Omitted means current-repo-only (the secure default).
 * @param args.excludeIssueNumber - The issue/PR number the run is working on;
 *   a reference to it is a self-reference, never a follow-up
 * @param args.ghClient - GitHub client providing `getIssue` + `removeLabel`
 * @param args.logger - Logger for the per-stripped-label WARNING and per-step
 *                      errors
 * @returns What the strip did, or an error carrying that summary
 */
export async function stripReservedLabelsFromModelFollowUp(args: {
  message: string | undefined;
  currentRepo: string;
  loadAllowedRepos?: () => Promise<string[]>;
  excludeIssueNumber?: number;
  ghClient: Pick<GitHubClient, "getIssue" | "removeLabel">;
  logger: Logger;
}): Promise<FollowUpStripResult> {
  const detection = detectEscapeHatch(args.message, args.currentRepo);
  if (!detection.invoked || !detection.issueRef) {
    return { ok: true, value: emptyStripSummary() };
  }

  return await stripReservedLabelsFromFollowUp({
    issueRef: detection.issueRef,
    currentRepo: args.currentRepo,
    allowedRepos: await args.loadAllowedRepos?.() ?? [],
    ...(args.excludeIssueNumber !== undefined
      ? { excludeIssueNumber: args.excludeIssueNumber }
      : {}),
    ghClient: args.ghClient,
    logger: args.logger,
  });
}
