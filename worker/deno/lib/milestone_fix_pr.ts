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
 * The merge method follows the head's shape (Issue #3596): a merge commit when
 * the head merges the default branch, since a squash would drop that ancestry
 * and strand the milestone's final PR; a squash otherwise. If the repository
 * refuses merge commits, the PR is not armed and the refusal is reported, never
 * squashed.
 *
 * Unlike the sync PR, this module does not push — the caller has already
 * committed and pushed the fix branch (the same way it would for any other
 * PR) before calling {@link raiseMilestoneFixPr}. This module only opens (or
 * reuses) the PR and arms it.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import type { Result } from "../types.ts";
import type { AlertDedupAuthorOptions } from "./alert_dedup_authors.ts";
import { isSafeRef } from "./conflict_fallback_context.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import {
  isMilestoneFixBranch,
  milestoneFixPrefixFor,
  sanitiseSegment,
} from "./milestone_branch_names.ts";
import { makeGhDefaultBranchFn } from "./milestone_branch_sync.ts";
import { clearMilestoneReviewRequests } from "./milestone_pr_reviewers.ts";
import { isMergeCommitNotAllowed } from "./milestone_sync_pr.ts";
import { findOwnedOpenArtefact } from "./owned_open_artefact.ts";

/** `owner/repo` with the character set GitHub actually allows. */
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export {
  isMilestoneFixBranch,
  MILESTONE_FIX_BRANCH_PREFIX,
  milestoneFixPrefixFor,
} from "./milestone_branch_names.ts";

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

/** Injected seams so the whole path is testable without GitHub. */
export interface MilestoneFixPrDeps {
  /** Runs `gh`, returning stdout; throws on failure. */
  gh: (args: string[]) => Promise<string>;
  log?: (message: string) => void;
  /** Sink for the one warning; falls back to {@link log}. */
  warn?: (message: string) => void;
  /**
   * The fleet logins a listed fix PR must be opened by (Issue #2965). Omitted
   * reads the configured fleet identity; an unresolved set finds nothing, so
   * the caller files rather than reuses (Issue #3065).
   */
  fleetAuthors?: readonly string[];
  /**
   * Where the configured fleet identity is read from when `fleetAuthors` is
   * omitted; production passes the caller's own.
   */
  dedupAuthors?: AlertDedupAuthorOptions;
}

/** An open fix PR raised into a gated milestone branch. */
export interface MilestoneFixPr {
  number: number;
  url: string;
  /** True when this call opened the PR rather than reusing an open one. */
  opened: boolean;
  /** Set when arming was refused because the repository forbids the merge commit this head needs (Issue #3596): the fix PR cannot land until merge commits are allowed. */
  mergeCommitRefusal?: string;
}

/**
 * Whether one `gh pr list` entry is a fix PR this fleet raised: same
 * repository, and opened by one of `fleetAuthors` (Issue #2965). Missing or
 * true `isCrossRepository` is a fork, or an answer that did not say, and
 * neither is this fleet's fix PR.
 */
export function isFleetFixPrListing(
  entry: { isCrossRepository?: unknown; author?: unknown },
  fleetAuthors: readonly string[],
): boolean {
  if (entry.isCrossRepository !== false) return false;
  const author = entry.author;
  const login = typeof author === "string"
    ? author
    : author !== null && typeof author === "object" &&
        typeof (author as { login?: unknown }).login === "string"
    ? (author as { login: string }).login
    : undefined;
  return login !== undefined && isFleetAuthor(login, [...fleetAuthors]);
}

/**
 * Find the open fix PR (if any) already raised for this milestone PR.
 *
 * Reuses only an owned, open, fleet-authored fix PR: same repository, state
 * OPEN, head under the shared prefix (Issue #3065), and opened by a fleet
 * login. Every caller gets this check. Fails loud, not null: an unreadable
 * listing must not be mistaken for "no fix PR exists" — that would file a
 * duplicate where one already answers the fix.
 */
