/**
 * Shared helper for escalating an issue or PR to a human (Issue #2208).
 *
 * Centralises the "add `needs-human` label + post an explanation comment"
 * pattern so every caller routes through a single chokepoint. This makes
 * it impossible to add the label silently — the helper enforces an
 * accompanying explanation comment with a stable shape (heading, why,
 * next step, worker footer).
 *
 * Part of the milestone tracked in #2202.
 *
 * **CI guard:** Direct `addLabel(... needsHumanLabel)` (or
 * `addLabel(..., "needs-human")`) calls outside this module are
 * forbidden — `worker/deno/tests/needs_human_helper_only_test.ts`
 * enforces this and fails the build if a new caller bypasses the
 * chokepoint. See Issue #2202 (and #2212 for the guard itself).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { GitHubClient, GitHubComment, Logger, Result } from "../types.ts";
import { ensureLabelExists as defaultEnsureLabelExists } from "./label_operations.ts";

/**
 * Result returned to callers — reports which side effects fired.
 */
export interface EscalateToHumanOutcome {
  /** True when an explanation comment was posted on this call. */
  commentPosted: boolean;
  /** True when `addLabel` succeeded on this call. */
  labelAdded: boolean;
  /**
   * True when the comment was suppressed because a prior comment with the
   * same `dedupKey` was found within the last 24 hours.
   */
  dedupSkipped: boolean;
}

/** Injectable dependencies for testing. */
export interface EscalateToHumanDeps {
  github?: {
    /**
     * Ensure the label exists in the repository. Defaults to the
     * production `ensureLabelExists` from `label_operations.ts`.
     */
    ensureLabelExists?: (
      repo: string,
      labelName: string,
      colour?: string,
      description?: string,
    ) => Promise<Result<void>>;
  };
  /** Override the current time (used by dedup window). Defaults to `Date.now`. */
  now?: () => number;
}

/** Options accepted by {@link escalateToHuman}. */
export interface EscalateToHumanOptions {
  ghClient: GitHubClient;
  repo: string;
  target: { kind: "issue" | "pr"; number: number };
  /** Label name to apply — typically `config.needsHumanLabel`. */
  needsHumanLabel: string;
  /** Short reason WHY the label is being applied. Goes after `**Why:**`. */
  reason: string;
  /** Exactly what the human must do next. Goes after `**Next step:**`. */
  nextStep: string;
  /** Comment heading. Defaults to `"Needs human attention"`. */
  heading?: string;
  /** Colour for {@link ensureLabelExists}. Defaults to `"fbca04"`. */
  ensureLabelColour?: string;
  /** Description for {@link ensureLabelExists}. */
  ensureLabelDescription?: string;
  /**
   * Optional dedup key. When supplied, the helper appends a marker
   * `<!-- needs-human-escalation: {dedupKey} -->` to the comment body and
   * scans the most recent ~50 comments for the same marker; if a match
   * was created within 24 hours, the duplicate comment is skipped (the
   * label add is still re-attempted, idempotently).
   */
  dedupKey?: string;
  /**
   * Optional list of additional substrings that count as a pre-existing
   * explanation. When the dedup scan finds any of these substrings in
   * the most recent ~50 comments within the 24-hour window, the
   * duplicate comment is skipped — even if the helper's own dedup
   * marker is absent. Used by callers (e.g. the grill-me processor)
   * whose Round N / Ready comments already serve as the explanation
   * the helper would otherwise duplicate. The label is still added,
   * idempotently.
   */
  additionalDedupMarkers?: readonly string[];
  /**
   * Pre-fetched issue comments to use for the dedup scan, avoiding an
   * extra `getIssueComments` API call when the caller already has a
   * recent comment list in hand. When omitted, the helper falls back
   * to `ghClient.getIssueComments`.
   */
  prefetchedComments?: readonly GitHubComment[];
  /**
   * GitHub login used in the `🤖 Processed by:` footer. Optional — when
   * absent, the footer reads `🤖 Processed by: the worker`.
   */
  githubUser?: string;
  /** Injectable deps. */
  deps?: EscalateToHumanDeps;
  /** Logger. */
  logger: Logger;
}

const DEFAULT_HEADING = "Needs human attention";
const DEFAULT_LABEL_COLOUR = "fbca04";
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const COMMENT_SCAN_LIMIT = 50;

/**
 * Build the marker placed in the comment body when a `dedupKey` is set.
 * Exported for testing.
 */
export function buildDedupMarker(dedupKey: string): string {
  return `<!-- needs-human-escalation: ${dedupKey} -->`;
}

/**
 * Build the standard escalation comment body. Exported for testing.
 */
export function buildEscalationCommentBody(opts: {
  heading?: string;
  reason: string;
  nextStep: string;
  dedupKey?: string;
  githubUser?: string;
}): string {
  const heading = opts.heading ?? DEFAULT_HEADING;
  const footer = `🤖 Processed by: ${opts.githubUser ?? "the worker"}`;
  const marker = opts.dedupKey ? `\n\n${buildDedupMarker(opts.dedupKey)}` : "";
  return (
    `## ${heading}\n\n` +
    `**Why:** ${opts.reason}\n\n` +
    `**Next step:** ${opts.nextStep}` +
    `${marker}\n\n---\n${footer}`
  );
}

