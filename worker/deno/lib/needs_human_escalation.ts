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
 * **Label allowlist:** the label is asserted against
 * `assertWorkerCanApplyLabel` (`worker_label_guard.ts`) before either
 * label mutation, so this chokepoint cannot be used to apply a label
 * outside the worker's allowlist (Issue #13).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { GitHubClient, GitHubComment, Logger, Result } from "../types.ts";
import { ensureLabelExists as defaultEnsureLabelExists } from "./label_operations.ts";
import { assertWorkerCanApplyLabel } from "./worker_label_guard.ts";
import {
  type AlertDedupAuthorOptions,
  selectFleetAuthoredComments,
} from "./alert_dedup_authors.ts";
import {
  getLabelColour,
  getLabelDescription,
} from "../setup/label_definitions.ts";

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
  /**
   * Sink for the `[SECURITY] [WORKER_LABEL_REFUSED]` audit line emitted by
   * {@link assertWorkerCanApplyLabel}. Defaults to `console.warn`; tests
   * inject a recorder (Issue #13).
   */
  labelGuardLogFn?: (line: string) => void;
  /**
   * Fleet identity used to verify who wrote a dedup marker (Issue #1216).
   *
   * Omitted in production, which reads the configured fleet identity; tests
   * state the fleet rather than writing a config file.
   */
  dedupAuthors?: AlertDedupAuthorOptions;
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
  /**
   * Colour for {@link ensureLabelExists}. Defaults to the canonical
   * colour for `needsHumanLabel` (Issue #368).
   */
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
// Issue #368: the fallback colour is the canonical table's entry for the
// label being ensured — no literal duplicated from label_definitions.ts.
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
  // Step 0: worker label allowlist guard (Issue #13)
  // ---------------------------------------------------------------------
  // `ghClient.addLabel` talks to the labels API directly, so without this
  // check the guard invariant ("every worker-applied label passes through
  // `assertWorkerCanApplyLabel`") would hold only for `addLabelToIssue`
  // callers. Refusing here covers both label mutations below — the repo
  // label creation and the issue label add — and emits a `[SECURITY]`
  // audit line rather than failing quietly. The explanation comment is
  // still posted: the escalation must stay visible to a human even when
  // the label itself is refused.
  const labelGuard = assertWorkerCanApplyLabel(needsHumanLabel, {
    caller: `escalateToHuman(${repo}#${target.number})`,
    logFn: deps?.labelGuardLogFn,
  });
  const labelAllowed = labelGuard.ok;
  if (!labelAllowed) {
    logger.warn("escalateToHuman: label refused by worker allowlist", {
      repo,
      target: `#${target.number}`,
      label: needsHumanLabel,
      error: labelGuard.error.message,
    });
  }

  // ---------------------------------------------------------------------
  // Step 1: ensure label exists (best-effort)
  // ---------------------------------------------------------------------
  if (labelAllowed) {
    try {
      const ensureResult = await ensureLabel(
        repo,
        needsHumanLabel,
        ensureLabelColour ?? getLabelColour(needsHumanLabel),
        ensureLabelDescription ?? getLabelDescription(needsHumanLabel),
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
  }

  // ---------------------------------------------------------------------
  // Step 2: add label (best-effort, skipped when the guard refused)
  // ---------------------------------------------------------------------
  let labelAdded = false;
  if (labelAllowed) {
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
      const matched = recent.filter((comment) => {
        if (!markers.some((marker) => comment.body.includes(marker))) {
          return false;
        }
        const createdMs = Date.parse(comment.createdAt);
        return !Number.isNaN(createdMs) && createdMs >= cutoff;
      });
      // Issue #1216: the marker lives in a comment body anybody may write and
      // every dedup key is derivable from public numbers, so a match on the
      // body alone let one planted `<!-- needs-human-escalation: … -->`
      // suppress the hand-off's "why / next step" comment for 24 hours. The
      // author is the only authenticated part of the match; an unresolvable
      // fleet identity discards every row, so the escalation is posted.
      const verified = await selectFleetAuthoredComments(
        matched,
        `needs-human escalation dedup on ${repo}#${target.number}`,
        deps?.dedupAuthors ?? {},
        (message) => logger.warn(message),
        "the escalation comment is posted — a marker anyone can write must " +
          "not silence a hand-off to a human",
      );
      dedupSkipped = verified.length > 0;
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
