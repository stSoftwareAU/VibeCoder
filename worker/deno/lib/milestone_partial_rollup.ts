/**
 * Partial rollup of a deadlocked milestone (Issue #2830, part of #2794).
 *
 * When a cross-milestone deadlock holds work behind a still-open milestone
 * (see `milestone_deadlock.ts`), the work already merged into that milestone
 * must reach the default branch without closing it. This module raises a
 * **partial rollup** PR from an immutable snapshot of the milestone branch:
 *
 * ```mermaid
 * flowchart TD
 *   A[createPartialRollup] --> B{open marked PR?}
 *   B -- yes --> X[exists]
 *   B -- no --> C[read milestone tip]
 *   C --> D{tip behind default?}
 *   D -- yes --> Y[deferred — sync first]
 *   D -- no --> E["create or reuse ref partial-rollup/slug-sha"]
 *   E --> F[gh pr create --head snapshot --base default]
 *   F --> Z[created]
 * ```
 *
 * The snapshot head is not a `milestone/` branch, so the full-rollup gates
 * (`hasExistingMilestoneSummaryPr`, `decideMilestoneBaseMerge`) never mistake
 * it for the milestone's own rollup: the milestone stays open and its final
 * rollup is raised later as normal. The body carries no closing keyword, so
 * the partial merge closes no issue.
 *
 * Never merges, rebases, updates or force-pushes (#2807, #2809, #2824): a
 * behind milestone is deferred to the sync path, and an existing snapshot ref
 * is reused only when it already points at the tip.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { isMilestoneBranch } from "./milestone_children_gate.ts";

/** Function signature for running gh CLI commands. */
export type GhCommandFn = (args: string[]) => Promise<string>;

/** Branch prefix of every partial-rollup snapshot. */
export const PARTIAL_ROLLUP_BRANCH_PREFIX = "partial-rollup/";

/** Argument allowlists — the same shapes the milestone gate accepts. */
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
/** A title embedded in the HTML-comment marker must not break out of it. */
const TITLE_PATTERN = /^[^"<>\r\n]{1,255}$/;
/** GitHub closing keywords followed by an issue reference. */
const CLOSING_KEYWORD_PATTERN =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s*[\w.-]*\/?[\w.-]*#\d+/i;

/** The body marker identifying the partial rollup of `milestoneTitle`. */
export function partialRollupMarker(milestoneTitle: string): string {
  return `<!-- vibe-partial-rollup milestone="${milestoneTitle}" -->`;
}

/** The snapshot branch name for a milestone branch at `sha`. */
export function partialRollupBranchName(
  milestoneBranch: string,
  sha: string,
): string {
  const slug = milestoneBranch.slice("milestone/".length);
  return `${PARTIAL_ROLLUP_BRANCH_PREFIX}${slug}-${sha.slice(0, 7)}`;
}

/** What {@link createPartialRollup} did. */
export type PartialRollupOutcome =
  /** A snapshot ref is in place and a partial rollup PR was raised. */
  | {
    outcome: "created";
    prUrl: string;
    snapshotBranch: string;
    headSha: string;
    /** True when an existing snapshot ref at the same tip was reused. */
    reusedRef: boolean;
  }
  /** An open partial rollup PR for this milestone already exists. */
  | { outcome: "exists"; prNumber: number; snapshotBranch: string }
  /** Not raised this pass; nothing was created. */
  | {
    outcome: "deferred";
    reason: "milestone-behind" | "nothing-to-roll-up";
    detail: string;
  }
  /** A lookup or create failed — reported loudly, never as success. */
  | { outcome: "failed"; reason: string };

/** Inputs for {@link createPartialRollup}. */
export interface PartialRollupOptions {
  /** Repository in `owner/repo` form. */
  repo: string;
  /** The milestone title (written into the body marker). */
  milestone: string;
  /** The milestone branch (`milestone/<slug>`). */
  milestoneBranch: string;
  /** The repository's default branch. */
  defaultBranch: string;
  /** Function to execute gh CLI commands. */
  ghFn: GhCommandFn;
}

interface RawPartialRollupPr {
  number?: unknown;
  headRefName?: unknown;
  headRefOid?: unknown;
  body?: unknown;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Partial-rollup PRs in `state` carrying this milestone's marker; throws on
 * lookup failure. The `head:` search only narrows server-side — the head
 * prefix and the exact marker are re-checked locally.
 */
async function listPartialRollupPrs(
  repo: string,
  milestone: string,
  state: "open" | "merged",
  ghFn: GhCommandFn,
): Promise<RawPartialRollupPr[]> {
  // SIMPLE-ON-PURPOSE: reads up to 100 partial rollups per state — upgrade when a repo accumulates more than 100
  const raw = await ghFn([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    state,
    "--search",
    "head:partial-rollup",
    "--json",
    "number,headRefName,headRefOid,body",
    "--limit",
    "100",
  ]);
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`gh pr list returned ${typeof parsed}, not an array`);
  }
  const marker = partialRollupMarker(milestone);
  return (parsed as RawPartialRollupPr[]).filter((pr) =>
    typeof pr.number === "number" &&
    typeof pr.headRefName === "string" &&
    pr.headRefName.startsWith(PARTIAL_ROLLUP_BRANCH_PREFIX) &&
    typeof pr.body === "string" && pr.body.includes(marker)
  );
}

