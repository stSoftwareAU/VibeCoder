/**
 * Escalation for unworkable `work-on` issues (Issue #2752).
 *
 * Two detection sources in `collect_work_on_candidates.ts` feed one shared
 * escalation action:
 *   1. dependency cycles — an issue that (transitively) blocks itself, so the
 *      worker can never progress it; and
 *   2. self-suppressing dead labels — a milestone-tracking issue carrying the
 *      `work-on` label, which the worker never actions.
 *
 * Breaking a cycle, or deciding whether a tracker should be relabelled or
 * closed, needs human judgement, so the correct unattended behaviour is to
 * escalate (apply `needs-human` + post exactly one explanatory comment) and
 * continue to the next issue — never retry forever or silently deadlock.
 *
 * The escalation routes through the shared {@link escalateToHuman} chokepoint
 * via a thin `ghFn`-backed client, so the label is never applied without an
 * accompanying comment. A stable `dedupKey` per issue makes a re-scan
 * idempotent (no duplicate comment within 24 hours); the applied
 * `needs-human` label independently drops the issue from `filterAndSort` on
 * the next scan.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { GitHubClient, Logger, Result } from "../types.ts";
import { defaultLogger } from "./logger.ts";
import { createGhEscalationClient } from "./gh_escalation_client.ts";
import { ensureLabelExists as defaultEnsureLabelExists } from "./label_operations.ts";
import { escalateToHuman } from "./needs_human_escalation.ts";

type GhFn = (args: string[]) => Promise<string>;

/** Injectable dependencies for {@link escalateUnworkableWorkOn} (testing). */
export interface EscalateUnworkableDeps {
  /** Override the GitHub client. Defaults to a `ghFn`-backed shim. */
  ghClient?: GitHubClient;
  /**
   * Override label-existence ensuring. Defaults to routing the production
   * `ensureLabelExists` through `ghFn`, so the whole escalation flows through
   * the single injected command function (hermetic in tests).
   */
  ensureLabelExists?: (
    repo: string,
    labelName: string,
    colour?: string,
    description?: string,
  ) => Promise<Result<void>>;
  /** Override the logger. Defaults to {@link defaultLogger}. */
  logger?: Logger;
  /** Override the clock used by the dedup window. Defaults to `Date.now`. */
  now?: () => number;
}

/** A pre-built escalation message (reason + next step + stable dedup key). */
export interface UnworkableEscalation {
  reason: string;
  nextStep: string;
  dedupKey: string;
}

/**
 * Build the escalation message for a detected dependency cycle.
 *
 * `cyclePath` is the ordered list of issue numbers on the cycle; the message
 * renders it as `#A → #B → #A` so a human can see the loop at a glance.
 */
export function buildCycleEscalation(
  issueNumber: number,
  cyclePath: number[],
): UnworkableEscalation {
  const rendered = renderCyclePath(issueNumber, cyclePath);
  return {
    reason:
      `blocked: dependency cycle ${rendered}. This issue (transitively) ` +
      `depends on itself, so the worker can never progress it autonomously.`,
    nextStep: "Break the cycle — decide the correct ordering and remove the " +
      "offending dependency/parent reference (or close the duplicate), then " +
      "remove `needs-human`.",
    dedupKey: `work-on-dependency-cycle-${issueNumber}`,
  };
}

/**
 * Build the escalation message for a milestone-tracking issue that carries
 * the `work-on` label (a dead label the worker never actions).
 */
export function buildDeadLabelEscalation(
  issueNumber: number,
): UnworkableEscalation {
  return {
    reason:
      `this is a milestone-tracking issue the worker never actions, but it ` +
      `is labelled \`work-on\`. The label can never lead to work, so it ` +
      `silently sits in the backlog.`,
    nextStep:
      "Relabel or close this issue — remove `work-on` (the worker handles " +
      "milestone trackers separately), then remove `needs-human`.",
    dedupKey: `work-on-dead-label-tracker-${issueNumber}`,
  };
}

/**
 * Render a cycle path as `#A → #B → #A`, rooted at `issueNumber` and closed
 * back to it so the loop is explicit.
 */
function renderCyclePath(issueNumber: number, cyclePath: number[]): string {
  const ordered = cyclePath.length > 0 ? cyclePath : [issueNumber];
  const parts = ordered.map((n) => `#${n}`);
  // Close the loop back to the first node when it is not already shown.
  if (parts.length > 0 && ordered[ordered.length - 1] !== ordered[0]) {
    parts.push(`#${ordered[0]}`);
  }
  return parts.join(" → ");
}

/**
 * Apply `needs-human` and post exactly one explanatory comment for an
 * unworkable `work-on` issue, routed through the shared escalation
 * chokepoint. Best-effort and non-fatal — a failure is logged and swallowed
 * so escalation never blocks the work stream or the repo scan.
 *
 * @returns true when the escalation fired (label and/or comment), false on
 *   failure or when the comment was deduped away.
 */
export async function escalateUnworkableWorkOn(opts: {
  repo: string;
  issueNumber: number;
  needsHumanLabel: string;
  escalation: UnworkableEscalation;
  githubUser?: string;
  ghFn: GhFn;
  deps?: EscalateUnworkableDeps;
}): Promise<boolean> {
  const logger = opts.deps?.logger ?? defaultLogger;
  const ghClient = opts.deps?.ghClient ?? createGhEscalationClient(opts.ghFn);
  // Route label-existence ensuring through the same ghFn by default so the
  // escalation is hermetic in tests and never touches the real gh CLI.
  const ensureLabelExists = opts.deps?.ensureLabelExists ??
    ((repo, labelName, colour, description) =>
      defaultEnsureLabelExists(
        repo,
        labelName,
        colour ?? "fbca04",
        description ?? "",
        { ghCommandFn: opts.ghFn },
      ));

  try {
    const result = await escalateToHuman({
      ghClient,
      repo: opts.repo,
      target: { kind: "issue", number: opts.issueNumber },
      needsHumanLabel: opts.needsHumanLabel,
      reason: opts.escalation.reason,
      nextStep: opts.escalation.nextStep,
      heading: "Unworkable work-on issue — needs human attention",
      dedupKey: opts.escalation.dedupKey,
      githubUser: opts.githubUser,
      logger,
      deps: {
        github: { ensureLabelExists },
        ...(opts.deps?.now ? { now: opts.deps.now } : {}),
      },
    });
    if (!result.ok) {
      logger.warn("escalateUnworkableWorkOn: escalation failed", {
        repo: opts.repo,
        issue: `#${opts.issueNumber}`,
        error: result.error.message,
      });
      return false;
    }
    return result.value.labelAdded || result.value.commentPosted;
  } catch (err) {
    logger.warn("escalateUnworkableWorkOn: escalation threw", {
      repo: opts.repo,
      issue: `#${opts.issueNumber}`,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
