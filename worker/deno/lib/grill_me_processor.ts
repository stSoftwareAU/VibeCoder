/**
 * Grill-me iterative-clarification processor (Issue #1615, #1618, #1693, #2064).
 *
 * Drives the back-and-forth grill-me workflow: each round invokes Claude
 * once to read prior comments, refine the understanding, and either pose
 * the next round of clarifying choices or finalise the requirement and
 * hand the issue to the planning workflow.
 *
 * Modelled on refinement_processor.ts and planning_processor.ts.
 *
 * Turn signal (Issue #1693, #2064): the processor adds the existing
 * `needs-human` label immediately after a successful Round N comment is
 * posted. The developer removes the label themselves once they have
 * replied; the discovery filter (which already skips `needs-human`
 * issues) then picks the issue up on the next scan.
 *
 * Completion signal (Issue #2064): on the Ready-marker path the
 * processor likewise ensures `needs-human` is **added** alongside
 * removing `grill-me`. Every grill-me completion requires the user to
 * pick a next-phase label (`planning` or `work-on`) by hand, so
 * `needs-human` is the correct signal that the ball is back in the
 * user's court — it is no longer removed on convergence.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  failedRunOutcome,
  outcomeForNonCodingResult,
  outcomeForThrown,
  type RunOutcome,
} from "./run_outcome.ts";
import type { GitHubClient, GitHubComment, Logger, Result } from "../types.ts";
import type { WorkerDeps } from "./issue_worker_wiring.ts";
import type { IssueContext } from "./issue_worker.ts";
import {
  type HeartbeatHandle,
  startHeartbeat,
  stopHeartbeat,
} from "./heartbeat.ts";
import { loadPrompt } from "./prompt_manager.ts";
import {
  buildCodingGuidelines,
  buildVerbosityBlock,
} from "./prompt_builder.ts";
import {
  buildBoundaryIntegrityInstruction,
  createPromptDelimiters,
  generateBoundaryId,
  sanitiseDelimitedComments,
  sanitiseDelimiterPatterns,
} from "./prompt_delimiter.ts";
import {
  evaluateRequirementsRubric,
  formatRubricFindings,
} from "./requirements_rubric.ts";
import { prepareTrustAnnotatedCommentList } from "./comment_trust_filter.ts";
import { invalidateComments } from "./comment_cache.ts";
import { getLabelLastRemoveInfo } from "./issue_query.ts";
import { escalateToHuman } from "./needs_human_escalation.ts";
import { reportGrillMeDegradation } from "./grill_me_run_stats.ts";
import { releaseAllWorkerClaims } from "./claim_release.ts";
import { redactSecrets } from "./secret_redaction.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Marker prefix for a worker grill-me round comment. */
export const GRILL_ME_ROUND_MARKER = "## Grill-Me Round ";

/** Marker for the final confirmation comment posted on the last round. */
export const GRILL_ME_FINAL_MARKER = "## Grill-Me — Understanding Confirmed";

/**
 * Marker the v2 prompt posts when Claude believes the requirement is
 * understood and the developer should choose the next workflow phase
 * (Issue #1647, #1648).
 */
export const GRILL_ME_READY_MARKER = "## Grill-Me — Ready for Next Phase";

/** Marker the processor itself posts when a round fails. */
export const GRILL_ME_FAILED_MARKER = "## Grill-Me Failed";

/**
 * Footer prefix every worker-authored comment carries (see
 * `worker_identity.ts`). Used to recognise a comment as worker-authored
 * regardless of which fleet identity posted it (Issue #2729), without
 * hardcoding a single account.
 */
export const WORKER_COMMENT_FOOTER_PREFIX = "🤖 Processed by:";

/** Result of a grill-me processing run. */
export interface GrillMeResult {
  /** True when Claude was invoked (regardless of outcome). */
  processed: boolean;
  /** The round number processed (1-indexed). 0 when not processed. */
  roundNumber: number;
  /**
   * True when the safety-cap round was reached without convergence
   * (Issue #1648). The previous "isFinalRound" semantics are gone — the
   * processor never forces finalisation, so this flag now indicates only
   * that the safety cap was hit.
   */
  isFinalRound: boolean;
  /** True when Claude posted at least one comment in this round. */
  workerCommentPosted: boolean;
  /**
   * True when the worker removed the `grill-me` label as defence in
   * depth after detecting Claude's Ready marker (Issue #1648). The
   * processor never adds operational labels — the developer applies the
   * next-phase label.
   */
  labelsSwapped: boolean;
  /**
   * True when defence-in-depth removed the `grill-me` label that
   * Claude left behind after posting a Ready marker (Issue #1648).
   */
  defenceInDepthApplied: boolean;
  /**
   * True when the processor escalated to `needs-human` — either
   * because of two consecutive failures, or because the
   * `maxGrillMeRounds` safety cap was reached without convergence
   * (Issue #1648).
   */
  escalatedToHuman: boolean;
  /**
   * True when this run added the `needs-human` label, either after
   * a successful Round N post (Issue #1693) or after the Ready
   * marker as the completion turn signal (Issue #2064). Escalation
   * paths set `escalatedToHuman` instead — they do not set this flag.
   */
  needsHumanAdded: boolean;
  /**
   * Reserved for any future path that needs to remove `needs-human`
   * (Issue #1693). As of Issue #2064 the Ready-marker paths add
   * `needs-human` instead of removing it, so this flag is always
   * false in the current implementation. Kept on the result type for
   * backwards compatibility with downstream callers.
   */
  needsHumanRemoved: boolean;
  /**
   * True when this run unassigned the worker user from the issue
   * (Issue #1830). The worker assigns itself when claiming, but once
   * a round is posted (or the work is escalated/finished) the ball is
   * in the developer's court — leaving the assignment in place causes
   * the assigned-without-heartbeat detector to trigger an unnecessary
   * "Automatic recovery" comment ~30 minutes later.
   */
  workerUnassigned: boolean;
  /**
   * True when this round was served by a degraded model and the worker
   * therefore applied the `degraded-model` label and posted a stats comment
   * (Issue #2717). Undefined/false on rounds that did not invoke Claude or
   * were served by the expected top-tier model.
   */
  degraded?: boolean;
  /** Human-readable summary. */
  summary: string;
}

/** Options for the grill-me processor. */
export interface GrillMeProcessorDeps {
  /** GitHub client for API operations. */
  ghClient: GitHubClient;
  /** Logger for diagnostic output. */
  logger: Logger;
  /** Worker deps for cross-cutting concerns. */
  deps: WorkerDeps;
  /**
   * Prompts directory the round's templates are read from (Issue #968).
   *
   * Defaults to `getPromptsDir()`, which is what production wants. A test
   * names this instead of exporting `PROMPTS_DIR`, so pointing the loader at
   * a directory that does not exist — the prompt-build failure path of
   * #2727 — no longer mutates the process environment every other parallel
   * worker shares.
   */
  promptsDir?: string;
}

/** Options for building the grill-me prompt. */
/** Trust configuration for the grill-me comment history (Issue #3706). */
export interface GrillMeCommentTrustOptions {
  /** Configured allowed issue authors (primary trusted users). */
  allowedAuthors: string[];
  /** Configured authorised commenters (secondary trusted users). */
  authorisedCommenters: string[];
  /** Whether untrusted comments are included, annotated (default true). */
  includeUntrustedComments?: boolean;
  /** Worker login — its own round comments are trusted (API-supplied author). */
  githubUser?: string;
}

/** Trust-annotated comment history for the grill-me prompt (Issue #3706). */
export interface GrillMeCommentHistory {
  /** Trust-annotated, rate-limited comment blob ready for the prompt. */
  formattedComments: string;
  /** Nonce borne by the genuine per-comment headers in the blob. */
  boundaryId: string;
  /** Security audit messages for logging (suspicious/flooding comments). */
  securityAuditMessages: string[];
}

