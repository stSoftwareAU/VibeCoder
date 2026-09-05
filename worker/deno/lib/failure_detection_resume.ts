/**
 * Resume pass that finishes outstanding Failure-Detection repairs (Issue #60,
 * part of #54).
 *
 * A partially-repaired planning run leaves its parent labelled
 * `needs-failure-detection-repair` instead of `failed-once` (Issue #59). Without
 * a resume path that state is inert: the sub-issues stay published without a
 * `## Failure Detection` section and nothing ever revisits them. This module is
 * the thing that revisits them.
 *
 * For each labelled parent the pass:
 *   1. enumerates the parent's **native** sub-issues (the original run's
 *      `subIssueUrls` are long gone by then — see `fetchNativeSubIssueNumbers`),
 *   2. re-runs the deterministic gate (`runFailureDetectionGate`) over them,
 *   3. repairs only what is *still* offending
 *      (`repairFailureDetectionSections`), and
 *   4. removes the label and posts a confirmation comment when the set is empty.
 *
 * Re-gating first is what makes the pass idempotent and self-healing: a
 * sub-issue a human fixed by hand is no longer an offender, so an already-clean
 * parent costs **zero** Claude calls and simply loses its label.
 *
 * **Bounded retries.** A parent that cannot be repaired must not be retried
 * forever. Each cycle that genuinely attempted a repair and still failed records
 * an attempt marker in its parent comment; once
 * {@link MAX_FAILURE_DETECTION_RESUME_ATTEMPTS} attempts are spent the parent is
 * handed to a human through the existing `escalateToHuman` chokepoint and the
 * resume label is dropped, so the pass stops re-picking it. Offenders the
 * handler budget merely **deferred** (Issue #58 — never attempted) do not spend
 * an attempt: a budget shortfall is not evidence that a repair is impossible.
 *
 * **Only the fleet may spend the budget.** The tally lives in the parent's
 * comment thread, which anyone who can see the issue may post to, so an
 * attempt marker on its own is a stranger asserting how many repairs have
 * been tried. Left unchecked, one planted `<!-- failure-detection-resume-
 * attempt: N -->` exhausts the budget and forces the `escalated` outcome —
 * the label dropped, the parent handed to a human, the repair abandoned.
 * The comment **author** is checked against the fleet identity
 * (`alert_dedup_authors.ts`) before an attempt counts. The fail direction
 * is towards **retrying**: an unverifiable tally counts as zero attempts,
 * so the pass tries again rather than giving up on evidence it cannot read.
 *
 * Running outside the Planning handler takes the repair off that handler's
 * watchdog budget entirely.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { GitHubClient, GitHubComment, Logger } from "../types.ts";
import {
  type AlertDedupAuthorOptions,
  selectFleetAuthoredComments,
} from "./alert_dedup_authors.ts";
import { FAILURE_DETECTION_REPAIR_LABEL } from "./config_defaults.ts";
import {
  type FailureDetectionOffender,
  runFailureDetectionGate,
} from "./failure_detection_gate.ts";
import {
  type RepairClaudeRunner,
  repairFailureDetectionSections,
} from "./failure_detection_repair.ts";
import { fetchNativeSubIssueNumbers } from "./native_sub_issues.ts";
import { findFailureDetectionRepairParents } from "./find_failure_detection_repair_issues.ts";
import {
  escalateToHuman,
  type EscalateToHumanDeps,
} from "./needs_human_escalation.ts";

/**
 * How many *attempted* resume repairs a parent gets before the outstanding
 * repairs are handed to a human.
 *
 * Three matches the auto-fix attempt budget (`auto_fix_attempt_tracker.ts`):
 * enough for a transient model or `gh` failure to clear, few enough that a
 * genuinely un-repairable sub-issue reaches a human within a few cycles.
 */
export const MAX_FAILURE_DETECTION_RESUME_ATTEMPTS = 3;

/** Default number of parents processed per dispatch cycle. */
const DEFAULT_MAX_PARENTS_PER_CYCLE = 1;

/** Marker prefix embedded in the parent comment of a failed resume attempt. */
const ATTEMPT_MARKER_PREFIX = "<!-- failure-detection-resume-attempt:";

