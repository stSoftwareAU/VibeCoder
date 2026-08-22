/**
 * Stranded work detection for the merged-PR pre-check (Issue #174).
 *
 * `merged_pr_precheck` runs before any repo I/O: it asks the linker for a PR,
 * and closes the issue when that PR is merged. The linker matches any PR
 * referencing the issue, so a human's or a sibling's merged partial PR closes
 * an issue whose real work is sitting unpublished on a pushed branch — and
 * because the pre-check runs on every claim, re-opening the issue by hand
 * gets it closed again on the next one.
 *
 * This module answers the question the pre-check should ask first: **is there
 * a pushed branch for this issue that is ahead of base with no open PR?** If
 * there is, the work is stranded and the issue must stay open so the run can
 * resume that branch (Issue #220) and raise its PR.
 *
 * Everything here goes through the GitHub API rather than git, because the
 * pre-check has no checkout yet. The calls are made only on the close path,
 * which is rare, so the cost does not land on every claim.
 *
 * Fails **safe toward not closing**: a lookup that errors reports the branch
 * as possibly stranded. Issue #174 is a report of lost work, and the cost of
 * being wrong in that direction is one issue left open for a human, against
 * three commits silently discarded in the other.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** A pushed branch for this issue that has commits nobody has published. */
export interface StrandedBranch {
  /** Short branch name, e.g. `issue-42-primary-graphql-quota…`. */
  branch: string;
  /** Commits ahead of base, or null when the comparison could not be made. */
  aheadBy: number | null;
  /** Why it counts as stranded — for the log line. */
  reason: "ahead-with-no-open-pr" | "comparison-failed";
}

/** Injected `gh` runner: resolves stdout, rejects on failure. */
export type GhFn = (args: string[]) => Promise<string>;

/** Options for {@link findStrandedIssueBranches}. */
export interface StrandedBranchOptions {
  repo: string;
  issueNumber: number;
  /**
   * Branch the work would merge into, e.g. `main`. Optional: the pre-check
   * runs before `setup_branch_phase` populates `state.defaultBranch`, so it
   * is resolved from the repository when omitted.
   */
  baseBranch?: string;
  ghFn: GhFn;
  /** Diagnostics sink; every fail-safe fallback is logged, never swallowed. */
  warn?: (message: string) => void;
}

/**
 * Whether a ref belongs to this issue.
 *
 * Matches `issue-<N>` exactly and `issue-<N>-<slug>`, and nothing else — in
 * particular not `issue-420-…` when asked about issue 42, which a plain
 * prefix test would accept.
 */
export function isIssueBranchRef(ref: string, issueNumber: number): boolean {
  const name = ref.replace(/^refs\/heads\//, "");
  if (name === `issue-${issueNumber}`) return true;
  return name.startsWith(`issue-${issueNumber}-`);
}

/** List remote branches for this issue via matching-refs. */
async function listIssueBranches(
  opts: StrandedBranchOptions,
): Promise<string[] | null> {
  try {
    const out = await opts.ghFn([
      "api",
      `repos/${opts.repo}/git/matching-refs/heads/issue-${opts.issueNumber}`,
      "--jq",
      ".[].ref",
    ]);
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .filter((ref) => isIssueBranchRef(ref, opts.issueNumber))
      .map((ref) => ref.replace(/^refs\/heads\//, ""));
  } catch (err) {
    opts.warn?.(
      `[stranded-branch] could not list branches for ` +
        `${opts.repo}#${opts.issueNumber}: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
    return null;
  }
}

/** The repository's default branch, when the caller could not supply one. */
async function resolveBaseBranch(
  opts: StrandedBranchOptions,
): Promise<string | null> {
  const given = (opts.baseBranch ?? "").trim();
  if (given !== "") return given;
  try {
    const out = await opts.ghFn([
      "repo",
      "view",
      opts.repo,
      "--json",
      "defaultBranchRef",
      "--jq",
      ".defaultBranchRef.name",
    ]);
    const name = out.trim();
    return name === "" ? null : name;
  } catch (err) {
    opts.warn?.(
      `[stranded-branch] could not resolve the default branch of ` +
        `${opts.repo}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Commits `branch` is ahead of `base`, or null when unknown. */
async function aheadOfBase(
  branch: string,
  base: string,
  opts: StrandedBranchOptions,
): Promise<number | null> {
  try {
    const out = await opts.ghFn([
      "api",
      `repos/${opts.repo}/compare/${encodeURIComponent(base)}...${
        encodeURIComponent(branch)
      }`,
      "--jq",
      ".ahead_by",
    ]);
    const n = Number(out.trim());
    return Number.isFinite(n) ? n : null;
  } catch (err) {
    opts.warn?.(
      `[stranded-branch] could not compare ${branch} against ` +
        `${base}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** True when an open PR already has `branch` as its head. */
async function hasOpenPr(
  branch: string,
  opts: StrandedBranchOptions,
): Promise<boolean | null> {
  try {
    const out = await opts.ghFn([
      "pr",
      "list",
      "--repo",
      opts.repo,
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number",
    ]);
    const rows = JSON.parse(out || "[]") as unknown[];
    return rows.length > 0;
  } catch (err) {
    opts.warn?.(
      `[stranded-branch] could not check for an open PR on ${branch}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * Find pushed branches for this issue holding unpublished commits.
 *
 * @returns Every branch that is ahead of base with no open PR, plus any whose
 *   status could not be established. Empty means nothing is stranded and the
 *   caller may close.
 */
export async function findStrandedIssueBranches(
  opts: StrandedBranchOptions,
): Promise<StrandedBranch[]> {
  const branches = await listIssueBranches(opts);
  if (branches === null || branches.length === 0) return [];

  const base = await resolveBaseBranch(opts);
  if (base === null) {
    // No base means no comparison is possible. Report every candidate as
    // unproven rather than reporting "nothing stranded" — this module fails
    // safe toward not closing.
    return branches.map((branch) => ({
      branch,
      aheadBy: null,
      reason: "comparison-failed" as const,
    }));
  }

  const stranded: StrandedBranch[] = [];
  for (const branch of branches) {
    const ahead = await aheadOfBase(branch, base, opts);
    if (ahead === null) {
      stranded.push({ branch, aheadBy: null, reason: "comparison-failed" });
      continue;
    }
    if (ahead === 0) continue;

    const open = await hasOpenPr(branch, opts);
    if (open === true) continue;
    // `null` (the check failed) lands here deliberately: unproven is not
    // "there is a PR", and this module fails safe toward not closing.
    stranded.push({ branch, aheadBy: ahead, reason: "ahead-with-no-open-pr" });
  }
  return stranded;
}

/** One line naming what is stranded, for the pre-check's log. */
export function describeStrandedBranches(
  stranded: readonly StrandedBranch[],
): string {
  return stranded
    .map((s) =>
      s.reason === "comparison-failed"
        ? `${s.branch} (comparison failed)`
        : `${s.branch} (+${s.aheadBy})`
    )
    .join(", ");
}