export interface BuildGrillMePromptOptions {
  roundNumber: number;
  maxRounds: number;
  issueBody: string;
  commentHistory: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  codingGuidelines: string;
  verbosityInstructions: string;
  /**
   * Boundary id whose per-comment headers inside `commentHistory` are genuine
   * (Issue #3706). Supplied when the history came from
   * {@link formatCommentHistory}; the prompt adopts it as this run's nonce so
   * the integrity instruction names the very id those headers bear, and the
   * second scrub leaves them byte-intact.
   */
  commentBoundaryId?: string;
  /** Path to the prompts directory (defaults to repo prompts dir). */
  promptsDir?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Count how many grill-me rounds the worker has already posted.
 *
 * A worker round is a comment authored by `githubUser` containing the
 * `## Grill-Me Round N` marker. The final-confirmation comment also counts
 * because finalisation is itself the last round.
 *
 * @param comments - Issue comments (chronological order)
 * @param githubUser - Worker's GitHub username
 * @returns The number of prior rounds posted by the worker
 */
export function countGrillMeRounds(
  comments: readonly GitHubComment[],
  githubUser: string,
): number {
  let count = 0;
  for (const c of comments) {
    if (c.author !== githubUser) continue;
    if (
      c.body.includes(GRILL_ME_ROUND_MARKER) ||
      c.body.includes(GRILL_ME_FINAL_MARKER)
    ) {
      count++;
    }
  }
  return count;
}

/**
 * Count consecutive grill-me failure markers at the tail of the comment list.
 *
 * Used to escalate to `needs-human` when two consecutive rounds have failed
 * (Claude error / timeout). In a fleet that runs more than one worker
 * identity (e.g. `Vibecoderbot` on one host and `stsvcbot` on another),
 * failures may be authored by *different* identities, so a `## Grill-Me
 * Failed` marker counts regardless of which worker posted it (Issue #2729) —
 * keyed off the distinctive marker rather than a single hardcoded account.
 *
 * Counting stops (the streak resets) at:
 *   - a successful round (`## Grill-Me Round` / final marker), or
 *   - a genuine non-worker (human) reply — a human comment between failures
 *     means the loop is no longer "consecutive worker failures".
 *
 * Any other worker-authored comment (the current identity, the
 * `🤖 Processed by:` footer of another identity, or a Ready marker) is
 * skipped without resetting, so it neither counts nor breaks the streak.
 *
 * @param comments - Issue comments (chronological order)
 * @param githubUser - Worker's GitHub username (current identity)
 * @returns Number of consecutive failures at the tail across all identities
 */
export function countConsecutiveFailures(
  comments: readonly GitHubComment[],
  githubUser: string,
): number {
  let count = 0;
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i]!;
    const body = c.body;
    // A failure marker counts regardless of which worker identity posted it
    // (Issue #2729) — failures by different machines must still accumulate.
    if (body.includes(GRILL_ME_FAILED_MARKER)) {
      count++;
      continue;
    }
    // A successful round resets the streak.
    if (
      body.includes(GRILL_ME_ROUND_MARKER) ||
      body.includes(GRILL_ME_FINAL_MARKER)
    ) {
      break;
    }
    // Any other worker-authored comment (current identity, another fleet
    // identity's footer, or a Ready marker) is not a failure and not a human
    // reply — skip it without resetting.
    if (
      c.author === githubUser ||
      body.includes(WORKER_COMMENT_FOOTER_PREFIX) ||
      body.includes(GRILL_ME_READY_MARKER)
    ) {
      continue;
    }
    // A genuine human reply between failures resets the streak.
    break;
  }
  return count;
}

/**
 * Format the comment history block passed to Claude.
 *
 * Issue #3706 (SEC-3a91c6d47e50): grill-me used to build this block itself,
 * prefixing every comment with a bare `**author** (date):` line. That header
 * is plain markdown any commenter can type, so an untrusted commenter could
 * fabricate a maintainer reply — and because the bespoke formatter bypassed
 * `prepareTrustAnnotatedComments`, none of the shared defences applied: no
 * trust classification, no suspicious-pattern audit, and no Issue #1342 volume
 * caps. The history now goes through the same trust pipeline every other
 * comment-fed prompt uses, so each comment carries a genuine
 * `---COMMENT_<nonce> [TRUSTED|UNTRUSTED] author=<login>---` header whose
 * author comes from the GitHub API and whose nonce an attacker cannot guess.
 *
 * The worker's own login is trusted for this thread: grill-me convergence is
 * driven by the worker's own `## Grill-Me Round N` comments, and the author
 * login is API-supplied, so it cannot be spoofed by a commenter.
 *
 * The per-comment `createdAt` timestamp is dropped — it was only ever part of
 * the forgeable attribution line, and the prompt reads the history as an
 * ordered thread ("oldest first"), not by date.
 *
 * @param comments - Issue comments (chronological order)
 * @param options - Trust configuration for classifying comment authors
 * @returns Trust-annotated history plus the nonce and any audit messages
 */
export function formatCommentHistory(
  comments: readonly GitHubComment[],
  options: GrillMeCommentTrustOptions,
): GrillMeCommentHistory {
  const boundaryId = generateBoundaryId();
  if (comments.length === 0) {
    return {
      formattedComments: "(no prior comments)",
      boundaryId,
      securityAuditMessages: [],
    };
  }

  const trusted = [...options.allowedAuthors];
  if (options.githubUser) trusted.push(options.githubUser);

  const result = prepareTrustAnnotatedCommentList(
    comments.map((c) => ({ body: c.body, author: { login: c.author } })),
    {
      allowedAuthors: trusted,
      authorisedCommenters: options.authorisedCommenters,
      includeUntrustedComments: options.includeUntrustedComments ?? true,
    },
    boundaryId,
  );

  // Every comment can be filtered out (operational comments only, or strict
  // mode with no trusted authors). Say so rather than emitting an empty block
  // that reads as "the thread is empty".
  const formattedComments = result.formattedComments ||
    "(no prior comments available for this prompt)";

  return {
    formattedComments,
    boundaryId: result.boundaryId,
    securityAuditMessages: result.securityAuditMessages,
  };
}

/**
 * Detect what kind of comment Claude posted by scanning its final output
 * text for the Round / Ready marker substrings (Issue #1843).
 *
 * Claude posts the round comment via `gh issue comment` as a subprocess,
 * so the worker has no direct return value to inspect. The grill-me
 * prompt instructs Claude to title its comment with the literal marker
 * (`## Grill-Me Round N` or `## Grill-Me — Ready for Next Phase`), and
 * Claude's final stdout summary commonly echoes that title. When the
 * marker is detected we can synthesise the comment in-memory and skip
 * the verification refetch entirely.
 *
 * Returns:
 *   - `"ready"` when the Ready marker text appears in Claude's output.
 *     Ready takes precedence — Claude only posts Ready when grilling
 *     has converged and the round marker would not also appear.
 *   - `"round"` when only the Round marker appears.
 *   - `null` when neither marker is detected — caller should fall back
 *     to a single comment-list refetch as a safety net.
 *
 * @param claudeOutput - Claude's stdout result text from `runClaudeWithRetry`
 */
export function detectGrillMeOutcome(
  claudeOutput: string,
): "ready" | "round" | null {
  if (!claudeOutput) return null;
  if (claudeOutput.includes(GRILL_ME_READY_MARKER)) return "ready";
  if (claudeOutput.includes(GRILL_ME_ROUND_MARKER)) return "round";
  return null;
}

/**
 * Synthesise an in-memory `GitHubComment` for a freshly-posted round
 * comment (Issue #1843). Used when the verification refetch is skipped
 * because Claude's output reliably indicated what was posted. The id is
 * `0` (placeholder — the real id is unknown without a refetch); the body
 * carries only the marker so downstream `countGrillMeRounds` /
 * `hasReadyMarkerBeenPosted` checks treat it as a worker round.
 *
 * @param outcome - "round" or "ready"
 * @param roundNumber - Round number to embed in the synthesised body
 * @param githubUser - Worker's GitHub username (becomes the comment author)
 */
