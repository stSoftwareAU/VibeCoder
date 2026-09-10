/**
 * The issue comments the implementation prompt carries (Issue #1910).
 *
 * The planning, question and PR-feedback prompts have always fenced the
 * issue's comments; the implementation prompt carried the title, body and
 * labels alone, so a maintainer who narrowed or redirected scope in a comment
 * — the normal way a human talks on an issue — got an agent that worked the
 * original description regardless.
 *
 * Two decisions live here, and neither belongs in the prompt builder:
 *
 * 1. **Which comments.** A resumed issue carries run-stats and claim-release
 *    comments the worker posted about itself. They say nothing the agent can
 *    act on, so they are dropped outright, and what remains is admitted
 *    newest-first in trust order — **trusted humans, then other authors, then
 *    the worker itself**. Neither the worker's own chatter nor a flood of
 *    untrusted comments can crowd out a maintainer's direction.
 * 2. **How much.** The prompt prefix is cached and measured against the
 *    context budget (#1262, #3713), so a busy issue's thread is bounded here
 *    before `comment_trust_filter.ts` applies its own per-author caps.
 *
 * Trust annotation, suspicious-pattern auditing and the per-comment nonce
 * headers are **not** re-implemented: this module selects, then delegates to
 * `prepareTrustAnnotatedCommentList`, which is the vetted path every other
 * prompt route already uses.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { IssueComment } from "./issue_data.ts";
import {
  classifyCommentAuthor,
  type CommentTrustOptions,
  prepareTrustAnnotatedCommentList,
} from "./comment_trust_filter.ts";
import { capFormattedComments } from "./comment_rate_limiter.ts";
import { normaliseLogin } from "./identity_guard.ts";
import { ISSUE_RUN_STATS_MARKER } from "./issue_run_stats_comment.ts";
import { SCHEDULED_RELEASE_MARKER } from "./failure_diagnosis.ts";

/**
 * How much of an issue's thread the implementation prompt may carry.
 *
 * Deliberately below the `comment_rate_limiter.ts` total cap (20,000
 * characters): those caps exist to bound an attacker's volume, these exist to
 * keep a long thread from displacing the task itself in a prompt that already
 * carries the repo context and the codebase map.
 */
export const IMPLEMENTATION_COMMENT_LIMITS = {
  /** Maximum comments carried, however small they are. */
  maxComments: 20,
  /** Maximum characters of comment body carried in total. */
  maxTotalChars: 12_000,
} as const;

/** The `## <Phase> run model stats` heading every run-stats comment shares. */
const RUN_STATS_HEADING_PATTERN = /^##[ \t]+\S.*run model stats[ \t]*$/im;

/**
 * Report whether a comment is worker bookkeeping rather than direction.
 *
 * Matched on the markers the producing modules export, so a rename there is a
 * type error here rather than silent drift. `comment_trust_filter.ts` drops
 * the claim locks and automated-failure notices on its own; this covers the
 * two families it does not.
 */
export function isWorkerNoiseComment(body: string): boolean {
  if (typeof body !== "string") return false;
  return body.includes(ISSUE_RUN_STATS_MARKER) ||
    body.includes(SCHEDULED_RELEASE_MARKER) ||
    RUN_STATS_HEADING_PATTERN.test(body);
}

/** Options for {@link selectImplementationComments}. */
export interface ImplementationCommentSelectionOptions {
  /**
   * The worker's own GitHub login. Comments from it are admitted only after
   * every other author has taken what it needs of the budget.
   */
  workerLogin?: string;
  /** Logins that may direct work — admitted before anyone else. */
  allowedAuthors?: readonly string[];
  /** Logins whose input is acted on — admitted alongside `allowedAuthors`. */
  authorisedCommenters?: readonly string[];
  /** Override the comment count cap (tests, and callers with a tighter budget). */
  maxComments?: number;
  /** Override the total character budget. */
  maxTotalChars?: number;
}

/** What {@link selectImplementationComments} kept, and what it did not. */
export interface ImplementationCommentSelection {
  /** The comments to carry, in chronological order. */
  selected: IssueComment[];
  /** Worker bookkeeping comments dropped outright. */
  droppedNoise: number;
  /** Comments dropped because the count or character budget was spent. */
  droppedForBudget: number;
}

/**
 * Choose which of an issue's comments the implementation prompt carries.
 *
 * @param comments - The issue's comments in chronological order
 * @param options - Worker login and budget overrides
 * @returns The selected comments plus what was dropped and why
 */