/**
 * Atomically post an escalation comment and add the `needs-human` label.
 *
 * Behaviour ordering:
 *   1. ensure label exists (best-effort, warning on failure)
 *   2. add label (best-effort, warning on failure)
 *   3. if `dedupKey` set, scan recent comments for a prior marker
 *      within 24h — skip the comment when found
 *   4. post comment (best-effort, warning on failure)
 *
 * Each step is independently fault-tolerant. The helper returns success
 * when at least one of the two visible side effects (label add or
 * comment post) succeeded.
 */
export async function escalateToHuman(
  options: EscalateToHumanOptions,
): Promise<Result<EscalateToHumanOutcome>> {
  const {
    ghClient,
    repo,
    target,
    needsHumanLabel,
    reason,
    nextStep,
    heading,
    ensureLabelColour,
    ensureLabelDescription,
    dedupKey,
    additionalDedupMarkers,
    prefetchedComments,
    githubUser,
    deps,
    logger,
  } = options;

  const now = deps?.now ?? (() => Date.now());
  const ensureLabel = deps?.github?.ensureLabelExists ??
    defaultEnsureLabelExists;

  // ---------------------------------------------------------------------
  // Step 1: ensure label exists (best-effort)
  // ---------------------------------------------------------------------
  try {
    const ensureResult = await ensureLabel(
      repo,
      needsHumanLabel,
      ensureLabelColour ?? DEFAULT_LABEL_COLOUR,
      ensureLabelDescription ?? "",
    );
    if (!ensureResult.ok) {
      logger.warn("escalateToHuman: ensureLabelExists failed", {
        repo,
        target: `#${target.number}`,
        label: needsHumanLabel,
        error: ensureResult.error.message,
      });
    }
  } catch (err) {
    logger.warn("escalateToHuman: ensureLabelExists threw", {
      repo,
      target: `#${target.number}`,
      label: needsHumanLabel,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ---------------------------------------------------------------------
  // Step 2: add label (best-effort)
  // ---------------------------------------------------------------------
  let labelAdded = false;
  try {
    await ghClient.addLabel(repo, target.number, needsHumanLabel);
    labelAdded = true;
  } catch (err) {
    logger.warn("escalateToHuman: addLabel failed", {
      repo,
      target: `#${target.number}`,
      label: needsHumanLabel,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ---------------------------------------------------------------------
  // Step 3: dedup check (only when dedupKey or additionalDedupMarkers set)
  // ---------------------------------------------------------------------
  let dedupSkipped = false;
  const dedupActive = Boolean(dedupKey) ||
    (additionalDedupMarkers !== undefined &&
      additionalDedupMarkers.length > 0);
  if (dedupActive) {
    const markers: string[] = [];
    if (dedupKey) markers.push(buildDedupMarker(dedupKey));
    if (additionalDedupMarkers) markers.push(...additionalDedupMarkers);
    try {
      const comments = prefetchedComments
        ? prefetchedComments
        : await ghClient.getIssueComments(repo, target.number);
      // Scan the most recent ~50 comments (issue-spec). Newer comments
      // come last in the REST default ordering, so iterate the tail.
      const recent = comments.slice(-COMMENT_SCAN_LIMIT);
      const cutoff = now() - DEDUP_WINDOW_MS;
      outer: for (const comment of recent) {
        for (const marker of markers) {
          if (!comment.body.includes(marker)) continue;
          const createdMs = Date.parse(comment.createdAt);
          if (Number.isNaN(createdMs)) continue;
          if (createdMs >= cutoff) {
            dedupSkipped = true;
            break outer;
          }
        }
      }
    } catch (err) {
      // Dedup is an optimisation. If the lookup fails, post the comment
      // anyway rather than silently drop the escalation.
      logger.warn("escalateToHuman: dedup comment lookup failed", {
        repo,
        target: `#${target.number}`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---------------------------------------------------------------------
  // Step 4: post comment (best-effort, skipped if dedupSkipped)
  // ---------------------------------------------------------------------
  let commentPosted = false;
  if (!dedupSkipped) {
    const body = buildEscalationCommentBody({
      heading,
      reason,
      nextStep,
      dedupKey,
      githubUser,
    });
    try {
      await ghClient.postComment(repo, target.number, body);
      commentPosted = true;
    } catch (err) {
      logger.warn("escalateToHuman: postComment failed", {
        repo,
        target: `#${target.number}`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---------------------------------------------------------------------
  // Return: success when at least one visible side effect fired, or when
  // the comment was intentionally skipped because of dedup.
  // ---------------------------------------------------------------------
  if (labelAdded || commentPosted || dedupSkipped) {
    return {
      ok: true,
      value: { commentPosted, labelAdded, dedupSkipped },
    };
  }
  return {
    ok: false,
    error: new Error(
      `escalateToHuman: both label add and comment post failed for ${repo}#${target.number}`,
    ),
  };
}