export function synthesiseRoundComment(
  outcome: "round" | "ready",
  roundNumber: number,
  githubUser: string,
): GitHubComment {
  const body = outcome === "ready"
    ? GRILL_ME_READY_MARKER
    : `${GRILL_ME_ROUND_MARKER}${roundNumber}`;
  return {
    id: 0,
    body,
    author: githubUser,
    createdAt: new Date().toISOString(),
    reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
  };
}

/**
 * Detect whether the worker has already posted a Ready-for-Next-Phase
 * marker (Issue #1648). When true the processor must not invoke Claude
 * again — it is the developer's turn to apply the next-phase label.
 *
 * @param comments - Issue comments (chronological order)
 * @param githubUser - Worker's GitHub username
 * @returns True when a Ready marker authored by the worker is present
 */
export function hasReadyMarkerBeenPosted(
  comments: readonly GitHubComment[],
  githubUser: string,
): boolean {
  for (const c of comments) {
    if (c.author !== githubUser) continue;
    if (c.body.includes(GRILL_ME_READY_MARKER)) return true;
  }
  return false;
}

/**
 * Detect whether the worker is awaiting a developer reply to the most
 * recent grill-me Round N comment (Issue #1876).
 *
 * Returns true when the most recent worker-authored grill-me marker is
 * a Round N (or final-confirmation) comment AND no non-worker comment
 * has been posted after it. In that state the ball is in the
 * developer's court — the processor must not invoke Claude again,
 * otherwise a second worker (or a re-run of the same worker after a
 * label-strip) would fast-forward to a Ready marker before the
 * developer has had a chance to answer.
 *
 * The race this guards against: machine A posts Round N, signals
 * "awaiting developer" via the `needs-human` label, and unassigns.
 * Because `needs-human` is an operational label and the worker user
 * is not on the authorised allowlist, `verifyOperationalLabels`
 * strips it. Machine B then picks the issue up and re-enters
 * grill-me. Without this comment-state-based gate, machine B would
 * invoke Claude again — Claude reads Round N (with checkboxes
 * pre-filled by Claude itself) and self-answers them, producing a
 * Ready marker simultaneously with Round N from the user's
 * perspective.
 *
 * Ready markers are not handled here — {@link hasReadyMarkerBeenPosted}
 * is the dedicated check for that case and is called first.
 *
 * @param comments - Issue comments (chronological order)
 * @param githubUser - Worker's GitHub username
 * @returns True when a developer reply is pending after the latest round
 */
export function isAwaitingDeveloperReply(
  comments: readonly GitHubComment[],
  githubUser: string,
): boolean {
  // Walk backwards. The first non-worker comment we hit means the
  // developer (or another participant) has spoken since the latest
  // worker activity — proceed normally. The first worker Round N /
  // final-confirmation marker we encounter before any non-worker
  // comment means the worker is awaiting a reply. Worker comments
  // that are not grill-me markers (claim, heartbeat, etc.) are
  // skipped so they do not confuse the lookback.
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i]!;
    if (c.author !== githubUser) {
      return false;
    }
    if (
      c.body.includes(GRILL_ME_ROUND_MARKER) ||
      c.body.includes(GRILL_ME_FINAL_MARKER)
    ) {
      return true;
    }
    // Other worker comments (claim, heartbeat, failure marker) — skip past.
  }
  return false;
}

/**
 * Detect whether a grill-me round is already posted and still awaiting a
 * developer reply, **regardless of which identity posted it** (Issue #3768).
 *
 * In a fleet running more than one worker identity (e.g. `Vibecoderbot` on one
 * host and `stsvcbot` on another), a peer may post `## Grill-Me Round N`
 * moments before this identity claims the same issue. Because
 * {@link countGrillMeRounds} and {@link hasReadyMarkerBeenPosted} only see
 * comments authored by the current identity, the post-run verification used to
 * conclude "Claude did not post a Grill-Me round comment" and post a
 * `## Grill-Me Failed` marker that directly contradicted the visible round
 * comment (observed on #3767). Keying off the distinctive marker rather than
 * the author is consistent with the Issue #2729 failure-marker fix.
 *
 * Walking backwards guards against masking a genuine failure: a round marker
 * only counts while it is still the newest thing in the thread. Once a human
 * has replied to it, the round we were supposed to post really is missing and
 * the failure must be reported loudly.
 *
 * @param comments - Issue comments (chronological order)
 * @param githubUser - Worker's GitHub username (current identity)
 * @returns True when a round/final/ready marker from any author is unanswered
 */
export function hasGrillMeRoundAwaitingReply(
  comments: readonly GitHubComment[],
  githubUser: string,
): boolean {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i]!;
    const body = c.body;
    if (
      body.includes(GRILL_ME_ROUND_MARKER) ||
      body.includes(GRILL_ME_FINAL_MARKER) ||
      body.includes(GRILL_ME_READY_MARKER)
    ) {
      return true;
    }
    // Worker-authored non-marker comments (this identity's claim/heartbeat,
    // another identity's `🤖 Processed by:` footer, a failure marker) neither
    // confirm nor deny the round — skip without deciding.
    if (
      c.author === githubUser ||
      body.includes(WORKER_COMMENT_FOOTER_PREFIX) ||
      body.includes(GRILL_ME_FAILED_MARKER)
    ) {
      continue;
    }
    // A genuine non-worker reply is newer than any round marker.
    return false;
  }
  return false;
}

/**
 * Find the `createdAt` ISO timestamp of the most recent worker-authored
 * Round N (or final-confirmation) comment, or `null` when no such
 * comment exists (Issue #1878).
 *
 * Used to test whether a `needs-human` removal event in the issue
 * timeline came AFTER the latest grilling round. Heartbeat and other
 * non-marker worker comments are skipped so they do not shadow the
 * round timestamp.
 *
 * @param comments - Issue comments (chronological order)
 * @param githubUser - Worker's GitHub username
 */
export function findLatestWorkerRoundTimestamp(
  comments: readonly GitHubComment[],
  githubUser: string,
): string | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i]!;
    if (c.author !== githubUser) continue;
    if (
      c.body.includes(GRILL_ME_ROUND_MARKER) ||
      c.body.includes(GRILL_ME_FINAL_MARKER)
    ) {
      return c.createdAt;
    }
  }
  return null;
}

/**
 * Decide whether a non-worker user has explicitly removed
 * `needs-human` after the latest worker Round N (Issue #1878).
 *
 * The grill-me workflow uses `needs-human` as a turn signal — added
 * after Round N is posted, removed when the developer has answered.
 * If the user removes the label without posting a separate reply
 * comment, the awaiting-reply guard would otherwise re-add the label
 * on every iteration, producing the "constantly labelling as
 * needs-human but no questions posed" loop reported in #1878.
 *
 * Returns true when:
 *   - the timeline shows a recent `unlabeled needs-human` event;
 *   - the actor is NOT the worker user (i.e. the removal was an
 *     intentional developer signal, not the operational-label
 *     verifier stripping the label); and
 *   - the removal occurred AFTER the most recent worker Round N
 *     comment.
 *
 * Returns false when no such event exists, when the timeline lookup
 * fails (fail-safe — preserve the existing awaiting-reply behaviour),
 * or when the most recent removal pre-dates the latest Round N.
 */
export function isNonWorkerRemovalAfterRound(
  removeInfo: { removedAt: number; removedBy: string } | null,
  latestRoundTimestamp: string | null,
  githubUser: string,
): boolean {
  if (removeInfo === null) return false;
  if (latestRoundTimestamp === null) return false;
  if (removeInfo.removedBy.toLowerCase() === githubUser.toLowerCase()) {
    return false;
  }
  const roundMs = Date.parse(latestRoundTimestamp);
  if (Number.isNaN(roundMs)) return false;
  return removeInfo.removedAt * 1000 > roundMs;
}

