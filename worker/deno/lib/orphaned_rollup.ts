/**
 * Self-heal for an orphaned merge into a milestone branch (Issue #175).
 *
 * `verifyMergeLanded` (Issue #4396) correctly refuses to close an issue whose
 * PR merged into `milestone/…` *after* that milestone's rollup PR had already
 * merged into the default branch — the merge commit is unreachable from the
 * default branch, so the work went nowhere. Refusing is only half a fix: the
 * milestone branch is genuinely ahead of the default branch, so the repair is
 * a fresh rollup PR. Once it lands the merge commit becomes reachable and the
 * ordinary close-on-merge path closes the issue with no human action.
 *
 * Without this the worker livelocked: both pool slots re-claimed GRQ#4173
 * every scan cycle, the pre-check refused every time, and nothing ever
 * changed the state that made it refuse.
 *
 * Idempotent by construction — an already-open rollup PR for the same branch
 * is reported as `exists` and nothing is created.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { isMilestoneBranch } from "./milestone_children_gate.ts";
import { getRepoDefaultBranch } from "./shell_helpers.ts";

/** Function signature for running gh CLI commands. */
export type GhCommandFn = (args: string[]) => Promise<string>;

/** Marker written into every self-healed rollup PR body. */
export const ORPHANED_ROLLUP_MARKER = "<!-- vibe-coder:orphaned-rollup -->";

/** Argument allowlists — the same shapes the milestone gate accepts. */
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;

/** What the repair did. */
export type OrphanedRollupOutcome =
  /** A fresh rollup PR was raised. */
  | { action: "created"; prUrl: string; milestoneBranch: string }
  /** An open rollup PR for this branch already exists — nothing to do. */
  | { action: "exists"; prNumber: number; milestoneBranch: string }
  /** The branch is missing or not ahead of the default branch. */
  | { action: "nothing-to-merge"; milestoneBranch: string }
  /** The merge was not into a milestone branch — outside this repair. */
  | { action: "not-applicable"; reason: string }
  /** The repair was attempted and failed — reported loudly, never as success. */
  | { action: "failed"; reason: string };

/** Inputs for {@link repairOrphanedMilestoneMerge}. */
export interface OrphanedRollupOptions {
  /** Repository in `owner/repo` form. */
  repo: string;
  /** The branch the orphaned PR merged into. */
  milestoneBranch: string;
  /** The PR whose merge was orphaned — quoted in the rollup PR body. */
  orphanedPrNumber: number;
  /** Function to execute gh CLI commands. */
  ghCommandFn: GhCommandFn;
  /** Default branch, when the caller already knows it (saves a lookup). */
  defaultBranch?: string;
}

interface RawPr {
  number?: unknown;
  headRefName?: unknown;
  baseRefName?: unknown;
}

/** The open rollup PR for `milestoneBranch`, or null; throws on lookup failure. */
async function findOpenRollupPr(
  repo: string,
  milestoneBranch: string,
  ghCommandFn: GhCommandFn,
): Promise<number | null> {
  const raw = await ghCommandFn([
    "pr",
    "list",
    "--repo",
    repo,
    "--head",
    milestoneBranch,
    "--state",
    "open",
    "--json",
    "number,headRefName,baseRefName",
    "--limit",
    "50",
  ]);
  const parsed = JSON.parse(raw);
  const prs: RawPr[] = Array.isArray(parsed) ? parsed as RawPr[] : [];
  // Defence in depth: `gh pr list --head` has been observed returning broader
  // results, so re-check the head locally (Issue #859). Any open PR from the
  // milestone branch counts — a second rollup from the same head, whatever
  // its base, would be duplicate noise.
  const match = prs.find((pr) =>
    pr.headRefName === milestoneBranch && typeof pr.number === "number"
  );
  return match ? match.number as number : null;
}

/** Commits `milestoneBranch` has that `defaultBranch` does not; null when unreadable. */
async function commitsAhead(
  repo: string,
  milestoneBranch: string,
  defaultBranch: string,
  ghCommandFn: GhCommandFn,
): Promise<number | null> {
  const out = await ghCommandFn([
    "api",
    `repos/${repo}/compare/${defaultBranch}...${milestoneBranch}`,
    "--jq",
    ".ahead_by",
  ]);
  const aheadBy = Number(out.trim());
  return Number.isFinite(aheadBy) ? aheadBy : null;
}

