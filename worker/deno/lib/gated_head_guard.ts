/**
 * Standing down from a PR head that no direct push can reach (Issue #1679).
 *
 * `stSoftwareAU/GRQ#4702` is the shape. Its head is the milestone branch
 * `milestone/4690-…`, and GRQ's ruleset applies `required_status_checks` to
 * `milestone/**`, so a commit can only arrive there through a pull request.
 * The spelling, CI-fix and merge-conflict passes did not know that: each
 * checked the milestone head out, let the agent commit on it, and pushed —
 * and every push was refused, once per worker run, for as long as the PR
 * stayed open (and the CI-nudge pass repeated the shape with its empty
 * commit until Issue #1762 wired it in):
 *
 * ```text
 * remote: error: GH013: Repository rule violations found for
 *   refs/heads/milestone/4690-….
 * remote: - 2 of 2 required status checks are expected.
 * ```
 *
 * A refusal that recurs identically every run is not a retryable fault, it is
 * a configuration fact (the Issue #853 lesson, one level up: there the ruleset
 * refused branch *creation*, here it refuses every push to an existing head).
 * So the passes ask this module **before** they check the branch out: a gated
 * head means the agent never runs, no attempt or retry is spent, and the PR
 * carries one comment naming the rule rather than an alternating run of
 * "pushed" and "no changes were needed" replies.
 *
 * The merge-conflict pass has since gone one step further (Issue #1772): a
 * `milestone/**` head is the milestone branch sync's to resolve, gated or not,
 * so that pass calls {@link standDownMilestoneHead} and never reads the rules.
 * The spelling and CI-nudge passes still ask {@link guardGatedHead} and stand
 * down. The CI-fix and review-feedback passes no longer do (Issue #2907):
 * they ask {@link assessGatedHead} directly and, when the head is gated, do
 * their fix work on a `milestone-fix/**` side branch and deliver it through
 * a pull request into the gated branch instead of giving up.
 *
 * Issue #2997: every stand-down comment now names the pass that now owns
 * the conflict (`conflict takeover` or `milestone sync`) and the UTC moment
 * the merge-conflict pass takes it back if the head has not moved —
 * {@link CONFLICT_OWNER_CHECK_HOURS} after the stand-down, carried on the
 * marker itself as `at="…"` so a restarted worker can still read the clock's
 * start back out ({@link readLatestStandDownAtMs}) rather than re-starting it
 * from `Date.now()` every run.
 *
 * Scope is deliberately narrow — only `milestone/**` heads are assessed. An
 * ordinary feature head under a repo-wide ruleset is left exactly as it was:
 * `GET /rules/branches/{branch}` does not account for the caller's bypass
 * permission, so widening this would stand the fix passes down on repos where
 * the fleet account can push perfectly well. A milestone head is the case
 * #589 already settled: changes land there through a PR.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Logger } from "../types.ts";
import { getBranchRules, type GhExec } from "./repo_rulesets.ts";
import {
  CONFLICT_OWNER_CHECK_HOURS,
  CONFLICT_PARKED_MARKER,
  CONFLICT_WATCHDOG_CHECKED_MARKER,
  standDownAtAttribute,
} from "./merge_conflict_markers.ts";
import { conflictCommentAuthor } from "./conflict_marker_trust.ts";

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

/** Prefix of the collection branches a chain of child PRs lands into. */
const MILESTONE_HEAD_PREFIX = "milestone/";

/**
 * Rule types that refuse a direct push to the branch they cover.
 *
 * `required_status_checks` refuses because a commit being pushed has no
 * checks yet; `pull_request` refuses direct pushes outright.
 */
export const GATING_RULE_TYPES: readonly string[] = [
  "required_status_checks",
  "pull_request",
];

/** True when `branchName` is a milestone collection branch. */
export function isMilestoneHead(branchName: string): boolean {
  return branchName.startsWith(MILESTONE_HEAD_PREFIX) &&
    branchName.length > MILESTONE_HEAD_PREFIX.length;
}