/** Matches {@link buildResumeAttemptMarker} in a comment body. */
const ATTEMPT_MARKER_RE =
  /<!--\s*failure-detection-resume-attempt:\s*(\d+)\s*-->/g;

/**
 * The same marker without `g`, for a one-shot predicate.
 *
 * A `g` regex carries `lastIndex` between calls, so `.test()` on the shared
 * constant would skip every second comment.
 */
const ATTEMPT_MARKER_TEST =
  /<!--\s*failure-detection-resume-attempt:\s*\d+\s*-->/;

/** What the resume pass did to one parent. */
export type FailureDetectionResumeStatus =
  /** The re-gate found no offenders — the label was stale and is now cleared. */
  | "already-clean"
  /** Every remaining offender was repaired this cycle; the label is cleared. */
  | "repaired"
  /** Offenders remain; the label stays so the next cycle retries. */
  | "outstanding"
  /** The retry budget is spent; the parent is now a human's to finish. */
  | "escalated";

/** Outcome of resuming one parent's outstanding repairs. */
export interface FailureDetectionResumeOutcome {
  repo: string;
  parentIssueNumber: number;
  status: FailureDetectionResumeStatus;
  /** Sub-issue numbers the re-gate found still offending. */
  offenders: number[];
  /** Sub-issue numbers repaired this cycle. */
  repaired: number[];
  /** Sub-issue numbers still lacking a criterion after this cycle. */
  unresolved: number[];
  /** Claude invocations spent on this parent (zero on the clean path). */
  claudeInvocations: number;
  /** Whether the resume label was removed from the parent. */
  labelCleared: boolean;
}

/** Build the attempt marker recorded in a failed attempt's parent comment. */
export function buildResumeAttemptMarker(attempt: number): string {
  return `${ATTEMPT_MARKER_PREFIX} ${attempt} -->`;
}

/**
 * Read the highest resume attempt recorded in a parent's comments.
 *
 * The count lives in the comments rather than on disk so it survives a worker
 * restart and is the same number for every worker in the fleet.
 *
 * Pass only comments a fleet account authored — {@link readRecordedAttempts}
 * filters them first. A marker in an arbitrary comment is a claim, not a
 * record.
 *
 * @returns 0 when no attempt has been recorded.
 */
export function countRecordedResumeAttempts(
  comments: readonly GitHubComment[],
): number {
  let highest = 0;
  for (const comment of comments) {
    for (const match of comment.body.matchAll(ATTEMPT_MARKER_RE)) {
      const attempt = Number(match[1]);
      if (Number.isInteger(attempt) && attempt > highest) highest = attempt;
    }
  }
  return highest;
}

/** Format an offender list as markdown bullets. */
function offenderLines(offenders: readonly FailureDetectionOffender[]): string {
  return offenders
    .map((o) => `- #${o.number} (${o.title}) — ${o.reason}`)
    .join("\n");
}

/**
 * Build the confirmation comment posted when a parent's sub-issues all pass.
 *
 * @param repaired - Sub-issues this cycle repaired (empty when the parent was
 *   already clean — fixed by hand, or by an earlier cycle).
 */
export function buildResumeClearedComment(repaired: readonly number[]): string {
  const opening = repaired.length > 0
    ? "✅ **Failure-Detection repairs finished.** The resume pass repaired " +
      repaired.map((n) => `#${n}`).join(", ") +
      " — every published sub-issue " +
      "now carries a filled `## Failure Detection` section."
    : "✅ **Failure-Detection repairs already complete.** Re-gating this " +
      "parent's sub-issues found no offender — every published sub-issue " +
      "carries a filled `## Failure Detection` section.";
  return [
    opening,
    "",
    `The \`${FAILURE_DETECTION_REPAIR_LABEL}\` label has been removed.`,
  ].join("\n");
}

