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
 * **Only a PR the fleet raised is ever retargeted (Issue #2022).** A human
 * who bases a PR on the default branch chose that base — on 2026-09-12 the
 * pass retargeted a maintainer's deliberate commit-by-commit replay onto a
 * rewritten milestone branch and turned a clean PR into ninety conflicting
 * files. Admission is {@link isFleetRaisedPr}: the author is a fleet login
 * *and* the body carries the worker's own marker. A branch named
 * `issue-<n>-…` is not evidence — humans use that shape too — and neither
 * is the author alone. A PR that fails the test is left exactly as its
 * author raised it: no base change, no comment, no label.
 *
 * A fleet PR is also not retargeted when the merge onto the milestone branch
 * would conflict ({@link MilestoneSelfHealDeps.mergeWouldConflictFn}): the
 * pass exists to stop work landing outside the milestone, not to manufacture
 * conflicts for the merge-conflict lane to spend an hour on (#2023).
 *
 * Deliberately out of scope: merged PRs are never touched, and PRs auto-closed
 * by a past branch deletion are not reopened.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { createMilestoneBranchName } from "./git_branch.ts";
import {
  ALERT_DEDUP_JSON_FIELDS,
  type AlertDedupAuthorOptions,
  type AlertDedupRow,
  resolveAlertDedupAuthors,
  selectFleetAuthoredMatches,
} from "./alert_dedup_authors.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import { WORKER_PR_MARKER_PREFIX } from "./pr_body.ts";
import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import { guardedLabelArgs } from "./guarded_issue_labels.ts";
import {
  claimRepoLevelRejectionReport,
  describeRepoLevelRejection,
  hasReportedRepoLevelRejection,
  isRepoLevelBranchRejection,
} from "./milestone_branch_rejection.ts";
import { redactSecrets } from "./secret_redaction.ts";
import {
  recordSelfDiagnosticFiling,
  type SelfDiagnosticFiling,
} from "./self_diagnostic_attestation.ts";
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
   * Whether merging `headRefName` onto `milestoneBranch` would conflict
   * (Issue #2022). `true` refuses the retarget; `false` allows it; `null`
   * means the answer could not be read, which allows it as before — the
   * dry run is a guard against manufacturing conflicts, not a gate the
   * retarget cannot pass without. Omitted in tests that do not care.
   */
  mergeWouldConflictFn?: MergeWouldConflictFn;
  /**
   * Fleet identity used to verify who wrote the retarget marker (Issue
   * #1216). Omitted in production, which reads the configured fleet identity.
   */
  dedupAuthors?: AlertDedupAuthorOptions;
  /**
   * Records the filing attestation for a refused-branch diagnostic
   * (Issue #1277). Injected by tests; production writes the real one.
   */
  recordFiling?: (filing: SelfDiagnosticFiling) => Promise<boolean>;
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
  /** The PR author's login, or `null` when the listing did not say. */
  author: string | null;
  /** The PR body; the worker's own PRs carry {@link WORKER_PR_MARKER_PREFIX}. */
  body: string;
}

/**
 * Answers whether merging a PR's head onto the milestone branch would
 * conflict (Issue #2022). `null` when it could not be determined.
 */
export type MergeWouldConflictFn = (
  repo: string,
  milestoneBranch: string,
  headRefName: string,
) => Promise<boolean | null>;

/**
 * True when the fleet itself raised this PR (Issue #2022).
 *
 * Two independent signals, both required: the author is one of the fleet's
 * logins, and the body carries the marker the worker writes into every PR it
 * raises ({@link WORKER_PR_MARKER_PREFIX}). The marker alone is a fixed
 * public string anyone can paste; the author alone is a human on any host
 * that shares an account. The `issue-<n>-…` branch shape is deliberately not
 * consulted — the PR that motivated this check was a maintainer's replay on
 * exactly that shape.
 *
 * A head ref with a leading dash is refused as well (Issue #12): the retarget
 * hands the head to git and gh as a positional.
 *
 * @param pr - The listed PR.
 * @param fleetLogins - The resolved fleet maintenance set.
 * @returns True only when both signals say the fleet raised it.
 */
export function isFleetRaisedPr(
  pr: Pick<OpenPr, "author" | "body" | "headRefName">,
  fleetLogins: readonly string[],
): boolean {
  if (!isFleetAuthor(pr.author, [...fleetLogins])) return false;
  if (!pr.body.includes(WORKER_PR_MARKER_PREFIX)) return false;
  return pr.headRefName !== "" && !pr.headRefName.startsWith("-");
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
        author: isRecord(entry.author) && typeof entry.author.login === "string"
          ? entry.author.login
          : null,
        body: typeof entry.body === "string" ? entry.body : "",
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
      "number,baseRefName,headRefName,milestone,closingIssuesReferences,author,body",
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
  /** Merge dry run (Issue #2022); omitted means "cannot tell", which allows. */
  mergeWouldConflictFn?: MergeWouldConflictFn;
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
    mergeWouldConflictFn,
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

    // Issue #2022: never turn a clean PR into a conflicting one. A dry run

    // that cannot answer allows the retarget as before, and says so.

    if (mergeWouldConflictFn) {
      const conflicts = await mergeWouldConflictFn(
        repo,
        milestoneBranch,
        pr.headRefName,
      );

      if (conflicts === true) {
        log(
          `Not retargeting ${repo}#${pr.number} at '${milestoneBranch}': ` +
            `merging its head '${pr.headRefName}' there would conflict, so ` +
            `it stays on '${defaultBranch}' (Issue #2022)`,
        );

        continue;
      }

      if (conflicts === null) {
        log(
          `Merge dry run for ${repo}#${pr.number} onto '${milestoneBranch}' ` +
            `could not be read — retargeting as before (Issue #2022)`,
        );
      }
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
      // Issue #2022: the fleet's own logins, resolved once per repository;
      // only a PR one of them raised may be retargeted.
      let fleetLogins: string[] | undefined;

      for (const milestone of milestones) {
        // Idle-task milestones never carry a milestone branch — the findings
        // are filed as standalone issues (Issue #2125).
        if (isIdleTaskMilestone(milestone.title)) continue;

        const childrenResult = await fetchAuthoritativeOpenChildren(
          repo,
          milestone.number,
          ghCommandFn,
          { log },
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
          // Issue #2007: a repository that refused this branch's creation
          // refuses it identically on every cycle until a human changes the
          // ruleset. Once reported this run, the push is not repeated; the
          // next worker start tries once more, which is how a fixed ruleset
          // is noticed.
          if (hasReportedRepoLevelRejection(repo, milestoneBranch)) {
            log(
              `Not retrying milestone branch '${milestoneBranch}' in ${repo}: ` +
                `the repository refused its creation earlier this run and ` +
                `the diagnostic is filed — retried at the next worker start ` +
                `(Issue #2007)`,
            );
            failures++;
            continue;
          }
          const ensured = await ensureBranchFn(
            repo,
            milestoneBranch,
            defaultBranch,
          );
          if (!ensured.ok) {
            const message = ensured.error.message;
            if (
              isRepoLevelBranchRejection(message) &&
              claimRepoLevelRejectionReport(repo, milestoneBranch)
            ) {
              const remedy = describeRepoLevelRejection(
                message,
                milestoneBranch,
              ) ?? "";
              log(
                `WARNING: could not recreate milestone branch ` +
                  `'${milestoneBranch}' in ${repo} for open milestone ` +
                  `'${milestone.title}' (${children.openCount} open ` +
                  `children): ${message} — ${remedy} Filing one diagnostic ` +
                  `in ${repo} and not retrying this run (Issues #3912, #2007)`,
              );
              await fileMilestoneBranchRefusedIssue({
                repo,
                branch: milestoneBranch,
                milestoneTitle: milestone.title,
                openChildren: children.openCount,
                message,
                remedy,
                ghCommandFn,
                dedupAuthors: deps.dedupAuthors,
                recordFiling: deps.recordFiling,
                log,
              });
              failures++;
              continue;
            }
            log(
              `WARNING: could not recreate milestone branch ` +
                `'${milestoneBranch}' in ${repo} for open milestone ` +
                `'${milestone.title}' (${children.openCount} open children): ` +
                `${message} (Issue #3912)`,
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
        if (fleetLogins === undefined) {
          fleetLogins = await resolveAlertDedupAuthors(
            deps.dedupAuthors ?? {},
            log,
          );
          if (fleetLogins.length === 0) {
            log(
              `Fleet identity unresolved for ${repo} — no PR can be shown ` +
                `to be the fleet's own, so none is retargeted this cycle ` +
                `(Issue #2022)`,
            );
          }
        }

        const childIssueNumbers = new Set(
          children.children
            .filter((child) => !child.isPullRequest)
            .map((child) => child.number),
        );
        // The milestone's own delivery PR (head = the milestone branch,
        // closing the children) is not a child on the wrong base — retargeting
        // it onto its own head is refused by GitHub every cycle (Issue #4360).
        const onDefaultBranch = openPrs.filter((pr) =>
          pr.baseRefName === defaultBranch &&
          pr.headRefName !== milestoneBranch &&
          prBelongsToMilestone(pr, milestone.title, childIssueNumbers)
        );
        // Issue #2022: a PR the fleet did not raise is not the fleet's to
        // move. It is left exactly as its author raised it — logged once so
        // the decision is visible, never commented on or labelled.
        const logins = fleetLogins;
        const candidates = onDefaultBranch.filter((pr) => {
          if (logins.length > 0 && isFleetRaisedPr(pr, logins)) return true;
          log(
            `Leaving ${repo}#${pr.number} on '${defaultBranch}': it belongs ` +
              `to milestone '${milestone.title}' but was not raised by the ` +
              `fleet (author ${pr.author ?? "unknown"}), so the worker does ` +
              `not touch it (Issue #2022)`,
          );
          return false;
        });
        if (candidates.length === 0) continue;

        const outcome = await retargetChildPrs({
          repo,
          milestoneTitle: milestone.title,
          milestoneBranch,
          defaultBranch,
          candidates,
          ghCommandFn,
          dedupAuthors: deps.dedupAuthors,
          mergeWouldConflictFn: deps.mergeWouldConflictFn,
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

// ---------------------------------------------------------------------------
// One diagnostic per repository whose ruleset refuses milestone branches
// (Issue #2007)
// ---------------------------------------------------------------------------

/** Marker prefix; the value is the repository, so one issue covers it. */
export const MILESTONE_BRANCH_REFUSED_MARKER_PREFIX =
  "VIBE_MILESTONE_BRANCH_REFUSED";

/** Family id recorded in the filing attestation (Issue #1277). */
export const MILESTONE_BRANCH_REFUSED_FAMILY_ID = "milestone-branch-refused";

/** The HTML comment the diagnostic carries, matched whole on dedup. */
export function formatMilestoneBranchRefusedMarker(repo: string): string {
  return `<!-- ${MILESTONE_BRANCH_REFUSED_MARKER_PREFIX}:${repo} -->`;
}

/** Whether an issue body is this repository's refused-branch diagnostic. */
export function isMilestoneBranchRefusedIssue(
  body: string,
  repo: string,
): boolean {
  return body.includes(formatMilestoneBranchRefusedMarker(repo));
}

/** The diagnostic's title: the repository is the identity, not the branch. */
export function formatMilestoneBranchRefusedTitle(repo: string): string {
  return `Milestone branches cannot be created in ${repo}: the repository ` +
    `refuses the push that would create them`;
}

/** What the diagnostic says: the fact, the branch it was seen on, the fix. */
export function formatMilestoneBranchRefusedBody(input: {
  repo: string;
  branch: string;
  milestoneTitle: string;
  openChildren: number;
  message: string;
  remedy: string;
}): string {
  const error = redactSecrets(input.message).trim();
  return [
    formatMilestoneBranchRefusedMarker(input.repo),
    "",
    `The Vibe Coder cannot create milestone branches in \`${input.repo}\`. ` +
    `Milestone \`${input.milestoneTitle}\` is open with ` +
    `${input.openChildren} open child issue(s) and no collection branch, ` +
    `so its children cannot be worked as a milestone until this is fixed.`,
    "",
    `Branch: \`${input.branch}\``,
    "",
    "The repository's answer to the push:",
    "",
    "```text",
    error,
    "```",
    "",
    input.remedy,
    "",
    "**The one-flag fix (Issue #3912).** A branch being created has no check " +
    "runs, so a `required_status_checks` rule that is enforced on creation " +
    "refuses every push that would create it. On the ruleset covering " +
    "`refs/heads/milestone/**`, set `do_not_enforce_on_create: true` on that " +
    "rule — the checks still gate every merge into the branch, and " +
    "auto-merge arming keeps working. `mod.ts repo-settings-harden --repo " +
    `${input.repo}\` plans exactly that step; \`--apply\` writes the whole ` +
    "hardening set, so review the plan first. An admin has to make this " +
    "change: the fleet account cannot write rulesets.",
    "",
    "The worker files this once per repository and does not retry the push " +
    "again in the same run; the next worker start tries once more, so a " +
    "fixed ruleset is picked up on its own. Close this issue once the " +
    "branch exists (Issue #2007).",
  ].join("\n");
}

/** Outcome of one filing attempt; logged, never thrown. */
export type MilestoneBranchRefusedFilingDecision =
  | { action: "filed"; issueNumber: number }
  | { action: "exists"; issueNumber: number }
  | { action: "suppressed"; reason: "gh_failed" };

/** Everything {@link fileMilestoneBranchRefusedIssue} needs. */
export interface FileMilestoneBranchRefusedIssueOptions {
  repo: string;
  branch: string;
  milestoneTitle: string;
  openChildren: number;
  message: string;
  remedy: string;
  ghCommandFn: GhCommandFn;
  dedupAuthors?: AlertDedupAuthorOptions;
  recordFiling?: (filing: SelfDiagnosticFiling) => Promise<boolean>;
  log: (message: string) => void;
}

/**
 * File (or find) the one diagnostic for a repository that refuses milestone
 * branches (Issue #2007).
 *
 * Deduplicated on the marker **and** fleet authorship, like every other
 * worker-filed diagnostic: an open issue carrying this repository's marker,
 * authored by a fleet account on any host, is the existing report. Never
 * throws — the caller is the self-heal loop, and a GitHub failure is a
 * `suppressed:gh_failed` decision plus a fault event, not a crash.
 */
export async function fileMilestoneBranchRefusedIssue(
  opts: FileMilestoneBranchRefusedIssueOptions,
): Promise<MilestoneBranchRefusedFilingDecision> {
  const { repo, log } = opts;
  const decide = (
    decision: MilestoneBranchRefusedFilingDecision,
  ): MilestoneBranchRefusedFilingDecision => {
    log(
      `milestone-branch-refused filing: ${decision.action}${
        decision.action === "suppressed"
          ? `:${decision.reason}`
          : `:#${decision.issueNumber}`
      } repo=${repo} branch=${opts.branch}`,
    );
    return decision;
  };
  try {
    try {
      const raw = await opts.ghCommandFn([
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--search",
        `"${MILESTONE_BRANCH_REFUSED_MARKER_PREFIX}:${repo}" in:body`,
        "--json",
        ALERT_DEDUP_JSON_FIELDS,
        "--limit",
        "20",
      ]);
      const list = JSON.parse(raw || "[]") as AlertDedupRow[];
      const verified = await selectFleetAuthoredMatches(
        list.filter((row) =>
          isMilestoneBranchRefusedIssue(row.body ?? "", repo)
        ),
        `milestone-branch-refused ${repo}`,
        opts.dedupAuthors ?? {},
        log,
      );
      const match = verified.sort((a, b) => a.number - b.number)[0];
      if (match) {
        return decide({ action: "exists", issueNumber: match.number });
      }
    } catch (err) {
      recordFaultEvent(
        "catch_block_warning",
        `milestone-branch-refused issue search failed (${repo}): ${err}`,
      );
      return decide({ action: "suppressed", reason: "gh_failed" });
    }
    // Built before the try: a refused label is a programming error and must
    // fail loud, not be reported as a `gh_failed` suppression.
    const labelArgs = guardedLabelArgs(
      ["bug"],
      "worker/deno/lib/milestone_branch_self_heal.ts",
    );
    const title = formatMilestoneBranchRefusedTitle(repo);
    const body = formatMilestoneBranchRefusedBody(opts);
    try {
      const raw = await opts.ghCommandFn([
        "issue",
        "create",
        "--repo",
        repo,
        "--title",
        title,
        "--body",
        body,
        ...labelArgs,
      ]);
      const m = /\/issues\/(\d+)\s*$/.exec(raw.trim());
      const issueNumber = m ? parseInt(m[1]!, 10) : 0;
      const recordFiling = opts.recordFiling ??
        ((filing: SelfDiagnosticFiling) =>
          recordSelfDiagnosticFiling(filing, { log }));
      await recordFiling({
        repo,
        issueNumber,
        familyId: MILESTONE_BRANCH_REFUSED_FAMILY_ID,
        title,
        body,
        filedBy: "worker/deno/lib/milestone_branch_self_heal.ts",
      });
      return decide({ action: "filed", issueNumber });
    } catch (err) {
      recordFaultEvent(
        "catch_block_warning",
        `milestone-branch-refused issue create failed (${repo}): ${err}`,
      );
      return decide({ action: "suppressed", reason: "gh_failed" });
    }
  } catch (err) {
    recordFaultEvent(
      "catch_block_warning",
      `milestone-branch-refused filing threw (${repo}): ${err}`,
    );
    return decide({ action: "suppressed", reason: "gh_failed" });
  }
}