/** Whether a PR head can be pushed to directly, and why. */
export interface GatedHeadAssessment {
  /** True only when a rule is known to refuse a direct push to the head. */
  gated: boolean;
  /** One line naming the rule, or why the head was not judged gated. */
  detail: string;
  /** The gating rule types found on the branch, for the log and the comment. */
  ruleTypes: readonly string[];
}

/**
 * Assess whether a PR head refuses direct pushes.
 *
 * Fails **open**: a head that is not a milestone branch, and any branch whose
 * rules cannot be read, is reported as not gated. The push is then attempted
 * as before and a genuine refusal is still loud — GH013 on stderr — whereas
 * failing closed on an unreadable API would silently stop every milestone PR
 * from being worked on a transient blip.
 *
 * @param repo - `owner/repo` slug.
 * @param branchName - The PR head branch.
 * @param ghFn - Injected `gh` executor.
 */
export async function assessGatedHead(
  repo: string,
  branchName: string,
  ghFn: GhExec,
): Promise<GatedHeadAssessment> {
  if (!isMilestoneHead(branchName)) {
    return {
      gated: false,
      detail: `'${branchName}' is not a milestone branch`,
      ruleTypes: [],
    };
  }

  const rules = await getBranchRules(repo, branchName, ghFn);
  if (!rules.ok) {
    return {
      gated: false,
      detail:
        `branch rules for '${branchName}' unreadable: ${rules.error.message}`,
      ruleTypes: [],
    };
  }

  const ruleTypes = [
    ...new Set(
      rules.value
        .map((rule) => rule?.type)
        .filter((type): type is string =>
          typeof type === "string" && GATING_RULE_TYPES.includes(type)
        ),
    ),
  ];
  if (ruleTypes.length === 0) {
    return {
      gated: false,
      detail: `the rules endpoint returned no rule refusing a direct push to ` +
        `'${branchName}'`,
      ruleTypes: [],
    };
  }
  return {
    gated: true,
    detail: `a ruleset applies ${
      ruleTypes.join(", ")
    } to '${branchName}', so every direct push is refused (GH013)`,
    ruleTypes,
  };
}

// ---------------------------------------------------------------------------
// Comment
// ---------------------------------------------------------------------------

/** The pass that now owns a conflict once a stand-down is posted (Issue #2997). */
export type StandDownOwner = "milestone sync" | "conflict takeover";

/**
 * The UTC moment the merge-conflict pass takes a stood-down conflict back
 * (Issue #2997).
 *
 * Throws on a non-finite `standDownAtMs`: a takeover time nobody can compute
 * is a comment that cannot be posted, not a comment posted with a bogus
 * clock in it.
 */
export function takeoverAtMs(standDownAtMs: number): number {
  if (!Number.isFinite(standDownAtMs)) {
    throw new Error(
      `Refusing to compute a takeover time from a non-finite stand-down ` +
        `time (${standDownAtMs}) — the stand-down comment is not posted`,
    );
  }
  return standDownAtMs + CONFLICT_OWNER_CHECK_HOURS * 3_600_000;
}

/**
 * The two lines every stand-down comment carries naming its owner and the
 * UTC moment the merge-conflict pass takes the conflict back (Issue #2997).
 */
export function standDownNextStepLines(
  owner: StandDownOwner,
  standDownAtMs: number,
): string[] {
  const iso = new Date(takeoverAtMs(standDownAtMs)).toISOString();
  return [
    `**Owner:** \`${owner}\` — the pass that now owns this conflict.`,
    `**Takeover at ${iso}** (UTC) — if the PR head has not moved by then, ` +
    "the merge-conflict pass takes the conflict back and fixes it forward.",
  ];
}

/** Prefix shared by every gated-head marker for one branch, legacy or current. */
export function gatedHeadMarkerPrefix(branchName: string): string {
  return `<!-- vibe-gated-head branch="${branchName}"`;
}

/** Hidden marker identifying this module's stand-down comment on a PR. */
export function gatedHeadMarker(
  branchName: string,
  standDownAtMs: number,
): string {
  return `${gatedHeadMarkerPrefix(branchName)} ${
    standDownAtAttribute(standDownAtMs)
  } -->`;
}