/** Build the comment posted when a resume attempt left offenders behind. */
export function buildResumeProgressComment(args: {
  attempt: number;
  maxAttempts: number;
  repaired: readonly number[];
  stillOffending: readonly FailureDetectionOffender[];
}): string {
  const repairedLine = args.repaired.length > 0
    ? `Repaired this cycle: ${args.repaired.map((n) => `#${n}`).join(", ")}.`
    : "Nothing could be repaired this cycle.";
  return [
    `⚠️ **Failure-Detection repair still outstanding** (attempt ${args.attempt} ` +
    `of ${args.maxAttempts}). ${repairedLine} The following sub-issue(s) still ` +
    "lack a filled `## Failure Detection` section:",
    "",
    offenderLines(args.stillOffending),
    "",
    `The \`${FAILURE_DETECTION_REPAIR_LABEL}\` label stays on this issue so the ` +
    "next cycle retries. After the final attempt the outstanding repairs are " +
    "handed to a human.",
    "",
    buildResumeAttemptMarker(args.attempt),
  ].join("\n");
}

/**
 * Build the comment posted when the parent's native sub-issues could not be
 * enumerated, so the re-gate could not run at all.
 *
 * Carries the same attempt marker as a failed repair: an un-enumerable parent
 * must reach a human on the same bound rather than being retried forever.
 */
export function buildResumeEnumerationFailureComment(
  attempt: number,
  maxAttempts: number,
): string {
  return [
    `⚠️ **Failure-Detection repair could not be re-gated** (attempt ${attempt} ` +
    `of ${maxAttempts}). This issue carries the ` +
    `\`${FAILURE_DETECTION_REPAIR_LABEL}\` label, but no native sub-issues ` +
    "could be read from it, so the outstanding repairs could not be checked.",
    "",
    "The label stays so the next cycle retries. After the final attempt the " +
    "outstanding repairs are handed to a human.",
    "",
    buildResumeAttemptMarker(attempt),
  ].join("\n");
}

/** Shared options for one parent's resume. */
export interface ResumeFailureDetectionRepairOptions {
  repo: string;
  parentIssueNumber: number;
  ghClient: GitHubClient;
  ghCommandFn: (args: string[]) => Promise<string>;
  runClaude: RepairClaudeRunner;
  logger: Logger;
  /** Label applied when the retry budget is spent — `config.needsHumanLabel`. */
  needsHumanLabel: string;
  /** Attempt budget; defaults to {@link MAX_FAILURE_DETECTION_RESUME_ATTEMPTS}. */
  maxAttempts?: number;
  /** Handler watchdog deadline (epoch ms), forwarded to the repair (#58). */
  deadlineMs?: number;
  /** Injected clock, so the budget is testable with no timers. */
  now?: () => number;
  /** GitHub login used in the escalation comment footer. */
  githubUser?: string;
  /**
   * Fleet logins whose attempt markers count towards the retry budget.
   * Omitted reads the configured fleet identity, which is what every
   * production caller does.
   */
  fleetAuthors?: AlertDedupAuthorOptions["fleetAuthors"];
  /**
   * Injected {@link escalateToHuman} dependencies — used by tests to stub the
   * label creation so no test reaches the network.
   */
  escalationDeps?: EscalateToHumanDeps;
}

/**
 * Re-gate one labelled parent's native sub-issues, repair what still offends,
 * and clear the label when nothing is left.
 *
 * Every GitHub and Claude interaction is injected, so the whole path is
 * unit-tested without a network.
 */
