/**
 * Self-heal for milestone branches deleted while children remain open
 * (Issue #3912).
 *
 * A milestone can gain open children *after* its summary PR merged and
 * `delete_branch_on_merge` destroyed the milestone branch. Milestone 53 is the
 * proof: the summary PR merged at 07:46, nine further issues were milestoned
 * into it at 07:55, and the milestone stayed open with 21 open children and no
 * branch. Every one of those children then hits the missing-branch path when a
 * worker picks it up, and any child PR already raised against the default
 * branch would merge its work outside the milestone.
 *
 * This pass repairs both halves, on the existing milestone maintenance cycle:
 *
 *   1. an **open** milestone with at least one open child and no branch on the
 *      remote has its branch recreated from the default branch; and
 *   2. an open child PR still based on the default branch is retargeted at the
 *      milestone branch, with one explanatory comment.
 *
 * Both halves are idempotent. The branch check is the remote itself — once the
 * branch is back, the next cycle does nothing. The retarget is guarded by
 * {@link MILESTONE_RETARGET_MARKER} in the explanatory comment, so a PR is
 * retargeted at most once: a human who points it back at the default branch is
 * never overruled.
 *
 * Deliberately out of scope: merged PRs are never touched, and PRs auto-closed
 * by a past branch deletion are not reopened.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { createMilestoneBranchName } from "./git_branch.ts";
import type { AlertDedupAuthorOptions } from "./alert_dedup_authors.ts";
import { issueCommentsContainMarker } from "./issue_comment_pages.ts";
import { isIdleTaskMilestone } from "./idle_task_merge_gate.ts";
import type {
  DefaultBranchFn,
  GhCommandFn,
  LocalCloneExistsFn,
} from "./milestone_branch_sync.ts";
import { fetchAuthoritativeOpenChildren } from "./milestone_open_children.ts";
import { retargetPrToMilestone } from "./pr_retarget.ts";
import { validateGitHubMilestonesJson } from "./validation.ts";

/**
 * Marker written into the explanatory comment. Its presence on a PR means the
 * worker has already retargeted that PR once — the pass then leaves the PR
 * alone forever, which is both what makes it idempotent and what stops it
 * fighting a human who retargets the PR back at the default branch.
 */
export const MILESTONE_RETARGET_MARKER =
  "<!-- vibe-coder:milestone-retarget -->";

/** Function signature for recreating a milestone branch on the remote. */
export type EnsureMilestoneBranchFn = (
  repo: string,
  milestoneBranch: string,
  defaultBranch: string,
) => Promise<Result<string>>;

/** Dependencies for the milestone branch self-heal pass. */
export interface MilestoneSelfHealDeps {
  /** Repositories to scan (owner/repo format). */
  repos: string[];
  /** Function to execute gh CLI commands. */
  ghCommandFn: GhCommandFn;
  /** Function that resolves the default branch for a repository. */
  defaultBranchFn: DefaultBranchFn;
  /** Function that recreates a missing milestone branch (local git + push). */
  ensureBranchFn: EnsureMilestoneBranchFn;
  /**
   * Optional check for whether the repo has a local clone. Branch recreation
   * is a local-git operation, so a repo that was never cloned here is skipped
   * rather than reported as a failure.
   */
  localCloneExistsFn?: LocalCloneExistsFn;
  /**
   * Fleet identity used to verify who wrote the retarget marker (Issue
   * #1216). Omitted in production, which reads the configured fleet identity.
   */
  dedupAuthors?: AlertDedupAuthorOptions;
  /** Logging function. */
  log: (message: string) => void;
}

/** Outcome of the self-heal pass. */
export interface MilestoneSelfHealResult {
  /** Milestone branches recreated from the default branch. */
  branchesRecreated: number;
  /** Open child PRs retargeted at their milestone branch. */
  prsRetargeted: number;
  /** Repairs that were attempted and failed (each is logged as a warning). */
  failures: number;
}

/** An open milestone, as far as this pass needs it. */
interface OpenMilestone {
  number: number;
  title: string;
}

