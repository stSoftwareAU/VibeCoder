/**
 * Deduplicated, non-fatal baseline-carryover tracking-issue filer
 * (Issue #2605).
 *
 * Two callers, one dedup mechanism: the diffable bypass files the carried-over
 * findings ({@link fileBaselineCarryoverTracker}), and the pre-existing gate
 * failure stop files the names of the checks red on the repository's own
 * default branch ({@link fileRedCheckTracker}, Issue #1852). They share the
 * search-then-file machinery but keep **separate titles and markers**: a
 * shared one would let an open findings tracker suppress the red-check
 * tracker, and then nothing on the repository would name the check that
 * stopped every run.
 *
 * Companion to the generic baseline-aware quality-gate bypass (Issue #2604).
 * When an unrelated PR is correctly waved through because every current
 * diffable finding (shellcheck, mermaid, markdownlint, docs) was already
 * present at the baseline, the underlying broken artefact is still broken —
 * it would silently rot until something else trips over it. This filer puts
 * that pre-existing breakage on its OWN line as a `needs-human` tracking
 * issue so a human (or a future worker task) fixes it independently, rather
 * than having it ride or block an unrelated PR.
 *
 * Two invariants keep it well-behaved:
 *
 *   1. **Deduplicated** — at most one open tracker per repo. The filer
 *      searches open issues for the stable title before filing, and counts a
 *      match only when the fleet authored it (`idle_task_wrapper_dedup.ts`):
 *      a title is text anyone may write, so an unverified match would let an
 *      outsider suppress the tracker for good.
 *   2. **Non-fatal** — every failure is caught, logged, and swallowed. The
 *      filer must never block the bypass or the PR (mirrors the non-fatal
 *      label-sync pattern).
 *
 * Why `needs-human` (not `idle-task`): the idle-task claim handler routes a
 * claimed issue by title to a registered template; no template fixes an
 * arbitrary quality-gate failure, so an `idle-task` tracker would be
 * unactionable. `needs-human` is the only self-appliable label that lands the
 * issue in the existing human-triage queue (permitted by
 * `WORKER_APPLIABLE_LABEL_LITERALS`).
 *
 * Australian English used throughout (behaviour, organisation, favour, etc.).
 */

import { runGhCommand as defaultGhCommand } from "./github.ts";
import { guardedLabelArgs } from "./guarded_issue_labels.ts";
import type { AlertDedupAuthorOptions } from "./alert_dedup_authors.ts";
import { findFleetAuthoredIssuesTitled } from "./idle_task_wrapper_dedup.ts";
import type { GenericFinding } from "./baseline_gate.ts";

/** Body marker that, with the stable title, identifies an open tracker. */
export const BASELINE_CARRYOVER_MARKER = "<!-- baseline-carryover-tracker -->";

/** Marker of the red-check tracker (Issue #1852) — its own, never shared. */
export const PRE_EXISTING_GATE_MARKER = "<!-- pre-existing-gate-tracker -->";

/** The label that lands the tracker in the human-triage queue. */
const TRACKER_LABEL = "needs-human";

/**
 * Build the stable tracker title for a repo. Stable so the dedup search can
 * match it exactly across runs.
 */
export function buildCarryoverTrackerTitle(repo: string): string {
  return `Pre-existing quality-gate failures: ${repo}`;
}

/**
 * Build the stable red-check tracker title for a repo (Issue #1852). Distinct
 * from {@link buildCarryoverTrackerTitle} so the two trackers dedup
 * independently.
 */
export function buildRedCheckTrackerTitle(repo: string): string {
  return `Quality gate red on the default branch: ${repo}`;
}

/** Minimal logger surface — satisfied by the worker `Logger` and by `console`. */
interface TrackerLogger {
  warn: (message: string) => void;
}

/** Injectable dependencies (default to the production `gh` runner + console). */
export interface CarryoverTrackerDeps {
  ghCommand?: (args: string[]) => Promise<string>;
  logger?: TrackerLogger;
  /**
   * Author-verification inputs for the dedup search. Omitted — every
   * production caller — reads the configured fleet identity.
   */
  dedupAuthors?: AlertDedupAuthorOptions;
}

/**
 * Render the tracker issue body: a short explanation of why the issue exists
 * and what to do, the list of carried-over findings, and the dedup marker.
 *
 * Note: the findings are framed as PRE-EXISTING (present at baseline) — the
 * opposite of `formatCarryoverFindings`, whose "new findings" wording would be
 * misleading here. The per-finding `- [check] display` line format matches it.
 */
export function formatCarryoverTrackerBody(
  repo: string,
  findings: GenericFinding[],
): string {
  const lines: string[] = [
    BASELINE_CARRYOVER_MARKER,
    "",
    `## Pre-existing quality-gate failures in \`${repo}\``,
    "",
    "The worker bypassed a failing quality gate on an unrelated PR because " +
    "every current diffable finding was already present on the baseline " +
    "(Issue #2604). Those pre-existing failures are tracked here on their " +
    "own line so they are fixed independently rather than riding or " +
    "blocking an unrelated change.",
    "",
    "### Carried-over findings",
    "",
    ...(findings.length > 0
      ? findings.map((f) => `- [${f.check}] ${f.display}`)
      : ["- (no structured findings captured)"]),
    "",
    "### What a human should do",
    "",
    "Fix the artefacts above (or open targeted issues for them), then close " +
    "this tracker. While it stays open, the worker will not file a " +
    "duplicate — one open tracker per repo.",
  ];
  return lines.join("\n");
}

