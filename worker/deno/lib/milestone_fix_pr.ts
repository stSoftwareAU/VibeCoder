/**
 * Landing a fix into a gated `milestone/**` PR through a side-branch PR
 * (Issue #2907).
 *
 * Today, when a milestone PR's head is itself a `milestone/**` branch — a
 * ruleset-gated branch the service account cannot push to (GH013) — the
 * fleet's fix pass stands down rather than lose the fix. Standing down is
 * safe, but it leaves the milestone PR broken forever: nothing else ever
 * tries again.
 *
 * This module models {@link raiseMilestoneFixPr} on
 * `raiseMilestoneSyncPr` (Issue #589): the fix is pushed to a side branch the
 * ruleset does not cover, and a PR is raised from that branch *into* the
 * milestone branch, with auto-merge armed. The same gate that blocks the
 * direct push is what lets this PR land unattended once its checks are
 * green.
 *
 * Unlike the sync PR, this module does not push — the caller has already
 * committed and pushed the fix branch (the same way it would for any other
 * PR) before calling {@link raiseMilestoneFixPr}. This module only opens (or
 * reuses) the PR and arms it.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import type { Result } from "../types.ts";
import { clearMilestoneReviewRequests } from "./milestone_pr_reviewers.ts";

/** `owner/repo` with the character set GitHub actually allows. */
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Prefix for the branch a milestone fix PR is raised from. */
export const MILESTONE_FIX_BRANCH_PREFIX = "milestone-fix";

/** Sanitise a path segment to the character set a git ref allows. */
function sanitiseSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/**
 * The branch a fix PR is raised from for a given milestone PR and pass.
 *
 * `milestone-fix/<leaf>/pr-<N>-<disc>`, where `leaf` is `milestoneBranch`
 * with its leading `milestone/` removed, and both `leaf` and `discriminator`
 * are sanitised to the character set a git ref allows. `discriminator`
 * distinguishes repeated passes on the same PR (e.g. successive CI fixes),
 * so it is truncated rather than dropped when it runs long.
 */