export async function resumeFailureDetectionRepair(
  opts: ResumeFailureDetectionRepairOptions,
): Promise<FailureDetectionResumeOutcome> {
  const { repo, parentIssueNumber, ghCommandFn, logger } = opts;
  const maxAttempts = opts.maxAttempts ?? MAX_FAILURE_DETECTION_RESUME_ATTEMPTS;

  const base = {
    repo,
    parentIssueNumber,
    offenders: [] as number[],
    repaired: [] as number[],
    unresolved: [] as number[],
    claudeInvocations: 0,
    labelCleared: false,
  };

  // --- Re-gate the parent's native sub-issues ---
  const subIssueNumbers = await fetchNativeSubIssueNumbers(
    repo,
    parentIssueNumber,
    ghCommandFn,
  );

  if (subIssueNumbers.length === 0) {
    // An empty list is indistinguishable from a failed API read, so this is
    // never treated as a clean pass: the label stays and the attempt is
    // recorded, which means a parent that can never be enumerated reaches a
    // human rather than looping forever.
    logger.warn(
      "Failure-Detection resume: the parent reports no native sub-issues — cannot re-gate, keeping the label (Issue #60)",
      { repo, issueNumber: parentIssueNumber },
    );
    const attempts = await readRecordedAttempts(opts);
    if (attempts >= maxAttempts) {
      return await escalateSpentBudget(opts, {
        base,
        attempts,
        reason:
          `${attempts} resume attempts could not enumerate this parent's ` +
          "native sub-issues, so the outstanding `## Failure Detection` " +
          "repairs cannot be re-gated automatically.",
        nextStep:
          "Check the parent's sub-issue links, repair each sub-issue's " +
          "`## Failure Detection` section by hand, then close this issue.",
        unresolved: [],
      });
    }
    await postComment(
      opts,
      buildResumeEnumerationFailureComment(attempts + 1, maxAttempts),
    );
    return { ...base, status: "outstanding" };
  }

  const offenders = await runFailureDetectionGate({
    repo,
    subIssueNumbers,
    ghCommandFn,
    logger,
  });

  // --- Clean re-gate: the label is stale, nothing else to do ---
  if (offenders.length === 0) {
    logger.info(
      "Failure-Detection resume: re-gate found no offenders — clearing the label (Issue #60)",
      { repo, issueNumber: parentIssueNumber },
    );
    const cleared = await clearRepairLabel(opts);
    await postComment(opts, buildResumeClearedComment([]));
    return { ...base, status: "already-clean", labelCleared: cleared };
  }

  base.offenders = offenders.map((o) => o.number);

  // --- Bounded retries: a spent budget goes to a human, not another repair ---
  const priorAttempts = await readRecordedAttempts(opts);
  if (priorAttempts >= maxAttempts) {
    return await escalateSpentBudget(opts, {
      base,
      attempts: priorAttempts,
      reason:
        `${priorAttempts} resume attempts could not give these sub-issues a ` +
        `filled \`## Failure Detection\` section:\n\n${
          offenderLines(offenders)
        }`,
      nextStep:
        "Add a `## Failure Detection` section to each sub-issue above (a " +
        "concrete test, CI gate or alert — or `N/A — <reason>` for docs-only " +
        "work), then close this issue.",
      unresolved: base.offenders,
    });
  }

  // --- Repair whatever is still offending ---
  const repair = await repairFailureDetectionSections({
    repo,
    offenders,
    runClaude: opts.runClaude,
    ghCommandFn,
    logger,
    ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });

  base.repaired = repair.repaired;
  base.claudeInvocations = repair.invocations.length;

  const unresolved = [...repair.stillOffending, ...repair.deferred];
  if (unresolved.length === 0) {
    logger.info(
      "Failure-Detection resume: every outstanding repair finished — clearing the label (Issue #60)",
      {
        repo,
        issueNumber: parentIssueNumber,
        repaired: repair.repaired.join(","),
      },
    );
    const cleared = await clearRepairLabel(opts);
    await postComment(opts, buildResumeClearedComment(repair.repaired));
    return { ...base, status: "repaired", labelCleared: cleared };
  }

  return await recordUnresolvedAttempt(
    opts,
    maxAttempts,
    {
      ...base,
      status: "outstanding",
      unresolved: unresolved.map((o) => o.number),
    },
    repair.stillOffending,
    repair.deferred,
  );
}

/**
 * Hand a parent whose retry budget is spent to a human.
 *
 * Routes through the shared `escalateToHuman` chokepoint (label + explanation
 * always together), then drops the resume label: the outstanding repairs are a
 * human's now, and leaving the label on would have the pass re-pick an
 * already-escalated parent every cycle.
 */