/** The stand-down comment: what was refused, why, and what a human can do. */
export function buildGatedHeadComment(
  branchName: string,
  assessment: GatedHeadAssessment,
  standDownAtMs: number,
): string {
  const nextStepLines = standDownNextStepLines(
    "conflict takeover",
    standDownAtMs,
  );
  return [
    gatedHeadMarker(branchName, standDownAtMs),
    `**Standing down — \`${branchName}\` cannot be pushed to directly.**`,
    "",
    `${capitalise(assessment.detail)}.`,
    "",
    "The automated spelling, merge-conflict and CI-nudge passes therefore " +
    "leave this PR alone rather than retrying a push that can never land. " +
    "The CI-fix and review-feedback passes still deliver their fixes: each " +
    "does the work on a `milestone-fix/**` branch and opens a pull request " +
    "into this branch instead (Issue #2907). An operator can also add the " +
    "fleet account as a bypass actor on the rule.",
    "",
    ...nextStepLines,
    "",
    "This comment is posted once per branch, not once per run.",
  ].join("\n");
}

/** Prefix shared by every milestone-head marker for one branch, legacy or current. */
export function milestoneHeadMarkerPrefix(branchName: string): string {
  return `<!-- vibe-milestone-head branch="${branchName}"`;
}

/** Hidden marker identifying the milestone-sync stand-down comment on a PR. */
export function milestoneHeadMarker(
  branchName: string,
  standDownAtMs: number,
): string {
  return `${milestoneHeadMarkerPrefix(branchName)} ${
    standDownAtAttribute(standDownAtMs)
  } -->`;
}

/**
 * The merge-conflict pass's stand-down: this branch belongs to the sync.
 *
 * Same shape as {@link buildGatedHeadComment} — marker, one bold line, the
 * reason, and the once-per-branch note — but it names the milestone branch
 * sync rather than a ruleset, because the stand-down holds whether or not a
 * rule is in force (Issue #1772).
 */
export function buildMilestoneHeadComment(
  branchName: string,
  standDownAtMs: number,
): string {
  const nextStepLines = standDownNextStepLines("milestone sync", standDownAtMs);
  return [
    milestoneHeadMarker(branchName, standDownAtMs),
    `**Standing down — \`${branchName}\` is resolved by the milestone ` +
    `branch sync.**`,
    "",
    `Merges of the default branch into \`${branchName}\` have a single ` +
    `owner: the every-cycle milestone branch sync, which already falls back ` +
    `to a sync PR when a ruleset refuses its direct push (Issue #589). ` +
    `Running the merge-conflict pass here as well would duplicate that merge ` +
    `on the same branch and race its push, so no resolution attempt is spent ` +
    `on this PR.`,
    "",
    ...nextStepLines,
    "",
    "This comment is posted once per branch, not once per run.",
  ].join("\n");
}