/** The SHA `refs/heads/<branch>` points at; throws when absent or unreadable. */
async function readBranchSha(
  repo: string,
  branch: string,
  ghFn: GhCommandFn,
): Promise<string> {
  const sha = (await ghFn([
    "api",
    `repos/${repo}/git/ref/heads/${branch}`,
    "--jq",
    ".object.sha",
  ])).trim();
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`ref heads/${branch} returned no commit SHA`);
  }
  return sha;
}

/** Behind/ahead counts of `sha` against the default branch; throws when unreadable. */
async function compareWithDefault(
  repo: string,
  defaultBranch: string,
  sha: string,
  ghFn: GhCommandFn,
): Promise<{ behindBy: number; aheadBy: number }> {
  const raw = await ghFn([
    "api",
    `repos/${repo}/compare/${defaultBranch}...${sha}`,
    "--jq",
    "{behind_by, ahead_by}",
  ]);
  const parsed = JSON.parse(raw) as { behind_by?: unknown; ahead_by?: unknown };
  const { behind_by: behindBy, ahead_by: aheadBy } = parsed;
  if (typeof behindBy !== "number" || typeof aheadBy !== "number") {
    throw new Error(`compare ${defaultBranch}...${sha} returned no counts`);
  }
  return { behindBy, aheadBy };
}

/**
 * Create `refs/heads/<snapshot>` at `sha`, or reuse it when it already points
 * there. Never updates or forces an existing ref. Returns whether it was
 * reused; throws when the ref cannot be created or points elsewhere.
 */
async function ensureSnapshotRef(
  repo: string,
  snapshotBranch: string,
  sha: string,
  ghFn: GhCommandFn,
): Promise<boolean> {
  try {
    await ghFn([
      "api",
      "-X",
      "POST",
      `repos/${repo}/git/refs`,
      "-f",
      `ref=refs/heads/${snapshotBranch}`,
      "-f",
      `sha=${sha}`,
    ]);
    return false;
  } catch (createErr) {
    // Typically "Reference already exists" (422): reuse it only when it is
    // the same snapshot; any other failure surfaces the create error.
    let existing: string;
    try {
      existing = await readBranchSha(repo, snapshotBranch, ghFn);
    } catch {
      throw new Error(
        `could not create ${snapshotBranch}: ${errorText(createErr)}`,
      );
    }
    if (existing !== sha) {
      throw new Error(
        `${snapshotBranch} already exists at ${existing}, not ${sha} — ` +
          `refusing to update it`,
      );
    }
    return true;
  }
}

/** The body of a partial rollup PR. Carries no closing keyword by design. */
export function buildPartialRollupBody(options: {
  milestone: string;
  milestoneBranch: string;
  defaultBranch: string;
  snapshotBranch: string;
  headSha: string;
  aheadBy: number;
}): string {
  const {
    milestone,
    milestoneBranch,
    defaultBranch,
    snapshotBranch,
    headSha,
    aheadBy,
  } = options;
  return `${partialRollupMarker(milestone)}
## Partial milestone rollup

This PR lands the work already merged into \`${milestoneBranch}\` onto
\`${defaultBranch}\` to break a cross-milestone dependency deadlock (#2794).

- Snapshot: \`${snapshotBranch}\` at \`${headSha}\` — an immutable copy of the
  milestone tip, ${aheadBy} commit(s) ahead of \`${defaultBranch}\`.
- The milestone **stays open**; its final rollup is raised as normal once the
  remaining issues land.
- No issue is closed by this merge.

Raised automatically by the Vibe Coder (Issue #2830).`;
}

/**
 * Raise a partial rollup PR for a milestone, from a snapshot of its branch.
 *
 * Fails loud: a failed lookup or create returns `failed` with the reason,
 * never a quiet "nothing to do".
 */