/**
 * Return true when the fleet already has an open tracking issue for `repo`.
 *
 * The stable title is what the search matches, and an issue title is text any
 * account able to open an issue may write — so the title alone would let an
 * outsider convince the worker a tracker exists and keep pre-existing
 * breakage permanently unreported. `findFleetAuthoredIssuesTitled` adds the
 * author check that makes a match evidence; an unresolvable fleet author set
 * yields no match, so the tracker is filed rather than silently skipped.
 *
 * Throws whatever `gh` throws — the caller's `try` already treats a failed
 * lookup as "do not file", which is its existing behaviour.
 */
async function hasOpenCarryoverTracker(
  repo: string,
  title: string,
  ghCommand: (args: string[]) => Promise<string>,
  dedupAuthors: AlertDedupAuthorOptions,
  logger: TrackerLogger,
): Promise<boolean> {
  const matches = await findFleetAuthoredIssuesTitled({
    repo,
    title,
    context: `carryover tracker ${repo}`,
    ghCommand,
    log: logger.warn,
    ...dedupAuthors,
  });
  return matches.length > 0;
}

/**
 * Render the tracker body for checks that are red on the repository's own
 * default branch (Issue #1852).
 *
 * The findings body above needs structured findings, which only the diffable
 * checks produce. A repository whose own check fails on the untouched tree
 * has none — the name of the red check is all there is to say, and it is
 * exactly what a human needs to fix the gate.
 */
export function formatRedCheckTrackerBody(
  repo: string,
  checks: readonly string[],
): string {
  const lines: string[] = [
    PRE_EXISTING_GATE_MARKER,
    "",
    `## The quality gate is red on \`${repo}\`'s default branch`,
    "",
    "The quality gate is red on this repository's own default branch. A " +
    "worker run reproduced exactly the same failure after its change, so " +
    "the run was ended as a pre-existing gate failure (Issue #1852): no " +
    "PR was raised, the issue it was working was released untouched, and " +
    "the run was not recorded as a worker failure. Every run on this " +
    "repository will stop the same way until the gate is green again.",
    "",
    "### Checks red on the untouched tree",
    "",
    ...(checks.length > 0
      ? checks.map((check) => `- \`${check}\``)
      : ["- (the failing check could not be named)"]),
    "",
    "### What a human should do",
    "",
    "Fix the checks above on the default branch (or open targeted issues " +
    "for them), then close this tracker. While it stays open, the worker " +
    "will not file a duplicate — one open tracker per repo.",
  ];
  return lines.join("\n");
}

/**
 * File a deduplicated `needs-human` tracking issue for the checks that are
 * red on the repository's own default branch (Issue #1852).
 *
 * Carries its own title and marker, so an open findings tracker
 * ({@link fileBaselineCarryoverTracker}) cannot suppress it — the repository
 * must be able to say which check is red however the gate broke.
 *
 * Deduplicated (one open red-check tracker per repo) and non-fatal, exactly
 * like its sibling. Never throws.
 *
 * @param repo - `owner/repo` slug whose gate is red.
 * @param checks - Names of the checks failing on the untouched tree.
 * @param deps - Optional injectable `gh` runner and logger.
 */
export async function fileRedCheckTracker(
  repo: string,
  checks: readonly string[],
  deps: CarryoverTrackerDeps = {},
): Promise<void> {
  await fileTracker(
    repo,
    buildRedCheckTrackerTitle(repo),
    formatRedCheckTrackerBody(repo, checks),
    deps,
  );
}

/**
 * File a deduplicated `needs-human` tracking issue for the pre-existing
 * quality-gate findings carried over on a bypassed PR (Issue #2605).
 *
 * Deduplicated (skips when an open tracker exists) and non-fatal (any failure
 * is logged and swallowed). Never throws.
 *
 * @param repo - `owner/repo` slug the bypass occurred in.
 * @param findings - The pre-existing carryover findings (`decision.preExisting`).
 * @param deps - Optional injectable `gh` runner and logger.
 */
export async function fileBaselineCarryoverTracker(
  repo: string,
  findings: GenericFinding[],
  deps: CarryoverTrackerDeps = {},
): Promise<void> {
  await fileTracker(
    repo,
    buildCarryoverTrackerTitle(repo),
    formatCarryoverTrackerBody(repo, findings),
    deps,
  );
}

/**
 * File the one tracker, with whichever body the caller rendered.
 *
 * Holds the dedup search, the guarded label and the swallow-and-log contract
 * both filers share, so the two entry points cannot drift apart.
 */
async function fileTracker(
  repo: string,
  title: string,
  body: string,
  deps: CarryoverTrackerDeps,
): Promise<void> {
  const ghCommand = deps.ghCommand ?? defaultGhCommand;
  const logger = deps.logger ?? { warn: (m: string) => console.error(m) };

  // Built before the try so a refused label fails loud rather than being
  // folded into the "filing failed (continuing)" warning.
  const labelArgs = guardedLabelArgs(
    [TRACKER_LABEL],
    "worker/deno/lib/baseline_carryover_tracker.ts",
  );

  try {
    if (
      await hasOpenCarryoverTracker(
        repo,
        title,
        ghCommand,
        deps.dedupAuthors ?? {},
        logger,
      )
    ) {
      // A tracker is already open — do not spam a duplicate.
      return;
    }

    await ghCommand([
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      title,
      ...labelArgs,
      "--body",
      body,
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      `Baseline-carryover tracker filing failed (continuing): ${message}`,
    );
  }
}