export function selectImplementationComments(
  comments: readonly IssueComment[],
  options: ImplementationCommentSelectionOptions,
): ImplementationCommentSelection {
  const maxComments = options.maxComments ??
    IMPLEMENTATION_COMMENT_LIMITS.maxComments;
  const maxTotalChars = options.maxTotalChars ??
    IMPLEMENTATION_COMMENT_LIMITS.maxTotalChars;

  const candidates = comments.filter((c) => !isWorkerNoiseComment(c.body));
  const droppedNoise = comments.length - candidates.length;

  const workerKey = options.workerLogin
    ? normaliseLogin(options.workerLogin)
    : "";
  const isWorkerAuthored = (c: IssueComment) =>
    workerKey !== "" && normaliseLogin(c.author) === workerKey;

  const isTrusted = (c: IssueComment) =>
    classifyCommentAuthor(c.author, {
      allowedAuthors: [...(options.allowedAuthors ?? [])],
      authorisedCommenters: [...(options.authorisedCommenters ?? [])],
    }) === "TRUSTED";

  const admitted = new Set<number>();
  let chars = 0;

  // Newest first, so a maintainer's latest redirect is the comment that is
  // certain to survive.
  const admit = (wanted: (c: IssueComment) => boolean) => {
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (admitted.size >= maxComments) return;
      if (admitted.has(i)) continue;
      const candidate = candidates[i]!;
      if (!wanted(candidate)) continue;
      const cost = candidate.body.length;
      // A single comment larger than the whole budget is still admitted when
      // nothing else has been — it is truncated downstream rather than lost.
      if (admitted.size > 0 && chars + cost > maxTotalChars) continue;
      admitted.add(i);
      chars += cost;
    }
  };
  // Trusted humans take the budget first, so a flood of untrusted comments
  // cannot evict a maintainer's direction; the worker's own comments take
  // only what is left over from both.
  admit((c) => !isWorkerAuthored(c) && isTrusted(c));
  admit((c) => !isWorkerAuthored(c));
  admit(isWorkerAuthored);

  const selected = candidates.filter((_, i) => admitted.has(i));
  return {
    selected,
    droppedNoise,
    droppedForBudget: candidates.length - selected.length,
  };
}

/**
 * Format comments as plain `author: body` records, capped in total size.
 *
 * The no-trust-configuration path (Issue #3648): no author can be established
 * as trusted, so no per-comment trust header is emitted and the whole blob is
 * scrubbed by the prompt builder's sanitiser.
 */
export function formatPlainComments(
  comments: readonly IssueComment[],
  maxTotalChars?: number,
): string {
  return capFormattedComments(
    comments.map((c) => `${c.author}: ${c.body}`).join("\n---\n"),
    maxTotalChars,
  );
}

/**
 * Options for {@link buildImplementationCommentContext}.
 *
 * The trust lists are required here — they are what `classifyCommentAuthor`
 * decides on — and this shape structurally satisfies
 * {@link ImplementationCommentSelectionOptions}, so one options object drives
 * both the selection and the trust annotation.
 */
export interface ImplementationCommentContextOptions
  extends CommentTrustOptions {
  /** The worker's own GitHub login (see the selection options). */
  workerLogin?: string;
  /** Override the comment count cap. */
  maxComments?: number;
  /** Override the total character budget. */
  maxTotalChars?: number;
}

/** The comment fields an {@link IssueContext} carries for the prompt. */
export interface ImplementationCommentContext {
  /** The blob handed to the prompt builder; empty when nothing survived. */
  issueComments: string;
  /**
   * Boundary id of the genuine per-comment trust headers inside
   * `issueComments`. Absent on the plain path, so no untrusted text gains an
   * exemption from the prompt builder's full scrub.
   */
  commentBoundaryId?: string;
  /** `[SECURITY]` audit events raised while classifying the comments. */
  securityAuditMessages: string[];
}

/**
 * Build the comment context an issue run hands to its prompt builders.
 *
 * @param comments - The issue's comments in chronological order
 * @param options - Trust lists, worker login, and budget overrides
 * @returns The comment blob, its boundary id, and any security audit events
 */
export function buildImplementationCommentContext(
  comments: readonly IssueComment[],
  options: ImplementationCommentContextOptions,
): ImplementationCommentContext {
  const { selected } = selectImplementationComments(comments, options);
  if (selected.length === 0) {
    return { issueComments: "", securityAuditMessages: [] };
  }

  const hasTrustConfig = options.allowedAuthors.length > 0 ||
    options.authorisedCommenters.length > 0;
  if (!hasTrustConfig) {
    return {
      issueComments: formatPlainComments(selected),
      securityAuditMessages: [],
    };
  }

  const trusted = prepareTrustAnnotatedCommentList(
    selected.map((c) => ({ body: c.body, author: { login: c.author } })),
    options,
  );
  return {
    issueComments: trusted.formattedComments,
    ...(trusted.formattedComments
      ? { commentBoundaryId: trusted.boundaryId }
      : {}),
    securityAuditMessages: trusted.securityAuditMessages,
  };
}