/** First letter upper-cased; an empty string stays empty, never "undefined". */
function capitalise(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

/** Stand-downs already reported this run, keyed `repo#pr#marker`. */
const reported = new Set<string>();

/** Reset the per-run report registry. Tests only. */
export function resetGatedHeadReportsForTest(): void {
  reported.clear();
}

/** Options for {@link guardGatedHead}. */
export interface GatedHeadGuardOptions {
  repo: string;
  prNumber: number;
  branchName: string;
  /** The pass standing down (`spelling fix`, `CI fix`, …), named in the log. */
  pass: string;
  logger: Logger;
  /** `gh` runner, used for the rules read and the comment. */
  runGhCommand: (args: string[]) => Promise<string>;
  /** The current time, injected for tests. Defaults to `Date.now`. */
  nowMs?: () => number;
}

/**
 * Assess a PR head and, when it is gated, record the stand-down once.
 *
 * The comment is posted at most once per branch — see
 * {@link recordStandDownOnce}.
 *
 * @returns The assessment. A `gated: true` answer means the caller must not
 *   check the branch out, run the agent, or spend an attempt on it.
 */
export async function guardGatedHead(
  options: GatedHeadGuardOptions,
): Promise<GatedHeadAssessment> {
  const {
    repo,
    prNumber,
    branchName,
    pass,
    logger,
    runGhCommand,
    nowMs = Date.now,
  } = options;
  const assessment = await assessGatedHead(
    repo,
    branchName,
    (args: string[]) => runGhCommand(args),
  );
  if (!assessment.gated) return assessment;

  logger.warn(
    `${pass} skipped for PR #${prNumber}: head '${branchName}' refuses direct ` +
      `pushes — ${assessment.detail}`,
    { repo, prNumber, branchName, ruleTypes: assessment.ruleTypes.join(",") },
  );

  const standDownAtMs = nowMs();
  const body = buildGatedHeadComment(branchName, assessment, standDownAtMs);

  await recordStandDownOnce({
    repo,
    prNumber,
    markerPrefix: gatedHeadMarkerPrefix(branchName),
    body,
    logger,
    runGhCommand,
  });
  return assessment;
}

/** Options for {@link standDownMilestoneHead}. */
export interface MilestoneHeadStandDownOptions {
  repo: string;
  prNumber: number;
  branchName: string;
  logger: Logger;
  /** `gh` runner, used for the comment listing and the comment. */
  runGhCommand: (args: string[]) => Promise<string>;
  /** The current time, injected for tests. Defaults to `Date.now`. */
  nowMs?: () => number;
}

/**
 * Stand down from a `milestone/**` PR head, gated or not (Issue #1772).
 *
 * The every-cycle milestone branch sync is the single owner of
 * `default → milestone/*` merges, and it already lands its merge through a
 * sync PR when a ruleset refuses the direct push (Issue #589). Resolving the
 * same conflict from the PR ladder would duplicate that merge on the same
 * branch and race its push, so the merge-conflict pass leaves the branch to
 * the sync — whether or not a rule is in force, which is why this is decided
 * on the branch name rather than on {@link assessGatedHead}.
 *
 * @returns `true` when the head is a milestone branch: the caller must not
 *   check it out, run the agent, or open an attempt on it.
 */
export async function standDownMilestoneHead(
  options: MilestoneHeadStandDownOptions,
): Promise<boolean> {
  const { repo, prNumber, branchName, logger, runGhCommand, nowMs = Date.now } =
    options;
  if (!isMilestoneHead(branchName)) return false;

  logger.info(
    "Merge-conflict resolution skipped: milestone head — resolved by the " +
      "milestone branch sync",
    { repo, prNumber, branchName },
  );

  const standDownAtMs = nowMs();
  const body = buildMilestoneHeadComment(branchName, standDownAtMs);

  await recordStandDownOnce({
    repo,
    prNumber,
    markerPrefix: milestoneHeadMarkerPrefix(branchName),
    body,
    logger,
    runGhCommand,
  });
  return true;
}

/**
 * Post a stand-down comment at most once per branch and marker prefix.
 *
 * Once per process via the registry above, and once across runs via the
 * marker on the PR. Deduped on the **prefix** rather than the full marker
 * (Issue #2997): the marker now carries an `at="…"` timestamp that is
 * different on every call, so matching the full string would post a fresh
 * comment every run; matching the prefix means a legacy marker with no
 * `at=` still counts as "already recorded" too. A comment listing that fails
 * posts nothing — a duplicate comment every run is the noise this exists to
 * remove — and says so in the log.
 */
async function recordStandDownOnce(options: {
  repo: string;
  prNumber: number;
  markerPrefix: string;
  body: string;
  logger: Logger;
  runGhCommand: (args: string[]) => Promise<string>;
}): Promise<void> {
  const { repo, prNumber, markerPrefix, body, logger, runGhCommand } = options;
  const key = `${repo}#${prNumber}#${markerPrefix}`;
  if (reported.has(key)) return;
  reported.add(key);

  try {
    if (
      await hasStandDownComment(repo, prNumber, markerPrefix, runGhCommand)
    ) return;
    await runGhCommand([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      body,
    ]);
  } catch (error) {
    logger.warn("Could not record the stand-down on the PR", {
      repo,
      prNumber,
      marker: markerPrefix,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Whether the PR already carries the stand-down comment `markerPrefix`
 * identifies.
 *
 * Throws when the listing cannot be read or parsed: an unreadable thread is
 * not an empty one, and reading it as empty is how a "posted once" comment
 * becomes a comment per run (the same fail-loud stance as
 * `ghIssueCommentLister`).
 */
async function hasStandDownComment(
  repo: string,
  prNumber: number,
  markerPrefix: string,
  runGhCommand: (args: string[]) => Promise<string>,
): Promise<boolean> {
  const raw = await runGhCommand([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "comments",
  ]);
  const parsed = JSON.parse(raw) as { comments?: { body?: unknown }[] };
  if (!Array.isArray(parsed?.comments)) {
    throw new Error(
      "gh pr view returned no `comments` array — cannot tell whether the " +
        "stand-down was already recorded",
    );
  }
  return parsed.comments.some((comment) =>
    typeof comment?.body === "string" && comment.body.includes(markerPrefix)
  );
}

// ---------------------------------------------------------------------------
// Reading the stand-down clock back (Issue #2997)
// ---------------------------------------------------------------------------

/** The literal prefixes {@link readLatestStandDownAtMs} recognises as a stand-down. */
const STAND_DOWN_MARKER_PREFIXES: readonly string[] = [
  "<!-- vibe-gated-head ",
  "<!-- vibe-milestone-head ",
  CONFLICT_PARKED_MARKER,
  CONFLICT_WATCHDOG_CHECKED_MARKER,
];

/** The epoch ms one comment's own `at="…"`/`created_at` carries, or `undefined`. */
function readOneStandDownAtMs(
  body: string,
  createdAt: unknown,
): number | undefined {
  for (const prefix of STAND_DOWN_MARKER_PREFIXES) {
    const start = body.indexOf(prefix);
    if (start < 0) continue;

    const end = body.indexOf("-->", start);
    const markerText = body.slice(
      start,
      end >= 0 ? end + "-->".length : body.length,
    );
    const written = /at="([^"]*)"/.exec(markerText)?.[1];
    if (written !== undefined) {
      const parsed = Date.parse(written);
      if (Number.isFinite(parsed)) return parsed;
    }
    // Legacy marker (no `at=`), or an `at=` nothing can parse: fall back to
    // the comment's own `created_at`, the moment it was actually posted.
    if (typeof createdAt === "string") {
      const parsed = Date.parse(createdAt);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  }
  return undefined;
}

/**
 * The newest trusted stand-down's clock start, across every stand-down
 * marker this module and `merge_conflict_markers.ts`'s park marker write
 * (Issue #2997).
 *
 * The stall watchdog reads this back to know when the
 * {@link CONFLICT_OWNER_CHECK_HOURS}-hour owner clock started, so the
 * merge-conflict pass takes a conflict back at the same moment the
 * stand-down comment itself named — rather than re-measuring from whenever
 * the watchdog happens to run.
 *
 * Author-filtered like every reader in this vocabulary
 * (`conflict_marker_trust.ts`): a comment with no readable login, or whose
 * login `isTrustedAuthor` rejects, is skipped entirely, because a forged
 * stand-down would move another pass's clock.
 *
 * @param comments - Raw REST comment objects, oldest first.
 * @param isTrustedAuthor - Predicate a comment's `user.login` must pass for
 *   its marker to be read at all.
 * @returns The greatest (newest) stand-down time found, or `undefined` when
 *   no trusted comment carries one.
 */
export function readLatestStandDownAtMs(
  comments: readonly unknown[],
  isTrustedAuthor: (login: string) => boolean,
): number | undefined {
  let latest: number | undefined;

  for (const raw of comments) {
    if (typeof raw !== "object" || raw === null) continue;
    const comment = raw as { body?: unknown; created_at?: unknown };
    if (typeof comment.body !== "string") continue;

    const author = conflictCommentAuthor(raw);
    if (author === undefined || !isTrustedAuthor(author)) continue;

    const atMs = readOneStandDownAtMs(comment.body, comment.created_at);
    if (atMs === undefined) continue;
    if (latest === undefined || atMs > latest) latest = atMs;
  }

  return latest;
}