async function escalateSpentBudget(
  opts: ResumeFailureDetectionRepairOptions,
  args: {
    base: Omit<FailureDetectionResumeOutcome, "status">;
    attempts: number;
    reason: string;
    nextStep: string;
    unresolved: number[];
  },
): Promise<FailureDetectionResumeOutcome> {
  opts.logger.error(
    "Failure-Detection resume: retry budget spent — escalating the outstanding repairs to a human (Issue #60)",
    {
      repo: opts.repo,
      issueNumber: opts.parentIssueNumber,
      attempts: args.attempts,
      unresolved: args.unresolved.join(","),
    },
  );
  await escalateToHuman({
    ghClient: opts.ghClient,
    repo: opts.repo,
    target: { kind: "issue", number: opts.parentIssueNumber },
    needsHumanLabel: opts.needsHumanLabel,
    heading: "Failure-Detection repairs could not be finished",
    reason: args.reason,
    nextStep: args.nextStep,
    dedupKey: `failure-detection-resume-${opts.parentIssueNumber}`,
    ...(opts.githubUser ? { githubUser: opts.githubUser } : {}),
    ...(opts.escalationDeps ? { deps: opts.escalationDeps } : {}),
    logger: opts.logger,
  });
  const labelCleared = await clearRepairLabel(opts);
  return {
    ...args.base,
    status: "escalated",
    unresolved: args.unresolved,
    labelCleared,
  };
}

/**
 * Record an unfinished resume cycle on the parent.
 *
 * An attempt is only consumed when the repair genuinely **tried** and failed
 * (`stillOffending` non-empty). A cycle whose offenders were all deferred by the
 * handler budget (Issue #58) was never attempted, so it neither spends an
 * attempt nor posts a comment — the label alone carries the state to the next
 * cycle, and the parent's thread is not spammed once per cycle.
 */
async function recordUnresolvedAttempt(
  opts: ResumeFailureDetectionRepairOptions,
  maxAttempts: number,
  outcome: FailureDetectionResumeOutcome,
  stillOffending: readonly FailureDetectionOffender[],
  deferred: readonly FailureDetectionOffender[],
): Promise<FailureDetectionResumeOutcome> {
  if (stillOffending.length === 0) {
    opts.logger.warn(
      "Failure-Detection resume: no repair was attempted this cycle — the label stays and no attempt is spent (Issue #60)",
      {
        repo: opts.repo,
        issueNumber: opts.parentIssueNumber,
        deferred: deferred.map((o) => o.number).join(","),
      },
    );
    return outcome;
  }

  const attempt = (await readRecordedAttempts(opts)) + 1;
  opts.logger.warn(
    "Failure-Detection resume: sub-issue(s) still missing the criterion after the repair — retrying next cycle (Issue #60)",
    {
      repo: opts.repo,
      issueNumber: opts.parentIssueNumber,
      attempt,
      maxAttempts,
      stillOffending: stillOffending.map((o) => o.number).join(","),
    },
  );
  await postComment(
    opts,
    buildResumeProgressComment({
      attempt,
      maxAttempts,
      repaired: outcome.repaired,
      stillOffending,
    }),
  );
  return outcome;
}