export function milestoneFixBranchFor(
  milestoneBranch: string,
  prNumber: number,
  discriminator: string,
): string {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(
      `milestoneFixBranchFor: prNumber must be a positive integer, got ${prNumber}`,
    );
  }
  const leaf = sanitiseSegment(milestoneBranch.replace(/^milestone\//, ""));
  if (!leaf) {
    throw new Error(
      `milestoneFixBranchFor: milestoneBranch '${milestoneBranch}' sanitised to an empty leaf`,
    );
  }
  const disc = sanitiseSegment(discriminator).slice(0, 40);
  if (!disc) {
    throw new Error(
      `milestoneFixBranchFor: discriminator '${discriminator}' sanitised to empty`,
    );
  }
  return `${milestoneFixPrefixFor(milestoneBranch, prNumber)}${disc}`;
}

/** Whether a PR head branch is one this module raised. */
export function isMilestoneFixBranch(head: string): boolean {
  return head.startsWith(`${MILESTONE_FIX_BRANCH_PREFIX}/`);
}

/**
 * The head prefix every fix branch for this milestone PR shares:
 * `milestone-fix/<leaf>/pr-<N>-`.
 *
 * Used both to build a fresh branch name and to recognise an already-open
 * fix PR raised by an earlier pass, regardless of that pass's discriminator.
 */
export function milestoneFixPrefixFor(
  milestoneBranch: string,
  prNumber: number,
): string {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(
      `milestoneFixPrefixFor: prNumber must be a positive integer, got ${prNumber}`,
    );
  }
  const leaf = sanitiseSegment(milestoneBranch.replace(/^milestone\//, ""));
  if (!leaf) {
    throw new Error(
      `milestoneFixPrefixFor: milestoneBranch '${milestoneBranch}' sanitised to an empty leaf`,
    );
  }
  return `${MILESTONE_FIX_BRANCH_PREFIX}/${leaf}/pr-${prNumber}-`;
}

/** Injected seams so the whole path is testable without GitHub. */
export interface MilestoneFixPrDeps {
  /** Runs `gh`, returning stdout; throws on failure. */
  gh: (args: string[]) => Promise<string>;
  log?: (message: string) => void;
  /** Sink for the one warning; falls back to {@link log}. */
  warn?: (message: string) => void;
}

/** An open fix PR raised into a gated milestone branch. */
export interface MilestoneFixPr {
  number: number;
  url: string;
  /** True when this call opened the PR rather than reusing an open one. */
  opened: boolean;
}

/**
 * Find the open fix PR (if any) already raised for this milestone PR.
 *
 * Fails loud, not null: an unreadable listing must not be mistaken for "no
 * fix PR exists" — that would file a duplicate where one already answers
 * the fix.
 */
export async function findOpenMilestoneFixPr(
  repo: string,
  milestoneBranch: string,
  prNumber: number,
  deps: MilestoneFixPrDeps,
): Promise<Result<MilestoneFixPr | null>> {
  const prefix = milestoneFixPrefixFor(milestoneBranch, prNumber);
  let listed: string;
  try {
    listed = await deps.gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--base",
      milestoneBranch,
      "--json",
      "number,url,headRefName",
      "--limit",
      "100",
    ]);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(listed || "[]");
  } catch (error) {
    return {
      ok: false,
      error: new Error(
        `findOpenMilestoneFixPr: could not parse the PR listing for ` +
          `${repo}#${prNumber}: ${
            error instanceof Error ? error.message : String(error)
          }`,
      ),
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error: new Error(
        `findOpenMilestoneFixPr: unexpected PR listing shape for ${repo}#${prNumber}`,
      ),
    };
  }
  const match = (parsed as Array<
    { number?: unknown; url?: unknown; headRefName?: unknown }
  >).find((entry) =>
    typeof entry.headRefName === "string" &&
    entry.headRefName.startsWith(prefix)
  );
  if (!match || typeof match.number !== "number" ||
    typeof match.url !== "string"
  ) {
    return { ok: true, value: null };
  }
  return {
    ok: true,
    value: { number: match.number, url: match.url, opened: false },
  };
}

/** Options for {@link raiseMilestoneFixPr}. */
export interface RaiseMilestoneFixPrOptions {
  /** Repository in `owner/repo` form. */
  repo: string;
  /** The gated branch the fix PR targets. */
  milestoneBranch: string;
  /** The milestone PR the fix is for. */
  milestonePrNumber: number;
  /** The fix branch; already pushed by the caller. */
  fixBranch: string;
  /** Human label for the pass, e.g. "review feedback" or "CI fix". */
  pass: string;
}

/**
 * Arm auto-merge on a freshly-raised fix PR.
 *
 * Best-effort: a PR that cannot be armed still lands through the fleet's own
 * Auto-Merge sweep, so a failure here does not fail the fix. It is never
 * silent — the failure is both logged and posted as a PR comment (Issue
 * #2457), naming the reason and that the sweep retries.
 */
