/**
 * Standing down from a PR head that no direct push can reach (Issue #1679).
 *
 * `stSoftwareAU/GRQ#4702` is the shape. Its head is the milestone branch
 * `milestone/4690-…`, and GRQ's ruleset applies `required_status_checks` to
 * `milestone/**`, so a commit can only arrive there through a pull request.
 * The spelling, CI-fix and merge-conflict passes did not know that: each
 * checked the milestone head out, let the agent commit on it, and pushed —
 * and every push was refused, once per worker run, for as long as the PR
 * stayed open:
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

/** Hidden marker identifying this module's stand-down comment on a PR. */
export function gatedHeadMarker(branchName: string): string {
  return `<!-- vibe-gated-head branch="${branchName}" -->`;
}

/** The stand-down comment: what was refused, why, and what a human can do. */
export function buildGatedHeadComment(
  branchName: string,
  assessment: GatedHeadAssessment,
): string {
  return [
    gatedHeadMarker(branchName),
    `**Standing down — \`${branchName}\` cannot be pushed to directly.**`,
    "",
    `${capitalise(assessment.detail)}.`,
    "",
    "The automated spelling, CI-fix and merge-conflict passes therefore leave " +
    "this PR alone rather than retrying a push that can never land. Changes " +
    "for this branch have to arrive through a pull request into it, or an " +
    "operator has to add the fleet account as a bypass actor on the rule.",
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

/** PRs already reported this run, keyed `repo#pr`. */
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
}

/**
 * Assess a PR head and, when it is gated, record the stand-down once.
 *
 * The comment is posted at most once per branch: once per process via the
 * registry above, and once across runs via {@link gatedHeadMarker} on the PR.
 * A comment listing that fails posts nothing — a duplicate comment every run
 * is the noise this exists to remove — and says so in the log.
 *
 * @returns The assessment. A `gated: true` answer means the caller must not
 *   check the branch out, run the agent, or spend an attempt on it.
 */
export async function guardGatedHead(
  options: GatedHeadGuardOptions,
): Promise<GatedHeadAssessment> {
  const { repo, prNumber, branchName, pass, logger, runGhCommand } = options;
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

  const key = `${repo}#${prNumber}`;
  if (reported.has(key)) return assessment;
  reported.add(key);

  try {
    if (await hasGatedHeadComment(repo, prNumber, branchName, runGhCommand)) {
      return assessment;
    }
    await runGhCommand([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      buildGatedHeadComment(branchName, assessment),
    ]);
  } catch (error) {
    logger.warn("Could not record the gated-head stand-down on the PR", {
      repo,
      prNumber,
      branchName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return assessment;
}

/**
 * Whether the PR already carries this branch's stand-down comment.
 *
 * Throws when the listing cannot be read or parsed: an unreadable thread is
 * not an empty one, and reading it as empty is how a "posted once" comment
 * becomes a comment per run (the same fail-loud stance as
 * `ghIssueCommentLister`).
 */
async function hasGatedHeadComment(
  repo: string,
  prNumber: number,
  branchName: string,
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
  const marker = gatedHeadMarker(branchName);
  return parsed.comments.some((comment) =>
    typeof comment?.body === "string" && comment.body.includes(marker)
  );
}
