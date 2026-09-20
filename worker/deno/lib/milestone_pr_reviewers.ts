/**
 * Reviewer requests on pull requests targeting a milestone branch
 * (Issue #2438).
 *
 * The fleet raises two kinds of PR into a `milestone/**` branch —
 * completion-phase child-issue PRs and `sync/milestone-*` sync PRs — and
 * nothing waits on a review of either: the `milestone/**` ruleset requires
 * status checks only, and the review that matters sits on the milestone →
 * default-branch PR. A pending request on those PRs is noise in every
 * reviewer's queue.
 *
 * Two sources create one. The worker's own `--reviewer` argument is
 * suppressed by {@link reviewersForBase}; GitHub's CODEOWNERS auto-request
 * cannot be suppressed at creation, so {@link clearMilestoneReviewRequests}
 * removes it once, immediately after the PR is opened.
 *
 * Quota discipline (Issue #2409): the removal reads the requested reviewers
 * once and issues the DELETE **only** when that read comes back non-empty, so
 * a milestone PR with no auto-request costs a single call and nothing more.
 * Every call is `gh api <rest-path>` — the core quota, never GraphQL — which
 * is why the REST `requested_reviewers` read is used in place of the
 * GraphQL-backed `gh pr view --json reviewRequests`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { runGhCommand } from "./github.ts";
import { isMilestoneBranch } from "./milestone_children_gate.ts";

/** `owner/repo` with the character set GitHub actually allows. */
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** A user login or a team slug, with the character set GitHub allows. */
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Which pull request to clear the review requests on. */
export interface MilestoneReviewClearOptions {
  /** Repository in `owner/repo` form. */
  repo: string;
  /** The pull request number. */
  prNumber: number;
  /** The branch the pull request targets. */
  base: string;
}

/** Injection seams. */
export interface MilestoneReviewClearDeps {
  /** Runs `gh`; defaults to the retrying wrapper. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Sink for the one success line. */
  log?: (message: string) => void;
  /** Sink for the one warning; falls back to {@link log}. */
  warn?: (message: string) => void;
}

/** What the removal did — reported, never thrown. */
export type MilestoneReviewClearOutcome =
  /** The base is not a milestone branch, so nothing was read or changed. */
  | "not-milestone-base"
  /** The repo or PR number was malformed; no call was made. */
  | "invalid-target"
  /** Nothing was requested, so no DELETE was issued. */
  | "none-requested"
  /** A request existed and was removed. */
  | "cleared"
  /** A call failed; one warning was emitted and the caller carries on. */
  | "failed";

/**
 * The reviewers a PR into `base` should be created with.
 *
 * A milestone base asks for none; every other base keeps the list it was
 * configured with, so default-branch PRs are unaffected.
 */
export function reviewersForBase(
  base: string,
  configured: readonly string[],
): readonly string[] {
  return isMilestoneBranch(base) ? [] : configured;
}

/** The logins and team slugs in a `requested_reviewers` response. */
function parseRequested(
  raw: string,
): { users: string[]; teams: string[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { users?: unknown; teams?: unknown };
  const names = (value: unknown, key: "login" | "slug"): string[] =>
    Array.isArray(value)
      ? value
        .map((entry) =>
          entry && typeof entry === "object"
            ? (entry as Record<string, unknown>)[key]
            : undefined
        )
        .filter((name): name is string =>
          typeof name === "string" && NAME_PATTERN.test(name)
        )
      : [];
  return {
    users: names(record.users, "login"),
    teams: names(record.teams, "slug"),
  };
}

/**
 * Remove every pending review request from a PR that targets a milestone
 * branch.
 *
 * Fail-soft by design: a failed read or DELETE logs exactly one warning and
 * returns `"failed"` — the caller's exit code is unchanged, because a stale
 * review request is noise, not a broken PR. A human can always re-request by
 * hand where a repo's `milestone/**` ruleset does require an approval.
 */
export async function clearMilestoneReviewRequests(
  options: MilestoneReviewClearOptions,
  deps: MilestoneReviewClearDeps = {},
): Promise<MilestoneReviewClearOutcome> {
  const { repo, prNumber, base } = options;
  if (!isMilestoneBranch(base)) return "not-milestone-base";
  if (!REPO_PATTERN.test(repo)) return "invalid-target";
  if (!Number.isInteger(prNumber) || prNumber <= 0) return "invalid-target";

  const gh = deps.ghCommandFn ?? runGhCommand;
  const warn = deps.warn ?? deps.log;
  const path = `repos/${repo}/pulls/${prNumber}/requested_reviewers`;

  let requested: { users: string[]; teams: string[] } | null;
  try {
    requested = parseRequested(await gh(["api", "-X", "GET", path]));
  } catch (err) {
    warn?.(
      `milestone PR review-request read failed (non-fatal) for ${repo}#${prNumber}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return "failed";
  }
  if (!requested) {
    warn?.(
      `milestone PR review-request read returned unreadable JSON (non-fatal) ` +
        `for ${repo}#${prNumber}`,
    );
    return "failed";
  }
  // Issue #2409: the common case is no auto-request at all — spend nothing.
  if (requested.users.length === 0 && requested.teams.length === 0) {
    return "none-requested";
  }

  const fields = [
    ...requested.users.flatMap((login) => ["-f", `reviewers[]=${login}`]),
    ...requested.teams.flatMap((slug) => ["-f", `team_reviewers[]=${slug}`]),
  ];
  try {
    await gh(["api", "-X", "DELETE", path, ...fields]);
  } catch (err) {
    warn?.(
      `milestone PR review-request removal failed (non-fatal) for ${repo}#${prNumber}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return "failed";
  }
  deps.log?.(
    `milestone PR ${repo}#${prNumber}: removed ${requested.users.length} reviewer(s) ` +
      `and ${requested.teams.length} team(s) auto-requested by CODEOWNERS`,
  );
  return "cleared";
}