/** An open PR, projected to the fields the retarget decision needs. */
interface OpenPr {
  number: number;
  baseRefName: string;
  /** Head branch — the milestone's own delivery PR has the milestone branch here (Issue #4360). */
  headRefName: string;
  /** The PR's own milestone title, when it carries one. */
  milestoneTitle: string | null;
  /** Issue numbers the PR closes (`Closes #N`), per GitHub's own linkage. */
  closingIssues: number[];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the comment posted on a PR the pass has retargeted.
 *
 * Exported so tests can assert against it directly.
 */
export function renderRetargetComment(
  milestoneTitle: string,
  milestoneBranch: string,
  defaultBranch: string,
): string {
  return [
    MILESTONE_RETARGET_MARKER,
    `## Retargeted at the milestone branch \`${milestoneBranch}\``,
    "",
    `This PR belongs to the open milestone '${milestoneTitle}' but was based ` +
    `on \`${defaultBranch}\`. Merging it there would land the work outside ` +
    `the milestone branch, so the worker has retargeted it at ` +
    `\`${milestoneBranch}\` (Issue #3912).`,
    "",
    `If \`${defaultBranch}\` really is the right base, change it back — the ` +
    "worker records this retarget and never repeats it on the same PR.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Return true when `value` is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read the open PR list off a `gh pr list --json …` payload, or throw. */
function parseOpenPrs(raw: string): OpenPr[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("expected an array of pull requests");
  }
  return parsed
    .filter(isRecord)
    .filter((entry) => typeof entry.number === "number")
    .map((entry) => {
      const milestone = isRecord(entry.milestone) ? entry.milestone : null;
      const closing = Array.isArray(entry.closingIssuesReferences)
        ? entry.closingIssuesReferences
        : [];
      return {
        number: entry.number as number,
        baseRefName: typeof entry.baseRefName === "string"
          ? entry.baseRefName
          : "",
        headRefName: typeof entry.headRefName === "string"
          ? entry.headRefName
          : "",
        milestoneTitle: milestone && typeof milestone.title === "string"
          ? milestone.title
          : null,
        closingIssues: closing
          .filter(isRecord)
          .map((ref) => ref.number)
          .filter((n): n is number => typeof n === "number"),
      };
    });
}

// ---------------------------------------------------------------------------
// GitHub reads
// ---------------------------------------------------------------------------

/** Fetch a repository's open milestones. Throws on an unusable response. */
async function fetchOpenMilestones(
  repo: string,
  ghCommandFn: GhCommandFn,
): Promise<OpenMilestone[]> {
  const raw = await ghCommandFn([
    "api",
    `repos/${repo}/milestones?state=open&per_page=100`,
  ]);
  const validated = validateGitHubMilestonesJson(JSON.parse(raw));
  if (!validated.ok) {
    throw new Error(`malformed milestone listing: ${validated.error.message}`);
  }
  // `state=open` is the filter that matters, but a milestone object carries
  // its own state — honour it too so a finished milestone can never have its
  // branch resurrected on a scan cycle.
  return validated.value
    .filter((milestone) => {
      const state = (milestone as { state?: unknown }).state;
      return typeof state !== "string" || state === "open";
    })
    .map((milestone) => ({
      number: milestone.number,
      title: milestone.title,
    }));
}

/** True when the milestone branch exists on the remote. */
async function branchExistsOnRemote(
  repo: string,
  branch: string,
  ghCommandFn: GhCommandFn,
): Promise<boolean> {
  try {
    await ghCommandFn([
      "api",
      `repos/${repo}/branches/${branch}`,
      "--jq",
      ".name",
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Fetch the repository's open PRs, or `null` when the read failed. */
async function fetchOpenPrs(
  repo: string,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
): Promise<OpenPr[] | null> {
  try {
    const raw = await ghCommandFn([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,baseRefName,headRefName,milestone,closingIssuesReferences",
    ]);
    return parseOpenPrs(raw);
  } catch (err) {
    log(
      `WARNING: could not list open PRs for ${repo} — child PRs cannot be ` +
        `retargeted this cycle: ${
          err instanceof Error ? err.message : String(err)
        } (Issue #3912)`,
    );
    return null;
  }
}

/**
 * True when this PR has already been retargeted **by the worker**.
 *
 * A read failure returns `true` (treated as "already handled"): retargeting a
 * PR whose history cannot be read risks overruling a human and re-commenting
 * every cycle, which is worse than skipping it.
 *
 * Issue #1216: the marker used to be substring-matched against every comment
 * body on the PR, from any author. A hit makes `retargetChildPrs` skip the PR
 * for good, so one planted `<!-- vibe-coder:milestone-retarget -->` comment
 * exempted a PR from ever being retargeted at its milestone branch and let the
 * work merge to the default branch outside the milestone.
 * {@link issueCommentsContainMarker} checks the comment author against the
 * fleet identity and fails towards retargeting.
 */
async function alreadyRetargeted(
  repo: string,
  prNumber: number,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
  dedupAuthors: AlertDedupAuthorOptions = {},
): Promise<boolean> {
  try {
    return await issueCommentsContainMarker(
      repo,
      prNumber,
      MILESTONE_RETARGET_MARKER,
      ghCommandFn,
      dedupAuthors,
      log,
    );
  } catch (err) {
    log(
      `WARNING: could not read comments on ${repo}#${prNumber} to check the ` +
        `milestone retarget marker — leaving the PR alone: ${
          err instanceof Error ? err.message : String(err)
        } (Issue #3912)`,
    );
    return true;
  }
}

// ---------------------------------------------------------------------------
// Retargeting
// ---------------------------------------------------------------------------

/** True when `pr` belongs to the milestone, directly or via a closed issue. */
function prBelongsToMilestone(
  pr: OpenPr,
  milestoneTitle: string,
  childIssueNumbers: ReadonlySet<number>,
): boolean {
  if (pr.milestoneTitle === milestoneTitle) return true;
  return pr.closingIssues.some((number) => childIssueNumbers.has(number));
}

/** Options for {@link retargetChildPrs}. */
interface RetargetOptions {
  repo: string;
  milestoneTitle: string;
  milestoneBranch: string;
  defaultBranch: string;
  candidates: readonly OpenPr[];
  ghCommandFn: GhCommandFn;
  /** Fleet identity the retarget-marker author check uses (Issue #1216). */
  dedupAuthors?: AlertDedupAuthorOptions;
  log: (message: string) => void;
}

/**
 * Retarget the milestone's open child PRs that are still based on the default
 * branch, commenting once on each.
 *
 * @returns counts of successful retargets and failures.
 */
async function retargetChildPrs(
  options: RetargetOptions,
): Promise<{ retargeted: number; failures: number }> {
  const {
    repo,
    milestoneTitle,
    milestoneBranch,
    defaultBranch,
    candidates,
    ghCommandFn,
    dedupAuthors,
    log,
  } = options;
  let retargeted = 0;
  let failures = 0;

  for (const pr of candidates) {
    if (
      await alreadyRetargeted(
        repo,
        pr.number,
        ghCommandFn,
        log,
        dedupAuthors,
      )
    ) {
      continue;
    }

    const result = await retargetPrToMilestone(
      repo,
      pr.number,
      milestoneBranch,
      ghCommandFn,
    );
    if (!result.ok) {
      log(`WARNING: ${result.error.message} (Issue #3912)`);
      failures++;
      continue;
    }

    // The comment carries the marker, so post it even if the retarget was a
    // no-op — without it the guard has nothing to read next cycle.
    try {
      await ghCommandFn([
        "pr",
        "comment",
        String(pr.number),
        "--repo",
        repo,
        "--body",
        renderRetargetComment(milestoneTitle, milestoneBranch, defaultBranch),
      ]);
    } catch (err) {
      log(
        `WARNING: retargeted ${repo}#${pr.number} at '${milestoneBranch}' but ` +
          `could not post the explanatory comment: ${
            err instanceof Error ? err.message : String(err)
          } (Issue #3912)`,
      );
      failures++;
      continue;
    }

    log(
      `Retargeted ${repo}#${pr.number} from '${defaultBranch}' to ` +
        `'${milestoneBranch}' for milestone '${milestoneTitle}' (Issue #3912)`,
    );
    retargeted++;
  }

  return { retargeted, failures };
}

// ---------------------------------------------------------------------------
// selfHealMilestoneBranches (main entry point)
// ---------------------------------------------------------------------------

/**
 * Recreate missing milestone branches and rescue child PRs based on the
 * default branch (Issue #3912).
 *
 * Runs as part of the milestone maintenance cycle. Per-repository and
 * per-milestone failures are logged as warnings and counted — never swallowed
 * — but do not abort the remaining repairs.
 *
 * @param deps - Injected dependencies
 * @returns Result with the repair summary
 */
export async function selfHealMilestoneBranches(
  deps: MilestoneSelfHealDeps,
): Promise<Result<MilestoneSelfHealResult>> {
  const {
    repos,
    ghCommandFn,
    defaultBranchFn,
    ensureBranchFn,
    localCloneExistsFn,
    log,
  } = deps;
  let branchesRecreated = 0;
  let prsRetargeted = 0;
  let failures = 0;

  for (const repo of repos) {
    try {
      if (localCloneExistsFn && !(await localCloneExistsFn(repo))) {
        log(`Skipping milestone branch self-heal for ${repo} — no local clone`);
        continue;
      }

      const defaultBranchResult = await defaultBranchFn(repo);
      if (!defaultBranchResult.ok || !defaultBranchResult.value.trim()) {
        log(
          `WARNING: could not determine the default branch for ${repo} — ` +
            `skipping milestone branch self-heal (Issue #3912)`,
        );
        failures++;
        continue;
      }
      const defaultBranch = defaultBranchResult.value.trim();

      const milestones = await fetchOpenMilestones(repo, ghCommandFn);

      // Fetched lazily and once per repo — most cycles need no PR listing.
      let openPrs: OpenPr[] | null | undefined;

      for (const milestone of milestones) {
        // Idle-task milestones never carry a milestone branch — the findings
        // are filed as standalone issues (Issue #2125).
        if (isIdleTaskMilestone(milestone.title)) continue;

        const childrenResult = await fetchAuthoritativeOpenChildren(
          repo,
          milestone.number,
          ghCommandFn,
        );
        if (!childrenResult.ok) {
          log(`WARNING: ${childrenResult.error.message} (Issue #3912)`);
          failures++;
          continue;
        }
        const children = childrenResult.value;
        if (children.openCount === 0) continue;

        const milestoneBranch = createMilestoneBranchName(milestone.title);

        if (!(await branchExistsOnRemote(repo, milestoneBranch, ghCommandFn))) {
          const ensured = await ensureBranchFn(
            repo,
            milestoneBranch,
            defaultBranch,
          );
          if (!ensured.ok) {
            log(
              `WARNING: could not recreate milestone branch ` +
                `'${milestoneBranch}' in ${repo} for open milestone ` +
                `'${milestone.title}' (${children.openCount} open children): ` +
                `${ensured.error.message} (Issue #3912)`,
            );
            failures++;
            continue;
          }
          log(
            `Recreated missing milestone branch '${milestoneBranch}' in ` +
              `${repo} from '${defaultBranch}' — milestone ` +
              `'${milestone.title}' is open with ${children.openCount} open ` +
              `children (Issue #3912)`,
          );
          branchesRecreated++;
        }

        if (openPrs === undefined) {
          openPrs = await fetchOpenPrs(repo, ghCommandFn, log);
        }
        if (openPrs === null) continue;

        const childIssueNumbers = new Set(
          children.children
            .filter((child) => !child.isPullRequest)
            .map((child) => child.number),
        );
        // The milestone's own delivery PR (head = the milestone branch,
        // closing the children) is not a child on the wrong base — retargeting
        // it onto its own head is refused by GitHub every cycle (Issue #4360).
        const candidates = openPrs.filter((pr) =>
          pr.baseRefName === defaultBranch &&
          pr.headRefName !== milestoneBranch &&
          prBelongsToMilestone(pr, milestone.title, childIssueNumbers)
        );
        if (candidates.length === 0) continue;

        const outcome = await retargetChildPrs({
          repo,
          milestoneTitle: milestone.title,
          milestoneBranch,
          defaultBranch,
          candidates,
          ghCommandFn,
          dedupAuthors: deps.dedupAuthors,
          log,
        });
        prsRetargeted += outcome.retargeted;
        failures += outcome.failures;
      }
    } catch (err) {
      log(
        `WARNING: milestone branch self-heal failed for ${repo}: ${
          err instanceof Error ? err.message : String(err)
        } (Issue #3912)`,
      );
      failures++;
    }
  }

  if (branchesRecreated > 0 || prsRetargeted > 0 || failures > 0) {
    log(
      `Milestone branch self-heal complete: ${branchesRecreated} branch(es) ` +
        `recreated, ${prsRetargeted} PR(s) retargeted, ${failures} failed ` +
        `(Issue #3912)`,
    );
  }

  return {
    ok: true,
    value: { branchesRecreated, prsRetargeted, failures },
  };
}