export async function createPartialRollup(
  options: PartialRollupOptions,
): Promise<PartialRollupOutcome> {
  const { repo, milestone, milestoneBranch, defaultBranch, ghFn } = options;

  if (
    !REPO_PATTERN.test(repo) ||
    !isMilestoneBranch(milestoneBranch) ||
    !BRANCH_PATTERN.test(milestoneBranch) ||
    !BRANCH_PATTERN.test(defaultBranch)
  ) {
    return {
      outcome: "failed",
      reason: "repo or branch name failed the argument allowlist",
    };
  }
  if (!TITLE_PATTERN.test(milestone)) {
    return {
      outcome: "failed",
      reason: "milestone title cannot be embedded in the body marker",
    };
  }

  // Idempotency: at most one open partial rollup per milestone.
  try {
    const open = await listPartialRollupPrs(repo, milestone, "open", ghFn);
    const first = open[0];
    if (first !== undefined) {
      return {
        outcome: "exists",
        prNumber: first.number as number,
        snapshotBranch: first.headRefName as string,
      };
    }
  } catch (err) {
    return {
      outcome: "failed",
      reason: `could not list open partial rollups for "${milestone}": ${
        errorText(err)
      }`,
    };
  }

  // Compare the exact tip that will be snapshotted, so the sync check and
  // the snapshot cannot disagree.
  let headSha: string;
  let counts: { behindBy: number; aheadBy: number };
  try {
    headSha = await readBranchSha(repo, milestoneBranch, ghFn);
    counts = await compareWithDefault(repo, defaultBranch, headSha, ghFn);
  } catch (err) {
    return {
      outcome: "failed",
      reason: `could not compare ${milestoneBranch} with ${defaultBranch}: ${
        errorText(err)
      }`,
    };
  }
  if (counts.behindBy !== 0) {
    return {
      outcome: "deferred",
      reason: "milestone-behind",
      detail: `${milestoneBranch} is ${counts.behindBy} commit(s) behind ` +
        `${defaultBranch} — the milestone sync must land first`,
    };
  }
  if (counts.aheadBy === 0) {
    return {
      outcome: "deferred",
      reason: "nothing-to-roll-up",
      detail: `${milestoneBranch} has no commits ahead of ${defaultBranch}`,
    };
  }

  const snapshotBranch = partialRollupBranchName(milestoneBranch, headSha);
  const body = buildPartialRollupBody({
    milestone,
    milestoneBranch,
    defaultBranch,
    snapshotBranch,
    headSha,
    aheadBy: counts.aheadBy,
  });
  // Defence in depth: the title is untrusted and lands in the body.
  if (CLOSING_KEYWORD_PATTERN.test(body)) {
    return {
      outcome: "failed",
      reason: "partial rollup body would carry a closing keyword",
    };
  }

  let reusedRef: boolean;
  try {
    reusedRef = await ensureSnapshotRef(repo, snapshotBranch, headSha, ghFn);
  } catch (err) {
    return { outcome: "failed", reason: errorText(err) };
  }

  try {
    const prUrl = (await ghFn([
      "pr",
      "create",
      "--repo",
      repo,
      "--title",
      `Partial rollup: ${milestone} → ${defaultBranch}`,
      "--body",
      body,
      "--head",
      snapshotBranch,
      "--base",
      defaultBranch,
    ])).trim();
    return { outcome: "created", prUrl, snapshotBranch, headSha, reusedRef };
  } catch (err) {
    return {
      outcome: "failed",
      reason: `could not create the partial rollup PR from ${snapshotBranch}: ${
        errorText(err)
      }`,
    };
  }
}

/**
 * Head SHAs of the merged partial rollups of `milestone`, in the order gh
 * lists them. Consumed by the cross-milestone hold release. Throws on a
 * lookup failure or an invalid argument — an unreadable history is never
 * reported as "none merged".
 */
export async function listMergedPartialRollupHeads(
  repo: string,
  milestone: string,
  ghFn: GhCommandFn,
): Promise<string[]> {
  if (!REPO_PATTERN.test(repo)) {
    throw new Error("repo name failed the argument allowlist");
  }
  if (!TITLE_PATTERN.test(milestone)) {
    throw new Error("milestone title cannot be matched against the marker");
  }
  const merged = await listPartialRollupPrs(repo, milestone, "merged", ghFn);
  return merged
    .map((pr) => pr.headRefOid)
    .filter((sha): sha is string =>
      typeof sha === "string" && SHA_PATTERN.test(sha)
    );
}