/** Read the parent's recorded attempt count; 0 when the comments are unreadable. */
async function readRecordedAttempts(
  opts: ResumeFailureDetectionRepairOptions,
): Promise<number> {
  try {
    const comments = await opts.ghClient.getIssueComments(
      opts.repo,
      opts.parentIssueNumber,
    );
    return countRecordedResumeAttempts(
      await selectFleetAuthoredComments(
        comments.filter((comment) => ATTEMPT_MARKER_TEST.test(comment.body)),
        `failure-detection-resume ${opts.repo}#${opts.parentIssueNumber}`,
        { fleetAuthors: opts.fleetAuthors },
        (message) =>
          opts.logger.warn(message, {
            repo: opts.repo,
            issueNumber: opts.parentIssueNumber,
          }),
        "no attempt is counted and the repair is retried rather than " +
          "escalated — a marker anyone can post must not spend the budget",
      ),
    );
  } catch (err) {
    // Loud: the retry bound is derived from these comments, so an unreadable
    // thread means this cycle's attempt cannot be counted.
    opts.logger.error(
      "Failure-Detection resume: could not read the parent's comments — the retry budget cannot be counted this cycle (Issue #60)",
      {
        repo: opts.repo,
        issueNumber: opts.parentIssueNumber,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return 0;
  }
}

/** Remove the resume label from the parent. Best-effort, never silent. */
async function clearRepairLabel(
  opts: ResumeFailureDetectionRepairOptions,
): Promise<boolean> {
  try {
    await opts.ghClient.removeLabel(
      opts.repo,
      opts.parentIssueNumber,
      FAILURE_DETECTION_REPAIR_LABEL,
    );
    return true;
  } catch (err) {
    opts.logger.error(
      "Failure-Detection resume: could not remove the needs-failure-detection-repair label — the parent will be re-picked next cycle (Issue #60)",
      {
        repo: opts.repo,
        issueNumber: opts.parentIssueNumber,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return false;
  }
}

/** Post a comment on the parent. Best-effort — never aborts the pass. */
async function postComment(
  opts: ResumeFailureDetectionRepairOptions,
  body: string,
): Promise<void> {
  try {
    await opts.ghClient.postComment(opts.repo, opts.parentIssueNumber, body);
  } catch (err) {
    opts.logger.warn(
      "Failure-Detection resume: could not post the parent comment (non-fatal)",
      {
        repo: opts.repo,
        issueNumber: opts.parentIssueNumber,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
}

/** Result of one resume pass over the configured repositories. */
export interface FailureDetectionResumePassResult {
  /** Parents discovered carrying the resume label. */
  parentsFound: number;
  /** Outcomes for the parents processed this cycle. */
  outcomes: FailureDetectionResumeOutcome[];
}

/**
 * Run the resume pass across the configured repositories.
 *
 * Discovery is cheap (one `gh issue list` per repository) and processing is
 * bounded to `maxParentsPerCycle` parents so one cycle cannot spend its whole
 * budget on a backlog of parents — the rest are picked up next cycle.
 */
export async function runFailureDetectionResumePass(opts: {
  repos: readonly string[];
  ghClient: GitHubClient;
  ghCommandFn: (args: string[]) => Promise<string>;
  runClaude: RepairClaudeRunner;
  logger: Logger;
  needsHumanLabel: string;
  maxParentsPerCycle?: number;
  maxAttempts?: number;
  deadlineMs?: number;
  now?: () => number;
  githubUser?: string;
  /**
   * Fleet logins whose attempt markers count towards the retry budget.
   * Omitted reads the configured fleet identity.
   */
  fleetAuthors?: AlertDedupAuthorOptions["fleetAuthors"];
}): Promise<FailureDetectionResumePassResult> {
  const parents = await findFailureDetectionRepairParents({
    repos: opts.repos,
    ghCommandFn: opts.ghCommandFn,
    logger: opts.logger,
  });

  if (parents.length === 0) {
    return { parentsFound: 0, outcomes: [] };
  }

  const limit = opts.maxParentsPerCycle ?? DEFAULT_MAX_PARENTS_PER_CYCLE;
  const outcomes: FailureDetectionResumeOutcome[] = [];

  for (const parent of parents.slice(0, Math.max(0, limit))) {
    opts.logger.info(
      "Failure-Detection resume: finishing outstanding repairs on a labelled parent (Issue #60)",
      { repo: parent.repo, issueNumber: parent.number },
    );
    outcomes.push(
      await resumeFailureDetectionRepair({
        repo: parent.repo,
        parentIssueNumber: parent.number,
        ghClient: opts.ghClient,
        ghCommandFn: opts.ghCommandFn,
        runClaude: opts.runClaude,
        logger: opts.logger,
        needsHumanLabel: opts.needsHumanLabel,
        ...(opts.maxAttempts !== undefined
          ? { maxAttempts: opts.maxAttempts }
          : {}),
        ...(opts.deadlineMs !== undefined
          ? { deadlineMs: opts.deadlineMs }
          : {}),
        ...(opts.now ? { now: opts.now } : {}),
        ...(opts.githubUser ? { githubUser: opts.githubUser } : {}),
        ...(opts.fleetAuthors !== undefined
          ? { fleetAuthors: opts.fleetAuthors }
          : {}),
      }),
    );
  }

  if (parents.length > outcomes.length) {
    // Never silently capped: the deferred parents are named in the log so a
    // growing backlog is visible rather than looking like full coverage.
    opts.logger.info(
      "Failure-Detection resume: more labelled parents than this cycle's bound — the rest are picked up next cycle (Issue #60)",
      {
        found: parents.length,
        processed: outcomes.length,
      },
    );
  }

  return { parentsFound: parents.length, outcomes };
}