/** The body of a self-healed rollup PR. */
export function buildOrphanedRollupBody(options: {
  milestoneBranch: string;
  defaultBranch: string;
  orphanedPrNumber: number;
  aheadBy: number;
}): string {
  const { milestoneBranch, defaultBranch, orphanedPrNumber, aheadBy } = options;
  return `${ORPHANED_ROLLUP_MARKER}
## Orphaned milestone merge — fresh rollup

PR #${orphanedPrNumber} merged into \`${milestoneBranch}\` **after** that
milestone's rollup PR had already merged into \`${defaultBranch}\`, so its
merge commit is not reachable from \`${defaultBranch}\` and the work has not
landed (Issue #4396).

\`${milestoneBranch}\` is ${aheadBy} commit(s) ahead of \`${defaultBranch}\`.
This PR merges them so the orphaned work lands and the issues behind it close
on merge in the ordinary way.

Raised automatically by the Vibe Coder (Issue #175).`;
}

/**
 * Ensure a rollup PR exists for a milestone branch carrying an orphaned merge.
 *
 * Fails loud: a lookup or create that errors returns `failed` with the reason,
 * never a quiet "nothing to do".
 */
export async function repairOrphanedMilestoneMerge(
  options: OrphanedRollupOptions,
): Promise<OrphanedRollupOutcome> {
  const { repo, milestoneBranch, orphanedPrNumber, ghCommandFn } = options;

  if (!isMilestoneBranch(milestoneBranch)) {
    return {
      action: "not-applicable",
      reason: `${
        milestoneBranch || "(no base branch)"
      } is not a milestone branch`,
    };
  }
  if (!REPO_PATTERN.test(repo) || !BRANCH_PATTERN.test(milestoneBranch)) {
    return {
      action: "failed",
      reason: "repo or branch name failed the argument allowlist",
    };
  }

  let defaultBranch = options.defaultBranch;
  if (!defaultBranch) {
    const resolved = await getRepoDefaultBranch(repo, ghCommandFn);
    if (!resolved.ok) {
      return {
        action: "failed",
        reason: `default branch unknown: ${resolved.error.message}`,
      };
    }
    defaultBranch = resolved.value.trim();
  }
  if (!defaultBranch) {
    return {
      action: "failed",
      reason: "default branch resolved to an empty name",
    };
  }

  try {
    const existing = await findOpenRollupPr(
      repo,
      milestoneBranch,
      ghCommandFn,
    );
    if (existing !== null) {
      return { action: "exists", prNumber: existing, milestoneBranch };
    }
  } catch (err) {
    return {
      action: "failed",
      reason: `could not list open rollup PRs for ${milestoneBranch}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  let aheadBy: number | null;
  try {
    aheadBy = await commitsAhead(
      repo,
      milestoneBranch,
      defaultBranch,
      ghCommandFn,
    );
  } catch (err) {
    return {
      action: "failed",
      reason: `could not compare ${defaultBranch}...${milestoneBranch}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (aheadBy === null) {
    return {
      action: "failed",
      reason: `unreadable ahead_by for ${defaultBranch}...${milestoneBranch}`,
    };
  }
  if (aheadBy === 0) {
    return { action: "nothing-to-merge", milestoneBranch };
  }

  try {
    const prUrl = (await ghCommandFn([
      "pr",
      "create",
      "--repo",
      repo,
      "--title",
      `Milestone rollup: ${milestoneBranch} → ${defaultBranch} (orphaned merge)`,
      "--body",
      buildOrphanedRollupBody({
        milestoneBranch,
        defaultBranch,
        orphanedPrNumber,
        aheadBy,
      }),
      "--head",
      milestoneBranch,
      "--base",
      defaultBranch,
    ])).trim();
    return { action: "created", prUrl, milestoneBranch };
  } catch (err) {
    return {
      action: "failed",
      reason: `could not create the rollup PR for ${milestoneBranch}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