export async function findOpenMilestoneFixPr(
  repo: string,
  milestoneBranch: string,
  prNumber: number,
  deps: MilestoneFixPrDeps,
  /**
   * When set, only a head that continues the shared prefix with this
   * discriminator matches. The takeover passes `takeover-` so an open CI
   * or review-feedback fix PR is not mistaken for its own (Issue #2965).
   */
  discriminator?: string,
): Promise<Result<MilestoneFixPr | null>> {
  const prefix = milestoneFixPrefixFor(milestoneBranch, prNumber);
  const needle = discriminator ? `${prefix}${discriminator}` : prefix;
  // An explicit fleetAuthors overrides any injected dedup seam (Issue #3854).
  const authors: AlertDedupAuthorOptions = {
    ...(deps.dedupAuthors ?? {}),
    ...(deps.fleetAuthors === undefined
      ? {}
      : { fleetAuthors: deps.fleetAuthors }),
  };
  let found: Awaited<ReturnType<typeof findOwnedOpenArtefact>>;
  try {
    found = await findOwnedOpenArtefact({
      repo,
      kind: "pr",
      marker: needle,
      base: milestoneBranch,
      ghCommandFn: deps.gh,
      authors,
      ...(deps.log ? { log: deps.log } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(
        `findOpenMilestoneFixPr: could not list the open fix PRs for ` +
          `${repo}#${prNumber}: ${message}`,
      ),
    };
  }
  if (found === null) return { ok: true, value: null };
  return {
    ok: true,
    value: { number: found.number, url: found.url, opened: false },
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

/** The merge method a milestone fix PR is armed with (Issue #3596). */
export type MilestoneFixMergeMethod = "--merge" | "--squash";

/** A full commit sha, as the compare API returns it. */
const COMMIT_SHA = /^[0-9a-f]{40}$/i;

/**
 * Which merge method may land a milestone fix PR (Issue #3596).
 *
 * `--merge` when the head's merge base with the default branch is not yet in
 * `milestoneBranch`, so the head carries default-branch ancestry that a squash
 * would drop. `--squash` when that base is already in the milestone branch
 * (identical or behind), so the head carries only content changes. An
 * unreadable answer is an error, never a guessed method. Never throws.
 */
export async function milestoneFixMergeMethod(
  repo: string,
  milestoneBranch: string,
  head: string, // the fix branch name, or a head commit sha
  gh: (args: string[]) => Promise<string>,
): Promise<Result<MilestoneFixMergeMethod>> {
  if (!REPO_PATTERN.test(repo)) {
    return {
      ok: false,
      error: new Error(`milestoneFixMergeMethod: invalid repo '${repo}'`),
    };
  }
  if (!milestoneBranch.startsWith("milestone/")) {
    return {
      ok: false,
      error: new Error(
        `milestoneFixMergeMethod: '${milestoneBranch}' is not a milestone branch`,
      ),
    };
  }
  for (const ref of [milestoneBranch, head]) {
    if (!isSafeRef(ref)) {
      return {
        ok: false,
        error: new Error(
          `milestoneFixMergeMethod: '${ref}' is not a safe branch name or sha`,
        ),
      };
    }
  }

  const fail = (cause: unknown): Result<MilestoneFixMergeMethod> => ({
    ok: false,
    error: new Error(
      `milestoneFixMergeMethod: could not tell whether ${head} merges ` +
        `${repo}'s default branch: ${
          cause instanceof Error ? cause.message.trim() : String(cause)
        }`,
    ),
  });

  const defaultRead = await makeGhDefaultBranchFn(gh)(repo);
  if (!defaultRead.ok) return fail(defaultRead.error);
  const defaultBranch = defaultRead.value;

  let mergeBase: string;
  try {
    mergeBase = (await gh([
      "api",
      `repos/${repo}/compare/${defaultBranch}...${head}`,
      "--jq",
      ".merge_base_commit.sha",
    ])).trim();
  } catch (error) {
    return fail(error);
  }
  if (!COMMIT_SHA.test(mergeBase)) {
    return fail(`the merge base '${mergeBase}' is not a commit sha`);
  }

  let status: string;
  try {
    status = (await gh([
      "api",
      `repos/${repo}/compare/${milestoneBranch}...${mergeBase}`,
      "--jq",
      ".status",
    ])).trim();
  } catch (error) {
    return fail(error);
  }
  if (status === "identical" || status === "behind") {
    return { ok: true, value: "--squash" };
  }
  if (status === "ahead" || status === "diverged") {
    return { ok: true, value: "--merge" };
  }
  return fail(`GitHub reported the comparison as '${status}'`);
}

/**
 * The one-line refusal for a milestone fix PR whose head merges the default
 * branch but whose repository disallows merge commits (Issue #3596).
 */
export function milestoneFixMergeCommitRefusal(
  repo: string,
  prNumber: number,
  detail: string,
): string {
  return `the head of milestone fix PR ${repo}#${prNumber} merges the default branch, so it must land as a merge commit, but ${repo} does not permit merge commits (${detail.trim()}). It was NOT squashed: a squash drops the default branch's ancestry and the milestone's final PR stays conflicting (Issue #3596). Enable merge commits on ${repo} (Settings → Pull Requests → Allow merge commits).`;
}

/** Warn and comment why a fix PR was not armed; never throws. */
async function reportFixPrNotArmed(
  repo: string,
  prNumber: number,
  reason: string,
  deps: MilestoneFixPrDeps,
): Promise<void> {
  const warn = deps.warn ?? deps.log;
  warn?.(
    `WARNING: the milestone fix PR ${repo}#${prNumber} was not armed for ` +
      `auto-merge: ${reason}`,
  );
  try {
    await deps.gh([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      `Auto-merge was not armed on this fix PR: ${reason}\n\n` +
      "The Auto-Merge sweep re-checks it.",
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

/**
 * Arm auto-merge on a freshly-raised fix PR, only once its base reads back as
 * the milestone branch (Issue #3433; fail closed on an unreadable base).
 *
 * Best-effort: a PR that is not armed does not fail the fix, but it is never
 * silent — the reason is logged and posted as a PR comment (Issue #2457), and
 * the Auto-Merge sweep re-checks the base on every later pass (Issue #3433).
 *
 * The merge method follows the head (Issue #3596): `--merge` when it merges
 * the default branch, `--squash` otherwise. A repository that refuses merge
 * commits is reported, never retried with `--squash`, and the refusal text is
 * returned so the caller can surface it.
 */
async function armMilestoneFixPrAutoMerge(
  repo: string,
  prNumber: number,
  milestoneBranch: string,
  fixBranch: string,
  deps: MilestoneFixPrDeps,
): Promise<string | undefined> {
  let base: unknown;
  try {
    const raw = await deps.gh([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "baseRefName,headRefName",
    ]);
    base = (JSON.parse(raw) as { baseRefName?: unknown } | null)?.baseRefName;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await reportFixPrNotArmed(
      repo,
      prNumber,
      `its base could not be read (${message.trim()}) (Issue #3433)`,
      deps,
    );
    return undefined;
  }
  if (base !== milestoneBranch) {
    await reportFixPrNotArmed(
      repo,
      prNumber,
      `its base is '${
        typeof base === "string" ? base : "unknown"
      }', not its milestone branch '${milestoneBranch}' (Issue #3433)`,
      deps,
    );
    return undefined;
  }
  const method = await milestoneFixMergeMethod(
    repo,
    milestoneBranch,
    fixBranch,
    deps.gh,
  );
  if (!method.ok) {
    await reportFixPrNotArmed(
      repo,
      prNumber,
      `whether its head merges the default branch could not be read (${method.error.message}), so it is not armed rather than risk squashing a default-branch merge (Issue #3596)`,
      deps,
    );
    return undefined;
  }
  try {
    await deps.gh([
      "pr",
      "merge",
      String(prNumber),
      "--repo",
      repo,
      "--auto",
      method.value,
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (method.value === "--merge" && isMergeCommitNotAllowed(message)) {
      const refusal = milestoneFixMergeCommitRefusal(repo, prNumber, message);
      await reportFixPrNotArmed(repo, prNumber, refusal, deps);
      return refusal;
    }
    await reportFixPrNotArmed(repo, prNumber, message.trim(), deps);
  }
  return undefined;
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
  const { repo, milestoneBranch, milestonePrNumber, fixBranch, pass } = options;

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
    const open = JSON.parse(listed || "[]") as {
      number: number;
      url: string;
    }[];
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

    const mergeCommitRefusal = await armMilestoneFixPrAutoMerge(
      repo,
      number,
      milestoneBranch,
      fixBranch,
      deps,
    );
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
    return {
      ok: true,
      value: {
        number,
        url: created.trim(),
        opened: true,
        ...(mergeCommitRefusal ? { mergeCommitRefusal } : {}),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
