/**
 * Restore a working route for an open milestone whose rollup has merged
 * (Issue #4175).
 *
 * The route is a fresh rollup pull request from the milestone branch to the
 * default branch. A milestone-fix pull request stays on the milestone branch
 * and is reviewed by that rollup; it is never moved onto the default branch
 * (Issue #3433). Retiring the branch is not required: a fresh rollup does not
 * land a milestone-fix pull request on the default branch.
 *
 * A milestone that is closed, or that has no open work, is left closed. The
 * milestone sync must not open a sync pull request into that branch.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */ import { createMilestoneBranchName } from "./git_branch.ts";
import { parseJsonArrayPages } from "./json_array_pages.ts";
import { logAt } from "./log_sink.ts";
import { fetchOpenMilestoneChildren, isMilestoneBranch } from "./milestone_children_gate.ts";
import { getRepoDefaultBranch } from "./shell_helpers.ts";
/** Marker in every fresh-rollup body. Posted in the target repository. */ export const RESTORED_ROLLUP_MARKER = "<!-- vibe-restored-milestone-rollup -->";
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;
/**
 * Read `compare/{default}...{milestone}`.
 *
 * Fails loud: a thrown `gh` call or a payload without a numeric `ahead_by`
 * is an error, never a quiet zero.
 */ export async function readBranchCompare(repo, defaultBranch, milestoneBranch, ghCommandFn) {
  let raw;
  try {
    raw = await ghCommandFn([
      "api",
      `repos/${repo}/compare/${defaultBranch}...${milestoneBranch}`,
      "--jq",
      "{ahead_by, files}"
    ]);
  } catch (err) {
    return {
      ok: false,
      error: new Error(`could not compare ${defaultBranch}...${milestoneBranch}: ${errorText(err)}`)
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch  {
    return {
      ok: false,
      error: new Error(`compare ${defaultBranch}...${milestoneBranch} returned no ahead_by`)
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: new Error(`compare ${defaultBranch}...${milestoneBranch} returned no ahead_by`)
    };
  }
  const aheadBy = parsed.ahead_by;
  if (typeof aheadBy !== "number" || !Number.isFinite(aheadBy)) {
    return {
      ok: false,
      error: new Error(`compare ${defaultBranch}...${milestoneBranch} returned no ahead_by`)
    };
  }
  const files = parsed.files;
  return {
    ok: true,
    value: {
      aheadBy,
      fileCount: Array.isArray(files) ? files.length : null
    }
  };
}
function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}
/** Pull requests whose head is the milestone branch. Throws on a bad read. */ async function listHeadPullRequests(repo, milestoneBranch, ghCommandFn) {
  const raw = await ghCommandFn([
    "pr",
    "list",
    "--repo",
    repo,
    "--head",
    milestoneBranch,
    "--state",
    "all",
    "--json",
    "number,state,baseRefName,mergedAt,headRefOid",
    "--limit",
    "50"
  ]);
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`gh pr list for ${milestoneBranch} returned ${typeof parsed}, not an array`);
  }
  return parsed;
}
function isOpenRoute(pr) {
  return typeof pr.state === "string" && pr.state.toUpperCase() === "OPEN" && typeof pr.number === "number" && (typeof pr.baseRefName !== "string" || !isMilestoneBranch(pr.baseRefName));
}
function mergedRollup(prs) {
  return prs.find((pr)=>typeof pr.state === "string" && pr.state.toUpperCase() === "MERGED" && typeof pr.number === "number");
}
/**
 * Whether a rollup from the milestone branch has already merged into the
 * default branch while the branch head has not moved since (Issue #4514).
 *
 * A squash merge does not move the merge base, so the three-dot compare
 * `compare/{default}...{milestone}` still lists everything the squash landed.
 * It cannot say whether the rollup already carried the branch. An unchanged
 * head since a merged rollup is proof nothing is left to carry.
 *
 * A merged pull request with a missing or non-string `headRefOid` never
 * matches, so the net change is unknown and the caller falls back to the
 * compare alone.
 *
 * Fails loud: a read or validation problem is an error Result, never a quiet
 * `false`. Pass `prs` to reuse a list already fetched for the branch.
 */ export async function isMilestoneHeadAlreadyMerged(options) {
  const { repo, milestoneBranch, defaultBranch, ghCommandFn } = options;
  if (!REPO_PATTERN.test(repo) || !BRANCH_PATTERN.test(milestoneBranch) || !BRANCH_PATTERN.test(defaultBranch)) {
    return {
      ok: false,
      error: new Error("repo or branch name failed the argument allowlist")
    };
  }
  let head;
  try {
    head = (await ghCommandFn([
      "api",
      `repos/${repo}/branches/${milestoneBranch}`,
      "--jq",
      ".commit.sha"
    ])).trim();
  } catch (err) {
    return {
      ok: false,
      error: new Error(`could not read the head of ${milestoneBranch}: ${errorText(err)}`)
    };
  }
  if (!/^[0-9a-f]{40}$/i.test(head)) {
    return {
      ok: false,
      error: new Error(`head of ${milestoneBranch} is not a 40-hex commit sha: ${JSON.stringify(head)}`)
    };
  }
  let prs;
  if (options.prs) {
    prs = options.prs;
  } else {
    try {
      prs = await listHeadPullRequests(repo, milestoneBranch, ghCommandFn);
    } catch (err) {
      return {
        ok: false,
        error: new Error(`could not list rollup PRs for ${milestoneBranch}: ${errorText(err)}`)
      };
    }
  }
  const matched = prs.some((pr)=>typeof pr.state === "string" && pr.state.toUpperCase() === "MERGED" && pr.baseRefName === defaultBranch && typeof pr.headRefOid === "string" && pr.headRefOid.toLowerCase() === head.toLowerCase());
  return {
    ok: true,
    value: matched
  };
}
/** The milestone whose branch name is `milestoneBranch`. Throws when unread. */ async function findMilestone(repo, milestoneBranch, ghCommandFn) {
  const raw = await ghCommandFn([
    "api",
    "--paginate",
    `repos/${repo}/milestones?state=all&per_page=100`
  ]);
  for (const item of parseJsonArrayPages(raw)){
    if (!item || typeof item !== "object") continue;
    const record = item;
    if (typeof record.title !== "string") continue;
    if (createMilestoneBranchName(record.title) !== milestoneBranch) continue;
    if (typeof record.number !== "number") {
      throw new Error(`milestone "${record.title}" has no number`);
    }
    return {
      number: record.number,
      title: record.title,
      state: typeof record.state === "string" ? record.state : ""
    };
  }
  return null;
}
/**
 * Body of the fresh rollup. Posted in the target repository, so it carries
 * no Vibe Coder issue number — GitHub would autolink a bare `#N` there.
 * It also carries no closing keyword, so merging it does not close an issue
 * by the body alone.
 */ export function buildRestoredRollupBody(milestoneBranch, defaultBranch, aheadBy, hasOpenWork) {
  const situation = hasOpenWork ? `has already merged, and the milestone still has open work.` : `has already merged, and \`${milestoneBranch}\` has changes \`${defaultBranch}\` does not have.`;
  return `${RESTORED_ROLLUP_MARKER}
## Fresh milestone rollup

The previous rollup of \`${milestoneBranch}\` into \`${defaultBranch}\` ${situation} \`${milestoneBranch}\` is ${aheadBy} commit(s) ahead of \`${defaultBranch}\`. This pull request is that branch's route to \`${defaultBranch}\`.

Child pull requests stay based on \`${milestoneBranch}\` and merge there. This pull request carries that work to \`${defaultBranch}\` once the milestone's review is done.

The fleet does not move a milestone pull request onto \`${defaultBranch}\` directly.

Raised automatically by the Vibe Coder.`;
}
async function openFreshRollup(repo, milestoneBranch, defaultBranch, aheadBy, hasOpenWork, ghCommandFn) {
  const body = buildRestoredRollupBody(milestoneBranch, defaultBranch, aheadBy, hasOpenWork);
  try {
    const prUrl = (await ghCommandFn([
      "pr",
      "create",
      "--repo",
      repo,
      "--title",
      `Milestone rollup: ${milestoneBranch} → ${defaultBranch}`,
      "--body",
      body,
      "--head",
      milestoneBranch,
      "--base",
      defaultBranch
    ])).trim();
    return {
      ok: true,
      prUrl
    };
  } catch (err) {
    return {
      ok: false,
      reason: `could not create the rollup PR for ${milestoneBranch}: ${errorText(err)}`
    };
  }
}
/** Reopen milestone issues a child merge closed. Returns a clause for the failure. */ async function reopenClosedIssues(repo, issueNumbers, ghCommandFn) {
  if (issueNumbers.length === 0) {
    return "No milestone issue number was available to reopen.";
  }
  const problems = [];
  for (const number of issueNumbers){
    if (!Number.isInteger(number) || number <= 0) {
      problems.push(`#${number} is not a pull-request issue number`);
      continue;
    }
    try {
      await ghCommandFn([
        "issue",
        "reopen",
        String(number),
        "--repo",
        repo
      ]);
    } catch (err) {
      problems.push(`#${number} could not be reopened (${errorText(err)})`);
    }
  }
  if (problems.length > 0) {
    return `Reopen failed: ${problems.join("; ")}.`;
  }
  const listed = issueNumbers.map((number)=>`#${number}`).join(", ");
  return `Reopened ${listed} so the issue is not left closed.`;
}
/**
 * Open the rollup after the child has already landed on the milestone
 * branch. A rollup that cannot be created does not leave the issue closed.
 */ export async function openRollupForLandedChild(options) {
  const { repo, milestoneBranch, defaultBranch, childPrNumber, issueNumbers, ghCommandFn, log } = options;
  if (!Number.isInteger(childPrNumber) || childPrNumber <= 0) {
    return {
      action: "failed",
      reason: `child PR number ${childPrNumber} is not a positive integer`
    };
  }
  const compare = await readBranchCompare(repo, defaultBranch, milestoneBranch, ghCommandFn);
  if (!compare.ok || compare.value.aheadBy <= 0) {
    const reopen = await reopenClosedIssues(repo, issueNumbers, ghCommandFn);
    const why = compare.ok ? `${milestoneBranch} is still not ahead of ${defaultBranch}` : compare.error.message;
    return {
      action: "land-failed",
      reason: `child PR #${childPrNumber} merged onto ${milestoneBranch} but no rollup was opened (${why}). ${reopen}`
    };
  }
  const opened = await openFreshRollup(repo, milestoneBranch, defaultBranch, compare.value.aheadBy, false, ghCommandFn);
  if (!opened.ok) {
    const reopen = await reopenClosedIssues(repo, issueNumbers, ghCommandFn);
    return {
      action: "land-failed",
      reason: `${opened.reason}. ${reopen}`
    };
  }
  logAt(log, "info", `merged child PR #${childPrNumber} onto ${milestoneBranch} in ${repo} and opened rollup ${opened.prUrl} in the same pass (Issue #4175)`);
  return {
    action: "created",
    prUrl: opened.prUrl,
    milestoneBranch,
    landedChildPr: childPrNumber
  };
}
/**
 * After a child has merged into a milestone branch, open a rollup when that
 * branch is ahead and no rollup is open (Issue #4175).
 *
 * The merged pull request is no longer open, so the arming path will not see
 * it again. A create failure reopens the child's issues so the work is not
 * left closed on a branch with no route. A base that is not a milestone
 * branch, or a pull request that cannot be read, is left to the caller.
 */ export async function restoreRouteAfterMergedChild(options) {
  const { repo, prNumber, issueNumbers, ghCommandFn, log } = options;
  let baseRefName = "";
  try {
    const parsed = JSON.parse(await ghCommandFn([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "state,baseRefName"
    ]));
    if (parsed.state !== "MERGED") return {
      action: "not-milestone"
    };
    baseRefName = typeof parsed.baseRefName === "string" ? parsed.baseRefName.trim() : "";
  } catch  {
    return {
      action: "not-milestone"
    };
  }
  if (!isMilestoneBranch(baseRefName)) return {
    action: "not-milestone"
  };
  const restored = await restoreClosedMilestoneRoute({
    repo,
    milestoneBranch: baseRefName,
    ghCommandFn,
    log
  });
  if (restored.action !== "failed") return restored;
  const stranded = restored.reason.includes("could not create the rollup");
  const reopen = stranded ? await reopenClosedIssues(repo, issueNumbers, ghCommandFn) : "";
  const detail = reopen ? `${restored.reason}. ${reopen}` : restored.reason;
  logAt(log, "warn", `child PR #${prNumber} merged onto ${baseRefName} in ${repo} but no rollup is open (${detail}) (Issue #4175)`);
  return {
    action: "failed",
    reason: detail
  };
}
/**
 * Open a fresh rollup when an open milestone's previous rollup has merged.
 *
 * Fails loud: a lookup or create that errors returns `failed` with the
 * reason, never a quiet success.
 */ export async function restoreClosedMilestoneRoute(options) {
  const { repo, milestoneBranch, ghCommandFn, log } = options;
  if (!isMilestoneBranch(milestoneBranch)) {
    return {
      action: "not-closed",
      milestoneBranch
    };
  }
  if (!REPO_PATTERN.test(repo) || !BRANCH_PATTERN.test(milestoneBranch)) {
    return {
      action: "failed",
      reason: "repo or branch name failed the argument allowlist"
    };
  }
  let prs;
  try {
    prs = await listHeadPullRequests(repo, milestoneBranch, ghCommandFn);
  } catch (err) {
    return {
      action: "failed",
      reason: `could not list rollup PRs for ${milestoneBranch}: ${errorText(err)}`
    };
  }
  const open = prs.find(isOpenRoute);
  if (open) {
    return {
      action: "exists",
      prNumber: open.number,
      milestoneBranch
    };
  }
  const merged = mergedRollup(prs);
  if (!merged || typeof merged.number !== "number") {
    return {
      action: "not-closed",
      milestoneBranch
    };
  }
  let milestone;
  try {
    milestone = await findMilestone(repo, milestoneBranch, ghCommandFn);
  } catch (err) {
    return {
      action: "failed",
      reason: `could not read milestones for ${milestoneBranch}: ${errorText(err)}`
    };
  }
  if (!milestone || milestone.state.toLowerCase() !== "open") {
    const why = milestone ? `milestone "${milestone.title}" is closed` : `no open milestone matches ${milestoneBranch}`;
    return {
      action: "left-closed",
      milestoneBranch,
      detail: `rollup PR #${merged.number} has merged and ${why}`
    };
  }
  const children = await fetchOpenMilestoneChildren({
    repo,
    milestoneNumber: milestone.number,
    milestoneBranch,
    ghCommandFn
  });
  if (!children.ok) {
    return {
      action: "failed",
      reason: children.error.message
    };
  }
  let defaultBranch = options.defaultBranch?.trim();
  if (!defaultBranch) {
    const resolved = await (options.getDefaultBranchFn ?? ((name)=>getRepoDefaultBranch(name, ghCommandFn)))(repo);
    if (!resolved.ok) {
      return {
        action: "failed",
        reason: `default branch unknown: ${resolved.error.message}`
      };
    }
    defaultBranch = resolved.value.trim();
  }
  if (!defaultBranch || !BRANCH_PATTERN.test(defaultBranch)) {
    return {
      action: "failed",
      reason: "default branch failed the argument allowlist"
    };
  }
  const compare = await readBranchCompare(repo, defaultBranch, milestoneBranch, ghCommandFn);
  if (!compare.ok) {
    return {
      action: "failed",
      reason: compare.error.message
    };
  }
  const { aheadBy, fileCount } = compare.value;
  if (children.value.length === 0 && aheadBy > 0) {
    // Issue #4514: a squash-merged rollup leaves the three-dot compare
    // non-empty, so ask whether the branch head is the one that merged.
    const headMerged = await isMilestoneHeadAlreadyMerged({
      repo,
      milestoneBranch,
      defaultBranch,
      ghCommandFn,
      prs
    });
    if (!headMerged.ok) {
      return {
        action: "failed",
        reason: headMerged.error.message
      };
    }
    if (headMerged.value) {
      return {
        action: "left-closed",
        milestoneBranch,
        detail: `rollup PR #${merged.number} has merged and ${milestoneBranch} has not moved since, so there is nothing new to carry to ${defaultBranch}`
      };
    }
  }
  // No commits to carry. Open work waits; a milestone with nothing open
  // stays closed. An empty file list with commits still ahead is work the
  // default branch already has, not a new rollup. A squash leaves the list
  // non-empty, so the head check above is what catches that (Issue #4514).
  if (aheadBy <= 0 || children.value.length === 0 && fileCount === 0) {
    if (children.value.length === 0) {
      return {
        action: "left-closed",
        milestoneBranch,
        detail: aheadBy <= 0 ? `rollup PR #${merged.number} has merged and milestone "${milestone.title}" has no open work` : `rollup PR #${merged.number} has merged and ${milestoneBranch} has no file changes ${defaultBranch} does not already have`
      };
    }
    if (options.landChildPrNumber !== undefined) {
      return {
        action: "merge-via-gate",
        milestoneBranch,
        defaultBranch,
        issueNumbers: children.value.filter((child)=>child.kind === "issue").map((child)=>child.number)
      };
    }
    return {
      action: "waiting",
      milestoneBranch,
      detail: `${milestoneBranch} is not ahead of ${defaultBranch}, so no rollup is open yet`
    };
  }
  const opened = await openFreshRollup(repo, milestoneBranch, defaultBranch, aheadBy, children.value.length > 0, ghCommandFn);
  if (!opened.ok) {
    return {
      action: "failed",
      reason: opened.reason
    };
  }
  const carried = children.value.length > 0 ? "while the milestone still has open work" : "while the branch still has changes the default branch does not";
  logAt(log, "info", `opened a fresh rollup for ${milestoneBranch} in ${repo} after rollup PR #${merged.number} merged ${carried} (Issue #4175): ${opened.prUrl}`);
  return {
    action: "created",
    prUrl: opened.prUrl,
    milestoneBranch
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9taWxlc3RvbmVfcm91dGVfcmVzdG9yZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFJlc3RvcmUgYSB3b3JraW5nIHJvdXRlIGZvciBhbiBvcGVuIG1pbGVzdG9uZSB3aG9zZSByb2xsdXAgaGFzIG1lcmdlZFxuICogKElzc3VlICM0MTc1KS5cbiAqXG4gKiBUaGUgcm91dGUgaXMgYSBmcmVzaCByb2xsdXAgcHVsbCByZXF1ZXN0IGZyb20gdGhlIG1pbGVzdG9uZSBicmFuY2ggdG8gdGhlXG4gKiBkZWZhdWx0IGJyYW5jaC4gQSBtaWxlc3RvbmUtZml4IHB1bGwgcmVxdWVzdCBzdGF5cyBvbiB0aGUgbWlsZXN0b25lIGJyYW5jaFxuICogYW5kIGlzIHJldmlld2VkIGJ5IHRoYXQgcm9sbHVwOyBpdCBpcyBuZXZlciBtb3ZlZCBvbnRvIHRoZSBkZWZhdWx0IGJyYW5jaFxuICogKElzc3VlICMzNDMzKS4gUmV0aXJpbmcgdGhlIGJyYW5jaCBpcyBub3QgcmVxdWlyZWQ6IGEgZnJlc2ggcm9sbHVwIGRvZXMgbm90XG4gKiBsYW5kIGEgbWlsZXN0b25lLWZpeCBwdWxsIHJlcXVlc3Qgb24gdGhlIGRlZmF1bHQgYnJhbmNoLlxuICpcbiAqIEEgbWlsZXN0b25lIHRoYXQgaXMgY2xvc2VkLCBvciB0aGF0IGhhcyBubyBvcGVuIHdvcmssIGlzIGxlZnQgY2xvc2VkLiBUaGVcbiAqIG1pbGVzdG9uZSBzeW5jIG11c3Qgbm90IG9wZW4gYSBzeW5jIHB1bGwgcmVxdWVzdCBpbnRvIHRoYXQgYnJhbmNoLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgeyBjcmVhdGVNaWxlc3RvbmVCcmFuY2hOYW1lIH0gZnJvbSBcIi4vZ2l0X2JyYW5jaC50c1wiO1xuaW1wb3J0IHsgcGFyc2VKc29uQXJyYXlQYWdlcyB9IGZyb20gXCIuL2pzb25fYXJyYXlfcGFnZXMudHNcIjtcbmltcG9ydCB7IGxvZ0F0LCB0eXBlIExvZ1NpbmsgfSBmcm9tIFwiLi9sb2dfc2luay50c1wiO1xuaW1wb3J0IHtcbiAgZmV0Y2hPcGVuTWlsZXN0b25lQ2hpbGRyZW4sXG4gIGlzTWlsZXN0b25lQnJhbmNoLFxufSBmcm9tIFwiLi9taWxlc3RvbmVfY2hpbGRyZW5fZ2F0ZS50c1wiO1xuaW1wb3J0IHsgZ2V0UmVwb0RlZmF1bHRCcmFuY2ggfSBmcm9tIFwiLi9zaGVsbF9oZWxwZXJzLnRzXCI7XG5cbi8qKiBGdW5jdGlvbiBzaWduYXR1cmUgZm9yIHJ1bm5pbmcgZ2ggQ0xJIGNvbW1hbmRzLiAqL1xuZXhwb3J0IHR5cGUgR2hDb21tYW5kRm4gPSAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPjtcblxuLyoqIE1hcmtlciBpbiBldmVyeSBmcmVzaC1yb2xsdXAgYm9keS4gUG9zdGVkIGluIHRoZSB0YXJnZXQgcmVwb3NpdG9yeS4gKi9cbmV4cG9ydCBjb25zdCBSRVNUT1JFRF9ST0xMVVBfTUFSS0VSID0gXCI8IS0tIHZpYmUtcmVzdG9yZWQtbWlsZXN0b25lLXJvbGx1cCAtLT5cIjtcblxuY29uc3QgUkVQT19QQVRURVJOID0gL15bQS1aYS16MC05Ll8tXStcXC9bQS1aYS16MC05Ll8tXSskLztcbmNvbnN0IEJSQU5DSF9QQVRURVJOID0gL15bQS1aYS16MC05Ll8vLV0rJC87XG5cbi8qKiBIb3cgZmFyIGBtaWxlc3RvbmVCcmFuY2hgIGlzIGFoZWFkIG9mIGBkZWZhdWx0QnJhbmNoYCwgYW5kIHdoZXRoZXIgdGhlIGRpZmYgaGFzIGZpbGVzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBCcmFuY2hDb21wYXJlIHtcbiAgLyoqIENvbW1pdHMgb24gdGhlIG1pbGVzdG9uZSBicmFuY2ggdGhhdCBhcmUgbm90IG9uIHRoZSBkZWZhdWx0IGJyYW5jaC4gKi9cbiAgYWhlYWRCeTogbnVtYmVyO1xuICAvKipcbiAgICogQ2hhbmdlZCBmaWxlcyBpbiB0aGF0IHJhbmdlLiBgbnVsbGAgd2hlbiB0aGUgcGF5bG9hZCBvbWl0dGVkIGBmaWxlc2BcbiAgICogKG5vdCBwcm9vZiB0aGUgZGlmZiBpcyBlbXB0eSkuXG4gICAqL1xuICBmaWxlQ291bnQ6IG51bWJlciB8IG51bGw7XG59XG5cbi8qKlxuICogUmVhZCBgY29tcGFyZS97ZGVmYXVsdH0uLi57bWlsZXN0b25lfWAuXG4gKlxuICogRmFpbHMgbG91ZDogYSB0aHJvd24gYGdoYCBjYWxsIG9yIGEgcGF5bG9hZCB3aXRob3V0IGEgbnVtZXJpYyBgYWhlYWRfYnlgXG4gKiBpcyBhbiBlcnJvciwgbmV2ZXIgYSBxdWlldCB6ZXJvLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVhZEJyYW5jaENvbXBhcmUoXG4gIHJlcG86IHN0cmluZyxcbiAgZGVmYXVsdEJyYW5jaDogc3RyaW5nLFxuICBtaWxlc3RvbmVCcmFuY2g6IHN0cmluZyxcbiAgZ2hDb21tYW5kRm46IEdoQ29tbWFuZEZuLFxuKTogUHJvbWlzZTxSZXN1bHQ8QnJhbmNoQ29tcGFyZT4+IHtcbiAgbGV0IHJhdzogc3RyaW5nO1xuICB0cnkge1xuICAgIHJhdyA9IGF3YWl0IGdoQ29tbWFuZEZuKFtcbiAgICAgIFwiYXBpXCIsXG4gICAgICBgcmVwb3MvJHtyZXBvfS9jb21wYXJlLyR7ZGVmYXVsdEJyYW5jaH0uLi4ke21pbGVzdG9uZUJyYW5jaH1gLFxuICAgICAgXCItLWpxXCIsXG4gICAgICBcInthaGVhZF9ieSwgZmlsZXN9XCIsXG4gICAgXSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgY291bGQgbm90IGNvbXBhcmUgJHtkZWZhdWx0QnJhbmNofS4uLiR7bWlsZXN0b25lQnJhbmNofTogJHtcbiAgICAgICAgICBlcnJvclRleHQoZXJyKVxuICAgICAgICB9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICB0cnkge1xuICAgIHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBjb21wYXJlICR7ZGVmYXVsdEJyYW5jaH0uLi4ke21pbGVzdG9uZUJyYW5jaH0gcmV0dXJuZWQgbm8gYWhlYWRfYnlgLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG4gIGlmICghcGFyc2VkIHx8IHR5cGVvZiBwYXJzZWQgIT09IFwib2JqZWN0XCIgfHwgQXJyYXkuaXNBcnJheShwYXJzZWQpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBjb21wYXJlICR7ZGVmYXVsdEJyYW5jaH0uLi4ke21pbGVzdG9uZUJyYW5jaH0gcmV0dXJuZWQgbm8gYWhlYWRfYnlgLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG4gIGNvbnN0IGFoZWFkQnkgPSAocGFyc2VkIGFzIHsgYWhlYWRfYnk/OiB1bmtub3duIH0pLmFoZWFkX2J5O1xuICBpZiAodHlwZW9mIGFoZWFkQnkgIT09IFwibnVtYmVyXCIgfHwgIU51bWJlci5pc0Zpbml0ZShhaGVhZEJ5KSkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgY29tcGFyZSAke2RlZmF1bHRCcmFuY2h9Li4uJHttaWxlc3RvbmVCcmFuY2h9IHJldHVybmVkIG5vIGFoZWFkX2J5YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuICBjb25zdCBmaWxlcyA9IChwYXJzZWQgYXMgeyBmaWxlcz86IHVua25vd24gfSkuZmlsZXM7XG4gIHJldHVybiB7XG4gICAgb2s6IHRydWUsXG4gICAgdmFsdWU6IHtcbiAgICAgIGFoZWFkQnksXG4gICAgICBmaWxlQ291bnQ6IEFycmF5LmlzQXJyYXkoZmlsZXMpID8gZmlsZXMubGVuZ3RoIDogbnVsbCxcbiAgICB9LFxuICB9O1xufVxuXG4vKiogV2hhdCB7QGxpbmsgcmVzdG9yZUNsb3NlZE1pbGVzdG9uZVJvdXRlfSBkaWQuICovXG5leHBvcnQgdHlwZSBSb3V0ZVJlc3RvcmVPdXRjb21lID1cbiAgLyoqIEEgZnJlc2ggcm9sbHVwIHB1bGwgcmVxdWVzdCB3YXMgb3BlbmVkLiAqL1xuICB8IHtcbiAgICBhY3Rpb246IFwiY3JlYXRlZFwiO1xuICAgIHByVXJsOiBzdHJpbmc7XG4gICAgbWlsZXN0b25lQnJhbmNoOiBzdHJpbmc7XG4gICAgLyoqXG4gICAgICogU2V0IHdoZW4gdGhpcyBwYXNzIG1lcmdlZCB0aGUgY2hpbGQgaW50byB0aGUgbWlsZXN0b25lIGJyYW5jaCBiZWZvcmVcbiAgICAgKiBvcGVuaW5nIHRoZSByb2xsdXAuIFRoZSBjYWxsZXIgbXVzdCBub3QgbWVyZ2UgdGhhdCBwdWxsIHJlcXVlc3QgYWdhaW4uXG4gICAgICovXG4gICAgbGFuZGVkQ2hpbGRQcj86IG51bWJlcjtcbiAgfVxuICAvKipcbiAgICogVGhlIGJyYW5jaCBpcyBub3QgYWhlYWQsIGFuZCB0aGUgb3BlbiB3b3JrIGlzIHRoZSBjaGlsZCBpdHNlbGYuIFRoZVxuICAgKiBjYWxsZXIgbWVyZ2VzIHRoYXQgY2hpbGQgdGhyb3VnaCB0aGUgb3JkaW5hcnkgcGF0aCAoZ2F0ZWQgZGlyZWN0IG1lcmdlXG4gICAqIG9yIGF1dG8tbWVyZ2UpIGFuZCBvcGVucyB0aGUgcm9sbHVwIG9ubHkgb25jZSB0aGUgbWVyZ2UgaGFzIGxhbmRlZC5cbiAgICovXG4gIHwge1xuICAgIGFjdGlvbjogXCJtZXJnZS12aWEtZ2F0ZVwiO1xuICAgIG1pbGVzdG9uZUJyYW5jaDogc3RyaW5nO1xuICAgIGRlZmF1bHRCcmFuY2g6IHN0cmluZztcbiAgICAvKiogTWlsZXN0b25lIGlzc3VlcyB0byByZW9wZW4gaWYgdGhlIG1lcmdlIGxhbmRzIGFuZCB0aGUgcm9sbHVwIGRvZXMgbm90LiAqL1xuICAgIGlzc3VlTnVtYmVyczogcmVhZG9ubHkgbnVtYmVyW107XG4gIH1cbiAgLyoqIEFuIG9wZW4gcm9sbHVwIGZyb20gdGhpcyBicmFuY2ggYWxyZWFkeSBleGlzdHMuICovXG4gIHwgeyBhY3Rpb246IFwiZXhpc3RzXCI7IHByTnVtYmVyOiBudW1iZXI7IG1pbGVzdG9uZUJyYW5jaDogc3RyaW5nIH1cbiAgLyoqIE5vIG1lcmdlZCByb2xsdXAg4oCUIHRoZSByb3V0ZSB3YXMgbm90IGNsb3NlZC4gKi9cbiAgfCB7IGFjdGlvbjogXCJub3QtY2xvc2VkXCI7IG1pbGVzdG9uZUJyYW5jaDogc3RyaW5nIH1cbiAgLyoqXG4gICAqIFRoZSBtaWxlc3RvbmUgaXMgb3BlbiB3aXRoIHdvcmssIGJ1dCB0aGUgYnJhbmNoIGlzIG5vdCBhaGVhZCBvZiB0aGVcbiAgICogZGVmYXVsdCBicmFuY2gsIHNvIEdpdEh1YiB3aWxsIG5vdCBvcGVuIGEgcm9sbHVwIHlldC5cbiAgICovXG4gIHwgeyBhY3Rpb246IFwid2FpdGluZ1wiOyBtaWxlc3RvbmVCcmFuY2g6IHN0cmluZzsgZGV0YWlsOiBzdHJpbmcgfVxuICAvKiogVGhlIHJvdXRlIHN0YXlzIGNsb3NlZDogdGhlIG1pbGVzdG9uZSBpcyBjbG9zZWQgb3IgaGFzIG5vIG9wZW4gd29yay4gKi9cbiAgfCB7IGFjdGlvbjogXCJsZWZ0LWNsb3NlZFwiOyBtaWxlc3RvbmVCcmFuY2g6IHN0cmluZzsgZGV0YWlsOiBzdHJpbmcgfVxuICAvKiogQSBsb29rdXAgb3IgY3JlYXRlIGZhaWxlZC4gTmV2ZXIgcmVwb3J0ZWQgYXMgc3VjY2Vzcy4gKi9cbiAgfCB7IGFjdGlvbjogXCJmYWlsZWRcIjsgcmVhc29uOiBzdHJpbmcgfVxuICAvKipcbiAgICogVGhlIGNoaWxkIHdhcyBtZXJnZWQgYW5kIHRoZSByb2xsdXAgd2FzIG5vdCBvcGVuZWQuIEl0cyBpc3N1ZSBpcyBub3RcbiAgICogbGVmdCBjbG9zZWQgKElzc3VlICM0MTc1KS5cbiAgICovXG4gIHwgeyBhY3Rpb246IFwibGFuZC1mYWlsZWRcIjsgcmVhc29uOiBzdHJpbmcgfTtcblxuLyoqIElucHV0cyBmb3Ige0BsaW5rIHJlc3RvcmVDbG9zZWRNaWxlc3RvbmVSb3V0ZX0uICovXG5leHBvcnQgaW50ZXJmYWNlIFJvdXRlUmVzdG9yZU9wdGlvbnMge1xuICAvKiogUmVwb3NpdG9yeSBpbiBgb3duZXIvcmVwb2AgZm9ybS4gKi9cbiAgcmVwbzogc3RyaW5nO1xuICAvKiogTWlsZXN0b25lIGJyYW5jaCAoYG1pbGVzdG9uZS88c2x1Zz5gKS4gKi9cbiAgbWlsZXN0b25lQnJhbmNoOiBzdHJpbmc7XG4gIC8qKiBGdW5jdGlvbiB0byBleGVjdXRlIGdoIENMSSBjb21tYW5kcy4gKi9cbiAgZ2hDb21tYW5kRm46IEdoQ29tbWFuZEZuO1xuICAvKiogRGVmYXVsdCBicmFuY2gsIHdoZW4gdGhlIGNhbGxlciBhbHJlYWR5IGhhcyBpdC4gKi9cbiAgZGVmYXVsdEJyYW5jaD86IHN0cmluZztcbiAgLyoqIERlZmF1bHQtYnJhbmNoIGxvb2t1cCwgd2hlbiB0aGUgY2FsbGVyIGFscmVhZHkgaGFzIG9uZS4gKi9cbiAgZ2V0RGVmYXVsdEJyYW5jaEZuPzogKHJlcG86IHN0cmluZykgPT4gUHJvbWlzZTxSZXN1bHQ8c3RyaW5nPj47XG4gIC8qKiBTaW5rIGZvciBwcm9ncmVzcyBhbmQgZmFpbHVyZSBsaW5lcy4gKi9cbiAgbG9nPzogTG9nU2luaztcbiAgLyoqXG4gICAqIFdoZW4gdGhlIGJyYW5jaCBpcyBub3QgYWhlYWQsIGFzayB0aGUgY2FsbGVyIHRvIG1lcmdlIHRoaXMgY2hpbGRcbiAgICogdGhyb3VnaCB0aGUgb3JkaW5hcnkgbWVyZ2UgcGF0aCAoSXNzdWUgIzQxNzUpLiBPbWl0dGVkIGJ5IHRoZSBzeW5jXG4gICAqIHBhdGgsIHdoaWNoIG11c3Qgbm90IG9wZW4gYSBwdWxsIHJlcXVlc3QgaW50byBhIHdhaXRpbmcgcm91dGUuXG4gICAqL1xuICBsYW5kQ2hpbGRQck51bWJlcj86IG51bWJlcjtcbn1cblxuLyoqIE9uZSBwdWxsIHJlcXVlc3QgZnJvbSBgZ2ggcHIgbGlzdCAtLWpzb25gLiBFdmVyeSBmaWVsZCBpcyB1bmNoZWNrZWQuICovXG5leHBvcnQgaW50ZXJmYWNlIFJhd1JvbGx1cFByIHtcbiAgbnVtYmVyPzogdW5rbm93bjtcbiAgc3RhdGU/OiB1bmtub3duO1xuICBiYXNlUmVmTmFtZT86IHVua25vd247XG4gIG1lcmdlZEF0PzogdW5rbm93bjtcbiAgaGVhZFJlZk9pZD86IHVua25vd247XG59XG5cbmZ1bmN0aW9uIGVycm9yVGV4dChlcnI6IHVua25vd24pOiBzdHJpbmcge1xuICByZXR1cm4gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xufVxuXG4vKiogUHVsbCByZXF1ZXN0cyB3aG9zZSBoZWFkIGlzIHRoZSBtaWxlc3RvbmUgYnJhbmNoLiBUaHJvd3Mgb24gYSBiYWQgcmVhZC4gKi9cbmFzeW5jIGZ1bmN0aW9uIGxpc3RIZWFkUHVsbFJlcXVlc3RzKFxuICByZXBvOiBzdHJpbmcsXG4gIG1pbGVzdG9uZUJyYW5jaDogc3RyaW5nLFxuICBnaENvbW1hbmRGbjogR2hDb21tYW5kRm4sXG4pOiBQcm9taXNlPFJhd1JvbGx1cFByW10+IHtcbiAgY29uc3QgcmF3ID0gYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgIFwicHJcIixcbiAgICBcImxpc3RcIixcbiAgICBcIi0tcmVwb1wiLFxuICAgIHJlcG8sXG4gICAgXCItLWhlYWRcIixcbiAgICBtaWxlc3RvbmVCcmFuY2gsXG4gICAgXCItLXN0YXRlXCIsXG4gICAgXCJhbGxcIixcbiAgICBcIi0tanNvblwiLFxuICAgIFwibnVtYmVyLHN0YXRlLGJhc2VSZWZOYW1lLG1lcmdlZEF0LGhlYWRSZWZPaWRcIixcbiAgICBcIi0tbGltaXRcIixcbiAgICBcIjUwXCIsXG4gIF0pO1xuICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdyk7XG4gIGlmICghQXJyYXkuaXNBcnJheShwYXJzZWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYGdoIHByIGxpc3QgZm9yICR7bWlsZXN0b25lQnJhbmNofSByZXR1cm5lZCAke3R5cGVvZiBwYXJzZWR9LCBub3QgYW4gYXJyYXlgLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHBhcnNlZCBhcyBSYXdSb2xsdXBQcltdO1xufVxuXG5mdW5jdGlvbiBpc09wZW5Sb3V0ZShwcjogUmF3Um9sbHVwUHIpOiBwciBpcyBSYXdSb2xsdXBQciAmIHsgbnVtYmVyOiBudW1iZXIgfSB7XG4gIHJldHVybiB0eXBlb2YgcHIuc3RhdGUgPT09IFwic3RyaW5nXCIgJiYgcHIuc3RhdGUudG9VcHBlckNhc2UoKSA9PT0gXCJPUEVOXCIgJiZcbiAgICB0eXBlb2YgcHIubnVtYmVyID09PSBcIm51bWJlclwiICYmXG4gICAgKHR5cGVvZiBwci5iYXNlUmVmTmFtZSAhPT0gXCJzdHJpbmdcIiB8fCAhaXNNaWxlc3RvbmVCcmFuY2gocHIuYmFzZVJlZk5hbWUpKTtcbn1cblxuZnVuY3Rpb24gbWVyZ2VkUm9sbHVwKHByczogcmVhZG9ubHkgUmF3Um9sbHVwUHJbXSk6IFJhd1JvbGx1cFByIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIHBycy5maW5kKChwcikgPT5cbiAgICB0eXBlb2YgcHIuc3RhdGUgPT09IFwic3RyaW5nXCIgJiYgcHIuc3RhdGUudG9VcHBlckNhc2UoKSA9PT0gXCJNRVJHRURcIiAmJlxuICAgIHR5cGVvZiBwci5udW1iZXIgPT09IFwibnVtYmVyXCJcbiAgKTtcbn1cblxuLyoqXG4gKiBXaGV0aGVyIGEgcm9sbHVwIGZyb20gdGhlIG1pbGVzdG9uZSBicmFuY2ggaGFzIGFscmVhZHkgbWVyZ2VkIGludG8gdGhlXG4gKiBkZWZhdWx0IGJyYW5jaCB3aGlsZSB0aGUgYnJhbmNoIGhlYWQgaGFzIG5vdCBtb3ZlZCBzaW5jZSAoSXNzdWUgIzQ1MTQpLlxuICpcbiAqIEEgc3F1YXNoIG1lcmdlIGRvZXMgbm90IG1vdmUgdGhlIG1lcmdlIGJhc2UsIHNvIHRoZSB0aHJlZS1kb3QgY29tcGFyZVxuICogYGNvbXBhcmUve2RlZmF1bHR9Li4ue21pbGVzdG9uZX1gIHN0aWxsIGxpc3RzIGV2ZXJ5dGhpbmcgdGhlIHNxdWFzaCBsYW5kZWQuXG4gKiBJdCBjYW5ub3Qgc2F5IHdoZXRoZXIgdGhlIHJvbGx1cCBhbHJlYWR5IGNhcnJpZWQgdGhlIGJyYW5jaC4gQW4gdW5jaGFuZ2VkXG4gKiBoZWFkIHNpbmNlIGEgbWVyZ2VkIHJvbGx1cCBpcyBwcm9vZiBub3RoaW5nIGlzIGxlZnQgdG8gY2FycnkuXG4gKlxuICogQSBtZXJnZWQgcHVsbCByZXF1ZXN0IHdpdGggYSBtaXNzaW5nIG9yIG5vbi1zdHJpbmcgYGhlYWRSZWZPaWRgIG5ldmVyXG4gKiBtYXRjaGVzLCBzbyB0aGUgbmV0IGNoYW5nZSBpcyB1bmtub3duIGFuZCB0aGUgY2FsbGVyIGZhbGxzIGJhY2sgdG8gdGhlXG4gKiBjb21wYXJlIGFsb25lLlxuICpcbiAqIEZhaWxzIGxvdWQ6IGEgcmVhZCBvciB2YWxpZGF0aW9uIHByb2JsZW0gaXMgYW4gZXJyb3IgUmVzdWx0LCBuZXZlciBhIHF1aWV0XG4gKiBgZmFsc2VgLiBQYXNzIGBwcnNgIHRvIHJldXNlIGEgbGlzdCBhbHJlYWR5IGZldGNoZWQgZm9yIHRoZSBicmFuY2guXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBpc01pbGVzdG9uZUhlYWRBbHJlYWR5TWVyZ2VkKG9wdGlvbnM6IHtcbiAgcmVwbzogc3RyaW5nO1xuICBtaWxlc3RvbmVCcmFuY2g6IHN0cmluZztcbiAgZGVmYXVsdEJyYW5jaDogc3RyaW5nO1xuICBnaENvbW1hbmRGbjogR2hDb21tYW5kRm47XG4gIHBycz86IHJlYWRvbmx5IFJhd1JvbGx1cFByW107XG59KTogUHJvbWlzZTxSZXN1bHQ8Ym9vbGVhbj4+IHtcbiAgY29uc3QgeyByZXBvLCBtaWxlc3RvbmVCcmFuY2gsIGRlZmF1bHRCcmFuY2gsIGdoQ29tbWFuZEZuIH0gPSBvcHRpb25zO1xuICBpZiAoXG4gICAgIVJFUE9fUEFUVEVSTi50ZXN0KHJlcG8pIHx8ICFCUkFOQ0hfUEFUVEVSTi50ZXN0KG1pbGVzdG9uZUJyYW5jaCkgfHxcbiAgICAhQlJBTkNIX1BBVFRFUk4udGVzdChkZWZhdWx0QnJhbmNoKVxuICApIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcInJlcG8gb3IgYnJhbmNoIG5hbWUgZmFpbGVkIHRoZSBhcmd1bWVudCBhbGxvd2xpc3RcIiksXG4gICAgfTtcbiAgfVxuICBsZXQgaGVhZDogc3RyaW5nO1xuICB0cnkge1xuICAgIGhlYWQgPSAoYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgICAgXCJhcGlcIixcbiAgICAgIGByZXBvcy8ke3JlcG99L2JyYW5jaGVzLyR7bWlsZXN0b25lQnJhbmNofWAsXG4gICAgICBcIi0tanFcIixcbiAgICAgIFwiLmNvbW1pdC5zaGFcIixcbiAgICBdKSkudHJpbSgpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYGNvdWxkIG5vdCByZWFkIHRoZSBoZWFkIG9mICR7bWlsZXN0b25lQnJhbmNofTogJHtlcnJvclRleHQoZXJyKX1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG4gIGlmICghL15bMC05YS1mXXs0MH0kL2kudGVzdChoZWFkKSkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgaGVhZCBvZiAke21pbGVzdG9uZUJyYW5jaH0gaXMgbm90IGEgNDAtaGV4IGNvbW1pdCBzaGE6ICR7XG4gICAgICAgICAgSlNPTi5zdHJpbmdpZnkoaGVhZClcbiAgICAgICAgfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cbiAgbGV0IHByczogcmVhZG9ubHkgUmF3Um9sbHVwUHJbXTtcbiAgaWYgKG9wdGlvbnMucHJzKSB7XG4gICAgcHJzID0gb3B0aW9ucy5wcnM7XG4gIH0gZWxzZSB7XG4gICAgdHJ5IHtcbiAgICAgIHBycyA9IGF3YWl0IGxpc3RIZWFkUHVsbFJlcXVlc3RzKHJlcG8sIG1pbGVzdG9uZUJyYW5jaCwgZ2hDb21tYW5kRm4pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICAgIGBjb3VsZCBub3QgbGlzdCByb2xsdXAgUFJzIGZvciAke21pbGVzdG9uZUJyYW5jaH06ICR7ZXJyb3JUZXh0KGVycil9YCxcbiAgICAgICAgKSxcbiAgICAgIH07XG4gICAgfVxuICB9XG4gIGNvbnN0IG1hdGNoZWQgPSBwcnMuc29tZSgocHIpID0+XG4gICAgdHlwZW9mIHByLnN0YXRlID09PSBcInN0cmluZ1wiICYmIHByLnN0YXRlLnRvVXBwZXJDYXNlKCkgPT09IFwiTUVSR0VEXCIgJiZcbiAgICBwci5iYXNlUmVmTmFtZSA9PT0gZGVmYXVsdEJyYW5jaCAmJlxuICAgIHR5cGVvZiBwci5oZWFkUmVmT2lkID09PSBcInN0cmluZ1wiICYmXG4gICAgcHIuaGVhZFJlZk9pZC50b0xvd2VyQ2FzZSgpID09PSBoZWFkLnRvTG93ZXJDYXNlKClcbiAgKTtcbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBtYXRjaGVkIH07XG59XG5cbmludGVyZmFjZSBNaWxlc3RvbmVNYXRjaCB7XG4gIG51bWJlcjogbnVtYmVyO1xuICB0aXRsZTogc3RyaW5nO1xuICBzdGF0ZTogc3RyaW5nO1xufVxuXG4vKiogVGhlIG1pbGVzdG9uZSB3aG9zZSBicmFuY2ggbmFtZSBpcyBgbWlsZXN0b25lQnJhbmNoYC4gVGhyb3dzIHdoZW4gdW5yZWFkLiAqL1xuYXN5bmMgZnVuY3Rpb24gZmluZE1pbGVzdG9uZShcbiAgcmVwbzogc3RyaW5nLFxuICBtaWxlc3RvbmVCcmFuY2g6IHN0cmluZyxcbiAgZ2hDb21tYW5kRm46IEdoQ29tbWFuZEZuLFxuKTogUHJvbWlzZTxNaWxlc3RvbmVNYXRjaCB8IG51bGw+IHtcbiAgY29uc3QgcmF3ID0gYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgIFwiYXBpXCIsXG4gICAgXCItLXBhZ2luYXRlXCIsXG4gICAgYHJlcG9zLyR7cmVwb30vbWlsZXN0b25lcz9zdGF0ZT1hbGwmcGVyX3BhZ2U9MTAwYCxcbiAgXSk7XG4gIGZvciAoY29uc3QgaXRlbSBvZiBwYXJzZUpzb25BcnJheVBhZ2VzKHJhdykpIHtcbiAgICBpZiAoIWl0ZW0gfHwgdHlwZW9mIGl0ZW0gIT09IFwib2JqZWN0XCIpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHJlY29yZCA9IGl0ZW0gYXMge1xuICAgICAgbnVtYmVyPzogdW5rbm93bjtcbiAgICAgIHRpdGxlPzogdW5rbm93bjtcbiAgICAgIHN0YXRlPzogdW5rbm93bjtcbiAgICB9O1xuICAgIGlmICh0eXBlb2YgcmVjb3JkLnRpdGxlICE9PSBcInN0cmluZ1wiKSBjb250aW51ZTtcbiAgICBpZiAoY3JlYXRlTWlsZXN0b25lQnJhbmNoTmFtZShyZWNvcmQudGl0bGUpICE9PSBtaWxlc3RvbmVCcmFuY2gpIGNvbnRpbnVlO1xuICAgIGlmICh0eXBlb2YgcmVjb3JkLm51bWJlciAhPT0gXCJudW1iZXJcIikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBtaWxlc3RvbmUgXCIke3JlY29yZC50aXRsZX1cIiBoYXMgbm8gbnVtYmVyYCk7XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBudW1iZXI6IHJlY29yZC5udW1iZXIsXG4gICAgICB0aXRsZTogcmVjb3JkLnRpdGxlLFxuICAgICAgc3RhdGU6IHR5cGVvZiByZWNvcmQuc3RhdGUgPT09IFwic3RyaW5nXCIgPyByZWNvcmQuc3RhdGUgOiBcIlwiLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICogQm9keSBvZiB0aGUgZnJlc2ggcm9sbHVwLiBQb3N0ZWQgaW4gdGhlIHRhcmdldCByZXBvc2l0b3J5LCBzbyBpdCBjYXJyaWVzXG4gKiBubyBWaWJlIENvZGVyIGlzc3VlIG51bWJlciDigJQgR2l0SHViIHdvdWxkIGF1dG9saW5rIGEgYmFyZSBgI05gIHRoZXJlLlxuICogSXQgYWxzbyBjYXJyaWVzIG5vIGNsb3Npbmcga2V5d29yZCwgc28gbWVyZ2luZyBpdCBkb2VzIG5vdCBjbG9zZSBhbiBpc3N1ZVxuICogYnkgdGhlIGJvZHkgYWxvbmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFJlc3RvcmVkUm9sbHVwQm9keShcbiAgbWlsZXN0b25lQnJhbmNoOiBzdHJpbmcsXG4gIGRlZmF1bHRCcmFuY2g6IHN0cmluZyxcbiAgYWhlYWRCeTogbnVtYmVyLFxuICBoYXNPcGVuV29yazogYm9vbGVhbixcbik6IHN0cmluZyB7XG4gIGNvbnN0IHNpdHVhdGlvbiA9IGhhc09wZW5Xb3JrXG4gICAgPyBgaGFzIGFscmVhZHkgbWVyZ2VkLCBhbmQgdGhlIG1pbGVzdG9uZSBzdGlsbCBoYXMgb3BlbiB3b3JrLmBcbiAgICA6IGBoYXMgYWxyZWFkeSBtZXJnZWQsIGFuZCBcXGAke21pbGVzdG9uZUJyYW5jaH1cXGAgaGFzIGNoYW5nZXMgXFxgJHtkZWZhdWx0QnJhbmNofVxcYCBkb2VzIG5vdCBoYXZlLmA7XG4gIHJldHVybiBgJHtSRVNUT1JFRF9ST0xMVVBfTUFSS0VSfVxuIyMgRnJlc2ggbWlsZXN0b25lIHJvbGx1cFxuXG5UaGUgcHJldmlvdXMgcm9sbHVwIG9mIFxcYCR7bWlsZXN0b25lQnJhbmNofVxcYCBpbnRvIFxcYCR7ZGVmYXVsdEJyYW5jaH1cXGAgJHtzaXR1YXRpb259IFxcYCR7bWlsZXN0b25lQnJhbmNofVxcYCBpcyAke2FoZWFkQnl9IGNvbW1pdChzKSBhaGVhZCBvZiBcXGAke2RlZmF1bHRCcmFuY2h9XFxgLiBUaGlzIHB1bGwgcmVxdWVzdCBpcyB0aGF0IGJyYW5jaCdzIHJvdXRlIHRvIFxcYCR7ZGVmYXVsdEJyYW5jaH1cXGAuXG5cbkNoaWxkIHB1bGwgcmVxdWVzdHMgc3RheSBiYXNlZCBvbiBcXGAke21pbGVzdG9uZUJyYW5jaH1cXGAgYW5kIG1lcmdlIHRoZXJlLiBUaGlzIHB1bGwgcmVxdWVzdCBjYXJyaWVzIHRoYXQgd29yayB0byBcXGAke2RlZmF1bHRCcmFuY2h9XFxgIG9uY2UgdGhlIG1pbGVzdG9uZSdzIHJldmlldyBpcyBkb25lLlxuXG5UaGUgZmxlZXQgZG9lcyBub3QgbW92ZSBhIG1pbGVzdG9uZSBwdWxsIHJlcXVlc3Qgb250byBcXGAke2RlZmF1bHRCcmFuY2h9XFxgIGRpcmVjdGx5LlxuXG5SYWlzZWQgYXV0b21hdGljYWxseSBieSB0aGUgVmliZSBDb2Rlci5gO1xufVxuXG5hc3luYyBmdW5jdGlvbiBvcGVuRnJlc2hSb2xsdXAoXG4gIHJlcG86IHN0cmluZyxcbiAgbWlsZXN0b25lQnJhbmNoOiBzdHJpbmcsXG4gIGRlZmF1bHRCcmFuY2g6IHN0cmluZyxcbiAgYWhlYWRCeTogbnVtYmVyLFxuICBoYXNPcGVuV29yazogYm9vbGVhbixcbiAgZ2hDb21tYW5kRm46IEdoQ29tbWFuZEZuLFxuKTogUHJvbWlzZTx7IG9rOiB0cnVlOyBwclVybDogc3RyaW5nIH0gfCB7IG9rOiBmYWxzZTsgcmVhc29uOiBzdHJpbmcgfT4ge1xuICBjb25zdCBib2R5ID0gYnVpbGRSZXN0b3JlZFJvbGx1cEJvZHkoXG4gICAgbWlsZXN0b25lQnJhbmNoLFxuICAgIGRlZmF1bHRCcmFuY2gsXG4gICAgYWhlYWRCeSxcbiAgICBoYXNPcGVuV29yayxcbiAgKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBwclVybCA9IChhd2FpdCBnaENvbW1hbmRGbihbXG4gICAgICBcInByXCIsXG4gICAgICBcImNyZWF0ZVwiLFxuICAgICAgXCItLXJlcG9cIixcbiAgICAgIHJlcG8sXG4gICAgICBcIi0tdGl0bGVcIixcbiAgICAgIGBNaWxlc3RvbmUgcm9sbHVwOiAke21pbGVzdG9uZUJyYW5jaH0g4oaSICR7ZGVmYXVsdEJyYW5jaH1gLFxuICAgICAgXCItLWJvZHlcIixcbiAgICAgIGJvZHksXG4gICAgICBcIi0taGVhZFwiLFxuICAgICAgbWlsZXN0b25lQnJhbmNoLFxuICAgICAgXCItLWJhc2VcIixcbiAgICAgIGRlZmF1bHRCcmFuY2gsXG4gICAgXSkpLnRyaW0oKTtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgcHJVcmwgfTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIHJlYXNvbjogYGNvdWxkIG5vdCBjcmVhdGUgdGhlIHJvbGx1cCBQUiBmb3IgJHttaWxlc3RvbmVCcmFuY2h9OiAke1xuICAgICAgICBlcnJvclRleHQoZXJyKVxuICAgICAgfWAsXG4gICAgfTtcbiAgfVxufVxuXG4vKiogUmVvcGVuIG1pbGVzdG9uZSBpc3N1ZXMgYSBjaGlsZCBtZXJnZSBjbG9zZWQuIFJldHVybnMgYSBjbGF1c2UgZm9yIHRoZSBmYWlsdXJlLiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVvcGVuQ2xvc2VkSXNzdWVzKFxuICByZXBvOiBzdHJpbmcsXG4gIGlzc3VlTnVtYmVyczogcmVhZG9ubHkgbnVtYmVyW10sXG4gIGdoQ29tbWFuZEZuOiBHaENvbW1hbmRGbixcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGlmIChpc3N1ZU51bWJlcnMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIFwiTm8gbWlsZXN0b25lIGlzc3VlIG51bWJlciB3YXMgYXZhaWxhYmxlIHRvIHJlb3Blbi5cIjtcbiAgfVxuICBjb25zdCBwcm9ibGVtczogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCBudW1iZXIgb2YgaXNzdWVOdW1iZXJzKSB7XG4gICAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKG51bWJlcikgfHwgbnVtYmVyIDw9IDApIHtcbiAgICAgIHByb2JsZW1zLnB1c2goYCMke251bWJlcn0gaXMgbm90IGEgcHVsbC1yZXF1ZXN0IGlzc3VlIG51bWJlcmApO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICBhd2FpdCBnaENvbW1hbmRGbihbXG4gICAgICAgIFwiaXNzdWVcIixcbiAgICAgICAgXCJyZW9wZW5cIixcbiAgICAgICAgU3RyaW5nKG51bWJlciksXG4gICAgICAgIFwiLS1yZXBvXCIsXG4gICAgICAgIHJlcG8sXG4gICAgICBdKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHByb2JsZW1zLnB1c2goYCMke251bWJlcn0gY291bGQgbm90IGJlIHJlb3BlbmVkICgke2Vycm9yVGV4dChlcnIpfSlgKTtcbiAgICB9XG4gIH1cbiAgaWYgKHByb2JsZW1zLmxlbmd0aCA+IDApIHtcbiAgICByZXR1cm4gYFJlb3BlbiBmYWlsZWQ6ICR7cHJvYmxlbXMuam9pbihcIjsgXCIpfS5gO1xuICB9XG4gIGNvbnN0IGxpc3RlZCA9IGlzc3VlTnVtYmVycy5tYXAoKG51bWJlcikgPT4gYCMke251bWJlcn1gKS5qb2luKFwiLCBcIik7XG4gIHJldHVybiBgUmVvcGVuZWQgJHtsaXN0ZWR9IHNvIHRoZSBpc3N1ZSBpcyBub3QgbGVmdCBjbG9zZWQuYDtcbn1cblxuLyoqXG4gKiBPcGVuIHRoZSByb2xsdXAgYWZ0ZXIgdGhlIGNoaWxkIGhhcyBhbHJlYWR5IGxhbmRlZCBvbiB0aGUgbWlsZXN0b25lXG4gKiBicmFuY2guIEEgcm9sbHVwIHRoYXQgY2Fubm90IGJlIGNyZWF0ZWQgZG9lcyBub3QgbGVhdmUgdGhlIGlzc3VlIGNsb3NlZC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG9wZW5Sb2xsdXBGb3JMYW5kZWRDaGlsZChcbiAgb3B0aW9uczoge1xuICAgIHJlcG86IHN0cmluZztcbiAgICBtaWxlc3RvbmVCcmFuY2g6IHN0cmluZztcbiAgICBkZWZhdWx0QnJhbmNoOiBzdHJpbmc7XG4gICAgY2hpbGRQck51bWJlcjogbnVtYmVyO1xuICAgIGlzc3VlTnVtYmVyczogcmVhZG9ubHkgbnVtYmVyW107XG4gICAgZ2hDb21tYW5kRm46IEdoQ29tbWFuZEZuO1xuICAgIGxvZz86IExvZ1Npbms7XG4gIH0sXG4pOiBQcm9taXNlPFJvdXRlUmVzdG9yZU91dGNvbWU+IHtcbiAgY29uc3Qge1xuICAgIHJlcG8sXG4gICAgbWlsZXN0b25lQnJhbmNoLFxuICAgIGRlZmF1bHRCcmFuY2gsXG4gICAgY2hpbGRQck51bWJlcixcbiAgICBpc3N1ZU51bWJlcnMsXG4gICAgZ2hDb21tYW5kRm4sXG4gICAgbG9nLFxuICB9ID0gb3B0aW9ucztcbiAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKGNoaWxkUHJOdW1iZXIpIHx8IGNoaWxkUHJOdW1iZXIgPD0gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBhY3Rpb246IFwiZmFpbGVkXCIsXG4gICAgICByZWFzb246IGBjaGlsZCBQUiBudW1iZXIgJHtjaGlsZFByTnVtYmVyfSBpcyBub3QgYSBwb3NpdGl2ZSBpbnRlZ2VyYCxcbiAgICB9O1xuICB9XG4gIGNvbnN0IGNvbXBhcmUgPSBhd2FpdCByZWFkQnJhbmNoQ29tcGFyZShcbiAgICByZXBvLFxuICAgIGRlZmF1bHRCcmFuY2gsXG4gICAgbWlsZXN0b25lQnJhbmNoLFxuICAgIGdoQ29tbWFuZEZuLFxuICApO1xuICBpZiAoIWNvbXBhcmUub2sgfHwgY29tcGFyZS52YWx1ZS5haGVhZEJ5IDw9IDApIHtcbiAgICBjb25zdCByZW9wZW4gPSBhd2FpdCByZW9wZW5DbG9zZWRJc3N1ZXMoXG4gICAgICByZXBvLFxuICAgICAgaXNzdWVOdW1iZXJzLFxuICAgICAgZ2hDb21tYW5kRm4sXG4gICAgKTtcbiAgICBjb25zdCB3aHkgPSBjb21wYXJlLm9rXG4gICAgICA/IGAke21pbGVzdG9uZUJyYW5jaH0gaXMgc3RpbGwgbm90IGFoZWFkIG9mICR7ZGVmYXVsdEJyYW5jaH1gXG4gICAgICA6IGNvbXBhcmUuZXJyb3IubWVzc2FnZTtcbiAgICByZXR1cm4ge1xuICAgICAgYWN0aW9uOiBcImxhbmQtZmFpbGVkXCIsXG4gICAgICByZWFzb246XG4gICAgICAgIGBjaGlsZCBQUiAjJHtjaGlsZFByTnVtYmVyfSBtZXJnZWQgb250byAke21pbGVzdG9uZUJyYW5jaH0gYnV0IG5vIHJvbGx1cCB3YXMgb3BlbmVkICgke3doeX0pLiAke3Jlb3Blbn1gLFxuICAgIH07XG4gIH1cbiAgY29uc3Qgb3BlbmVkID0gYXdhaXQgb3BlbkZyZXNoUm9sbHVwKFxuICAgIHJlcG8sXG4gICAgbWlsZXN0b25lQnJhbmNoLFxuICAgIGRlZmF1bHRCcmFuY2gsXG4gICAgY29tcGFyZS52YWx1ZS5haGVhZEJ5LFxuICAgIGZhbHNlLFxuICAgIGdoQ29tbWFuZEZuLFxuICApO1xuICBpZiAoIW9wZW5lZC5vaykge1xuICAgIGNvbnN0IHJlb3BlbiA9IGF3YWl0IHJlb3BlbkNsb3NlZElzc3VlcyhcbiAgICAgIHJlcG8sXG4gICAgICBpc3N1ZU51bWJlcnMsXG4gICAgICBnaENvbW1hbmRGbixcbiAgICApO1xuICAgIHJldHVybiB7XG4gICAgICBhY3Rpb246IFwibGFuZC1mYWlsZWRcIixcbiAgICAgIHJlYXNvbjogYCR7b3BlbmVkLnJlYXNvbn0uICR7cmVvcGVufWAsXG4gICAgfTtcbiAgfVxuICBsb2dBdChcbiAgICBsb2csXG4gICAgXCJpbmZvXCIsXG4gICAgYG1lcmdlZCBjaGlsZCBQUiAjJHtjaGlsZFByTnVtYmVyfSBvbnRvICR7bWlsZXN0b25lQnJhbmNofSBpbiAke3JlcG99IGFuZCBvcGVuZWQgcm9sbHVwICR7b3BlbmVkLnByVXJsfSBpbiB0aGUgc2FtZSBwYXNzIChJc3N1ZSAjNDE3NSlgLFxuICApO1xuICByZXR1cm4ge1xuICAgIGFjdGlvbjogXCJjcmVhdGVkXCIsXG4gICAgcHJVcmw6IG9wZW5lZC5wclVybCxcbiAgICBtaWxlc3RvbmVCcmFuY2gsXG4gICAgbGFuZGVkQ2hpbGRQcjogY2hpbGRQck51bWJlcixcbiAgfTtcbn1cblxuLyoqXG4gKiBBZnRlciBhIGNoaWxkIGhhcyBtZXJnZWQgaW50byBhIG1pbGVzdG9uZSBicmFuY2gsIG9wZW4gYSByb2xsdXAgd2hlbiB0aGF0XG4gKiBicmFuY2ggaXMgYWhlYWQgYW5kIG5vIHJvbGx1cCBpcyBvcGVuIChJc3N1ZSAjNDE3NSkuXG4gKlxuICogVGhlIG1lcmdlZCBwdWxsIHJlcXVlc3QgaXMgbm8gbG9uZ2VyIG9wZW4sIHNvIHRoZSBhcm1pbmcgcGF0aCB3aWxsIG5vdCBzZWVcbiAqIGl0IGFnYWluLiBBIGNyZWF0ZSBmYWlsdXJlIHJlb3BlbnMgdGhlIGNoaWxkJ3MgaXNzdWVzIHNvIHRoZSB3b3JrIGlzIG5vdFxuICogbGVmdCBjbG9zZWQgb24gYSBicmFuY2ggd2l0aCBubyByb3V0ZS4gQSBiYXNlIHRoYXQgaXMgbm90IGEgbWlsZXN0b25lXG4gKiBicmFuY2gsIG9yIGEgcHVsbCByZXF1ZXN0IHRoYXQgY2Fubm90IGJlIHJlYWQsIGlzIGxlZnQgdG8gdGhlIGNhbGxlci5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlc3RvcmVSb3V0ZUFmdGVyTWVyZ2VkQ2hpbGQoXG4gIG9wdGlvbnM6IHtcbiAgICByZXBvOiBzdHJpbmc7XG4gICAgcHJOdW1iZXI6IG51bWJlcjtcbiAgICBpc3N1ZU51bWJlcnM6IHJlYWRvbmx5IG51bWJlcltdO1xuICAgIGdoQ29tbWFuZEZuOiBHaENvbW1hbmRGbjtcbiAgICBsb2c/OiBMb2dTaW5rO1xuICB9LFxuKTogUHJvbWlzZTxSb3V0ZVJlc3RvcmVPdXRjb21lIHwgeyBhY3Rpb246IFwibm90LW1pbGVzdG9uZVwiIH0+IHtcbiAgY29uc3QgeyByZXBvLCBwck51bWJlciwgaXNzdWVOdW1iZXJzLCBnaENvbW1hbmRGbiwgbG9nIH0gPSBvcHRpb25zO1xuICBsZXQgYmFzZVJlZk5hbWUgPSBcIlwiO1xuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UoXG4gICAgICBhd2FpdCBnaENvbW1hbmRGbihbXG4gICAgICAgIFwicHJcIixcbiAgICAgICAgXCJ2aWV3XCIsXG4gICAgICAgIFN0cmluZyhwck51bWJlciksXG4gICAgICAgIFwiLS1yZXBvXCIsXG4gICAgICAgIHJlcG8sXG4gICAgICAgIFwiLS1qc29uXCIsXG4gICAgICAgIFwic3RhdGUsYmFzZVJlZk5hbWVcIixcbiAgICAgIF0pLFxuICAgICkgYXMgeyBzdGF0ZT86IHVua25vd247IGJhc2VSZWZOYW1lPzogdW5rbm93biB9O1xuICAgIGlmIChwYXJzZWQuc3RhdGUgIT09IFwiTUVSR0VEXCIpIHJldHVybiB7IGFjdGlvbjogXCJub3QtbWlsZXN0b25lXCIgfTtcbiAgICBiYXNlUmVmTmFtZSA9IHR5cGVvZiBwYXJzZWQuYmFzZVJlZk5hbWUgPT09IFwic3RyaW5nXCJcbiAgICAgID8gcGFyc2VkLmJhc2VSZWZOYW1lLnRyaW0oKVxuICAgICAgOiBcIlwiO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4geyBhY3Rpb246IFwibm90LW1pbGVzdG9uZVwiIH07XG4gIH1cbiAgaWYgKCFpc01pbGVzdG9uZUJyYW5jaChiYXNlUmVmTmFtZSkpIHJldHVybiB7IGFjdGlvbjogXCJub3QtbWlsZXN0b25lXCIgfTtcblxuICBjb25zdCByZXN0b3JlZCA9IGF3YWl0IHJlc3RvcmVDbG9zZWRNaWxlc3RvbmVSb3V0ZSh7XG4gICAgcmVwbyxcbiAgICBtaWxlc3RvbmVCcmFuY2g6IGJhc2VSZWZOYW1lLFxuICAgIGdoQ29tbWFuZEZuLFxuICAgIGxvZyxcbiAgfSk7XG4gIGlmIChyZXN0b3JlZC5hY3Rpb24gIT09IFwiZmFpbGVkXCIpIHJldHVybiByZXN0b3JlZDtcbiAgY29uc3Qgc3RyYW5kZWQgPSByZXN0b3JlZC5yZWFzb24uaW5jbHVkZXMoXCJjb3VsZCBub3QgY3JlYXRlIHRoZSByb2xsdXBcIik7XG4gIGNvbnN0IHJlb3BlbiA9IHN0cmFuZGVkXG4gICAgPyBhd2FpdCByZW9wZW5DbG9zZWRJc3N1ZXMocmVwbywgaXNzdWVOdW1iZXJzLCBnaENvbW1hbmRGbilcbiAgICA6IFwiXCI7XG4gIGNvbnN0IGRldGFpbCA9IHJlb3BlbiA/IGAke3Jlc3RvcmVkLnJlYXNvbn0uICR7cmVvcGVufWAgOiByZXN0b3JlZC5yZWFzb247XG4gIGxvZ0F0KFxuICAgIGxvZyxcbiAgICBcIndhcm5cIixcbiAgICBgY2hpbGQgUFIgIyR7cHJOdW1iZXJ9IG1lcmdlZCBvbnRvICR7YmFzZVJlZk5hbWV9IGluICR7cmVwb30gYnV0IG5vIHJvbGx1cCBpcyBvcGVuICgke2RldGFpbH0pIChJc3N1ZSAjNDE3NSlgLFxuICApO1xuICByZXR1cm4geyBhY3Rpb246IFwiZmFpbGVkXCIsIHJlYXNvbjogZGV0YWlsIH07XG59XG5cbi8qKlxuICogT3BlbiBhIGZyZXNoIHJvbGx1cCB3aGVuIGFuIG9wZW4gbWlsZXN0b25lJ3MgcHJldmlvdXMgcm9sbHVwIGhhcyBtZXJnZWQuXG4gKlxuICogRmFpbHMgbG91ZDogYSBsb29rdXAgb3IgY3JlYXRlIHRoYXQgZXJyb3JzIHJldHVybnMgYGZhaWxlZGAgd2l0aCB0aGVcbiAqIHJlYXNvbiwgbmV2ZXIgYSBxdWlldCBzdWNjZXNzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVzdG9yZUNsb3NlZE1pbGVzdG9uZVJvdXRlKFxuICBvcHRpb25zOiBSb3V0ZVJlc3RvcmVPcHRpb25zLFxuKTogUHJvbWlzZTxSb3V0ZVJlc3RvcmVPdXRjb21lPiB7XG4gIGNvbnN0IHsgcmVwbywgbWlsZXN0b25lQnJhbmNoLCBnaENvbW1hbmRGbiwgbG9nIH0gPSBvcHRpb25zO1xuICBpZiAoIWlzTWlsZXN0b25lQnJhbmNoKG1pbGVzdG9uZUJyYW5jaCkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgYWN0aW9uOiBcIm5vdC1jbG9zZWRcIixcbiAgICAgIG1pbGVzdG9uZUJyYW5jaCxcbiAgICB9O1xuICB9XG4gIGlmICghUkVQT19QQVRURVJOLnRlc3QocmVwbykgfHwgIUJSQU5DSF9QQVRURVJOLnRlc3QobWlsZXN0b25lQnJhbmNoKSkge1xuICAgIHJldHVybiB7XG4gICAgICBhY3Rpb246IFwiZmFpbGVkXCIsXG4gICAgICByZWFzb246IFwicmVwbyBvciBicmFuY2ggbmFtZSBmYWlsZWQgdGhlIGFyZ3VtZW50IGFsbG93bGlzdFwiLFxuICAgIH07XG4gIH1cblxuICBsZXQgcHJzOiBSYXdSb2xsdXBQcltdO1xuICB0cnkge1xuICAgIHBycyA9IGF3YWl0IGxpc3RIZWFkUHVsbFJlcXVlc3RzKHJlcG8sIG1pbGVzdG9uZUJyYW5jaCwgZ2hDb21tYW5kRm4pO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgYWN0aW9uOiBcImZhaWxlZFwiLFxuICAgICAgcmVhc29uOiBgY291bGQgbm90IGxpc3Qgcm9sbHVwIFBScyBmb3IgJHttaWxlc3RvbmVCcmFuY2h9OiAke1xuICAgICAgICBlcnJvclRleHQoZXJyKVxuICAgICAgfWAsXG4gICAgfTtcbiAgfVxuICBjb25zdCBvcGVuID0gcHJzLmZpbmQoaXNPcGVuUm91dGUpO1xuICBpZiAob3Blbikge1xuICAgIHJldHVybiB7XG4gICAgICBhY3Rpb246IFwiZXhpc3RzXCIsXG4gICAgICBwck51bWJlcjogb3Blbi5udW1iZXIsXG4gICAgICBtaWxlc3RvbmVCcmFuY2gsXG4gICAgfTtcbiAgfVxuICBjb25zdCBtZXJnZWQgPSBtZXJnZWRSb2xsdXAocHJzKTtcbiAgaWYgKCFtZXJnZWQgfHwgdHlwZW9mIG1lcmdlZC5udW1iZXIgIT09IFwibnVtYmVyXCIpIHtcbiAgICByZXR1cm4geyBhY3Rpb246IFwibm90LWNsb3NlZFwiLCBtaWxlc3RvbmVCcmFuY2ggfTtcbiAgfVxuXG4gIGxldCBtaWxlc3RvbmU6IE1pbGVzdG9uZU1hdGNoIHwgbnVsbDtcbiAgdHJ5IHtcbiAgICBtaWxlc3RvbmUgPSBhd2FpdCBmaW5kTWlsZXN0b25lKHJlcG8sIG1pbGVzdG9uZUJyYW5jaCwgZ2hDb21tYW5kRm4pO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgYWN0aW9uOiBcImZhaWxlZFwiLFxuICAgICAgcmVhc29uOiBgY291bGQgbm90IHJlYWQgbWlsZXN0b25lcyBmb3IgJHttaWxlc3RvbmVCcmFuY2h9OiAke1xuICAgICAgICBlcnJvclRleHQoZXJyKVxuICAgICAgfWAsXG4gICAgfTtcbiAgfVxuICBpZiAoIW1pbGVzdG9uZSB8fCBtaWxlc3RvbmUuc3RhdGUudG9Mb3dlckNhc2UoKSAhPT0gXCJvcGVuXCIpIHtcbiAgICBjb25zdCB3aHkgPSBtaWxlc3RvbmVcbiAgICAgID8gYG1pbGVzdG9uZSBcIiR7bWlsZXN0b25lLnRpdGxlfVwiIGlzIGNsb3NlZGBcbiAgICAgIDogYG5vIG9wZW4gbWlsZXN0b25lIG1hdGNoZXMgJHttaWxlc3RvbmVCcmFuY2h9YDtcbiAgICByZXR1cm4ge1xuICAgICAgYWN0aW9uOiBcImxlZnQtY2xvc2VkXCIsXG4gICAgICBtaWxlc3RvbmVCcmFuY2gsXG4gICAgICBkZXRhaWw6IGByb2xsdXAgUFIgIyR7bWVyZ2VkLm51bWJlcn0gaGFzIG1lcmdlZCBhbmQgJHt3aHl9YCxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgY2hpbGRyZW4gPSBhd2FpdCBmZXRjaE9wZW5NaWxlc3RvbmVDaGlsZHJlbih7XG4gICAgcmVwbyxcbiAgICBtaWxlc3RvbmVOdW1iZXI6IG1pbGVzdG9uZS5udW1iZXIsXG4gICAgbWlsZXN0b25lQnJhbmNoLFxuICAgIGdoQ29tbWFuZEZuLFxuICB9KTtcbiAgaWYgKCFjaGlsZHJlbi5vaykge1xuICAgIHJldHVybiB7XG4gICAgICBhY3Rpb246IFwiZmFpbGVkXCIsXG4gICAgICByZWFzb246IGNoaWxkcmVuLmVycm9yLm1lc3NhZ2UsXG4gICAgfTtcbiAgfVxuICBsZXQgZGVmYXVsdEJyYW5jaCA9IG9wdGlvbnMuZGVmYXVsdEJyYW5jaD8udHJpbSgpO1xuICBpZiAoIWRlZmF1bHRCcmFuY2gpIHtcbiAgICBjb25zdCByZXNvbHZlZCA9IGF3YWl0IChvcHRpb25zLmdldERlZmF1bHRCcmFuY2hGbiA/P1xuICAgICAgKChuYW1lOiBzdHJpbmcpID0+IGdldFJlcG9EZWZhdWx0QnJhbmNoKG5hbWUsIGdoQ29tbWFuZEZuKSkpKHJlcG8pO1xuICAgIGlmICghcmVzb2x2ZWQub2spIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGFjdGlvbjogXCJmYWlsZWRcIixcbiAgICAgICAgcmVhc29uOiBgZGVmYXVsdCBicmFuY2ggdW5rbm93bjogJHtyZXNvbHZlZC5lcnJvci5tZXNzYWdlfWAsXG4gICAgICB9O1xuICAgIH1cbiAgICBkZWZhdWx0QnJhbmNoID0gcmVzb2x2ZWQudmFsdWUudHJpbSgpO1xuICB9XG4gIGlmICghZGVmYXVsdEJyYW5jaCB8fCAhQlJBTkNIX1BBVFRFUk4udGVzdChkZWZhdWx0QnJhbmNoKSkge1xuICAgIHJldHVybiB7XG4gICAgICBhY3Rpb246IFwiZmFpbGVkXCIsXG4gICAgICByZWFzb246IFwiZGVmYXVsdCBicmFuY2ggZmFpbGVkIHRoZSBhcmd1bWVudCBhbGxvd2xpc3RcIixcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgY29tcGFyZSA9IGF3YWl0IHJlYWRCcmFuY2hDb21wYXJlKFxuICAgIHJlcG8sXG4gICAgZGVmYXVsdEJyYW5jaCxcbiAgICBtaWxlc3RvbmVCcmFuY2gsXG4gICAgZ2hDb21tYW5kRm4sXG4gICk7XG4gIGlmICghY29tcGFyZS5vaykge1xuICAgIHJldHVybiB7IGFjdGlvbjogXCJmYWlsZWRcIiwgcmVhc29uOiBjb21wYXJlLmVycm9yLm1lc3NhZ2UgfTtcbiAgfVxuICBjb25zdCB7IGFoZWFkQnksIGZpbGVDb3VudCB9ID0gY29tcGFyZS52YWx1ZTtcbiAgaWYgKGNoaWxkcmVuLnZhbHVlLmxlbmd0aCA9PT0gMCAmJiBhaGVhZEJ5ID4gMCkge1xuICAgIC8vIElzc3VlICM0NTE0OiBhIHNxdWFzaC1tZXJnZWQgcm9sbHVwIGxlYXZlcyB0aGUgdGhyZWUtZG90IGNvbXBhcmVcbiAgICAvLyBub24tZW1wdHksIHNvIGFzayB3aGV0aGVyIHRoZSBicmFuY2ggaGVhZCBpcyB0aGUgb25lIHRoYXQgbWVyZ2VkLlxuICAgIGNvbnN0IGhlYWRNZXJnZWQgPSBhd2FpdCBpc01pbGVzdG9uZUhlYWRBbHJlYWR5TWVyZ2VkKHtcbiAgICAgIHJlcG8sXG4gICAgICBtaWxlc3RvbmVCcmFuY2gsXG4gICAgICBkZWZhdWx0QnJhbmNoLFxuICAgICAgZ2hDb21tYW5kRm4sXG4gICAgICBwcnMsXG4gICAgfSk7XG4gICAgaWYgKCFoZWFkTWVyZ2VkLm9rKSB7XG4gICAgICByZXR1cm4geyBhY3Rpb246IFwiZmFpbGVkXCIsIHJlYXNvbjogaGVhZE1lcmdlZC5lcnJvci5tZXNzYWdlIH07XG4gICAgfVxuICAgIGlmIChoZWFkTWVyZ2VkLnZhbHVlKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBhY3Rpb246IFwibGVmdC1jbG9zZWRcIixcbiAgICAgICAgbWlsZXN0b25lQnJhbmNoLFxuICAgICAgICBkZXRhaWw6XG4gICAgICAgICAgYHJvbGx1cCBQUiAjJHttZXJnZWQubnVtYmVyfSBoYXMgbWVyZ2VkIGFuZCAke21pbGVzdG9uZUJyYW5jaH0gaGFzIG5vdCBtb3ZlZCBzaW5jZSwgc28gdGhlcmUgaXMgbm90aGluZyBuZXcgdG8gY2FycnkgdG8gJHtkZWZhdWx0QnJhbmNofWAsXG4gICAgICB9O1xuICAgIH1cbiAgfVxuICAvLyBObyBjb21taXRzIHRvIGNhcnJ5LiBPcGVuIHdvcmsgd2FpdHM7IGEgbWlsZXN0b25lIHdpdGggbm90aGluZyBvcGVuXG4gIC8vIHN0YXlzIGNsb3NlZC4gQW4gZW1wdHkgZmlsZSBsaXN0IHdpdGggY29tbWl0cyBzdGlsbCBhaGVhZCBpcyB3b3JrIHRoZVxuICAvLyBkZWZhdWx0IGJyYW5jaCBhbHJlYWR5IGhhcywgbm90IGEgbmV3IHJvbGx1cC4gQSBzcXVhc2ggbGVhdmVzIHRoZSBsaXN0XG4gIC8vIG5vbi1lbXB0eSwgc28gdGhlIGhlYWQgY2hlY2sgYWJvdmUgaXMgd2hhdCBjYXRjaGVzIHRoYXQgKElzc3VlICM0NTE0KS5cbiAgaWYgKGFoZWFkQnkgPD0gMCB8fCAoY2hpbGRyZW4udmFsdWUubGVuZ3RoID09PSAwICYmIGZpbGVDb3VudCA9PT0gMCkpIHtcbiAgICBpZiAoY2hpbGRyZW4udmFsdWUubGVuZ3RoID09PSAwKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBhY3Rpb246IFwibGVmdC1jbG9zZWRcIixcbiAgICAgICAgbWlsZXN0b25lQnJhbmNoLFxuICAgICAgICBkZXRhaWw6IGFoZWFkQnkgPD0gMFxuICAgICAgICAgID8gYHJvbGx1cCBQUiAjJHttZXJnZWQubnVtYmVyfSBoYXMgbWVyZ2VkIGFuZCBtaWxlc3RvbmUgXCIke21pbGVzdG9uZS50aXRsZX1cIiBoYXMgbm8gb3BlbiB3b3JrYFxuICAgICAgICAgIDogYHJvbGx1cCBQUiAjJHttZXJnZWQubnVtYmVyfSBoYXMgbWVyZ2VkIGFuZCAke21pbGVzdG9uZUJyYW5jaH0gaGFzIG5vIGZpbGUgY2hhbmdlcyAke2RlZmF1bHRCcmFuY2h9IGRvZXMgbm90IGFscmVhZHkgaGF2ZWAsXG4gICAgICB9O1xuICAgIH1cbiAgICBpZiAob3B0aW9ucy5sYW5kQ2hpbGRQck51bWJlciAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBhY3Rpb246IFwibWVyZ2UtdmlhLWdhdGVcIixcbiAgICAgICAgbWlsZXN0b25lQnJhbmNoLFxuICAgICAgICBkZWZhdWx0QnJhbmNoLFxuICAgICAgICBpc3N1ZU51bWJlcnM6IGNoaWxkcmVuLnZhbHVlXG4gICAgICAgICAgLmZpbHRlcigoY2hpbGQpID0+IGNoaWxkLmtpbmQgPT09IFwiaXNzdWVcIilcbiAgICAgICAgICAubWFwKChjaGlsZCkgPT4gY2hpbGQubnVtYmVyKSxcbiAgICAgIH07XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBhY3Rpb246IFwid2FpdGluZ1wiLFxuICAgICAgbWlsZXN0b25lQnJhbmNoLFxuICAgICAgZGV0YWlsOlxuICAgICAgICBgJHttaWxlc3RvbmVCcmFuY2h9IGlzIG5vdCBhaGVhZCBvZiAke2RlZmF1bHRCcmFuY2h9LCBzbyBubyByb2xsdXAgaXMgb3BlbiB5ZXRgLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBvcGVuZWQgPSBhd2FpdCBvcGVuRnJlc2hSb2xsdXAoXG4gICAgcmVwbyxcbiAgICBtaWxlc3RvbmVCcmFuY2gsXG4gICAgZGVmYXVsdEJyYW5jaCxcbiAgICBhaGVhZEJ5LFxuICAgIGNoaWxkcmVuLnZhbHVlLmxlbmd0aCA+IDAsXG4gICAgZ2hDb21tYW5kRm4sXG4gICk7XG4gIGlmICghb3BlbmVkLm9rKSB7XG4gICAgcmV0dXJuIHsgYWN0aW9uOiBcImZhaWxlZFwiLCByZWFzb246IG9wZW5lZC5yZWFzb24gfTtcbiAgfVxuICBjb25zdCBjYXJyaWVkID0gY2hpbGRyZW4udmFsdWUubGVuZ3RoID4gMFxuICAgID8gXCJ3aGlsZSB0aGUgbWlsZXN0b25lIHN0aWxsIGhhcyBvcGVuIHdvcmtcIlxuICAgIDogXCJ3aGlsZSB0aGUgYnJhbmNoIHN0aWxsIGhhcyBjaGFuZ2VzIHRoZSBkZWZhdWx0IGJyYW5jaCBkb2VzIG5vdFwiO1xuICBsb2dBdChcbiAgICBsb2csXG4gICAgXCJpbmZvXCIsXG4gICAgYG9wZW5lZCBhIGZyZXNoIHJvbGx1cCBmb3IgJHttaWxlc3RvbmVCcmFuY2h9IGluICR7cmVwb30gYWZ0ZXIgcm9sbHVwIFBSICMke21lcmdlZC5udW1iZXJ9IG1lcmdlZCAke2NhcnJpZWR9IChJc3N1ZSAjNDE3NSk6ICR7b3BlbmVkLnByVXJsfWAsXG4gICk7XG4gIHJldHVybiB7IGFjdGlvbjogXCJjcmVhdGVkXCIsIHByVXJsOiBvcGVuZWQucHJVcmwsIG1pbGVzdG9uZUJyYW5jaCB9O1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7OztDQWNDLEdBR0QsU0FBUyx5QkFBeUIsUUFBUSxrQkFBa0I7QUFDNUQsU0FBUyxtQkFBbUIsUUFBUSx3QkFBd0I7QUFDNUQsU0FBUyxLQUFLLFFBQXNCLGdCQUFnQjtBQUNwRCxTQUNFLDBCQUEwQixFQUMxQixpQkFBaUIsUUFDWiwrQkFBK0I7QUFDdEMsU0FBUyxvQkFBb0Is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
// denoCacheMetadata=8822704665201067849,2746774972844152816