/**
 * Build the grill-me prompt by loading the latest template and substituting
 * placeholders. Throws no exceptions — returns Result for callers.
 *
 * Prompt-injection defence (Issue #1343, #2513): the issue title, issue
 * body, and comment history are untrusted GitHub content fed to an agent
 * with full `git`/`gh`/shell tool scope. Mirroring `buildPrFeedbackPrompt`
 * and the other untrusted-content builders, each value is run through
 * `sanitiseDelimiterPatterns()` (neutralising any forged boundary markers)
 * and wrapped in per-invocation randomised `[UNTRUSTED]` delimiters, and a
 * boundary-integrity instruction is appended so the agent treats the
 * wrapped content as data, not instructions.
 *
 * @param opts - Prompt options
 * @returns The rendered prompt content
 */
export async function buildGrillMePrompt(
  opts: BuildGrillMePromptOptions,
): Promise<Result<string>> {
  const templateResult = await loadPrompt(
    "grill-me",
    opts.promptsDir,
  );
  if (!templateResult.ok) return templateResult;

  // Generate randomised delimiters per invocation and sanitise every
  // untrusted value before wrapping (Issue #1343, #2513). When the history
  // carries genuine per-comment trust headers, adopt their nonce as this run's
  // boundary id so the integrity instruction names that very id (Issue #3706).
  const delimiters = createPromptDelimiters(opts.commentBoundaryId);
  const sanitisedTitle = sanitiseDelimiterPatterns(opts.issueTitle);
  const sanitisedBody = sanitiseDelimiterPatterns(opts.issueBody);
  // Scrub the history through the header-preserving variant so a genuine
  // `---COMMENT_<nonce> [TRUSTED] author=…---` line stays byte-intact and an
  // attacker's forgery stays visibly degraded beside it (Issue #3637).
  const sanitisedHistory = sanitiseDelimitedComments(
    opts.commentHistory,
    delimiters.boundaryId,
  );

  const wrappedTitle =
    `${delimiters.titleStart}\n${sanitisedTitle}\n${delimiters.titleEnd}`;
  const wrappedBody =
    `${delimiters.bodyStart}\n${sanitisedBody}\n${delimiters.bodyEnd}`;
  const wrappedHistory =
    `${delimiters.commentsStart}\n${sanitisedHistory}\n${delimiters.commentsEnd}`;

  const replacements: Record<string, string> = {
    ROUND_NUMBER: String(opts.roundNumber),
    MAX_ROUNDS: String(opts.maxRounds),
    REPO: opts.repo,
    ISSUE_NUMBER: String(opts.issueNumber),
    ISSUE_TITLE: wrappedTitle,
    ISSUE_BODY: wrappedBody,
    COMMENT_HISTORY: wrappedHistory,
    BOUNDARY_INTEGRITY_INSTRUCTION: buildBoundaryIntegrityInstruction(
      delimiters.boundaryId,
    ),
    CODING_GUIDELINES: opts.codingGuidelines,
    VERBOSITY_INSTRUCTIONS: opts.verbosityInstructions,
    // Deterministic requirements-quality pre-pass over the understanding
    // already in the body (Issue #519), in the shape of the
    // `duplicated_knowledge` duplicate-block pre-pass: the worker computes the
    // named classes so the round starts from a repeatable list rather than
    // model judgement alone. The renderer sanitises and truncates every
    // excerpt it draws from the untrusted body, so this block is safe outside
    // the fenced region.
    RUBRIC_FINDINGS: formatRubricFindings(
      evaluateRequirementsRubric({
        title: opts.issueTitle,
        body: opts.issueBody,
      }),
    ),
  };

  // Function-form replacements so a literal `$` in untrusted content is not
  // interpreted as a String.replaceAll substitution pattern (Issue #3654).
  // The string form expands `$&`, `` $` ``, `$'` and `$$`, which would let an
  // attacker splice the already-rendered prefix — ending in a genuine, nonced
  // boundary marker — into the untrusted region without guessing the nonce.
  let rendered = templateResult.value;
  for (const [key, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(`{{${key}}}`, () => value);
  }

  return { ok: true, value: rendered };
}

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------

/**
 * Process a single grill-me round for an issue.
 *
 * Flow (Issue #1648, #1693, #2064):
 *   1. Claim the issue.
 *   2. Start heartbeat.
 *   3. Fetch comments.
 *   4. If two consecutive rounds failed → escalate to needs-human.
 *   5. If the Ready marker has already been posted → no-op (developer
 *      must apply the next-phase label); remove any lingering
 *      `grill-me` label and ensure `needs-human` is applied as the
 *      completion turn signal (Issue #2064).
 *   6. If the safety cap `maxGrillMeRounds` has been reached without
 *      convergence → escalate to needs-human with a recommendation.
 *   7. Build the grill-me prompt and invoke Claude.
 *   8. If Claude posted the Ready marker, remove `grill-me` and ensure
 *      `needs-human` is applied (defence in depth — Issue #2064).
 *      Never add `planning`, `work-on`, or any other operational
 *      label.
 *   9. Otherwise, after Round N is posted, add `needs-human` so the
 *      developer's reply is the turn signal (Issue #1693).
 *  10. Stop heartbeat.
 *
 * @param ctx - Issue context
 * @param processorDeps - Processor dependencies
 * @returns Result with the round outcome
 */
export async function processGrillMe(
  ctx: IssueContext,
  processorDeps: GrillMeProcessorDeps,
): Promise<Result<GrillMeResult>> {
  const { repo, issueNumber, githubUser, config } = ctx;
  const { deps, ghClient, logger } = processorDeps;

  // Claim the issue atomically.
  const workerId = `${githubUser}-${Date.now()}`;
  const claimResult = await deps.issues.claimIssue({
    repo,
    issueNumber,
    githubUser,
    workerId,
  });
  if (!claimResult.ok) {
    return {
      ok: false,
      error: new Error(`Failed to claim issue: ${claimResult.error.message}`),
    };
  }
  if (!claimResult.value.claimed) {
    return {
      ok: false,
      error: new Error(
        `Issue claimed by another worker: ${
          claimResult.value.winnerId ?? "unknown"
        }`,
      ),
    };
  }

  // Start periodic heartbeat to prevent false crash detection.
  // The initial record is awaited (Issue #1888); on failure release the
  // claim so the next iteration can retry without a stale assignment.
  const heartbeatStart = await startHeartbeat({
    repo,
    issueNumber,
    workDir: config.workDir,
    recordFn: deps.crashHandling.recordHeartbeat,
    clearFn: deps.crashHandling.clearHeartbeat,
  });
  if (!heartbeatStart.ok) {
    try {
      await ghClient.unassignIssue(repo, issueNumber, [githubUser]);
    } catch (err) {
      logger.warn(
        "Failed to release claim after heartbeat start failure (non-fatal)",
        {
          repo,
          issueNumber,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
    return {
      ok: false,
      error: new Error(
        `Failed to start heartbeat for ${repo}#${issueNumber}: ${heartbeatStart.error.message}`,
      ),
    };
  }
  const heartbeatHandle: HeartbeatHandle = heartbeatStart.value;

  // The run outcome rides the final heartbeat clear (Issue #4330) so the
  // release comment states a deliberate no-PR — never a ⚠️ failure — for
  // a round that worked, and a diagnosed failure for one that did not.
  const runStartedAtMs = Date.now();
  let runOutcome: RunOutcome | undefined;
  try {
    const result = await _processGrillMeWithHeartbeat(ctx, processorDeps);
    runOutcome = outcomeForNonCodingResult(
      "grill-me",
      result,
      (Date.now() - runStartedAtMs) / 1000,
      "grill-me round posted",
    );
    return result;
  } catch (err) {
    runOutcome = outcomeForThrown(
      "grill-me",
      err,
      (Date.now() - runStartedAtMs) / 1000,
    );
    throw err;
  } finally {
    await stopHeartbeat(heartbeatHandle, runOutcome);
  }
}

/** Inner processor body — heartbeat lifecycle is managed by the wrapper. */
async function _processGrillMeWithHeartbeat(
  ctx: IssueContext,
  processorDeps: GrillMeProcessorDeps,
): Promise<Result<GrillMeResult>> {
  const { repo, issueNumber, issueTitle, issueBody, githubUser, config } = ctx;
  const { ghClient, logger, deps, promptsDir } = processorDeps;

  const grillMeLabel = config.grillMeLabel;
  const needsHumanLabel = config.needsHumanLabel;
  const maxRounds = Math.max(1, config.maxGrillMeRounds);

  // 1) Fetch comments. Mutable: re-assigned by the pre-Claude race guard
  //    to the freshly-fetched list (Issue #1876).
  let comments: GitHubComment[];
  try {
    comments = await ghClient.getIssueComments(repo, issueNumber);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.warn("Failed to fetch comments for grill-me", {
      repo,
      issueNumber,
      error: errorMsg,
    });
    return await postFailureAndUnassign(
      ghClient,
      repo,
      issueNumber,
      githubUser,
      `Failed to fetch comments: ${errorMsg}`,
      logger,
    );
  }

  // 2) Detect consecutive failures.
  const consecutiveFailures = countConsecutiveFailures(comments, githubUser);
  if (consecutiveFailures >= 2) {
    logger.warn(
      "Two consecutive grill-me failures — escalating to needs-human",
      {
        repo,
        issueNumber,
        consecutiveFailures,
      },
    );
    await escalateToHuman({
      ghClient,
      repo,
      target: { kind: "issue", number: issueNumber },
      needsHumanLabel,
      reason:
        `Two consecutive grill-me rounds failed — the worker cannot continue the clarification ` +
        `loop without help.`,
      nextStep:
        `Inspect the prior grill-me failure comments above, fix the underlying issue (or close ` +
        `this issue if it is no longer needed), then remove the \`${needsHumanLabel}\` label so ` +
        `the worker can resume.`,
      heading: "Grill-Me Escalation",
      githubUser,
      logger,
      deps: { github: { ensureLabelExists: deps.github.ensureLabelExists } },
    });
    const escalationUnassigned = await releaseAllWorkerClaims(
      ghClient,
      repo,
      issueNumber,
      githubUser,
      logger,
    );
    return {
      ok: true,
      value: {
        processed: false,
        roundNumber: 0,
        isFinalRound: false,
        workerCommentPosted: false,
        labelsSwapped: false,
        defenceInDepthApplied: false,
        escalatedToHuman: true,
        needsHumanAdded: false,
        needsHumanRemoved: false,
        workerUnassigned: escalationUnassigned,
        summary:
          `Escalated to ${needsHumanLabel} after ${consecutiveFailures} consecutive failures`,
      },
    };
  }

  // 3) Skip when the worker has already posted the Ready marker — it is
  //    the developer's turn to apply the next-phase label (Issue #1648).
  if (hasReadyMarkerBeenPosted(comments, githubUser)) {
    logger.info(
      "Ready-for-Next-Phase marker already posted — skipping Claude invocation",
      { repo, issueNumber },
    );
    // Defence in depth (Issue #2064): if `grill-me` still lingers,
    // remove it; if `needs-human` is missing, route through the
    // shared escalateToHuman helper so the label add is paired with
    // an explanation comment (Issue #2209). The dedup key prevents
    // a fresh comment on every loop iteration once the first
    // explanation has been posted.
    let removedGrillMe = false;
    let addedNeedsHuman = false;
    try {
      const issue = await ghClient.getIssue(repo, issueNumber);
      if (issue.labels.includes(grillMeLabel)) {
        try {
          await ghClient.removeLabel(repo, issueNumber, grillMeLabel);
          removedGrillMe = true;
        } catch (err) {
          logger.warn("Failed to remove lingering grill-me label", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (!issue.labels.includes(needsHumanLabel)) {
        const outcome = await escalateToHuman({
          ghClient,
          repo,
          target: { kind: "issue", number: issueNumber },
          needsHumanLabel,
          reason:
            "The earlier `## Ready for Next Phase` comment is still awaiting a next-phase label.",
          nextStep:
            "Apply `planning`, `work-on`, or `top-priority` (or close the issue) so the worker " +
            "knows how to proceed.",
          dedupKey: `grill-me-ready-${issueNumber}`,
          additionalDedupMarkers: [GRILL_ME_READY_MARKER],
          prefetchedComments: comments,
          githubUser,
          logger,
          deps: {
            github: { ensureLabelExists: deps.github.ensureLabelExists },
          },
        });
        if (outcome.ok && outcome.value.labelAdded) {
          addedNeedsHuman = true;
        }
      }
    } catch (err) {
      logger.warn("Failed to fetch issue labels to clean up grill-me", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Ball is in the developer's court — unassign the worker so the
    // assigned-without-heartbeat detector cannot trigger a spurious
    // "Automatic recovery" comment (Issue #1830).
    const unassigned = await releaseAllWorkerClaims(
      ghClient,
      repo,
      issueNumber,
      githubUser,
      logger,
    );
    return {
      ok: true,
      value: {
        processed: false,
        roundNumber: 0,
        isFinalRound: false,
        workerCommentPosted: false,
        labelsSwapped: removedGrillMe,
        defenceInDepthApplied: removedGrillMe || addedNeedsHuman,
        escalatedToHuman: false,
        needsHumanAdded: addedNeedsHuman,
        needsHumanRemoved: false,
        workerUnassigned: unassigned,
        summary: "Ready already posted, awaiting developer label change",
      },
    };
  }

  // 3b) Skip when the latest worker round has not yet been answered by
  //     a non-worker comment (Issue #1876). The label-based turn signal
  //     (`needs-human` added at step 9) is unreliable: the worker user
  //     is not on the operational-label allowlist, so the label gets
  //     stripped and a second worker can pick the issue up and run
  //     Claude again. Claude then reads the unanswered Round N
  //     (whose checkboxes the prompt pre-filled with its own
  //     suggestions) and posts a Ready marker before the developer
  //     has had a chance to answer — producing the simultaneous
  //     "asking questions" + "ready for next phase" race the user
  //     reported.
  //
  //     This comment-state gate fires regardless of label state, so
  //     it survives the operational-label strip and prevents the race.
  if (isAwaitingDeveloperReply(comments, githubUser)) {
    // Issue #1878: Treat an explicit non-worker removal of
    // `needs-human` after the latest Round N as the developer's "go"
    // signal — even when no separate reply comment has been posted.
    // Without this override the worker keeps re-adding `needs-human`
    // every iteration after the user removes it, producing the
    // "constantly labelling as needs-human but no questions posed"
    // loop reported in #1878.
    const latestRoundTimestamp = findLatestWorkerRoundTimestamp(
      comments,
      githubUser,
    );
    let explicitRemoval = false;
    try {
      const removeInfo = await getLabelLastRemoveInfo(
        repo,
        issueNumber,
        needsHumanLabel,
        deps.github.runGhCommand,
      );
      explicitRemoval = isNonWorkerRemovalAfterRound(
        removeInfo,
        latestRoundTimestamp,
        githubUser,
      );
      if (explicitRemoval && removeInfo !== null) {
        logger.info(
          "needs-human was explicitly removed by non-worker after Round N — proceeding to invoke Claude",
          {
            repo,
            issueNumber,
            removedBy: removeInfo.removedBy,
            removedAt: removeInfo.removedAt,
            latestRoundTimestamp,
          },
        );
      }
    } catch (err) {
      // Fail-safe: preserve the existing awaiting-reply behaviour
      // when the timeline lookup fails.
      logger.warn(
        "Failed to inspect timeline for needs-human removal — falling back to awaiting-reply guard",
        { error: err instanceof Error ? err.message : String(err) },
      );
    }

    if (!explicitRemoval) {
      logger.info(
        "Latest grill-me round has no developer reply yet — skipping Claude invocation",
        { repo, issueNumber },
      );
      // Defence in depth: re-add `needs-human` if it has been stripped.
      // The discovery filter skips `needs-human` issues so this also
      // helps reduce churn when the label sticks. Routed through the
      // shared escalateToHuman helper (Issue #2209) so the re-application
      // is paired with an explanation comment. The dedup key is keyed
      // off the awaiting round number, so a fresh comment is posted
      // only when the round number changes.
      const priorRounds = countGrillMeRounds(comments, githubUser);
      let awaitingNeedsHumanAdded = false;
      try {
        const issue = await ghClient.getIssue(repo, issueNumber);
        if (!issue.labels.includes(needsHumanLabel)) {
          const outcome = await escalateToHuman({
            ghClient,
            repo,
            target: { kind: "issue", number: issueNumber },
            needsHumanLabel,
            reason: `Round ${priorRounds} is still waiting for your reply.`,
            nextStep:
              "Answer the questions in the latest grill-me round, or remove `needs-human` to " +
              "signal me to proceed without further input.",
            dedupKey: `grill-me-awaiting-${issueNumber}-round-${priorRounds}`,
            prefetchedComments: comments,
            githubUser,
            logger,
            deps: {
              github: { ensureLabelExists: deps.github.ensureLabelExists },
            },
          });
          if (outcome.ok && outcome.value.labelAdded) {
            awaitingNeedsHumanAdded = true;
          }
        }
      } catch (err) {
        logger.warn("Failed to fetch issue labels while awaiting reply", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Ball is in the developer's court — unassign the worker so the
      // assigned-without-heartbeat detector cannot trigger a spurious
      // "Automatic recovery" comment (Issue #1830).
      const awaitingUnassigned = await releaseAllWorkerClaims(
        ghClient,
        repo,
        issueNumber,
        githubUser,
        logger,
      );
      return {
        ok: true,
        value: {
          processed: false,
          roundNumber: countGrillMeRounds(comments, githubUser),
          isFinalRound: false,
          workerCommentPosted: false,
          labelsSwapped: false,
          defenceInDepthApplied: awaitingNeedsHumanAdded,
          escalatedToHuman: false,
          needsHumanAdded: awaitingNeedsHumanAdded,
          needsHumanRemoved: false,
          workerUnassigned: awaitingUnassigned,
          summary:
            "Latest round still awaiting developer reply — skipped Claude invocation (Issue #1876)",
        },
      };
    }
    // explicitRemoval === true: fall through to the Claude invocation
    // path below. The user has removed `needs-human` themselves, which
    // is their "proceed" signal even without a separate reply comment.
  }

  // 4) Compute the current round number. maxGrillMeRounds is now a
  //    safety cap (Issue #1648) — when the next round would exceed it,
  //    escalate to needs-human instead of forcing finalisation.
  const priorRounds = countGrillMeRounds(comments, githubUser);
  if (priorRounds >= maxRounds) {
    logger.warn(
      "Grill-me safety cap reached without convergence — escalating to needs-human",
      { repo, issueNumber, priorRounds, maxRounds },
    );
    await escalateToHuman({
      ghClient,
      repo,
      target: { kind: "issue", number: issueNumber },
      needsHumanLabel,
      reason:
        `The grill-me workflow reached its safety cap of ${maxRounds} round${
          maxRounds === 1 ? "" : "s"
        } ` +
        `without Claude posting a \`${GRILL_ME_READY_MARKER}\` comment.`,
      nextStep:
        `Review the prior rounds and either apply \`planning\` (to move on with what is already understood), ` +
        `apply \`work-on\` (to start implementation directly), or close the issue if it is no longer needed. ` +
        `Remove \`${needsHumanLabel}\` once you have chosen.`,
      heading: "Grill-Me Escalation",
      githubUser,
      logger,
      deps: { github: { ensureLabelExists: deps.github.ensureLabelExists } },
    });
    const capUnassigned = await releaseAllWorkerClaims(
      ghClient,
      repo,
      issueNumber,
      githubUser,
      logger,
    );
    return {
      ok: true,
      value: {
        processed: false,
        roundNumber: priorRounds,
        isFinalRound: true,
        workerCommentPosted: false,
        labelsSwapped: false,
        defenceInDepthApplied: false,
        escalatedToHuman: true,
        needsHumanAdded: false,
        needsHumanRemoved: false,
        workerUnassigned: capUnassigned,
        summary:
          `Escalated to ${needsHumanLabel} — safety cap of ${maxRounds} reached without Ready marker`,
      },
    };
  }

  // 4a) Pre-Claude race guard (Issue #1876): another Vibe Coder running on
  //     a different machine may have already posted a Round N or Ready
  //     comment between our initial fetch and this point. Even though the
  //     claim sequence holds an exclusive lock, the lock has narrow race
  //     windows (cleanupStaleClaimComments deletes peers' locks; the
  //     freshness check ignores CLAIM_LOCK comments older than 60 s) which
  //     have been observed in production producing two contradictory
  //     comments on the same issue (see #1876).
  //
  //     Defence in depth: invalidate the per-iteration comments cache and
  //     re-fetch from GitHub. If priorRounds has grown OR a Ready marker
  //     has appeared, abort BEFORE burning a Claude invocation. Cost: one
  //     extra GH API call per round; benefit: eliminates the long
  //     (~2-3 minute) race window during the Claude invocation itself.
  invalidateComments(repo, issueNumber);
  let raceGuardComments: GitHubComment[] = comments;
  try {
    raceGuardComments = await ghClient.getIssueComments(repo, issueNumber);
  } catch (err) {
    // Fail open — if the refresh call fails, fall back to the original
    // (possibly stale) comment list rather than blocking the round.
    logger.warn(
      "Pre-Claude race-guard refresh failed — proceeding with cached comments",
      {
        repo,
        issueNumber,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }

  const guardPriorRounds = countGrillMeRounds(raceGuardComments, githubUser);
  const guardReadyPosted = hasReadyMarkerBeenPosted(
    raceGuardComments,
    githubUser,
  );

  if (guardPriorRounds > priorRounds || guardReadyPosted) {
    logger.warn(
      "Concurrent grill-me activity detected — another worker already posted; aborting before Claude",
      {
        repo,
        issueNumber,
        priorRoundsAtStart: priorRounds,
        priorRoundsNow: guardPriorRounds,
        readyPostedNow: guardReadyPosted,
      },
    );
    const unassigned = await releaseAllWorkerClaims(
      ghClient,
      repo,
      issueNumber,
      githubUser,
      logger,
    );
    return {
      ok: true,
      value: {
        processed: false,
        roundNumber: priorRounds,
        isFinalRound: false,
        workerCommentPosted: false,
        labelsSwapped: false,
        defenceInDepthApplied: false,
        escalatedToHuman: false,
        needsHumanAdded: false,
        needsHumanRemoved: false,
        workerUnassigned: unassigned,
        summary:
          `Aborted — another worker posted concurrently (priorRounds: ${priorRounds} → ${guardPriorRounds}, ready: ${guardReadyPosted})`,
      },
    };
  }

  // Use the freshly-fetched comments for the prompt so Claude sees the
  // most current developer reply.
  comments = raceGuardComments;

  const roundNumber = priorRounds + 1;

  logger.info("Starting grill-me round", {
    repo,
    issueNumber,
    roundNumber,
    maxRounds,
  });

  // 5) Build the prompt.
  // The active provider keys the per-model guidelines overlay (Issue #374);
  // without one authored for it the block is the agnostic baseline.
  const guidelinesResult = await buildCodingGuidelines(false, promptsDir, {
    provider: config.agentProvider,
  });
  const codingGuidelines = guidelinesResult.ok ? guidelinesResult.value : "";
  const verbosityInstructions = buildVerbosityBlock(config.verbosity);

  // Trust-annotate and rate-limit the thread before it reaches the prompt
  // (Issue #3706). Audit events are logged loudly rather than dropped.
  const history = formatCommentHistory(comments, {
    allowedAuthors: config.allowedAuthors ?? [],
    authorisedCommenters: config.authorisedCommenters ?? [],
    includeUntrustedComments: config.includeUntrustedComments ?? true,
    githubUser,
  });
  for (const auditMsg of history.securityAuditMessages) {
    logger.warn(auditMsg, { repo, issueNumber });
  }

  const promptResult = await buildGrillMePrompt({
    roundNumber,
    maxRounds,
    issueBody,
    commentHistory: history.formattedComments,
    commentBoundaryId: history.boundaryId,
    repo,
    issueNumber,
    issueTitle,
    codingGuidelines,
    verbosityInstructions,
    promptsDir,
  });

  if (!promptResult.ok) {
    logger.warn("Failed to build grill-me prompt", {
      error: promptResult.error.message,
    });
    return await postFailureAndUnassign(
      ghClient,
      repo,
      issueNumber,
      githubUser,
      `Failed to build grill-me prompt: ${promptResult.error.message}`,
      logger,
    );
  }

  // 6) Invoke Claude with the grill-me timeout.
  const claudeResult = await deps.claude.runClaudeWithRetry(
    {
      prompt: promptResult.value,
      timeoutSeconds: config.grillMeTimeout,
      killAfterSeconds: config.grillMeKillAfter,
      // Issue #3154: grill-me now has the full 1h hard budget so a genuinely
      // thinking top-tier run is not guillotined. The silence watchdog is the
      // counterweight — a stuck/refusing run that produces no output is killed
      // quickly instead of idling to the hour, so "error out fast when stuck,
      // wait when actually thinking" both hold.
      noOutputTimeout: config.claudeNoOutputTimeout,
      phase: "grill_me",
      cwd: config.workDir,
      logger,
    },
    {
      maxRetries: config.maxRateLimitRetries,
    },
  );

  if (!claudeResult.ok) {
    const errorMsg = claudeResult.error.message;
    logger.warn("Claude execution failed during grill-me", {
      repo,
      issueNumber,
      error: errorMsg,
    });
    return await postFailureAndUnassign(
      ghClient,
      repo,
      issueNumber,
      githubUser,
      `Claude execution failed: ${errorMsg}`,
      logger,
    );
  }

  if (claudeResult.value.timedOut) {
    logger.warn("Claude timed out during grill-me", { repo, issueNumber });
    return await postFailureAndUnassign(
      ghClient,
      repo,
      issueNumber,
      githubUser,
      "Claude timed out",
      logger,
    );
  }

  // 7) Verify Claude posted a comment.
  //
  // Issue #1843: avoid re-fetching the entire comment list to verify a
  // single comment Claude just posted. Two strategies, in order:
  //
  //   a) Detect the Round / Ready marker in Claude's stdout result text
  //      and append a synthesised in-memory comment to `commentList`.
  //      This costs zero extra GH calls.
  //   b) Fallback when neither marker is present in the output: invalidate
  //      the per-iteration comments cache (#1841) so a fresh REST call
  //      sees Claude's subprocess post, then refetch once. This preserves
  //      the safety net for runs where Claude's summary does not echo the
  //      title heading.
  //
  // The previous implementation always refetched, doubling the
  // comment-list reads per round. That refetch was further weakened by
  // #1841: the cache was not invalidated for subprocess writes, so the
  // refetch could return a stale list anyway. Synthesising in-memory
  // gives a precise verification signal and removes the redundant call.
  let postCommentList: GitHubComment[] = comments;
  const outcome = detectGrillMeOutcome(claudeResult.value.output);

  if (outcome !== null) {
    postCommentList = [
      ...comments,
      synthesiseRoundComment(outcome, priorRounds + 1, githubUser),
    ];
    logger.debug(
      "Detected grill-me outcome from Claude output — skipping verification refetch",
      { repo, issueNumber, outcome },
    );
  } else {
    // Fallback: Claude's output did not echo a marker. Invalidate the
    // per-iteration cache so the refetch reflects Claude's subprocess
    // write, then read once.
    invalidateComments(repo, issueNumber);
    try {
      postCommentList = await ghClient.getIssueComments(repo, issueNumber);
    } catch (err) {
      logger.warn("Failed to re-fetch comments to verify Claude output", {
        repo,
        issueNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const newRoundCount = countGrillMeRounds(postCommentList, githubUser);
  const readyPostedNow = hasReadyMarkerBeenPosted(postCommentList, githubUser);
  const workerCommentPosted = newRoundCount > priorRounds || readyPostedNow;

  // Issue #1876: duplicate-post detection. If `newRoundCount` jumped by
  // more than one since `priorRounds`, OR a Ready marker appeared
  // alongside an unexpected extra round, another worker raced our Claude
  // invocation and also posted. The pre-Claude guard catches the common
  // case; this check surfaces the rarer case where both workers were
  // mid-Claude during our pre-Claude refresh. We log loudly so the
  // duplicate is visible in telemetry and humans can clean up the issue.
  const expectedNewRounds = readyPostedNow ? 0 : 1;
  const observedNewRounds = newRoundCount - priorRounds;
  if (observedNewRounds > expectedNewRounds) {
    logger.warn(
      "Concurrent grill-me post detected — another worker also posted while Claude was running",
      {
        repo,
        issueNumber,
        priorRounds,
        newRoundCount,
        readyPostedNow,
        unexpectedExtraRounds: observedNewRounds - expectedNewRounds,
      },
    );
  }

  if (!workerCommentPosted) {
    // Issue #3768: before declaring failure, check for a round marker from
    // ANY author. A fleet peer may have posted the round for this issue
    // moments before we claimed it, in which case the work is done and this
    // run is a no-op success — posting `## Grill-Me Failed` would contradict
    // the round comment sitting right above it (observed on #3767).
    if (hasGrillMeRoundAwaitingReply(postCommentList, githubUser)) {
      logger.info(
        "Grill-me round already posted by another worker identity — treating this run as a no-op",
        { repo, issueNumber, priorRounds },
      );
      const peerUnassigned = await releaseAllWorkerClaims(
        ghClient,
        repo,
        issueNumber,
        githubUser,
        logger,
      );
      return {
        ok: true,
        value: {
          processed: false,
          roundNumber: priorRounds,
          isFinalRound: false,
          workerCommentPosted: false,
          labelsSwapped: false,
          defenceInDepthApplied: false,
          escalatedToHuman: false,
          needsHumanAdded: false,
          needsHumanRemoved: false,
          workerUnassigned: peerUnassigned,
          summary:
            "No-op — a grill-me round from another worker identity is already awaiting a reply (Issue #3768)",
        },
      };
    }
    logger.warn("Claude did not post a grill-me round or ready comment", {
      repo,
      issueNumber,
      priorRounds,
      newRoundCount,
    });
    return await postFailureAndUnassign(
      ghClient,
      repo,
      issueNumber,
      githubUser,
      "Claude did not post a Grill-Me round comment",
      logger,
    );
  }

  // 8) Ready-marker path: remove `grill-me` and ensure `needs-human`
  //    is applied so the user sees the completion as a "your turn"
  //    signal (Issue #2064). The developer must still manually pick
  //    `planning` / `work-on` / `top-priority` — `needs-human` only
  //    flags that the ball is in their court. NEVER add `planning`,
  //    `work-on`, or any other operational label — that is the
  //    developer's call (Issue #1648).
  let labelsSwapped = false;
  let defenceInDepthApplied = false;
  let needsHumanAdded = false;
  const needsHumanRemoved = false;

  if (readyPostedNow) {
    let issueLabels: string[] = [];
    try {
      const issue = await ghClient.getIssue(repo, issueNumber);
      issueLabels = issue.labels;
    } catch (err) {
      logger.warn(
        "Failed to fetch issue labels for Ready-marker verification",
        {
          repo,
          issueNumber,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }

    if (issueLabels.includes(grillMeLabel)) {
      logger.info(
        "Ready marker posted but grill-me label still present — removing",
        {
          repo,
          issueNumber,
        },
      );
      defenceInDepthApplied = true;
      try {
        await ghClient.removeLabel(repo, issueNumber, grillMeLabel);
        labelsSwapped = true;
      } catch (err) {
        logger.warn("Defence-in-depth: failed to remove grill-me label", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      // Already removed by Claude — record the convergence outcome.
      labelsSwapped = true;
    }

    // Issue #2064: ensure `needs-human` is applied on every grill-me
    // completion so the user sees the issue as awaiting their pick of
    // next-phase label. The v8 prompt instructs Claude to add the
    // label itself, but defence-in-depth re-applies it here in case
    // Claude's add-label call failed or this run is processing an
    // older Ready marker that pre-dates v8.
    //
    // Issue #2209: route through escalateToHuman. The Ready marker
    // Claude just posted IS the explanation — pass it via
    // `additionalDedupMarkers` so the helper recognises it and skips
    // a duplicate comment, only ensuring the label.
    if (!issueLabels.includes(needsHumanLabel)) {
      const outcome = await escalateToHuman({
        ghClient,
        repo,
        target: { kind: "issue", number: issueNumber },
        needsHumanLabel,
        reason:
          "The earlier `## Ready for Next Phase` comment is still awaiting a next-phase label.",
        nextStep:
          "Apply `planning`, `work-on`, or `top-priority` (or close the issue) so the worker " +
          "knows how to proceed.",
        dedupKey: `grill-me-ready-${issueNumber}`,
        additionalDedupMarkers: [GRILL_ME_READY_MARKER],
        prefetchedComments: postCommentList,
        githubUser,
        logger,
        deps: { github: { ensureLabelExists: deps.github.ensureLabelExists } },
      });
      if (outcome.ok && outcome.value.labelAdded) {
        needsHumanAdded = true;
        defenceInDepthApplied = true;
      }
    }
  } else {
    // 9) Round N path: add `needs-human` so the label list reflects
    //    that it is the developer's turn. The developer removes the
    //    label themselves once they reply; the discovery filter
    //    skips `needs-human` until they do (Issue #1693).
    //
    //    Issue #2209: route through escalateToHuman. The Round N
    //    comment Claude just posted IS the explanation — pass it via
    //    `additionalDedupMarkers` so the helper recognises it and
    //    skips a duplicate comment, only ensuring the label.
    const outcome = await escalateToHuman({
      ghClient,
      repo,
      target: { kind: "issue", number: issueNumber },
      needsHumanLabel,
      reason: `Round ${roundNumber} is still waiting for your reply.`,
      nextStep:
        "Answer the questions in the latest grill-me round, or remove `needs-human` to " +
        "signal me to proceed without further input.",
      dedupKey: `grill-me-awaiting-${issueNumber}-round-${roundNumber}`,
      additionalDedupMarkers: [
        `${GRILL_ME_ROUND_MARKER}${roundNumber}`,
      ],
      prefetchedComments: postCommentList,
      githubUser,
      logger,
      deps: { github: { ensureLabelExists: deps.github.ensureLabelExists } },
    });
    if (outcome.ok && outcome.value.labelAdded) {
      needsHumanAdded = true;
    }
  }

  // Issue #2717: grill-me routes to the same Fable 5 top tier as planning, so
  // surface a silent Fable→Opus degradation the same way the #2646 family does
  // for planning. Unlike planning (stats every run), grill-me posts the stats
  // block and applies the `degraded-model` label ONLY on a degraded round —
  // healthy interactive rounds stay clean. Non-fatal: never aborts the round.
  let degraded = false;
  try {
    const verdict = await reportGrillMeDegradation({
      repo,
      issueNumber,
      claudeResult: claudeResult.value,
      ghClient,
      runGhCommand: deps.github.runGhCommand,
      logger,
    });
    degraded = verdict.degraded;
  } catch (err) {
    logger.warn("Grill-me degraded-model detection failed (non-fatal)", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Ball is in the developer's court — unassign the worker so the
  // assigned-without-heartbeat detector cannot trigger a spurious
  // "Automatic recovery" comment ~30 minutes after the round was
  // posted (Issue #1830). Mirrors clarity_phase / question_clarification.
  const workerUnassigned = await releaseAllWorkerClaims(
    ghClient,
    repo,
    issueNumber,
    githubUser,
    logger,
  );

  return {
    ok: true,
    value: {
      processed: true,
      roundNumber,
      isFinalRound: false,
      workerCommentPosted,
      labelsSwapped,
      defenceInDepthApplied,
      escalatedToHuman: false,
      needsHumanAdded,
      needsHumanRemoved,
      workerUnassigned,
      degraded,
      summary: readyPostedNow
        ? `Round ${roundNumber}/${maxRounds} posted Ready marker — awaiting developer label change${
          defenceInDepthApplied ? " (grill-me removed defence-in-depth)" : ""
        }`
        : `Round ${roundNumber}/${maxRounds} posted`,
    },
  };
}

// ---------------------------------------------------------------------------
// Failure helpers
// ---------------------------------------------------------------------------

/**
 * Post a failure comment so consecutive failures can be detected on the
 * next worker run, and so the user sees what went wrong.
 *
 * Issue #3648: the comment is public, and callers pass raw external error text
 * — `github.ts` builds `gh command failed (exit N): <stderr>`, and Claude error
 * output flows straight through — either of which can carry a tokenised clone
 * URL or an API key. Scrub the reason before it leaves the worker.
 */
async function postFailureComment(
  ghClient: GitHubClient,
  repo: string,
  issueNumber: number,
  githubUser: string,
  reason: string,
): Promise<void> {
  const body = `${GRILL_ME_FAILED_MARKER}\n\nThis grill-me round failed: ${
    redactSecrets(reason)
  }\n\n---\n🤖 Processed by: ${githubUser}`;
  try {
    await ghClient.postComment(repo, issueNumber, body);
  } catch {
    // Best effort.
  }
}

/**
 * Terminal-failure exit helper (Issue #2727).
 *
 * Every terminal grill-me failure must (1) post the `## Grill-Me Failed`
 * marker so consecutive-failure detection / escalation can count it on the
 * next run, then (2) release the worker's self-assignment so a failed round
 * does not leave the issue assigned and re-looping (the symptom in
 * private-repo-14#2944). Order matters — post the marker FIRST so the
 * consecutive-failure counter still has it to count, then unassign.
 *
 * The unassign is best-effort: a failed unassign is logged, not fatal,
 * matching {@link releaseAllWorkerClaims}. Returns the error `Result` so callers
 * can `return await postFailureAndUnassign(...)`.
 */
async function postFailureAndUnassign(
  ghClient: GitHubClient,
  repo: string,
  issueNumber: number,
  githubUser: string,
  reason: string,
  logger: Logger,
): Promise<Result<GrillMeResult>> {
  await postFailureComment(ghClient, repo, issueNumber, githubUser, reason);
  await releaseAllWorkerClaims(
    ghClient,
    repo,
    issueNumber,
    githubUser,
    logger,
    {
      outcome: failedRunOutcome("grill-me", reason, 0),
    },
  );
  return { ok: false, error: new Error(reason) };
}