async function armMilestoneFixPrAutoMerge(
  repo: string,
  prNumber: number,
  deps: MilestoneFixPrDeps,
): Promise<void> {
  const warn = deps.warn ?? deps.log;
  try {
    await deps.gh([
      "pr",
      "merge",
      String(prNumber),
      "--repo",
      repo,
      "--auto",
      "--squash",
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn?.(
      `WARNING: the milestone fix PR ${repo}#${prNumber} was not armed for ` +
        `auto-merge: ${message.trim()}`,
    );
    try {
      await deps.gh([
        "pr",
        "comment",
        String(prNumber),
        "--repo",
        repo,
        "--body",
        `Auto-merge was not armed on this fix PR: ${message.trim()}\n\n` +
        "The Auto-Merge sweep retries.",
      ]);
    } catch (commentError) {
      // Fail loud: the refusal must never become silent because the comment
      // could not be posted either.
      warn?.(
        `WARNING: could not post the auto-merge reason comment on ` +
          `${repo}#${prNumber}: ${
            commentError instanceof Error
              ? commentError.message
              : String(commentError)
          }`,
      );
    }
  }
}

/**
 * Raise (or reuse) a PR that lands a fix into a gated milestone PR.
 *
 * The caller has already pushed `fixBranch`; this only opens the PR into
 * `milestoneBranch` and arms it. One open fix PR per milestone PR: a fix PR
 * that is still open for this milestone PR is reused rather than duplicated.
 */
export async function raiseMilestoneFixPr(
  options: RaiseMilestoneFixPrOptions,
  deps: MilestoneFixPrDeps,
): Promise<Result<MilestoneFixPr>> {
  const { repo, milestoneBranch, milestonePrNumber, fixBranch, pass } =
    options;

  if (!REPO_PATTERN.test(repo)) {
    return {
      ok: false,
      error: new Error(`raiseMilestoneFixPr: invalid repo '${repo}'`),
    };
  }
  if (!milestoneBranch.startsWith("milestone/")) {
    return {
      ok: false,
      error: new Error(
        `raiseMilestoneFixPr: '${milestoneBranch}' is not a milestone branch`,
      ),
    };
  }
  if (!isMilestoneFixBranch(fixBranch)) {
    return {
      ok: false,
      error: new Error(
        `raiseMilestoneFixPr: '${fixBranch}' is not a milestone fix branch`,
      ),
    };
  }

  // One open fix PR per milestone PR: reuse rather than duplicate.
  try {
    const listed = await deps.gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--head",
      fixBranch,
      "--base",
      milestoneBranch,
      "--json",
      "number,url",
    ]);
    const open = JSON.parse(listed || "[]") as { number: number; url: string }[];
    if (Array.isArray(open) && open.length > 0) {
      const existing = open[0]!;
      deps.log?.(
        `milestone fix: reusing the open fix PR #${existing.number} for ` +
          `${repo}#${milestonePrNumber} (Issue #2907)`,
      );
      return {
        ok: true,
        value: { number: existing.number, url: existing.url, opened: false },
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  try {
    const body = [
      `The head of #${milestonePrNumber} is \`${milestoneBranch}\`, which is ` +
      "ruleset-gated: the fleet cannot push a fix to it directly (GH013), so " +
      `it delivers the ${pass} through this PR instead.`,
      "",
      `References #${milestonePrNumber} and Issue #2907.`,
      "",
      `Refs #${milestonePrNumber}`,
    ].join("\n");

    const created = await deps.gh([
      "pr",
      "create",
      "--repo",
      repo,
      "--base",
      milestoneBranch,
      "--head",
      fixBranch,
      "--title",
      `Address #${milestonePrNumber} ${pass} on ${milestoneBranch}`,
      "--body",
      body,
    ]);

    const number = Number(created.trim().split("/").pop());
    if (!Number.isInteger(number) || number <= 0) {
      return {
        ok: false,
        error: new Error(
          `raiseMilestoneFixPr: could not parse a PR number from '${created.trim()}'`,
        ),
      };
    }

    await armMilestoneFixPrAutoMerge(repo, number, deps);
    await clearMilestoneReviewRequests({
      repo,
      prNumber: number,
      base: milestoneBranch,
    }, {
      ghCommandFn: deps.gh,
      ...(deps.log ? { log: deps.log } : {}),
      ...(deps.warn ?? deps.log ? { warn: deps.warn ?? deps.log } : {}),
    });

    deps.log?.(
      `milestone fix: raised PR ${created.trim()} to deliver the ${pass} ` +
        `into '${milestoneBranch}' for ${repo}#${milestonePrNumber} (Issue #2907)`,
    );
    return { ok: true, value: { number, url: created.trim(), opened: true } };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
