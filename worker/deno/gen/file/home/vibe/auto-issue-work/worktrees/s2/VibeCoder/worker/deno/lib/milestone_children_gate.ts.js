/**
 * Milestone open-children gate (Issue #3909).
 *
 * Merging a milestone summary PR is the irreversible step of the milestone
 * flow: `stSoftwareAU/VibeCoder` has `delete_branch_on_merge: true`, so the
 * merge deletes the milestone branch, and GitHub auto-closes every PR based on
 * it. Milestone 53 lost in-flight child PR #3901 exactly that way.
 *
 * A completeness check made when the summary PR is *created* is not enough —
 * children can appear (or simply remain) in the window between creation and
 * merge. This module re-reads GitHub's authoritative open-children set
 * immediately before the worker merges the summary PR, and before the
 * completion path closes the tracking issue or the GitHub milestone.
 *
 * "Open children" deliberately spans both shapes that the incident involved:
 *   1. open non-tracking issues assigned to the milestone, and
 *   2. open PRs whose *base* is the milestone branch — the in-flight child PRs
 *      the branch deletion would auto-close, which are typically not assigned
 *      to the milestone at all.
 *
 * Reads are uncached on purpose (time-of-check/time-of-use): the whole point
 * is to see state as it is at merge time, not as an earlier scan cached it.
 *
 * Follows the `idle_task_merge_gate.ts` precedent: pure decision function,
 * injected `gh` runner, no side effects until the caller asks for them.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */ import { parseAuthoredCommentRows, resolveAlertDedupAuthors, selectFleetAuthoredComments } from "./alert_dedup_authors.ts";
import { abandonAndRestart } from "./conflict_abandon_restart.ts";
import { disarmAutoMerge } from "./auto_merge_disarm.ts";
import { isMilestoneBranch } from "./milestone_branch_names.ts";
import { createMilestoneBranchName } from "./git_branch.ts";
import { partitionMilestoneTrackers } from "./milestone_tracker_identity.ts";
import { isMilestoneSyncBranch } from "./milestone_sync_pr.ts";
import { parseJsonArrayPages } from "./json_array_pages.ts";
import { inertCodeSpan } from "./ci_human_gate_comment.ts";
import { scrubUntrustedText } from "./prompt_delimiter.ts";
import { getRepoDefaultBranch } from "./shell_helpers.ts";
// Issue #3014: layer the declared-dependency hold onto this gate.
import { describePendingDependency, findPendingMilestoneDependencies, PENDING_DEPENDENCIES_BLOCK_MARKER, renderPendingDependenciesBlockComment } from "./milestone_dependency_hold.ts";
import { logAt } from "./log_sink.ts";
/**
 * Hidden marker on the explanatory comment. Its presence is what makes the
 * block comment idempotent — repeated scan cycles must not spam the PR.
 */ export const OPEN_CHILDREN_BLOCK_MARKER = "<!-- milestone-open-children-merge-block -->";
/** Repo must be exactly `owner/repo` before it reaches an API path. */ const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** Conservative branch-name allowlist for values interpolated into gh args. */ const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;
export { isMilestoneBranch };
/**
 * Read the milestone's open children straight from GitHub — no cache.
 *
 * Milestone-tracking issues (`Merge milestone '…' to …`) are excluded: the
 * tracker lives inside the milestone it tracks, so counting it would make
 * every milestone permanently incomplete (the Issue #3214 deadlock).
 *
 * @returns The open children, or an error when the state could not be read.
 */ export async function fetchOpenMilestoneChildren(options) {
  const { repo, milestoneNumber, milestoneBranch, ghCommandFn } = options;
  if (!REPO_PATTERN.test(repo)) {
    return {
      ok: false,
      error: new Error(`Invalid repo: ${repo}`)
    };
  }
  if (!Number.isInteger(milestoneNumber) || milestoneNumber <= 0) {
    return {
      ok: false,
      error: new Error(`Invalid milestone number: ${milestoneNumber}`)
    };
  }
  if (milestoneBranch !== undefined && !BRANCH_PATTERN.test(milestoneBranch)) {
    return {
      ok: false,
      error: new Error(`Invalid milestone branch: ${milestoneBranch}`)
    };
  }
  const excluded = new Set(options.excludePrNumbers ?? []);
  const children = new Map();
  // 1. Open issues (and milestone-assigned PRs) attached to the milestone.
  try {
    const raw = await ghCommandFn([
      "api",
      "--paginate",
      `repos/${repo}/issues?milestone=${milestoneNumber}&state=open&per_page=100`
    ]);
    // Issue #1246: excluding a child here is what allows the merge that
    // deletes the milestone branch, so only a tracker carrying the
    // tracking-issue body marker and opened by a fleet account is excluded.
    // A tracking-shaped child that cannot be verified keeps blocking.
    const { others } = await partitionMilestoneTrackers(parseIssueArray(raw).map((item)=>({
        number: item.number,
        title: item.title,
        body: item.body ?? "",
        author: item.author ?? "",
        pull_request: item.pull_request
      })), `merge gate for milestone #${milestoneNumber} in ${repo}`, {
      ...options.verification,
      unverifiedOutcome: "the candidate keeps blocking the summary-PR merge, so the " + "milestone branch is not deleted"
    });
    for (const item of others){
      if (excluded.has(item.number)) continue;
      children.set(item.number, {
        number: item.number,
        title: item.title,
        kind: item.pull_request ? "pr" : "issue"
      });
    }
  } catch (err) {
    return {
      ok: false,
      error: new Error(`Failed to read open children of milestone #${milestoneNumber} in ` + `${repo}: ${err instanceof Error ? err.message : String(err)}`)
    };
  }
  // 2. Open PRs targeting the milestone branch. These are the in-flight
  //    children a branch deletion auto-closes, and they are usually not
  //    assigned to the milestone — so query them separately.
  if (milestoneBranch !== undefined) {
    try {
      const raw = await ghCommandFn([
        "pr",
        "list",
        "--repo",
        repo,
        "--base",
        milestoneBranch,
        "--state",
        "open",
        "--json",
        "number,title",
        "--limit",
        "100"
      ]);
      for (const item of parseIssueArray(raw)){
        if (excluded.has(item.number)) continue;
        children.set(item.number, {
          number: item.number,
          title: item.title,
          kind: "pr"
        });
      }
    } catch (err) {
      return {
        ok: false,
        error: new Error(`Failed to read open PRs targeting ${milestoneBranch} in ${repo}: ` + `${err instanceof Error ? err.message : String(err)}`)
      };
    }
  }
  return {
    ok: true,
    value: [
      ...children.values()
    ].sort((a, b)=>a.number - b.number)
  };
}
/**
 * Parse a `gh` JSON array response into issue-shaped records.
 *
 * `gh api --paginate` concatenates pages as separate top-level JSON arrays
 * with no guaranteed separator, so pages are parsed with a string-aware scan
 * rather than a `][`-boundary regex (Issue #2895). A malformed payload
 * throws — an unreadable response must never be reported as "no children".
 */ function parseIssueArray(raw) {
  const out = [];
  for (const item of parseJsonArrayPages(raw)){
    const record = item;
    if (typeof record?.number === "number") {
      out.push({
        number: record.number,
        title: typeof record.title === "string" ? record.title : "",
        pull_request: record.pull_request,
        body: typeof record.body === "string" ? record.body : "",
        author: typeof record.user?.login === "string" ? record.user.login : ""
      });
    }
  }
  return out;
}
/**
 * Decide whether the worker may auto-merge this PR.
 *
 * Cheap by design: a PR whose head is not a `milestone/*` branch is allowed
 * after at most one lookup, so the gate costs nothing on ordinary fix PRs.
 *
 * Failure handling is deliberately asymmetric. While the PR is still
 * *unidentified* (head ref or milestone list unreadable) the gate allows the
 * merge — blocking every PR on a transient `gh` hiccup would be worse than the
 * risk it removes. Once the PR is known to be a milestone summary PR, any
 * failure to read the children blocks: the merge is irreversible, so an
 * unverifiable state is not a licence to proceed.
 *
 * Once the open-children set is empty, the gate also checks every member
 * issue's declared "Depends on #N" references (Issue #3014) — a milestone can
 * have zero open children yet still assemble a sub-issue whose declared
 * dependency has not actually landed on the target branch.
 */ export async function decideSummaryPrMerge(options) {
  const { repo, prNumber, ghCommandFn } = options;
  const headRefName = options.headRefName ?? await resolveHeadRef(repo, prNumber, ghCommandFn);
  if (headRefName === null) {
    return {
      decision: "allow",
      reason: "head-unknown"
    };
  }
  if (!isMilestoneBranch(headRefName)) {
    return {
      decision: "allow",
      reason: "not-milestone-pr"
    };
  }
  const milestone = await findMilestoneForBranch(repo, headRefName, ghCommandFn);
  if (milestone === null) {
    return {
      decision: "allow",
      reason: "milestone-not-found"
    };
  }
  const childrenResult = await fetchOpenMilestoneChildren({
    repo,
    milestoneNumber: milestone.number,
    milestoneBranch: headRefName,
    excludePrNumbers: [
      prNumber
    ],
    ...options.verification !== undefined ? {
      verification: options.verification
    } : {},
    ghCommandFn
  });
  if (!childrenResult.ok) {
    return {
      decision: "block",
      reason: "lookup-failed",
      stage: "open-children",
      milestoneNumber: milestone.number,
      milestoneTitle: milestone.title,
      milestoneBranch: headRefName,
      message: childrenResult.error.message
    };
  }
  if (childrenResult.value.length > 0) {
    return {
      decision: "block",
      reason: "open-children",
      milestoneNumber: milestone.number,
      milestoneTitle: milestone.title,
      milestoneBranch: headRefName,
      children: childrenResult.value
    };
  }
  // Issue #3014: no open children, but a member issue may still declare a
  // dependency that has not landed on the target branch.
  const dependenciesResult = await findPendingMilestoneDependencies({
    repo,
    milestoneNumber: milestone.number,
    ghCommandFn
  });
  if (!dependenciesResult.ok) {
    return {
      decision: "block",
      reason: "lookup-failed",
      stage: "declared-dependencies",
      milestoneNumber: milestone.number,
      milestoneTitle: milestone.title,
      milestoneBranch: headRefName,
      message: dependenciesResult.error.message
    };
  }
  if (dependenciesResult.value.length > 0) {
    return {
      decision: "block",
      reason: "pending-dependencies",
      milestoneNumber: milestone.number,
      milestoneTitle: milestone.title,
      milestoneBranch: headRefName,
      dependencies: dependenciesResult.value
    };
  }
  return {
    decision: "allow",
    reason: "no-open-children"
  };
}
/** Read a PR's head branch. Returns null when it cannot be determined. */ async function resolveHeadRef(repo, prNumber, ghCommandFn) {
  if (!REPO_PATTERN.test(repo)) return null;
  try {
    const raw = await ghCommandFn([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "headRefName"
    ]);
    const parsed = JSON.parse(raw);
    return typeof parsed.headRefName === "string" && parsed.headRefName !== "" ? parsed.headRefName : null;
  } catch  {
    return null;
  }
}
/**
 * Find the open milestone whose branch name is `branch`.
 *
 * The mapping is the same one that created the branch
 * ({@link createMilestoneBranchName}), so no extra metadata is needed.
 */ async function findMilestoneForBranch(repo, branch, ghCommandFn) {
  try {
    const raw = await ghCommandFn([
      "api",
      "--paginate",
      `repos/${repo}/milestones?state=open&per_page=100`
    ]);
    const milestones = parseIssueArray(raw);
    for (const milestone of milestones){
      if (typeof milestone.title !== "string") continue;
      if (createMilestoneBranchName(milestone.title) === branch) {
        return {
          number: milestone.number,
          title: milestone.title
        };
      }
    }
    return null;
  } catch  {
    return null;
  }
}
// ---------------------------------------------------------------------------
// Explanatory comment
// ---------------------------------------------------------------------------
/**
 * Render the comment posted on a summary PR whose merge was blocked.
 *
 * Exported so tests can assert against it directly.
 */ export function renderOpenChildrenBlockComment(milestoneTitle, children) {
  // Child titles are attacker-writable GitHub text quoted into a public
  // comment the worker signs, so they are scrubbed before interpolation
  // (Issue #1249, finding 8) — an unscrubbed `<!-- … -->` marker in a title
  // lands in this body and is read back as a genuine marker on a later scan.
  const list = children.map((child)=>`- #${child.number} (${child.kind}): ${scrubUntrustedText(child.title)}`).join("\n");
  return [
    OPEN_CHILDREN_BLOCK_MARKER,
    `## Auto-merge blocked — milestone '${scrubUntrustedText(milestoneTitle)}' still has open children`,
    "",
    "Merging this PR deletes the milestone branch (`delete_branch_on_merge` " + "is on for this repository), and deleting a base branch auto-closes " + "every PR based on it. The following children are still open, so the " + "worker has not merged this PR (Issue #3909):",
    "",
    list,
    "",
    "This PR has been left open. Close or merge the children above and the " + "worker will merge it on a later scan — or merge it by hand if you have " + "decided the milestone is finished."
  ].join("\n");
}
/**
 * Whether the **fleet** has already left `marker` on this PR (Issue #1249,
 * finding 3).
 *
 * Both explanatory comments on this path are deduplicated by their marker, and
 * a PR thread is open to anybody, so a stranger quoting the marker suppressed
 * the public explanation of why a merge was refused or a base rewritten. The
 * gate itself still ran — what went missing was the reason, which is the part
 * a human reads. Only the comment author is authenticated, so the read carries
 * `.user.login` and every match is filtered through
 * {@link selectFleetAuthoredComments}.
 *
 * Fail direction is **towards posting**: an unreadable thread or an
 * unresolvable fleet identity means no match can be attributed, so the comment
 * goes out. A duplicate explanation is noise a reader scrolls past; a missing
 * one is a silent refusal.
 *
 * @returns true when a fleet-authored comment already carries the marker.
 */ export async function hasFleetAuthoredMarker(repo, prNumber, marker, ghCommandFn, authorOptions, log) {
  const raw = await ghCommandFn([
    "api",
    "--paginate",
    `repos/${repo}/issues/${prNumber}/comments?per_page=100`,
    "--jq",
    "[.[] | {author: .user.login, body: .body}]"
  ]);
  // An unparseable payload yields no rows, which cannot establish that the
  // marker is present — the comment goes out.
  const rows = parseAuthoredCommentRows(raw, "body").filter((row)=>row.value.includes(marker));
  const fleetRows = await selectFleetAuthoredComments(rows, `milestone gate marker ${marker} on ${repo}#${prNumber}`, authorOptions, log, "the explanatory comment is posted — a marker anyone can quote must not " + "suppress the reason a merge was refused");
  return fleetRows.length > 0;
}
/**
 * Post the explanatory comment on the blocked summary PR — exactly once.
 *
 * Idempotency comes from {@link OPEN_CHILDREN_BLOCK_MARKER}: the existing
 * comments are read first and nothing is posted when the marker is already
 * there, so a repeating scan cycle does not spam the thread. When the existing
 * comments cannot be read, nothing is posted (a duplicate comment every cycle
 * would be worse than none) and the failure is logged.
 *
 * @returns which of the three states the PR thread ended in
 */ export async function postOpenChildrenBlockComment(options) {
  const body = renderOpenChildrenBlockComment(options.milestoneTitle, options.children);
  return await postMarkerDedupedBlockComment(options, OPEN_CHILDREN_BLOCK_MARKER, body, "milestone open-children", "Issue #3909");
}
/**
 * Shared idempotent comment poster (Issue #3014): read the thread for a
 * fleet-authored `marker`, post `body` only when it is absent. Factored out
 * of {@link postOpenChildrenBlockComment} so the declared-dependency hold's
 * comment can reuse the same de-duplication behaviour.
 */ async function postMarkerDedupedBlockComment(options, marker, body, description, issueRef) {
  const { repo, prNumber, ghCommandFn, log } = options;
  let alreadyPosted;
  try {
    alreadyPosted = await hasFleetAuthoredMarker(repo, prNumber, marker, ghCommandFn, options.authorOptions ?? {}, log);
  } catch (err) {
    logAt(log, "warn", `could not read comments on ${repo}#${prNumber} to de-duplicate ` + `the ${description} block comment: ` + `${err instanceof Error ? err.message : String(err)} (${issueRef})`);
    return "unconfirmed";
  }
  if (alreadyPosted) {
    return "already-present";
  }
  try {
    await ghCommandFn([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      body
    ]);
    return "posted";
  } catch (err) {
    logAt(log, "warn", `failed to post the ${description} block comment on ` + `${repo}#${prNumber}: ` + `${err instanceof Error ? err.message : String(err)} (${issueRef})`);
    return "unconfirmed";
  }
}
/**
 * Post the declared-dependency explanatory comment on the held summary PR —
 * exactly once, deduplicated by {@link PENDING_DEPENDENCIES_BLOCK_MARKER}
 * (Issue #3014). Mirrors {@link postOpenChildrenBlockComment}.
 *
 * @returns which of the three states the PR thread ended in
 */ export async function postPendingDependenciesBlockComment(options) {
  const body = renderPendingDependenciesBlockComment(options.milestoneTitle, [
    ...options.dependencies
  ]);
  return await postMarkerDedupedBlockComment(options, PENDING_DEPENDENCIES_BLOCK_MARKER, body, "milestone pending-dependencies", "Issue #3014");
}
/**
 * Render the log line for a blocked merge (scope item 3). Waiting on open
 * children is the normal state of a summary PR, so it carries no level
 * prefix; the caller logs it once, at INFO (Issue #4063).
 */ export function renderBlockWarning(repo, prNumber, milestoneNumber, milestoneTitle, children) {
  const numbers = children.map((c)=>`#${c.number}`).join(", ");
  return `refusing to auto-merge milestone summary PR ${repo}#${prNumber} ` + `for milestone #${milestoneNumber} '${milestoneTitle}' — ` + `${children.length} open child/children remain: ${numbers} (Issue #3909)`;
}
/**
 * Render the log line for a merge blocked on pending dependencies (Issue
 * #3014). A normal wait: no level prefix, logged once at INFO (Issue #4063).
 */ export function renderPendingDependenciesWarning(repo, prNumber, milestoneNumber, milestoneTitle, dependencies) {
  const descriptions = dependencies.map((dep)=>describePendingDependency(dep)).join("; ");
  return `refusing to auto-merge milestone summary PR ${repo}#${prNumber} ` + `for milestone #${milestoneNumber} '${scrubUntrustedText(milestoneTitle)}' — declared dependencies are not merged yet: ${descriptions} (Issue #3014)`;
}
/**
 * How long one milestone-vs-default compare is reused (Issue #1779).
 *
 * Long enough that the N children of one milestone in a single priority 1.65
 * sweep cost one API call, short enough that the next cycle's milestone sync
 * (Issue #1776) is seen rather than a stale "behind" holding the children
 * for the life of the process.
 */ export const MILESTONE_BEHIND_MEMO_TTL_MS = 60_000;
const behindMemo = new Map();
/** Clear the milestone-behind compare memo (tests). */ export function _resetMilestoneBehindMemo() {
  behindMemo.clear();
}
/**
 * Drop the cached compare for one milestone branch (Issue #2005).
 *
 * An in-cycle sync that just landed would otherwise be hidden by the 60 s
 * memo, and the re-arm would still see the stale "behind" reading.
 */ export function invalidateMilestoneBehindMemoForBranch(repo, milestoneBranch) {
  const prefix = `${repo}#`;
  const suffix = `...${milestoneBranch}`;
  for (const key of behindMemo.keys()){
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      behindMemo.delete(key);
    }
  }
}
/**
 * Commits `head` is behind `base`, read without any cache (Issue #3596).
 *
 * Never throws: an unreadable or empty answer comes back as `ok: false`.
 */ export async function readCompareBehindBy(repo, base, head, ghCommandFn) {
  try {
    const raw = await ghCommandFn([
      "api",
      `repos/${repo}/compare/${base}...${head}`,
      "--jq",
      ".behind_by"
    ]);
    // `Number("")` is 0, so an empty answer must be rejected BEFORE the
    // conversion: read as "level with the default branch" it would arm the
    // very merge this gate exists to refuse.
    const text = raw.trim();
    const behindBy = text.length > 0 ? Number(text) : Number.NaN;
    return Number.isFinite(behindBy) ? {
      ok: true,
      behindBy
    } : {
      ok: false,
      detail: `compare ${base}...${head} returned no behind_by`
    };
  } catch (err) {
    return {
      ok: false,
      detail: `could not compare ${base}...${head}: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}
/**
 * Commits `milestoneBranch` is behind `defaultBranch`, memoised per
 * (repo, default branch, milestone branch) for {@link MILESTONE_BEHIND_MEMO_TTL_MS}.
 *
 * Orientation matters and has been got wrong here before (Issue #470): in
 * `compare/{base}...{head}` the response describes the HEAD relative to the
 * base, so the milestone branch must be the head for `behind_by` to mean
 * "behind the default branch". Written the other way round the call still
 * succeeds and returns the ahead count instead — every healthy milestone
 * branch would then read as behind.
 */ async function readMilestoneBehindBy(repo, milestoneBranch, defaultBranch, ghCommandFn, nowMs) {
  const key = `${repo}#${defaultBranch}...${milestoneBranch}`;
  const now = nowMs();
  const memo = behindMemo.get(key);
  if (memo && now - memo.readAtMs < MILESTONE_BEHIND_MEMO_TTL_MS) {
    return memo.reading;
  }
  const reading = await readCompareBehindBy(repo, defaultBranch, milestoneBranch, ghCommandFn);
  behindMemo.set(key, {
    readAtMs: now,
    reading
  });
  return reading;
}
/**
 * `defer/milestone-behind` when the milestone branch is behind the default
 * branch, `defer/lookup-failed` when the comparison cannot be read, and
 * `null` when the branch is level and the merge may proceed (Issue #1779).
 */ async function deferWhenMilestoneBehind(options, milestoneBranch) {
  const { repo, prNumber, ghCommandFn } = options;
  // The milestone sync PR is the thing that *clears* "behind": its base is
  // the milestone branch and its head is `sync/milestone-*`. Deferring it
  // for the very state it exists to fix would deadlock the milestone — the
  // sync could never land, so the branch could never catch up, so no child
  // could ever merge. It is exempt, and costs no compare call.
  const headRefName = options.headRefName ?? await resolveHeadRef(repo, prNumber, ghCommandFn);
  if (headRefName === null) {
    return {
      decision: "defer",
      reason: "lookup-failed",
      milestoneBranch,
      detail: `could not read the head branch of ${repo}#${prNumber}, so the sync PR ` + `could not be told from a child`
    };
  }
  if (isMilestoneSyncBranch(headRefName)) return null;
  let defaultBranch = options.defaultBranch;
  if (!defaultBranch) {
    const resolved = await (options.getDefaultBranchFn ?? ((r)=>getRepoDefaultBranch(r, ghCommandFn)))(repo);
    if (!resolved.ok) {
      return {
        decision: "defer",
        reason: "lookup-failed",
        milestoneBranch,
        detail: `could not resolve the default branch of ${repo}: ${resolved.error.message}`
      };
    }
    defaultBranch = resolved.value;
  }
  if (!BRANCH_PATTERN.test(defaultBranch)) {
    return {
      decision: "defer",
      reason: "lookup-failed",
      milestoneBranch,
      detail: `default branch "${defaultBranch}" failed the argument allowlist`
    };
  }
  const reading = await readMilestoneBehindBy(repo, milestoneBranch, defaultBranch, ghCommandFn, options.nowMs ?? Date.now);
  if (!reading.ok) {
    return {
      decision: "defer",
      reason: "lookup-failed",
      milestoneBranch,
      detail: reading.detail
    };
  }
  if (reading.behindBy <= 0) return null;
  return {
    decision: "defer",
    reason: "milestone-behind",
    milestoneBranch,
    behindBy: reading.behindBy,
    detail: `${milestoneBranch} is ${reading.behindBy} commit${reading.behindBy === 1 ? "" : "s"} behind ${defaultBranch}`
  };
}
async function resolveBaseRef(repo, prNumber, ghCommandFn) {
  if (!REPO_PATTERN.test(repo)) return null;
  try {
    const raw = await ghCommandFn([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "baseRefName"
    ]);
    const parsed = JSON.parse(raw);
    return typeof parsed.baseRefName === "string" && parsed.baseRefName !== "" ? parsed.baseRefName : null;
  } catch  {
    return null;
  }
}
/**
 * The route to the default branch is open. Merging may still have to wait:
 * a pre-merge caller also requires the milestone branch to be level with the
 * default branch (Issue #1779).
 */ async function routeOpenDecision(options, milestoneBranch) {
  if (options.requireSyncedBase !== true) {
    return {
      decision: "allow",
      reason: "route-open"
    };
  }
  return await deferWhenMilestoneBehind(options, milestoneBranch) ?? {
    decision: "allow",
    reason: "route-open"
  };
}
/**
 * Whether a merged rollup still closes the route (Issue #4175).
 *
 * An open milestone with open work does not: the historical rollup is not
 * the route any more, and the caller opens a fresh one when the branch is
 * ahead. A closed milestone, or one with no open work, stays closed.
 * An unreadable milestone or child list is not evidence either way.
 */ async function mergedRollupChildRoute(options, milestoneBranch) {
  const { repo, ghCommandFn } = options;
  let milestones;
  try {
    const raw = await ghCommandFn([
      "api",
      "--paginate",
      `repos/${repo}/milestones?state=all&per_page=100`
    ]);
    milestones = [];
    for (const item of parseJsonArrayPages(raw)){
      if (item && typeof item === "object") {
        milestones.push(item);
      }
    }
  } catch (err) {
    return {
      kind: "unreadable",
      detail: `could not read milestones: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  const milestone = milestones.find((item)=>typeof item.title === "string" && createMilestoneBranchName(item.title) === milestoneBranch);
  if (!milestone || milestone.state !== "open") return {
    kind: "closed"
  };
  if (typeof milestone.number !== "number") {
    return {
      kind: "unreadable",
      detail: `milestone "${milestone.title}" has no number`
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
      kind: "unreadable",
      detail: children.error.message
    };
  }
  return children.value.length > 0 ? {
    kind: "open-work"
  } : {
    kind: "closed"
  };
}
/** An open pull request from the milestone branch to a non-milestone base. */ function isOpenRouteRollup(pr) {
  return typeof pr.state === "string" && pr.state.toUpperCase() === "OPEN" && typeof pr.number === "number" && (typeof pr.baseRefName !== "string" || !isMilestoneBranch(pr.baseRefName));
}
/** Refuse a merge into a milestone branch whose route to the default branch has closed. */ export async function decideMilestoneBaseMerge(options) {
  const { repo, prNumber, ghCommandFn } = options;
  const base = options.baseRefName ?? await resolveBaseRef(repo, prNumber, ghCommandFn);
  if (base === null) return {
    decision: "allow",
    reason: "base-unknown"
  };
  if (!isMilestoneBranch(base)) {
    return {
      decision: "allow",
      reason: "not-milestone-base"
    };
  }
  if (!REPO_PATTERN.test(repo) || !BRANCH_PATTERN.test(base)) {
    return {
      decision: "defer",
      reason: "lookup-failed",
      milestoneBranch: base,
      detail: "repo or branch name failed the argument allowlist"
    };
  }
  // 1. Has a rollup PR (head = the milestone branch) already merged?
  let rollups;
  try {
    const raw = await ghCommandFn([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      base,
      "--state",
      "all",
      "--json",
      "number,state,baseRefName,mergedAt",
      "--limit",
      "50"
    ]);
    const parsed = JSON.parse(raw);
    rollups = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return {
      decision: "defer",
      reason: "lookup-failed",
      milestoneBranch: base,
      detail: `could not list rollup PRs for ${base}: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  const merged = rollups.find((pr)=>typeof pr.state === "string" && pr.state.toUpperCase() === "MERGED");
  // An open rollup is the route, even after an older one merged (Issue
  // #4175). A merged rollup with no open successor still closes the route.
  // Open work does not make it safe to merge: the child stays unarmed until
  // a rollup is open, so the issue cannot close on a branch with no route.
  if (!rollups.some(isOpenRouteRollup) && merged && typeof merged.number === "number") {
    const childRoute = await mergedRollupChildRoute(options, base);
    if (childRoute.kind === "unreadable") {
      return {
        decision: "defer",
        reason: "lookup-failed",
        milestoneBranch: base,
        detail: childRoute.detail
      };
    }
    if (childRoute.kind !== "open-work") {
      return {
        decision: "block",
        reason: "rollup-merged",
        milestoneBranch: base,
        rollupPrNumber: merged.number,
        detail: `rollup PR #${merged.number} (${base} → ${typeof merged.baseRefName === "string" ? merged.baseRefName : "?"}) merged${typeof merged.mergedAt === "string" ? ` at ${merged.mergedAt}` : ""}`
      };
    }
    return {
      decision: "defer",
      reason: "route-waiting",
      milestoneBranch: base,
      detail: `rollup PR #${merged.number} has merged and ${base} has no open rollup, so the child stays unarmed until a rollup is open`
    };
  }
  // 2. Is the milestone itself closed? (A closed milestone has no route
  //    either, whether or not its rollup PR is on record.)
  try {
    const raw = await ghCommandFn([
      "api",
      "--paginate",
      `repos/${repo}/milestones?state=all&per_page=100`
    ]);
    // parseIssueArray keeps number/title only; the milestone STATE is the
    // point here, so parse the paginated arrays the same way and keep it.
    const milestones = [];
    for (const item of parseJsonArrayPages(raw)){
      if (item && typeof item === "object") {
        milestones.push(item);
      }
    }
    for (const milestone of milestones){
      if (typeof milestone.title !== "string") continue;
      if (createMilestoneBranchName(milestone.title) !== base) continue;
      if (milestone.state === "closed") {
        return {
          decision: "block",
          reason: "milestone-closed",
          milestoneBranch: base,
          ...typeof milestone.number === "number" ? {
            milestoneNumber: milestone.number
          } : {},
          milestoneTitle: milestone.title,
          detail: `milestone "${milestone.title}" is closed`
        };
      }
      return await routeOpenDecision(options, base);
    }
  } catch (err) {
    return {
      decision: "defer",
      reason: "lookup-failed",
      milestoneBranch: base,
      detail: `could not read milestones: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  // No milestone matches the branch and no rollup merged: an orphan branch
  // by another route, but the merge itself is not what loses the work.
  return await routeOpenDecision(options, base);
}
/**
 * Why the PR cannot land where it is, as a clause completing "This PR …". It
 * is posted in the target repo, so it carries no VibeCoder issue reference —
 * GitHub would autolink a bare `#N` to an unrelated issue there (Issue #3501).
 *
 * A closed milestone is named by title and linked by URL, never as `#N`:
 * GitHub would autolink that to an unrelated issue or PR (Issue #3673).
 */ export function describeClosedRoute(gate, repo) {
  const milestoneName = gate.milestoneTitle ? gate.milestoneNumber ? `[${inertCodeSpan(gate.milestoneTitle)}](https://github.com/${repo}/milestone/${gate.milestoneNumber})` : inertCodeSpan(gate.milestoneTitle) : "";
  const why = gate.reason === "rollup-merged" ? `its rollup PR #${gate.rollupPrNumber} has already merged` : gate.reason === "milestone-closed" ? `its milestone${milestoneName ? ` ${milestoneName}` : ""} is closed` : `its state could not be verified (${gate.detail})`;
  return `targets \`${gate.milestoneBranch}\`, which has no route to the ` + `default branch any more — ${why} — so merging there would orphan the work`;
}
/**
 * A PR whose milestone branch has no route to the default branch is never
 * merged there and never moved to the default branch (a PR off a milestone
 * branch would carry the milestone's work there without its final review).
 * Nor is it left on hold for a human (Issue #4304): auto-merge is disarmed,
 * then the PR is closed and its originating issue redone through
 * `abandonAndRestart`, so the work comes back against the current base. Only
 * a gate carrying positive evidence — a merged rollup, or a closed milestone —
 * reaches here; an unreadable route defers instead (Issue #477). Never throws:
 * an abandon that does not happen is logged and tried again next scan.
 */ export async function abandonOrphanBoundPr(options) {
  const { repo, prNumber, gate, ghCommandFn, log } = options;
  logAt(log, "warn", `refusing to merge ${repo}#${prNumber} into ${gate.milestoneBranch}: ${gate.detail} ` + "— auto-merge disarmed; closing it and redoing its issue (Issue #4304)");
  await disarmAutoMerge(repo, prNumber, ghCommandFn, log);
  try {
    const branchName = options.headRefName || (await ghCommandFn([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "headRefName",
      "--jq",
      ".headRefName"
    ])).trim();
    if (!branchName) throw new Error("its head branch could not be read");
    const trustedAuthors = await resolveAlertDedupAuthors(options.authorOptions ?? {}, log);
    const outcome = await (options.abandon ?? abandonAndRestart)({
      repo,
      prNumber,
      branchName,
      baseBranch: gate.milestoneBranch,
      reason: {
        kind: "stalled",
        detail: describeClosedRoute(gate, repo),
        tried: "route-closed-hold"
      }
    }, {
      gh: ghCommandFn,
      trustedAuthors
    });
    if (outcome.outcome === "declined" || outcome.outcome === "failed") {
      logAt(log, "warn", `could not abandon ${repo}#${prNumber} (${outcome.outcome === "declined" ? outcome.reason.kind : outcome.step}) — retried next scan (Issue #4304)`);
    }
  } catch (err) {
    logAt(log, "warn", `could not abandon ${repo}#${prNumber}: ${err instanceof Error ? err.message : String(err)} — retried next scan (Issue #4304)`);
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9taWxlc3RvbmVfY2hpbGRyZW5fZ2F0ZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIE1pbGVzdG9uZSBvcGVuLWNoaWxkcmVuIGdhdGUgKElzc3VlICMzOTA5KS5cbiAqXG4gKiBNZXJnaW5nIGEgbWlsZXN0b25lIHN1bW1hcnkgUFIgaXMgdGhlIGlycmV2ZXJzaWJsZSBzdGVwIG9mIHRoZSBtaWxlc3RvbmVcbiAqIGZsb3c6IGBzdFNvZnR3YXJlQVUvVmliZUNvZGVyYCBoYXMgYGRlbGV0ZV9icmFuY2hfb25fbWVyZ2U6IHRydWVgLCBzbyB0aGVcbiAqIG1lcmdlIGRlbGV0ZXMgdGhlIG1pbGVzdG9uZSBicmFuY2gsIGFuZCBHaXRIdWIgYXV0by1jbG9zZXMgZXZlcnkgUFIgYmFzZWQgb25cbiAqIGl0LiBNaWxlc3RvbmUgNTMgbG9zdCBpbi1mbGlnaHQgY2hpbGQgUFIgIzM5MDEgZXhhY3RseSB0aGF0IHdheS5cbiAqXG4gKiBBIGNvbXBsZXRlbmVzcyBjaGVjayBtYWRlIHdoZW4gdGhlIHN1bW1hcnkgUFIgaXMgKmNyZWF0ZWQqIGlzIG5vdCBlbm91Z2gg4oCUXG4gKiBjaGlsZHJlbiBjYW4gYXBwZWFyIChvciBzaW1wbHkgcmVtYWluKSBpbiB0aGUgd2luZG93IGJldHdlZW4gY3JlYXRpb24gYW5kXG4gKiBtZXJnZS4gVGhpcyBtb2R1bGUgcmUtcmVhZHMgR2l0SHViJ3MgYXV0aG9yaXRhdGl2ZSBvcGVuLWNoaWxkcmVuIHNldFxuICogaW1tZWRpYXRlbHkgYmVmb3JlIHRoZSB3b3JrZXIgbWVyZ2VzIHRoZSBzdW1tYXJ5IFBSLCBhbmQgYmVmb3JlIHRoZVxuICogY29tcGxldGlvbiBwYXRoIGNsb3NlcyB0aGUgdHJhY2tpbmcgaXNzdWUgb3IgdGhlIEdpdEh1YiBtaWxlc3RvbmUuXG4gKlxuICogXCJPcGVuIGNoaWxkcmVuXCIgZGVsaWJlcmF0ZWx5IHNwYW5zIGJvdGggc2hhcGVzIHRoYXQgdGhlIGluY2lkZW50IGludm9sdmVkOlxuICogICAxLiBvcGVuIG5vbi10cmFja2luZyBpc3N1ZXMgYXNzaWduZWQgdG8gdGhlIG1pbGVzdG9uZSwgYW5kXG4gKiAgIDIuIG9wZW4gUFJzIHdob3NlICpiYXNlKiBpcyB0aGUgbWlsZXN0b25lIGJyYW5jaCDigJQgdGhlIGluLWZsaWdodCBjaGlsZCBQUnNcbiAqICAgICAgdGhlIGJyYW5jaCBkZWxldGlvbiB3b3VsZCBhdXRvLWNsb3NlLCB3aGljaCBhcmUgdHlwaWNhbGx5IG5vdCBhc3NpZ25lZFxuICogICAgICB0byB0aGUgbWlsZXN0b25lIGF0IGFsbC5cbiAqXG4gKiBSZWFkcyBhcmUgdW5jYWNoZWQgb24gcHVycG9zZSAodGltZS1vZi1jaGVjay90aW1lLW9mLXVzZSk6IHRoZSB3aG9sZSBwb2ludFxuICogaXMgdG8gc2VlIHN0YXRlIGFzIGl0IGlzIGF0IG1lcmdlIHRpbWUsIG5vdCBhcyBhbiBlYXJsaWVyIHNjYW4gY2FjaGVkIGl0LlxuICpcbiAqIEZvbGxvd3MgdGhlIGBpZGxlX3Rhc2tfbWVyZ2VfZ2F0ZS50c2AgcHJlY2VkZW50OiBwdXJlIGRlY2lzaW9uIGZ1bmN0aW9uLFxuICogaW5qZWN0ZWQgYGdoYCBydW5uZXIsIG5vIHNpZGUgZWZmZWN0cyB1bnRpbCB0aGUgY2FsbGVyIGFza3MgZm9yIHRoZW0uXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbikuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBSZXN1bHQgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB7XG4gIHR5cGUgQWxlcnREZWR1cEF1dGhvck9wdGlvbnMsXG4gIHBhcnNlQXV0aG9yZWRDb21tZW50Um93cyxcbiAgcmVzb2x2ZUFsZXJ0RGVkdXBBdXRob3JzLFxuICBzZWxlY3RGbGVldEF1dGhvcmVkQ29tbWVudHMsXG59IGZyb20gXCIuL2FsZXJ0X2RlZHVwX2F1dGhvcnMudHNcIjtcbmltcG9ydCB7XG4gIGFiYW5kb25BbmRSZXN0YXJ0LFxuICB0eXBlIEFiYW5kb25SZXN0YXJ0RGVwcyxcbiAgdHlwZSBBYmFuZG9uUmVzdGFydE91dGNvbWUsXG4gIHR5cGUgQWJhbmRvblJlc3RhcnRSZXF1ZXN0LFxufSBmcm9tIFwiLi9jb25mbGljdF9hYmFuZG9uX3Jlc3RhcnQudHNcIjtcbmltcG9ydCB7IGRpc2FybUF1dG9NZXJnZSB9IGZyb20gXCIuL2F1dG9fbWVyZ2VfZGlzYXJtLnRzXCI7XG5pbXBvcnQgeyBpc01pbGVzdG9uZUJyYW5jaCB9IGZyb20gXCIuL21pbGVzdG9uZV9icmFuY2hfbmFtZXMudHNcIjtcbmltcG9ydCB7IGNyZWF0ZU1pbGVzdG9uZUJyYW5jaE5hbWUgfSBmcm9tIFwiLi9naXRfYnJhbmNoLnRzXCI7XG5pbXBvcnQge1xuICB0eXBlIE1pbGVzdG9uZVRyYWNrZXJWZXJpZmljYXRpb24sXG4gIHBhcnRpdGlvbk1pbGVzdG9uZVRyYWNrZXJzLFxufSBmcm9tIFwiLi9taWxlc3RvbmVfdHJhY2tlcl9pZGVudGl0eS50c1wiO1xuaW1wb3J0IHsgaXNNaWxlc3RvbmVTeW5jQnJhbmNoIH0gZnJvbSBcIi4vbWlsZXN0b25lX3N5bmNfcHIudHNcIjtcbmltcG9ydCB7IHBhcnNlSnNvbkFycmF5UGFnZXMgfSBmcm9tIFwiLi9qc29uX2FycmF5X3BhZ2VzLnRzXCI7XG5pbXBvcnQgeyBpbmVydENvZGVTcGFuIH0gZnJvbSBcIi4vY2lfaHVtYW5fZ2F0ZV9jb21tZW50LnRzXCI7XG5pbXBvcnQgeyBzY3J1YlVudHJ1c3RlZFRleHQgfSBmcm9tIFwiLi9wcm9tcHRfZGVsaW1pdGVyLnRzXCI7XG5pbXBvcnQgeyBnZXRSZXBvRGVmYXVsdEJyYW5jaCB9IGZyb20gXCIuL3NoZWxsX2hlbHBlcnMudHNcIjtcbi8vIElzc3VlICMzMDE0OiBsYXllciB0aGUgZGVjbGFyZWQtZGVwZW5kZW5jeSBob2xkIG9udG8gdGhpcyBnYXRlLlxuaW1wb3J0IHtcbiAgZGVzY3JpYmVQZW5kaW5nRGVwZW5kZW5jeSxcbiAgZmluZFBlbmRpbmdNaWxlc3RvbmVEZXBlbmRlbmNpZXMsXG4gIFBFTkRJTkdfREVQRU5ERU5DSUVTX0JMT0NLX01BUktFUixcbiAgdHlwZSBQZW5kaW5nRGVwZW5kZW5jeSxcbiAgcmVuZGVyUGVuZGluZ0RlcGVuZGVuY2llc0Jsb2NrQ29tbWVudCxcbn0gZnJvbSBcIi4vbWlsZXN0b25lX2RlcGVuZGVuY3lfaG9sZC50c1wiO1xuaW1wb3J0IHsgbG9nQXQgfSBmcm9tIFwiLi9sb2dfc2luay50c1wiO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFR5cGVzIGFuZCBjb25zdGFudHNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKiogSW5qZWN0YWJsZSBgZ2hgIGNvbW1hbmQgcnVubmVyLiAqL1xuZXhwb3J0IHR5cGUgR2hDb21tYW5kRm4gPSAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPjtcblxuLyoqIEFuIG9wZW4gY2hpbGQgb2YgYSBtaWxlc3RvbmUgdGhhdCBibG9ja3MgZmluYWxpc2F0aW9uLiAqL1xuZXhwb3J0IGludGVyZmFjZSBPcGVuTWlsZXN0b25lQ2hpbGQge1xuICAvKiogSXNzdWUgb3IgUFIgbnVtYmVyLiAqL1xuICBudW1iZXI6IG51bWJlcjtcbiAgLyoqIElzc3VlIG9yIFBSIHRpdGxlLiAqL1xuICB0aXRsZTogc3RyaW5nO1xuICAvKiogV2hpY2ggc2hhcGUgb2YgY2hpbGQgdGhpcyBpcy4gKi9cbiAga2luZDogXCJpc3N1ZVwiIHwgXCJwclwiO1xufVxuXG4vKipcbiAqIEhpZGRlbiBtYXJrZXIgb24gdGhlIGV4cGxhbmF0b3J5IGNvbW1lbnQuIEl0cyBwcmVzZW5jZSBpcyB3aGF0IG1ha2VzIHRoZVxuICogYmxvY2sgY29tbWVudCBpZGVtcG90ZW50IOKAlCByZXBlYXRlZCBzY2FuIGN5Y2xlcyBtdXN0IG5vdCBzcGFtIHRoZSBQUi5cbiAqL1xuZXhwb3J0IGNvbnN0IE9QRU5fQ0hJTERSRU5fQkxPQ0tfTUFSS0VSID1cbiAgXCI8IS0tIG1pbGVzdG9uZS1vcGVuLWNoaWxkcmVuLW1lcmdlLWJsb2NrIC0tPlwiO1xuXG4vKiogUmVwbyBtdXN0IGJlIGV4YWN0bHkgYG93bmVyL3JlcG9gIGJlZm9yZSBpdCByZWFjaGVzIGFuIEFQSSBwYXRoLiAqL1xuY29uc3QgUkVQT19QQVRURVJOID0gL15bQS1aYS16MC05Ll8tXStcXC9bQS1aYS16MC05Ll8tXSskLztcblxuLyoqIENvbnNlcnZhdGl2ZSBicmFuY2gtbmFtZSBhbGxvd2xpc3QgZm9yIHZhbHVlcyBpbnRlcnBvbGF0ZWQgaW50byBnaCBhcmdzLiAqL1xuY29uc3QgQlJBTkNIX1BBVFRFUk4gPSAvXltBLVphLXowLTkuXy8tXSskLztcblxuZXhwb3J0IHsgaXNNaWxlc3RvbmVCcmFuY2ggfTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBBdXRob3JpdGF0aXZlIG9wZW4tY2hpbGRyZW4gcmVhZFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBPcHRpb25zIGZvciB7QGxpbmsgZmV0Y2hPcGVuTWlsZXN0b25lQ2hpbGRyZW59LiAqL1xuZXhwb3J0IGludGVyZmFjZSBPcGVuQ2hpbGRyZW5PcHRpb25zIHtcbiAgLyoqIFJlcG9zaXRvcnkgaW4gYG93bmVyL3JlcG9gIGZvcm0uICovXG4gIHJlcG86IHN0cmluZztcbiAgLyoqIEdpdEh1YiBtaWxlc3RvbmUgbnVtYmVyICh0aGUgQVBJIGlkLCBub3QgdGhlIHRpdGxlKS4gKi9cbiAgbWlsZXN0b25lTnVtYmVyOiBudW1iZXI7XG4gIC8qKiBNaWxlc3RvbmUgYnJhbmNoIOKAlCBvcGVuIFBScyBiYXNlZCBvbiBpdCBjb3VudCBhcyBjaGlsZHJlbi4gKi9cbiAgbWlsZXN0b25lQnJhbmNoPzogc3RyaW5nO1xuICAvKiogUFIgbnVtYmVycyB0byBleGNsdWRlIChlLmcuIHRoZSBzdW1tYXJ5IFBSIGJlaW5nIG1lcmdlZCkuICovXG4gIGV4Y2x1ZGVQck51bWJlcnM/OiByZWFkb25seSBudW1iZXJbXTtcbiAgLyoqXG4gICAqIEZsZWV0LWlkZW50aXR5IGlucHV0cyBmb3IgdGhlIHRyYWNraW5nLWlzc3VlIGNoZWNrIChJc3N1ZSAjMTI0NikuIFRoZVxuICAgKiB0cmFja2VyIGV4Y2x1c2lvbiBiZWxvdyBpcyB3aGF0IGxldHMgYSBtZXJnZSB0aHJvdWdoLCBzbyBpdCBpcyBkZWNpZGVkXG4gICAqIGZyb20gYXV0aGVudGljYXRlZCBldmlkZW5jZSByYXRoZXIgdGhhbiB0aGUgY2hpbGQncyB0aXRsZS5cbiAgICovXG4gIHZlcmlmaWNhdGlvbj86IE1pbGVzdG9uZVRyYWNrZXJWZXJpZmljYXRpb247XG4gIGdoQ29tbWFuZEZuOiBHaENvbW1hbmRGbjtcbn1cblxuaW50ZXJmYWNlIFJhd0lzc3VlIHtcbiAgbnVtYmVyOiBudW1iZXI7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIHB1bGxfcmVxdWVzdD86IHVua25vd247XG4gIC8qKiBJc3N1ZSBib2R5IOKAlCBjYXJyaWVzIHRoZSB0cmFja2luZy1pc3N1ZSBtYXJrZXIgKElzc3VlICMxMjQ2KS4gKi9cbiAgYm9keT86IHN0cmluZztcbiAgLyoqIFJFU1QgbmFtZXMgdGhlIGlzc3VlJ3Mgb3BlbmVyIGB1c2VyYCwgbm90IGBhdXRob3JgIChJc3N1ZSAjMTI0NikuICovXG4gIHVzZXI/OiB7IGxvZ2luPzogc3RyaW5nIH07XG59XG5cbi8qKlxuICogUmVhZCB0aGUgbWlsZXN0b25lJ3Mgb3BlbiBjaGlsZHJlbiBzdHJhaWdodCBmcm9tIEdpdEh1YiDigJQgbm8gY2FjaGUuXG4gKlxuICogTWlsZXN0b25lLXRyYWNraW5nIGlzc3VlcyAoYE1lcmdlIG1pbGVzdG9uZSAn4oCmJyB0byDigKZgKSBhcmUgZXhjbHVkZWQ6IHRoZVxuICogdHJhY2tlciBsaXZlcyBpbnNpZGUgdGhlIG1pbGVzdG9uZSBpdCB0cmFja3MsIHNvIGNvdW50aW5nIGl0IHdvdWxkIG1ha2VcbiAqIGV2ZXJ5IG1pbGVzdG9uZSBwZXJtYW5lbnRseSBpbmNvbXBsZXRlICh0aGUgSXNzdWUgIzMyMTQgZGVhZGxvY2spLlxuICpcbiAqIEByZXR1cm5zIFRoZSBvcGVuIGNoaWxkcmVuLCBvciBhbiBlcnJvciB3aGVuIHRoZSBzdGF0ZSBjb3VsZCBub3QgYmUgcmVhZC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoT3Blbk1pbGVzdG9uZUNoaWxkcmVuKFxuICBvcHRpb25zOiBPcGVuQ2hpbGRyZW5PcHRpb25zLFxuKTogUHJvbWlzZTxSZXN1bHQ8T3Blbk1pbGVzdG9uZUNoaWxkW10+PiB7XG4gIGNvbnN0IHsgcmVwbywgbWlsZXN0b25lTnVtYmVyLCBtaWxlc3RvbmVCcmFuY2gsIGdoQ29tbWFuZEZuIH0gPSBvcHRpb25zO1xuXG4gIGlmICghUkVQT19QQVRURVJOLnRlc3QocmVwbykpIHtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBuZXcgRXJyb3IoYEludmFsaWQgcmVwbzogJHtyZXBvfWApIH07XG4gIH1cbiAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKG1pbGVzdG9uZU51bWJlcikgfHwgbWlsZXN0b25lTnVtYmVyIDw9IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihgSW52YWxpZCBtaWxlc3RvbmUgbnVtYmVyOiAke21pbGVzdG9uZU51bWJlcn1gKSxcbiAgICB9O1xuICB9XG4gIGlmIChtaWxlc3RvbmVCcmFuY2ggIT09IHVuZGVmaW5lZCAmJiAhQlJBTkNIX1BBVFRFUk4udGVzdChtaWxlc3RvbmVCcmFuY2gpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoYEludmFsaWQgbWlsZXN0b25lIGJyYW5jaDogJHttaWxlc3RvbmVCcmFuY2h9YCksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGV4Y2x1ZGVkID0gbmV3IFNldChvcHRpb25zLmV4Y2x1ZGVQck51bWJlcnMgPz8gW10pO1xuICBjb25zdCBjaGlsZHJlbiA9IG5ldyBNYXA8bnVtYmVyLCBPcGVuTWlsZXN0b25lQ2hpbGQ+KCk7XG5cbiAgLy8gMS4gT3BlbiBpc3N1ZXMgKGFuZCBtaWxlc3RvbmUtYXNzaWduZWQgUFJzKSBhdHRhY2hlZCB0byB0aGUgbWlsZXN0b25lLlxuICB0cnkge1xuICAgIGNvbnN0IHJhdyA9IGF3YWl0IGdoQ29tbWFuZEZuKFtcbiAgICAgIFwiYXBpXCIsXG4gICAgICBcIi0tcGFnaW5hdGVcIixcbiAgICAgIGByZXBvcy8ke3JlcG99L2lzc3Vlcz9taWxlc3RvbmU9JHttaWxlc3RvbmVOdW1iZXJ9JnN0YXRlPW9wZW4mcGVyX3BhZ2U9MTAwYCxcbiAgICBdKTtcbiAgICAvLyBJc3N1ZSAjMTI0NjogZXhjbHVkaW5nIGEgY2hpbGQgaGVyZSBpcyB3aGF0IGFsbG93cyB0aGUgbWVyZ2UgdGhhdFxuICAgIC8vIGRlbGV0ZXMgdGhlIG1pbGVzdG9uZSBicmFuY2gsIHNvIG9ubHkgYSB0cmFja2VyIGNhcnJ5aW5nIHRoZVxuICAgIC8vIHRyYWNraW5nLWlzc3VlIGJvZHkgbWFya2VyIGFuZCBvcGVuZWQgYnkgYSBmbGVldCBhY2NvdW50IGlzIGV4Y2x1ZGVkLlxuICAgIC8vIEEgdHJhY2tpbmctc2hhcGVkIGNoaWxkIHRoYXQgY2Fubm90IGJlIHZlcmlmaWVkIGtlZXBzIGJsb2NraW5nLlxuICAgIGNvbnN0IHsgb3RoZXJzIH0gPSBhd2FpdCBwYXJ0aXRpb25NaWxlc3RvbmVUcmFja2VycyhcbiAgICAgIHBhcnNlSXNzdWVBcnJheShyYXcpLm1hcCgoaXRlbSkgPT4gKHtcbiAgICAgICAgbnVtYmVyOiBpdGVtLm51bWJlcixcbiAgICAgICAgdGl0bGU6IGl0ZW0udGl0bGUsXG4gICAgICAgIGJvZHk6IGl0ZW0uYm9keSA/PyBcIlwiLFxuICAgICAgICBhdXRob3I6IChpdGVtIGFzIHsgYXV0aG9yPzogc3RyaW5nIH0pLmF1dGhvciA/PyBcIlwiLFxuICAgICAgICBwdWxsX3JlcXVlc3Q6IGl0ZW0ucHVsbF9yZXF1ZXN0LFxuICAgICAgfSkpLFxuICAgICAgYG1lcmdlIGdhdGUgZm9yIG1pbGVzdG9uZSAjJHttaWxlc3RvbmVOdW1iZXJ9IGluICR7cmVwb31gLFxuICAgICAge1xuICAgICAgICAuLi5vcHRpb25zLnZlcmlmaWNhdGlvbixcbiAgICAgICAgdW52ZXJpZmllZE91dGNvbWU6XG4gICAgICAgICAgXCJ0aGUgY2FuZGlkYXRlIGtlZXBzIGJsb2NraW5nIHRoZSBzdW1tYXJ5LVBSIG1lcmdlLCBzbyB0aGUgXCIgK1xuICAgICAgICAgIFwibWlsZXN0b25lIGJyYW5jaCBpcyBub3QgZGVsZXRlZFwiLFxuICAgICAgfSxcbiAgICApO1xuICAgIGZvciAoY29uc3QgaXRlbSBvZiBvdGhlcnMpIHtcbiAgICAgIGlmIChleGNsdWRlZC5oYXMoaXRlbS5udW1iZXIpKSBjb250aW51ZTtcbiAgICAgIGNoaWxkcmVuLnNldChpdGVtLm51bWJlciwge1xuICAgICAgICBudW1iZXI6IGl0ZW0ubnVtYmVyLFxuICAgICAgICB0aXRsZTogaXRlbS50aXRsZSxcbiAgICAgICAga2luZDogaXRlbS5wdWxsX3JlcXVlc3QgPyBcInByXCIgOiBcImlzc3VlXCIsXG4gICAgICB9KTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgRmFpbGVkIHRvIHJlYWQgb3BlbiBjaGlsZHJlbiBvZiBtaWxlc3RvbmUgIyR7bWlsZXN0b25lTnVtYmVyfSBpbiBgICtcbiAgICAgICAgICBgJHtyZXBvfTogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuXG4gIC8vIDIuIE9wZW4gUFJzIHRhcmdldGluZyB0aGUgbWlsZXN0b25lIGJyYW5jaC4gVGhlc2UgYXJlIHRoZSBpbi1mbGlnaHRcbiAgLy8gICAgY2hpbGRyZW4gYSBicmFuY2ggZGVsZXRpb24gYXV0by1jbG9zZXMsIGFuZCB0aGV5IGFyZSB1c3VhbGx5IG5vdFxuICAvLyAgICBhc3NpZ25lZCB0byB0aGUgbWlsZXN0b25lIOKAlCBzbyBxdWVyeSB0aGVtIHNlcGFyYXRlbHkuXG4gIGlmIChtaWxlc3RvbmVCcmFuY2ggIT09IHVuZGVmaW5lZCkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByYXcgPSBhd2FpdCBnaENvbW1hbmRGbihbXG4gICAgICAgIFwicHJcIixcbiAgICAgICAgXCJsaXN0XCIsXG4gICAgICAgIFwiLS1yZXBvXCIsXG4gICAgICAgIHJlcG8sXG4gICAgICAgIFwiLS1iYXNlXCIsXG4gICAgICAgIG1pbGVzdG9uZUJyYW5jaCxcbiAgICAgICAgXCItLXN0YXRlXCIsXG4gICAgICAgIFwib3BlblwiLFxuICAgICAgICBcIi0tanNvblwiLFxuICAgICAgICBcIm51bWJlcix0aXRsZVwiLFxuICAgICAgICBcIi0tbGltaXRcIixcbiAgICAgICAgXCIxMDBcIixcbiAgICAgIF0pO1xuICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHBhcnNlSXNzdWVBcnJheShyYXcpKSB7XG4gICAgICAgIGlmIChleGNsdWRlZC5oYXMoaXRlbS5udW1iZXIpKSBjb250aW51ZTtcbiAgICAgICAgY2hpbGRyZW4uc2V0KGl0ZW0ubnVtYmVyLCB7XG4gICAgICAgICAgbnVtYmVyOiBpdGVtLm51bWJlcixcbiAgICAgICAgICB0aXRsZTogaXRlbS50aXRsZSxcbiAgICAgICAgICBraW5kOiBcInByXCIsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICAgIGBGYWlsZWQgdG8gcmVhZCBvcGVuIFBScyB0YXJnZXRpbmcgJHttaWxlc3RvbmVCcmFuY2h9IGluICR7cmVwb306IGAgK1xuICAgICAgICAgICAgYCR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWAsXG4gICAgICAgICksXG4gICAgICB9O1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7XG4gICAgb2s6IHRydWUsXG4gICAgdmFsdWU6IFsuLi5jaGlsZHJlbi52YWx1ZXMoKV0uc29ydCgoYSwgYikgPT4gYS5udW1iZXIgLSBiLm51bWJlciksXG4gIH07XG59XG5cbi8qKlxuICogUGFyc2UgYSBgZ2hgIEpTT04gYXJyYXkgcmVzcG9uc2UgaW50byBpc3N1ZS1zaGFwZWQgcmVjb3Jkcy5cbiAqXG4gKiBgZ2ggYXBpIC0tcGFnaW5hdGVgIGNvbmNhdGVuYXRlcyBwYWdlcyBhcyBzZXBhcmF0ZSB0b3AtbGV2ZWwgSlNPTiBhcnJheXNcbiAqIHdpdGggbm8gZ3VhcmFudGVlZCBzZXBhcmF0b3IsIHNvIHBhZ2VzIGFyZSBwYXJzZWQgd2l0aCBhIHN0cmluZy1hd2FyZSBzY2FuXG4gKiByYXRoZXIgdGhhbiBhIGBdW2AtYm91bmRhcnkgcmVnZXggKElzc3VlICMyODk1KS4gQSBtYWxmb3JtZWQgcGF5bG9hZFxuICogdGhyb3dzIOKAlCBhbiB1bnJlYWRhYmxlIHJlc3BvbnNlIG11c3QgbmV2ZXIgYmUgcmVwb3J0ZWQgYXMgXCJubyBjaGlsZHJlblwiLlxuICovXG5mdW5jdGlvbiBwYXJzZUlzc3VlQXJyYXkocmF3OiBzdHJpbmcpOiBSYXdJc3N1ZVtdIHtcbiAgY29uc3Qgb3V0OiBSYXdJc3N1ZVtdID0gW107XG4gIGZvciAoY29uc3QgaXRlbSBvZiBwYXJzZUpzb25BcnJheVBhZ2VzKHJhdykpIHtcbiAgICBjb25zdCByZWNvcmQgPSBpdGVtIGFzIFJhd0lzc3VlIHwgbnVsbCB8IHVuZGVmaW5lZDtcbiAgICBpZiAodHlwZW9mIHJlY29yZD8ubnVtYmVyID09PSBcIm51bWJlclwiKSB7XG4gICAgICBvdXQucHVzaChcbiAgICAgICAge1xuICAgICAgICAgIG51bWJlcjogcmVjb3JkLm51bWJlcixcbiAgICAgICAgICB0aXRsZTogdHlwZW9mIHJlY29yZC50aXRsZSA9PT0gXCJzdHJpbmdcIiA/IHJlY29yZC50aXRsZSA6IFwiXCIsXG4gICAgICAgICAgcHVsbF9yZXF1ZXN0OiByZWNvcmQucHVsbF9yZXF1ZXN0LFxuICAgICAgICAgIGJvZHk6IHR5cGVvZiByZWNvcmQuYm9keSA9PT0gXCJzdHJpbmdcIiA/IHJlY29yZC5ib2R5IDogXCJcIixcbiAgICAgICAgICBhdXRob3I6IHR5cGVvZiByZWNvcmQudXNlcj8ubG9naW4gPT09IFwic3RyaW5nXCJcbiAgICAgICAgICAgID8gcmVjb3JkLnVzZXIubG9naW5cbiAgICAgICAgICAgIDogXCJcIixcbiAgICAgICAgfSBhcyBSYXdJc3N1ZSAmIHsgYm9keTogc3RyaW5nOyBhdXRob3I6IHN0cmluZyB9LFxuICAgICAgKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBTdW1tYXJ5LVBSIG1lcmdlIGRlY2lzaW9uXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqIFRoZSBnYXRlJ3MgZGVjaXNpb24gZm9yIGEgY2FuZGlkYXRlIGF1dG8tbWVyZ2UuICovXG5leHBvcnQgdHlwZSBTdW1tYXJ5UHJNZXJnZURlY2lzaW9uID1cbiAgfCB7XG4gICAgZGVjaXNpb246IFwiYWxsb3dcIjtcbiAgICByZWFzb246XG4gICAgICB8IFwibm90LW1pbGVzdG9uZS1wclwiXG4gICAgICB8IFwiaGVhZC11bmtub3duXCJcbiAgICAgIHwgXCJtaWxlc3RvbmUtbm90LWZvdW5kXCJcbiAgICAgIHwgXCJuby1vcGVuLWNoaWxkcmVuXCI7XG4gIH1cbiAgfCB7XG4gICAgZGVjaXNpb246IFwiYmxvY2tcIjtcbiAgICByZWFzb246IFwib3Blbi1jaGlsZHJlblwiO1xuICAgIG1pbGVzdG9uZU51bWJlcjogbnVtYmVyO1xuICAgIG1pbGVzdG9uZVRpdGxlOiBzdHJpbmc7XG4gICAgbWlsZXN0b25lQnJhbmNoOiBzdHJpbmc7XG4gICAgY2hpbGRyZW46IE9wZW5NaWxlc3RvbmVDaGlsZFtdO1xuICB9XG4gIHwge1xuICAgIGRlY2lzaW9uOiBcImJsb2NrXCI7XG4gICAgcmVhc29uOiBcImxvb2t1cC1mYWlsZWRcIjtcbiAgICAvKiogV2hpY2ggcmVhZCBmYWlsZWQsIHNvIHRoZSBQUiBjb21tZW50IG5hbWVzIHRoZSByaWdodCB1bnJlYWRhYmxlIHN0YXRlLiAqL1xuICAgIHN0YWdlOiBcIm9wZW4tY2hpbGRyZW5cIiB8IFwiZGVjbGFyZWQtZGVwZW5kZW5jaWVzXCI7XG4gICAgbWlsZXN0b25lTnVtYmVyOiBudW1iZXI7XG4gICAgbWlsZXN0b25lVGl0bGU6IHN0cmluZztcbiAgICBtaWxlc3RvbmVCcmFuY2g6IHN0cmluZztcbiAgICBtZXNzYWdlOiBzdHJpbmc7XG4gIH1cbiAgfCB7XG4gICAgLyoqIEEgbWVtYmVyIGlzc3VlIGRlY2xhcmVzIGEgZGVwZW5kZW5jeSB0aGF0IGhhcyBub3QgbGFuZGVkIHlldCAoSXNzdWUgIzMwMTQpLiAqL1xuICAgIGRlY2lzaW9uOiBcImJsb2NrXCI7XG4gICAgcmVhc29uOiBcInBlbmRpbmctZGVwZW5kZW5jaWVzXCI7XG4gICAgbWlsZXN0b25lTnVtYmVyOiBudW1iZXI7XG4gICAgbWlsZXN0b25lVGl0bGU6IHN0cmluZztcbiAgICBtaWxlc3RvbmVCcmFuY2g6IHN0cmluZztcbiAgICBkZXBlbmRlbmNpZXM6IFBlbmRpbmdEZXBlbmRlbmN5W107XG4gIH07XG5cbi8qKiBPcHRpb25zIGZvciB7QGxpbmsgZGVjaWRlU3VtbWFyeVByTWVyZ2V9LiAqL1xuZXhwb3J0IGludGVyZmFjZSBTdW1tYXJ5UHJNZXJnZUdhdGVPcHRpb25zIHtcbiAgLyoqIFJlcG9zaXRvcnkgaW4gYG93bmVyL3JlcG9gIGZvcm0uICovXG4gIHJlcG86IHN0cmluZztcbiAgLyoqIFRoZSBQUiB0aGUgd29ya2VyIGlzIGFib3V0IHRvIGF1dG8tbWVyZ2UuICovXG4gIHByTnVtYmVyOiBudW1iZXI7XG4gIC8qKiBIZWFkIGJyYW5jaCwgd2hlbiB0aGUgY2FsbGVyIGFscmVhZHkga25vd3MgaXQgKHNhdmVzIGEgbG9va3VwKS4gKi9cbiAgaGVhZFJlZk5hbWU/OiBzdHJpbmc7XG4gIC8qKiBGbGVldC1pZGVudGl0eSBpbnB1dHMgZm9yIHRoZSB0cmFja2luZy1pc3N1ZSBjaGVjayAoSXNzdWUgIzEyNDYpLiAqL1xuICB2ZXJpZmljYXRpb24/OiBNaWxlc3RvbmVUcmFja2VyVmVyaWZpY2F0aW9uO1xuICBnaENvbW1hbmRGbjogR2hDb21tYW5kRm47XG59XG5cbmludGVyZmFjZSBSYXdNaWxlc3RvbmUge1xuICBudW1iZXI6IG51bWJlcjtcbiAgdGl0bGU6IHN0cmluZztcbn1cblxuLyoqXG4gKiBEZWNpZGUgd2hldGhlciB0aGUgd29ya2VyIG1heSBhdXRvLW1lcmdlIHRoaXMgUFIuXG4gKlxuICogQ2hlYXAgYnkgZGVzaWduOiBhIFBSIHdob3NlIGhlYWQgaXMgbm90IGEgYG1pbGVzdG9uZS8qYCBicmFuY2ggaXMgYWxsb3dlZFxuICogYWZ0ZXIgYXQgbW9zdCBvbmUgbG9va3VwLCBzbyB0aGUgZ2F0ZSBjb3N0cyBub3RoaW5nIG9uIG9yZGluYXJ5IGZpeCBQUnMuXG4gKlxuICogRmFpbHVyZSBoYW5kbGluZyBpcyBkZWxpYmVyYXRlbHkgYXN5bW1ldHJpYy4gV2hpbGUgdGhlIFBSIGlzIHN0aWxsXG4gKiAqdW5pZGVudGlmaWVkKiAoaGVhZCByZWYgb3IgbWlsZXN0b25lIGxpc3QgdW5yZWFkYWJsZSkgdGhlIGdhdGUgYWxsb3dzIHRoZVxuICogbWVyZ2Ug4oCUIGJsb2NraW5nIGV2ZXJ5IFBSIG9uIGEgdHJhbnNpZW50IGBnaGAgaGljY3VwIHdvdWxkIGJlIHdvcnNlIHRoYW4gdGhlXG4gKiByaXNrIGl0IHJlbW92ZXMuIE9uY2UgdGhlIFBSIGlzIGtub3duIHRvIGJlIGEgbWlsZXN0b25lIHN1bW1hcnkgUFIsIGFueVxuICogZmFpbHVyZSB0byByZWFkIHRoZSBjaGlsZHJlbiBibG9ja3M6IHRoZSBtZXJnZSBpcyBpcnJldmVyc2libGUsIHNvIGFuXG4gKiB1bnZlcmlmaWFibGUgc3RhdGUgaXMgbm90IGEgbGljZW5jZSB0byBwcm9jZWVkLlxuICpcbiAqIE9uY2UgdGhlIG9wZW4tY2hpbGRyZW4gc2V0IGlzIGVtcHR5LCB0aGUgZ2F0ZSBhbHNvIGNoZWNrcyBldmVyeSBtZW1iZXJcbiAqIGlzc3VlJ3MgZGVjbGFyZWQgXCJEZXBlbmRzIG9uICNOXCIgcmVmZXJlbmNlcyAoSXNzdWUgIzMwMTQpIOKAlCBhIG1pbGVzdG9uZSBjYW5cbiAqIGhhdmUgemVybyBvcGVuIGNoaWxkcmVuIHlldCBzdGlsbCBhc3NlbWJsZSBhIHN1Yi1pc3N1ZSB3aG9zZSBkZWNsYXJlZFxuICogZGVwZW5kZW5jeSBoYXMgbm90IGFjdHVhbGx5IGxhbmRlZCBvbiB0aGUgdGFyZ2V0IGJyYW5jaC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRlY2lkZVN1bW1hcnlQck1lcmdlKFxuICBvcHRpb25zOiBTdW1tYXJ5UHJNZXJnZUdhdGVPcHRpb25zLFxuKTogUHJvbWlzZTxTdW1tYXJ5UHJNZXJnZURlY2lzaW9uPiB7XG4gIGNvbnN0IHsgcmVwbywgcHJOdW1iZXIsIGdoQ29tbWFuZEZuIH0gPSBvcHRpb25zO1xuXG4gIGNvbnN0IGhlYWRSZWZOYW1lID0gb3B0aW9ucy5oZWFkUmVmTmFtZSA/P1xuICAgIGF3YWl0IHJlc29sdmVIZWFkUmVmKHJlcG8sIHByTnVtYmVyLCBnaENvbW1hbmRGbik7XG4gIGlmIChoZWFkUmVmTmFtZSA9PT0gbnVsbCkge1xuICAgIHJldHVybiB7IGRlY2lzaW9uOiBcImFsbG93XCIsIHJlYXNvbjogXCJoZWFkLXVua25vd25cIiB9O1xuICB9XG4gIGlmICghaXNNaWxlc3RvbmVCcmFuY2goaGVhZFJlZk5hbWUpKSB7XG4gICAgcmV0dXJuIHsgZGVjaXNpb246IFwiYWxsb3dcIiwgcmVhc29uOiBcIm5vdC1taWxlc3RvbmUtcHJcIiB9O1xuICB9XG5cbiAgY29uc3QgbWlsZXN0b25lID0gYXdhaXQgZmluZE1pbGVzdG9uZUZvckJyYW5jaChcbiAgICByZXBvLFxuICAgIGhlYWRSZWZOYW1lLFxuICAgIGdoQ29tbWFuZEZuLFxuICApO1xuICBpZiAobWlsZXN0b25lID09PSBudWxsKSB7XG4gICAgcmV0dXJuIHsgZGVjaXNpb246IFwiYWxsb3dcIiwgcmVhc29uOiBcIm1pbGVzdG9uZS1ub3QtZm91bmRcIiB9O1xuICB9XG5cbiAgY29uc3QgY2hpbGRyZW5SZXN1bHQgPSBhd2FpdCBmZXRjaE9wZW5NaWxlc3RvbmVDaGlsZHJlbih7XG4gICAgcmVwbyxcbiAgICBtaWxlc3RvbmVOdW1iZXI6IG1pbGVzdG9uZS5udW1iZXIsXG4gICAgbWlsZXN0b25lQnJhbmNoOiBoZWFkUmVmTmFtZSxcbiAgICBleGNsdWRlUHJOdW1iZXJzOiBbcHJOdW1iZXJdLFxuICAgIC4uLihvcHRpb25zLnZlcmlmaWNhdGlvbiAhPT0gdW5kZWZpbmVkXG4gICAgICA/IHsgdmVyaWZpY2F0aW9uOiBvcHRpb25zLnZlcmlmaWNhdGlvbiB9XG4gICAgICA6IHt9KSxcbiAgICBnaENvbW1hbmRGbixcbiAgfSk7XG4gIGlmICghY2hpbGRyZW5SZXN1bHQub2spIHtcbiAgICByZXR1cm4ge1xuICAgICAgZGVjaXNpb246IFwiYmxvY2tcIixcbiAgICAgIHJlYXNvbjogXCJsb29rdXAtZmFpbGVkXCIsXG4gICAgICBzdGFnZTogXCJvcGVuLWNoaWxkcmVuXCIsXG4gICAgICBtaWxlc3RvbmVOdW1iZXI6IG1pbGVzdG9uZS5udW1iZXIsXG4gICAgICBtaWxlc3RvbmVUaXRsZTogbWlsZXN0b25lLnRpdGxlLFxuICAgICAgbWlsZXN0b25lQnJhbmNoOiBoZWFkUmVmTmFtZSxcbiAgICAgIG1lc3NhZ2U6IGNoaWxkcmVuUmVzdWx0LmVycm9yLm1lc3NhZ2UsXG4gICAgfTtcbiAgfVxuICBpZiAoY2hpbGRyZW5SZXN1bHQudmFsdWUubGVuZ3RoID4gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBkZWNpc2lvbjogXCJibG9ja1wiLFxuICAgICAgcmVhc29uOiBcIm9wZW4tY2hpbGRyZW5cIixcbiAgICAgIG1pbGVzdG9uZU51bWJlcjogbWlsZXN0b25lLm51bWJlcixcbiAgICAgIG1pbGVzdG9uZVRpdGxlOiBtaWxlc3RvbmUudGl0bGUsXG4gICAgICBtaWxlc3RvbmVCcmFuY2g6IGhlYWRSZWZOYW1lLFxuICAgICAgY2hpbGRyZW46IGNoaWxkcmVuUmVzdWx0LnZhbHVlLFxuICAgIH07XG4gIH1cblxuICAvLyBJc3N1ZSAjMzAxNDogbm8gb3BlbiBjaGlsZHJlbiwgYnV0IGEgbWVtYmVyIGlzc3VlIG1heSBzdGlsbCBkZWNsYXJlIGFcbiAgLy8gZGVwZW5kZW5jeSB0aGF0IGhhcyBub3QgbGFuZGVkIG9uIHRoZSB0YXJnZXQgYnJhbmNoLlxuICBjb25zdCBkZXBlbmRlbmNpZXNSZXN1bHQgPSBhd2FpdCBmaW5kUGVuZGluZ01pbGVzdG9uZURlcGVuZGVuY2llcyh7XG4gICAgcmVwbyxcbiAgICBtaWxlc3RvbmVOdW1iZXI6IG1pbGVzdG9uZS5udW1iZXIsXG4gICAgZ2hDb21tYW5kRm4sXG4gIH0pO1xuICBpZiAoIWRlcGVuZGVuY2llc1Jlc3VsdC5vaykge1xuICAgIHJldHVybiB7XG4gICAgICBkZWNpc2lvbjogXCJibG9ja1wiLFxuICAgICAgcmVhc29uOiBcImxvb2t1cC1mYWlsZWRcIixcbiAgICAgIHN0YWdlOiBcImRlY2xhcmVkLWRlcGVuZGVuY2llc1wiLFxuICAgICAgbWlsZXN0b25lTnVtYmVyOiBtaWxlc3RvbmUubnVtYmVyLFxuICAgICAgbWlsZXN0b25lVGl0bGU6IG1pbGVzdG9uZS50aXRsZSxcbiAgICAgIG1pbGVzdG9uZUJyYW5jaDogaGVhZFJlZk5hbWUsXG4gICAgICBtZXNzYWdlOiBkZXBlbmRlbmNpZXNSZXN1bHQuZXJyb3IubWVzc2FnZSxcbiAgICB9O1xuICB9XG4gIGlmIChkZXBlbmRlbmNpZXNSZXN1bHQudmFsdWUubGVuZ3RoID4gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBkZWNpc2lvbjogXCJibG9ja1wiLFxuICAgICAgcmVhc29uOiBcInBlbmRpbmctZGVwZW5kZW5jaWVzXCIsXG4gICAgICBtaWxlc3RvbmVOdW1iZXI6IG1pbGVzdG9uZS5udW1iZXIsXG4gICAgICBtaWxlc3RvbmVUaXRsZTogbWlsZXN0b25lLnRpdGxlLFxuICAgICAgbWlsZXN0b25lQnJhbmNoOiBoZWFkUmVmTmFtZSxcbiAgICAgIGRlcGVuZGVuY2llczogZGVwZW5kZW5jaWVzUmVzdWx0LnZhbHVlLFxuICAgIH07XG4gIH1cblxuICByZXR1cm4geyBkZWNpc2lvbjogXCJhbGxvd1wiLCByZWFzb246IFwibm8tb3Blbi1jaGlsZHJlblwiIH07XG59XG5cbi8qKiBSZWFkIGEgUFIncyBoZWFkIGJyYW5jaC4gUmV0dXJucyBudWxsIHdoZW4gaXQgY2Fubm90IGJlIGRldGVybWluZWQuICovXG5hc3luYyBmdW5jdGlvbiByZXNvbHZlSGVhZFJlZihcbiAgcmVwbzogc3RyaW5nLFxuICBwck51bWJlcjogbnVtYmVyLFxuICBnaENvbW1hbmRGbjogR2hDb21tYW5kRm4sXG4pOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgaWYgKCFSRVBPX1BBVFRFUk4udGVzdChyZXBvKSkgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgY29uc3QgcmF3ID0gYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgICAgXCJwclwiLFxuICAgICAgXCJ2aWV3XCIsXG4gICAgICBTdHJpbmcocHJOdW1iZXIpLFxuICAgICAgXCItLXJlcG9cIixcbiAgICAgIHJlcG8sXG4gICAgICBcIi0tanNvblwiLFxuICAgICAgXCJoZWFkUmVmTmFtZVwiLFxuICAgIF0pO1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KSBhcyB7IGhlYWRSZWZOYW1lPzogdW5rbm93biB9O1xuICAgIHJldHVybiB0eXBlb2YgcGFyc2VkLmhlYWRSZWZOYW1lID09PSBcInN0cmluZ1wiICYmIHBhcnNlZC5oZWFkUmVmTmFtZSAhPT0gXCJcIlxuICAgICAgPyBwYXJzZWQuaGVhZFJlZk5hbWVcbiAgICAgIDogbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLyoqXG4gKiBGaW5kIHRoZSBvcGVuIG1pbGVzdG9uZSB3aG9zZSBicmFuY2ggbmFtZSBpcyBgYnJhbmNoYC5cbiAqXG4gKiBUaGUgbWFwcGluZyBpcyB0aGUgc2FtZSBvbmUgdGhhdCBjcmVhdGVkIHRoZSBicmFuY2hcbiAqICh7QGxpbmsgY3JlYXRlTWlsZXN0b25lQnJhbmNoTmFtZX0pLCBzbyBubyBleHRyYSBtZXRhZGF0YSBpcyBuZWVkZWQuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGZpbmRNaWxlc3RvbmVGb3JCcmFuY2goXG4gIHJlcG86IHN0cmluZyxcbiAgYnJhbmNoOiBzdHJpbmcsXG4gIGdoQ29tbWFuZEZuOiBHaENvbW1hbmRGbixcbik6IFByb21pc2U8UmF3TWlsZXN0b25lIHwgbnVsbD4ge1xuICB0cnkge1xuICAgIGNvbnN0IHJhdyA9IGF3YWl0IGdoQ29tbWFuZEZuKFtcbiAgICAgIFwiYXBpXCIsXG4gICAgICBcIi0tcGFnaW5hdGVcIixcbiAgICAgIGByZXBvcy8ke3JlcG99L21pbGVzdG9uZXM/c3RhdGU9b3BlbiZwZXJfcGFnZT0xMDBgLFxuICAgIF0pO1xuICAgIGNvbnN0IG1pbGVzdG9uZXMgPSBwYXJzZUlzc3VlQXJyYXkocmF3KSBhcyB1bmtub3duIGFzIFJhd01pbGVzdG9uZVtdO1xuICAgIGZvciAoY29uc3QgbWlsZXN0b25lIG9mIG1pbGVzdG9uZXMpIHtcbiAgICAgIGlmICh0eXBlb2YgbWlsZXN0b25lLnRpdGxlICE9PSBcInN0cmluZ1wiKSBjb250aW51ZTtcbiAgICAgIGlmIChjcmVhdGVNaWxlc3RvbmVCcmFuY2hOYW1lKG1pbGVzdG9uZS50aXRsZSkgPT09IGJyYW5jaCkge1xuICAgICAgICByZXR1cm4geyBudW1iZXI6IG1pbGVzdG9uZS5udW1iZXIsIHRpdGxlOiBtaWxlc3RvbmUudGl0bGUgfTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gRXhwbGFuYXRvcnkgY29tbWVudFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogUmVuZGVyIHRoZSBjb21tZW50IHBvc3RlZCBvbiBhIHN1bW1hcnkgUFIgd2hvc2UgbWVyZ2Ugd2FzIGJsb2NrZWQuXG4gKlxuICogRXhwb3J0ZWQgc28gdGVzdHMgY2FuIGFzc2VydCBhZ2FpbnN0IGl0IGRpcmVjdGx5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyT3BlbkNoaWxkcmVuQmxvY2tDb21tZW50KFxuICBtaWxlc3RvbmVUaXRsZTogc3RyaW5nLFxuICBjaGlsZHJlbjogcmVhZG9ubHkgT3Blbk1pbGVzdG9uZUNoaWxkW10sXG4pOiBzdHJpbmcge1xuICAvLyBDaGlsZCB0aXRsZXMgYXJlIGF0dGFja2VyLXdyaXRhYmxlIEdpdEh1YiB0ZXh0IHF1b3RlZCBpbnRvIGEgcHVibGljXG4gIC8vIGNvbW1lbnQgdGhlIHdvcmtlciBzaWducywgc28gdGhleSBhcmUgc2NydWJiZWQgYmVmb3JlIGludGVycG9sYXRpb25cbiAgLy8gKElzc3VlICMxMjQ5LCBmaW5kaW5nIDgpIOKAlCBhbiB1bnNjcnViYmVkIGA8IS0tIOKApiAtLT5gIG1hcmtlciBpbiBhIHRpdGxlXG4gIC8vIGxhbmRzIGluIHRoaXMgYm9keSBhbmQgaXMgcmVhZCBiYWNrIGFzIGEgZ2VudWluZSBtYXJrZXIgb24gYSBsYXRlciBzY2FuLlxuICBjb25zdCBsaXN0ID0gY2hpbGRyZW5cbiAgICAubWFwKChjaGlsZCkgPT5cbiAgICAgIGAtICMke2NoaWxkLm51bWJlcn0gKCR7Y2hpbGQua2luZH0pOiAke3NjcnViVW50cnVzdGVkVGV4dChjaGlsZC50aXRsZSl9YFxuICAgIClcbiAgICAuam9pbihcIlxcblwiKTtcbiAgcmV0dXJuIFtcbiAgICBPUEVOX0NISUxEUkVOX0JMT0NLX01BUktFUixcbiAgICBgIyMgQXV0by1tZXJnZSBibG9ja2VkIOKAlCBtaWxlc3RvbmUgJyR7XG4gICAgICBzY3J1YlVudHJ1c3RlZFRleHQobWlsZXN0b25lVGl0bGUpXG4gICAgfScgc3RpbGwgaGFzIG9wZW4gY2hpbGRyZW5gLFxuICAgIFwiXCIsXG4gICAgXCJNZXJnaW5nIHRoaXMgUFIgZGVsZXRlcyB0aGUgbWlsZXN0b25lIGJyYW5jaCAoYGRlbGV0ZV9icmFuY2hfb25fbWVyZ2VgIFwiICtcbiAgICBcImlzIG9uIGZvciB0aGlzIHJlcG9zaXRvcnkpLCBhbmQgZGVsZXRpbmcgYSBiYXNlIGJyYW5jaCBhdXRvLWNsb3NlcyBcIiArXG4gICAgXCJldmVyeSBQUiBiYXNlZCBvbiBpdC4gVGhlIGZvbGxvd2luZyBjaGlsZHJlbiBhcmUgc3RpbGwgb3Blbiwgc28gdGhlIFwiICtcbiAgICBcIndvcmtlciBoYXMgbm90IG1lcmdlZCB0aGlzIFBSIChJc3N1ZSAjMzkwOSk6XCIsXG4gICAgXCJcIixcbiAgICBsaXN0LFxuICAgIFwiXCIsXG4gICAgXCJUaGlzIFBSIGhhcyBiZWVuIGxlZnQgb3Blbi4gQ2xvc2Ugb3IgbWVyZ2UgdGhlIGNoaWxkcmVuIGFib3ZlIGFuZCB0aGUgXCIgK1xuICAgIFwid29ya2VyIHdpbGwgbWVyZ2UgaXQgb24gYSBsYXRlciBzY2FuIOKAlCBvciBtZXJnZSBpdCBieSBoYW5kIGlmIHlvdSBoYXZlIFwiICtcbiAgICBcImRlY2lkZWQgdGhlIG1pbGVzdG9uZSBpcyBmaW5pc2hlZC5cIixcbiAgXS5qb2luKFwiXFxuXCIpO1xufVxuXG4vKiogT3B0aW9ucyBmb3Ige0BsaW5rIHBvc3RPcGVuQ2hpbGRyZW5CbG9ja0NvbW1lbnR9LiAqL1xuZXhwb3J0IGludGVyZmFjZSBCbG9ja0NvbW1lbnRPcHRpb25zIHtcbiAgcmVwbzogc3RyaW5nO1xuICBwck51bWJlcjogbnVtYmVyO1xuICBtaWxlc3RvbmVUaXRsZTogc3RyaW5nO1xuICBjaGlsZHJlbjogcmVhZG9ubHkgT3Blbk1pbGVzdG9uZUNoaWxkW107XG4gIGdoQ29tbWFuZEZuOiBHaENvbW1hbmRGbjtcbiAgbG9nOiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkO1xuICAvKiogRmxlZXQgaWRlbnRpdHkgaW5wdXRzIGZvciB0aGUgbWFya2VyIGF1dGhvciBjaGVjayAoSXNzdWUgIzEyNDkpLiAqL1xuICBhdXRob3JPcHRpb25zPzogQWxlcnREZWR1cEF1dGhvck9wdGlvbnM7XG59XG5cbi8qKlxuICogV2hldGhlciB0aGUgKipmbGVldCoqIGhhcyBhbHJlYWR5IGxlZnQgYG1hcmtlcmAgb24gdGhpcyBQUiAoSXNzdWUgIzEyNDksXG4gKiBmaW5kaW5nIDMpLlxuICpcbiAqIEJvdGggZXhwbGFuYXRvcnkgY29tbWVudHMgb24gdGhpcyBwYXRoIGFyZSBkZWR1cGxpY2F0ZWQgYnkgdGhlaXIgbWFya2VyLCBhbmRcbiAqIGEgUFIgdGhyZWFkIGlzIG9wZW4gdG8gYW55Ym9keSwgc28gYSBzdHJhbmdlciBxdW90aW5nIHRoZSBtYXJrZXIgc3VwcHJlc3NlZFxuICogdGhlIHB1YmxpYyBleHBsYW5hdGlvbiBvZiB3aHkgYSBtZXJnZSB3YXMgcmVmdXNlZCBvciBhIGJhc2UgcmV3cml0dGVuLiBUaGVcbiAqIGdhdGUgaXRzZWxmIHN0aWxsIHJhbiDigJQgd2hhdCB3ZW50IG1pc3Npbmcgd2FzIHRoZSByZWFzb24sIHdoaWNoIGlzIHRoZSBwYXJ0XG4gKiBhIGh1bWFuIHJlYWRzLiBPbmx5IHRoZSBjb21tZW50IGF1dGhvciBpcyBhdXRoZW50aWNhdGVkLCBzbyB0aGUgcmVhZCBjYXJyaWVzXG4gKiBgLnVzZXIubG9naW5gIGFuZCBldmVyeSBtYXRjaCBpcyBmaWx0ZXJlZCB0aHJvdWdoXG4gKiB7QGxpbmsgc2VsZWN0RmxlZXRBdXRob3JlZENvbW1lbnRzfS5cbiAqXG4gKiBGYWlsIGRpcmVjdGlvbiBpcyAqKnRvd2FyZHMgcG9zdGluZyoqOiBhbiB1bnJlYWRhYmxlIHRocmVhZCBvciBhblxuICogdW5yZXNvbHZhYmxlIGZsZWV0IGlkZW50aXR5IG1lYW5zIG5vIG1hdGNoIGNhbiBiZSBhdHRyaWJ1dGVkLCBzbyB0aGUgY29tbWVudFxuICogZ29lcyBvdXQuIEEgZHVwbGljYXRlIGV4cGxhbmF0aW9uIGlzIG5vaXNlIGEgcmVhZGVyIHNjcm9sbHMgcGFzdDsgYSBtaXNzaW5nXG4gKiBvbmUgaXMgYSBzaWxlbnQgcmVmdXNhbC5cbiAqXG4gKiBAcmV0dXJucyB0cnVlIHdoZW4gYSBmbGVldC1hdXRob3JlZCBjb21tZW50IGFscmVhZHkgY2FycmllcyB0aGUgbWFya2VyLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFzRmxlZXRBdXRob3JlZE1hcmtlcihcbiAgcmVwbzogc3RyaW5nLFxuICBwck51bWJlcjogbnVtYmVyLFxuICBtYXJrZXI6IHN0cmluZyxcbiAgZ2hDb21tYW5kRm46IEdoQ29tbWFuZEZuLFxuICBhdXRob3JPcHRpb25zOiBBbGVydERlZHVwQXV0aG9yT3B0aW9ucyxcbiAgbG9nOiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkLFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IHJhdyA9IGF3YWl0IGdoQ29tbWFuZEZuKFtcbiAgICBcImFwaVwiLFxuICAgIFwiLS1wYWdpbmF0ZVwiLFxuICAgIGByZXBvcy8ke3JlcG99L2lzc3Vlcy8ke3ByTnVtYmVyfS9jb21tZW50cz9wZXJfcGFnZT0xMDBgLFxuICAgIFwiLS1qcVwiLFxuICAgIFwiWy5bXSB8IHthdXRob3I6IC51c2VyLmxvZ2luLCBib2R5OiAuYm9keX1dXCIsXG4gIF0pO1xuXG4gIC8vIEFuIHVucGFyc2VhYmxlIHBheWxvYWQgeWllbGRzIG5vIHJvd3MsIHdoaWNoIGNhbm5vdCBlc3RhYmxpc2ggdGhhdCB0aGVcbiAgLy8gbWFya2VyIGlzIHByZXNlbnQg4oCUIHRoZSBjb21tZW50IGdvZXMgb3V0LlxuICBjb25zdCByb3dzID0gcGFyc2VBdXRob3JlZENvbW1lbnRSb3dzKHJhdywgXCJib2R5XCIpXG4gICAgLmZpbHRlcigocm93KSA9PiByb3cudmFsdWUuaW5jbHVkZXMobWFya2VyKSk7XG5cbiAgY29uc3QgZmxlZXRSb3dzID0gYXdhaXQgc2VsZWN0RmxlZXRBdXRob3JlZENvbW1lbnRzKFxuICAgIHJvd3MsXG4gICAgYG1pbGVzdG9uZSBnYXRlIG1hcmtlciAke21hcmtlcn0gb24gJHtyZXBvfSMke3ByTnVtYmVyfWAsXG4gICAgYXV0aG9yT3B0aW9ucyxcbiAgICBsb2csXG4gICAgXCJ0aGUgZXhwbGFuYXRvcnkgY29tbWVudCBpcyBwb3N0ZWQg4oCUIGEgbWFya2VyIGFueW9uZSBjYW4gcXVvdGUgbXVzdCBub3QgXCIgK1xuICAgICAgXCJzdXBwcmVzcyB0aGUgcmVhc29uIGEgbWVyZ2Ugd2FzIHJlZnVzZWRcIixcbiAgKTtcbiAgcmV0dXJuIGZsZWV0Um93cy5sZW5ndGggPiAwO1xufVxuXG4vKipcbiAqIFdoZXRoZXIgdGhlIGJsb2NrZWQgc3VtbWFyeSBQUiBjYXJyaWVzIHRoZSBnYXRlJ3MgZXhwbGFuYXRpb24gKElzc3VlICMyNDc5KS5cbiAqXG4gKiBgcG9zdGVkYCBhbmQgYGFscmVhZHktcHJlc2VudGAgYm90aCBtZWFuIHRoZSByZWFzb24gaXMgcmVhZGFibGUgb24gdGhlIFBSO1xuICogYHVuY29uZmlybWVkYCBtZWFucyBpdCBpcyBub3Qg4oCUIHRoZSB0aHJlYWQgY291bGQgbm90IGJlIHJlYWQsIG9yIHRoZSBwb3N0XG4gKiBmYWlsZWQg4oCUIHNvIGEgY2FsbGVyIG11c3Qgbm90IHRyZWF0IHRoZSBibG9jayBhcyBleHBsYWluZWQuXG4gKi9cbmV4cG9ydCB0eXBlIE9wZW5DaGlsZHJlbkNvbW1lbnRPdXRjb21lID1cbiAgfCBcInBvc3RlZFwiXG4gIHwgXCJhbHJlYWR5LXByZXNlbnRcIlxuICB8IFwidW5jb25maXJtZWRcIjtcblxuLyoqXG4gKiBQb3N0IHRoZSBleHBsYW5hdG9yeSBjb21tZW50IG9uIHRoZSBibG9ja2VkIHN1bW1hcnkgUFIg4oCUIGV4YWN0bHkgb25jZS5cbiAqXG4gKiBJZGVtcG90ZW5jeSBjb21lcyBmcm9tIHtAbGluayBPUEVOX0NISUxEUkVOX0JMT0NLX01BUktFUn06IHRoZSBleGlzdGluZ1xuICogY29tbWVudHMgYXJlIHJlYWQgZmlyc3QgYW5kIG5vdGhpbmcgaXMgcG9zdGVkIHdoZW4gdGhlIG1hcmtlciBpcyBhbHJlYWR5XG4gKiB0aGVyZSwgc28gYSByZXBlYXRpbmcgc2NhbiBjeWNsZSBkb2VzIG5vdCBzcGFtIHRoZSB0aHJlYWQuIFdoZW4gdGhlIGV4aXN0aW5nXG4gKiBjb21tZW50cyBjYW5ub3QgYmUgcmVhZCwgbm90aGluZyBpcyBwb3N0ZWQgKGEgZHVwbGljYXRlIGNvbW1lbnQgZXZlcnkgY3ljbGVcbiAqIHdvdWxkIGJlIHdvcnNlIHRoYW4gbm9uZSkgYW5kIHRoZSBmYWlsdXJlIGlzIGxvZ2dlZC5cbiAqXG4gKiBAcmV0dXJucyB3aGljaCBvZiB0aGUgdGhyZWUgc3RhdGVzIHRoZSBQUiB0aHJlYWQgZW5kZWQgaW5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHBvc3RPcGVuQ2hpbGRyZW5CbG9ja0NvbW1lbnQoXG4gIG9wdGlvbnM6IEJsb2NrQ29tbWVudE9wdGlvbnMsXG4pOiBQcm9taXNlPE9wZW5DaGlsZHJlbkNvbW1lbnRPdXRjb21lPiB7XG4gIGNvbnN0IGJvZHkgPSByZW5kZXJPcGVuQ2hpbGRyZW5CbG9ja0NvbW1lbnQoXG4gICAgb3B0aW9ucy5taWxlc3RvbmVUaXRsZSxcbiAgICBvcHRpb25zLmNoaWxkcmVuLFxuICApO1xuICByZXR1cm4gYXdhaXQgcG9zdE1hcmtlckRlZHVwZWRCbG9ja0NvbW1lbnQoXG4gICAgb3B0aW9ucyxcbiAgICBPUEVOX0NISUxEUkVOX0JMT0NLX01BUktFUixcbiAgICBib2R5LFxuICAgIFwibWlsZXN0b25lIG9wZW4tY2hpbGRyZW5cIixcbiAgICBcIklzc3VlICMzOTA5XCIsXG4gICk7XG59XG5cbi8qKlxuICogU2hhcmVkIGlkZW1wb3RlbnQgY29tbWVudCBwb3N0ZXIgKElzc3VlICMzMDE0KTogcmVhZCB0aGUgdGhyZWFkIGZvciBhXG4gKiBmbGVldC1hdXRob3JlZCBgbWFya2VyYCwgcG9zdCBgYm9keWAgb25seSB3aGVuIGl0IGlzIGFic2VudC4gRmFjdG9yZWQgb3V0XG4gKiBvZiB7QGxpbmsgcG9zdE9wZW5DaGlsZHJlbkJsb2NrQ29tbWVudH0gc28gdGhlIGRlY2xhcmVkLWRlcGVuZGVuY3kgaG9sZCdzXG4gKiBjb21tZW50IGNhbiByZXVzZSB0aGUgc2FtZSBkZS1kdXBsaWNhdGlvbiBiZWhhdmlvdXIuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHBvc3RNYXJrZXJEZWR1cGVkQmxvY2tDb21tZW50KFxuICBvcHRpb25zOiB7XG4gICAgcmVwbzogc3RyaW5nO1xuICAgIHByTnVtYmVyOiBudW1iZXI7XG4gICAgZ2hDb21tYW5kRm46IEdoQ29tbWFuZEZuO1xuICAgIGxvZzogKG1lc3NhZ2U6IHN0cmluZykgPT4gdm9pZDtcbiAgICBhdXRob3JPcHRpb25zPzogQWxlcnREZWR1cEF1dGhvck9wdGlvbnM7XG4gIH0sXG4gIG1hcmtlcjogc3RyaW5nLFxuICBib2R5OiBzdHJpbmcsXG4gIGRlc2NyaXB0aW9uOiBzdHJpbmcsXG4gIGlzc3VlUmVmOiBzdHJpbmcsXG4pOiBQcm9taXNlPE9wZW5DaGlsZHJlbkNvbW1lbnRPdXRjb21lPiB7XG4gIGNvbnN0IHsgcmVwbywgcHJOdW1iZXIsIGdoQ29tbWFuZEZuLCBsb2cgfSA9IG9wdGlvbnM7XG5cbiAgbGV0IGFscmVhZHlQb3N0ZWQ6IGJvb2xlYW47XG4gIHRyeSB7XG4gICAgYWxyZWFkeVBvc3RlZCA9IGF3YWl0IGhhc0ZsZWV0QXV0aG9yZWRNYXJrZXIoXG4gICAgICByZXBvLFxuICAgICAgcHJOdW1iZXIsXG4gICAgICBtYXJrZXIsXG4gICAgICBnaENvbW1hbmRGbixcbiAgICAgIG9wdGlvbnMuYXV0aG9yT3B0aW9ucyA/PyB7fSxcbiAgICAgIGxvZyxcbiAgICApO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBsb2dBdChcbiAgICAgIGxvZyxcbiAgICAgIFwid2FyblwiLFxuICAgICAgYGNvdWxkIG5vdCByZWFkIGNvbW1lbnRzIG9uICR7cmVwb30jJHtwck51bWJlcn0gdG8gZGUtZHVwbGljYXRlIGAgK1xuICAgICAgICBgdGhlICR7ZGVzY3JpcHRpb259IGJsb2NrIGNvbW1lbnQ6IGAgK1xuICAgICAgICBgJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9ICgke2lzc3VlUmVmfSlgLFxuICAgICk7XG4gICAgcmV0dXJuIFwidW5jb25maXJtZWRcIjtcbiAgfVxuXG4gIGlmIChhbHJlYWR5UG9zdGVkKSB7XG4gICAgcmV0dXJuIFwiYWxyZWFkeS1wcmVzZW50XCI7XG4gIH1cblxuICB0cnkge1xuICAgIGF3YWl0IGdoQ29tbWFuZEZuKFtcbiAgICAgIFwicHJcIixcbiAgICAgIFwiY29tbWVudFwiLFxuICAgICAgU3RyaW5nKHByTnVtYmVyKSxcbiAgICAgIFwiLS1yZXBvXCIsXG4gICAgICByZXBvLFxuICAgICAgXCItLWJvZHlcIixcbiAgICAgIGJvZHksXG4gICAgXSk7XG4gICAgcmV0dXJuIFwicG9zdGVkXCI7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGxvZ0F0KFxuICAgICAgbG9nLFxuICAgICAgXCJ3YXJuXCIsXG4gICAgICBgZmFpbGVkIHRvIHBvc3QgdGhlICR7ZGVzY3JpcHRpb259IGJsb2NrIGNvbW1lbnQgb24gYCArXG4gICAgICAgIGAke3JlcG99IyR7cHJOdW1iZXJ9OiBgICtcbiAgICAgICAgYCR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfSAoJHtpc3N1ZVJlZn0pYCxcbiAgICApO1xuICAgIHJldHVybiBcInVuY29uZmlybWVkXCI7XG4gIH1cbn1cblxuLyoqIE9wdGlvbnMgZm9yIHtAbGluayBwb3N0UGVuZGluZ0RlcGVuZGVuY2llc0Jsb2NrQ29tbWVudH0uICovXG5leHBvcnQgaW50ZXJmYWNlIFBlbmRpbmdEZXBlbmRlbmNpZXNDb21tZW50T3B0aW9ucyB7XG4gIHJlcG86IHN0cmluZztcbiAgcHJOdW1iZXI6IG51bWJlcjtcbiAgbWlsZXN0b25lVGl0bGU6IHN0cmluZztcbiAgZGVwZW5kZW5jaWVzOiByZWFkb25seSBQZW5kaW5nRGVwZW5kZW5jeVtdO1xuICBnaENvbW1hbmRGbjogR2hDb21tYW5kRm47XG4gIGxvZzogKG1lc3NhZ2U6IHN0cmluZykgPT4gdm9pZDtcbiAgLyoqIEZsZWV0IGlkZW50aXR5IGlucHV0cyBmb3IgdGhlIG1hcmtlciBhdXRob3IgY2hlY2sgKElzc3VlICMxMjQ5KS4gKi9cbiAgYXV0aG9yT3B0aW9ucz86IEFsZXJ0RGVkdXBBdXRob3JPcHRpb25zO1xufVxuXG4vKipcbiAqIFBvc3QgdGhlIGRlY2xhcmVkLWRlcGVuZGVuY3kgZXhwbGFuYXRvcnkgY29tbWVudCBvbiB0aGUgaGVsZCBzdW1tYXJ5IFBSIOKAlFxuICogZXhhY3RseSBvbmNlLCBkZWR1cGxpY2F0ZWQgYnkge0BsaW5rIFBFTkRJTkdfREVQRU5ERU5DSUVTX0JMT0NLX01BUktFUn1cbiAqIChJc3N1ZSAjMzAxNCkuIE1pcnJvcnMge0BsaW5rIHBvc3RPcGVuQ2hpbGRyZW5CbG9ja0NvbW1lbnR9LlxuICpcbiAqIEByZXR1cm5zIHdoaWNoIG9mIHRoZSB0aHJlZSBzdGF0ZXMgdGhlIFBSIHRocmVhZCBlbmRlZCBpblxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcG9zdFBlbmRpbmdEZXBlbmRlbmNpZXNCbG9ja0NvbW1lbnQoXG4gIG9wdGlvbnM6IFBlbmRpbmdEZXBlbmRlbmNpZXNDb21tZW50T3B0aW9ucyxcbik6IFByb21pc2U8T3BlbkNoaWxkcmVuQ29tbWVudE91dGNvbWU+IHtcbiAgY29uc3QgYm9keSA9IHJlbmRlclBlbmRpbmdEZXBlbmRlbmNpZXNCbG9ja0NvbW1lbnQoXG4gICAgb3B0aW9ucy5taWxlc3RvbmVUaXRsZSxcbiAgICBbLi4ub3B0aW9ucy5kZXBlbmRlbmNpZXNdLFxuICApO1xuICByZXR1cm4gYXdhaXQgcG9zdE1hcmtlckRlZHVwZWRCbG9ja0NvbW1lbnQoXG4gICAgb3B0aW9ucyxcbiAgICBQRU5ESU5HX0RFUEVOREVOQ0lFU19CTE9DS19NQVJLRVIsXG4gICAgYm9keSxcbiAgICBcIm1pbGVzdG9uZSBwZW5kaW5nLWRlcGVuZGVuY2llc1wiLFxuICAgIFwiSXNzdWUgIzMwMTRcIixcbiAgKTtcbn1cblxuLyoqXG4gKiBSZW5kZXIgdGhlIGxvZyBsaW5lIGZvciBhIGJsb2NrZWQgbWVyZ2UgKHNjb3BlIGl0ZW0gMykuIFdhaXRpbmcgb24gb3BlblxuICogY2hpbGRyZW4gaXMgdGhlIG5vcm1hbCBzdGF0ZSBvZiBhIHN1bW1hcnkgUFIsIHNvIGl0IGNhcnJpZXMgbm8gbGV2ZWxcbiAqIHByZWZpeDsgdGhlIGNhbGxlciBsb2dzIGl0IG9uY2UsIGF0IElORk8gKElzc3VlICM0MDYzKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlckJsb2NrV2FybmluZyhcbiAgcmVwbzogc3RyaW5nLFxuICBwck51bWJlcjogbnVtYmVyLFxuICBtaWxlc3RvbmVOdW1iZXI6IG51bWJlcixcbiAgbWlsZXN0b25lVGl0bGU6IHN0cmluZyxcbiAgY2hpbGRyZW46IHJlYWRvbmx5IE9wZW5NaWxlc3RvbmVDaGlsZFtdLFxuKTogc3RyaW5nIHtcbiAgY29uc3QgbnVtYmVycyA9IGNoaWxkcmVuLm1hcCgoYykgPT4gYCMke2MubnVtYmVyfWApLmpvaW4oXCIsIFwiKTtcbiAgcmV0dXJuIGByZWZ1c2luZyB0byBhdXRvLW1lcmdlIG1pbGVzdG9uZSBzdW1tYXJ5IFBSICR7cmVwb30jJHtwck51bWJlcn0gYCArXG4gICAgYGZvciBtaWxlc3RvbmUgIyR7bWlsZXN0b25lTnVtYmVyfSAnJHttaWxlc3RvbmVUaXRsZX0nIOKAlCBgICtcbiAgICBgJHtjaGlsZHJlbi5sZW5ndGh9IG9wZW4gY2hpbGQvY2hpbGRyZW4gcmVtYWluOiAke251bWJlcnN9IChJc3N1ZSAjMzkwOSlgO1xufVxuXG4vKipcbiAqIFJlbmRlciB0aGUgbG9nIGxpbmUgZm9yIGEgbWVyZ2UgYmxvY2tlZCBvbiBwZW5kaW5nIGRlcGVuZGVuY2llcyAoSXNzdWVcbiAqICMzMDE0KS4gQSBub3JtYWwgd2FpdDogbm8gbGV2ZWwgcHJlZml4LCBsb2dnZWQgb25jZSBhdCBJTkZPIChJc3N1ZSAjNDA2MykuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJQZW5kaW5nRGVwZW5kZW5jaWVzV2FybmluZyhcbiAgcmVwbzogc3RyaW5nLFxuICBwck51bWJlcjogbnVtYmVyLFxuICBtaWxlc3RvbmVOdW1iZXI6IG51bWJlcixcbiAgbWlsZXN0b25lVGl0bGU6IHN0cmluZyxcbiAgZGVwZW5kZW5jaWVzOiByZWFkb25seSBQZW5kaW5nRGVwZW5kZW5jeVtdLFxuKTogc3RyaW5nIHtcbiAgY29uc3QgZGVzY3JpcHRpb25zID0gZGVwZW5kZW5jaWVzLm1hcCgoZGVwKSA9PiBkZXNjcmliZVBlbmRpbmdEZXBlbmRlbmN5KGRlcCkpXG4gICAgLmpvaW4oXCI7IFwiKTtcbiAgcmV0dXJuIGByZWZ1c2luZyB0byBhdXRvLW1lcmdlIG1pbGVzdG9uZSBzdW1tYXJ5IFBSICR7cmVwb30jJHtwck51bWJlcn0gYCArXG4gICAgYGZvciBtaWxlc3RvbmUgIyR7bWlsZXN0b25lTnVtYmVyfSAnJHtcbiAgICAgIHNjcnViVW50cnVzdGVkVGV4dChtaWxlc3RvbmVUaXRsZSlcbiAgICB9JyDigJQgZGVjbGFyZWQgZGVwZW5kZW5jaWVzIGFyZSBub3QgbWVyZ2VkIHlldDogJHtkZXNjcmlwdGlvbnN9IChJc3N1ZSAjMzAxNClgO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIE1pbGVzdG9uZSBCQVNFIGdhdGUgKElzc3VlICM0Mzk2KTogdGhlIG1pcnJvciBpbWFnZSBvZiB0aGUgc3VtbWFyeS1QUiBnYXRlXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBEZWNpc2lvbiBmb3IgbWVyZ2luZyBhIFBSIHdob3NlIEJBU0UgaXMgYSBtaWxlc3RvbmUgYnJhbmNoLlxuICpcbiAqIE9ic2VydmVkIGxpdmU6IHNldmVuIGZpeGVzICgjMzM2NiwgIzMzNjksICMzMzcxLCDigKYpIG1lcmdlZCBpbnRvXG4gKiBgbWlsZXN0b25lL2NsZWFuLXVwYCBlbGV2ZW4gZGF5cyBhZnRlciB0aGF0IG1pbGVzdG9uZSdzIHJvbGx1cCBQUiAjMzEyNVxuICogaGFkIG1lcmdlZCBpbnRvIERldmVsb3AuIFRoZSBicmFuY2gncyBvbmx5IHJvdXRlIHRvIHRoZSBkZWZhdWx0IGJyYW5jaCBoYWRcbiAqIGNsb3NlZDsgdGhlIHdvcmsgZXZhcG9yYXRlZCB3aXRoIHRoZSBicmFuY2gsIGFuZCBldmVyeSBpc3N1ZSBhdXRvLWNsb3NlZFxuICogYXMgQ09NUExFVEVEIGJlY2F1c2UgYSBQUiByZWFsbHkgaGFkIG1lcmdlZC4gTWVyZ2luZyBpbnRvIGEgbWlsZXN0b25lXG4gKiBicmFuY2ggd2hvc2Ugcm9sbHVwIGhhcyBtZXJnZWQsIG9yIHdob3NlIG1pbGVzdG9uZSBpcyBjbG9zZWQsIGlzIHJlZnVzZWRcbiAqIGhlcmUg4oCUIGxvdWQsIG5hbWluZyB0aGUgcm9sbHVwIFBSIOKAlCBzbyB0aGUgY2FsbGVyIGhvbGRzIHRoZSBQUiBvbiBpdHMgYmFzZVxuICogYW5kIG5ldmVyIHJldGFyZ2V0cyBpdCAoSXNzdWUgIzM0MzMpLiBBbiBvcGVuIG1pbGVzdG9uZSB0aGF0IHN0aWxsIGhhc1xuICogb3BlbiB3b3JrIGlzIG5vdCB0aGF0IGNhc2U6IGEgZnJlc2ggcm9sbHVwIGlzIHRoZSByb3V0ZSwgYW5kIGFuIG9wZW5cbiAqIHJvbGx1cCBzdXBlcnNlZGVzIHRoZSBtZXJnZWQgb25lIChJc3N1ZSAjNDE3NSkuXG4gKlxuICogRmFpbHVyZSBwb2xpY3kgbWlycm9ycyB7QGxpbmsgZGVjaWRlU3VtbWFyeVByTWVyZ2V9OiBhIGJhc2UgdGhhdCBpcyBub3RcbiAqIGEgbWlsZXN0b25lIGJyYW5jaCBpcyBhbGxvd2VkIHdpdGhvdXQgYSBsb29rdXA7IGEgbWlsZXN0b25lIGJhc2UgdGhhdFxuICogY2Fubm90IGJlIHZlcmlmaWVkIChyb2xsdXAgb3IgbWlsZXN0b25lIGxvb2t1cCBmYWlsZWQpIEJMT0NLUyDigJQgdGhlIGNvc3RcbiAqIG9mIGEgZmFsc2UgYmxvY2sgaXMgYSByZXRyeSBuZXh0IHNjYW4sIHRoZSBjb3N0IG9mIGEgZmFsc2UgYWxsb3cgaXMgbG9zdFxuICogd29yay5cbiAqL1xuZXhwb3J0IHR5cGUgTWlsZXN0b25lQmFzZU1lcmdlRGVjaXNpb24gPVxuICB8IHtcbiAgICBkZWNpc2lvbjogXCJhbGxvd1wiO1xuICAgIHJlYXNvbjogXCJub3QtbWlsZXN0b25lLWJhc2VcIiB8IFwiYmFzZS11bmtub3duXCIgfCBcInJvdXRlLW9wZW5cIjtcbiAgfVxuICB8IHtcbiAgICAvKipcbiAgICAgKiBUaGUgcm91dGUgY291bGQgbm90IGJlICpyZWFkKiAoSXNzdWUgIzQ3NykuIE5vdCBldmlkZW5jZSBvZlxuICAgICAqIGFueXRoaW5nOiBsZWF2ZSB0aGUgUFIgZXhhY3RseSBhcyBpdCBpcyBhbmQgbG9vayBhZ2FpbiBuZXh0IHNjYW4uXG4gICAgICpcbiAgICAgKiBUaGlzIHVzZWQgdG8gYmUgYSBgYmxvY2tgLCB3aGljaCB0aGVuIHJldGFyZ2V0ZWQgdGhlIFBSIGF0IHRoZSBkZWZhdWx0XG4gICAgICogYnJhbmNoLiBBIEdpdEh1YiByYXRlIGxpbWl0IOKAlCBjZXJ0YWluIHRvIGhhcHBlbiBhY3Jvc3MgYW5cbiAgICAgKiB1bmF0dGVuZGVkIHdlZWtlbmQg4oCUIHRoZXJlZm9yZSByZWZ1c2VkIGV2ZXJ5IG1pbGVzdG9uZSBjaGlsZCwgYW5kXG4gICAgICogYW55IHdob3NlIHJldGFyZ2V0IHN1Y2NlZWRlZCB3YXMgbW92ZWQgb250byB0aGUgcmV2aWV3LWdhdGVkXG4gICAgICogZGVmYXVsdCBicmFuY2ggdG8gd2FpdCBmb3IgYSBodW1hbiB3aG8gd2FzIG5vdCB0aGVyZS4gXCJJIGNvdWxkIG5vdFxuICAgICAqIHJlYWQgaXRcIiBtdXN0IG5ldmVyIGJlIGFjdGlvbmVkIGFzIFwidGhlIHJvdXRlIGhhcyBjbG9zZWRcIi5cbiAgICAgKi9cbiAgICBkZWNpc2lvbjogXCJkZWZlclwiO1xuICAgIC8qKlxuICAgICAqIGBsb29rdXAtZmFpbGVkYCDigJQgdGhlIHJvdXRlIGNvdWxkIG5vdCBiZSByZWFkLlxuICAgICAqIGBtaWxlc3RvbmUtYmVoaW5kYCDigJQgdGhlIHJvdXRlIGlzIG9wZW4gYnV0IHRoZSBtaWxlc3RvbmUgYnJhbmNoIGlzXG4gICAgICogYmVoaW5kIHRoZSBkZWZhdWx0IGJyYW5jaCAoSXNzdWUgIzE3NzkpLCBzbyBhIGNoaWxkIG1lcmdlZCBub3cgd291bGRcbiAgICAgKiBsYW5kIG9uIGEgc3RhbGUgdGlwLiBUaGUgbmV4dCBjeWNsZSdzIG1pbGVzdG9uZSBzeW5jIGNsZWFycyBpdC5cbiAgICAgKi9cbiAgICByZWFzb246IFwibG9va3VwLWZhaWxlZFwiO1xuICAgIG1pbGVzdG9uZUJyYW5jaDogc3RyaW5nO1xuICAgIGRldGFpbDogc3RyaW5nO1xuICB9XG4gIHwge1xuICAgIC8qKlxuICAgICAqIFRoZSByb3V0ZSBpcyBvcGVuLCBidXQgdGhlIG1pbGVzdG9uZSBicmFuY2ggaXMgYmVoaW5kIHRoZSBkZWZhdWx0XG4gICAgICogYnJhbmNoIChJc3N1ZSAjMTc3OSksIHNvIGEgY2hpbGQgbWVyZ2VkIG5vdyB3b3VsZCBsYW5kIG9uIGEgc3RhbGVcbiAgICAgKiB0aXAuIE5vdGhpbmcgaXMgZG9uZSB0byB0aGUgUFI7IHRoZSBuZXh0IGN5Y2xlJ3MgbWlsZXN0b25lIHN5bmMg4oCUIG9yXG4gICAgICogYSByb2xsLWJhY2sg4oCUIGNsZWFycyBpdCBhbmQgdGhlIG5leHQgc3dlZXAgbWVyZ2VzLlxuICAgICAqL1xuICAgIGRlY2lzaW9uOiBcImRlZmVyXCI7XG4gICAgcmVhc29uOiBcIm1pbGVzdG9uZS1iZWhpbmRcIjtcbiAgICBtaWxlc3RvbmVCcmFuY2g6IHN0cmluZztcbiAgICBkZXRhaWw6IHN0cmluZztcbiAgICAvKiogQ29tbWl0cyB0aGUgbWlsZXN0b25lIGJyYW5jaCBpcyBiZWhpbmQgdGhlIGRlZmF1bHQgYnJhbmNoLiAqL1xuICAgIGJlaGluZEJ5OiBudW1iZXI7XG4gIH1cbiAgfCB7XG4gICAgLyoqXG4gICAgICogQSByb2xsdXAgaGFzIG1lcmdlZCBhbmQgbm8gb3BlbiByb2xsdXAgaGFzIHJlcGxhY2VkIGl0LCBidXQgdGhlXG4gICAgICogbWlsZXN0b25lIHN0aWxsIGhhcyBvcGVuIHdvcmsgKElzc3VlICM0MTc1KS4gVGhpcyBnYXRlIGRvZXMgbm90IG1lcmdlXG4gICAgICogdGhlIGNoaWxkLiBUaGUgYXJtaW5nIHBhdGggbGFuZHMgaXQgdGhyb3VnaCB0aGUgb3JkaW5hcnkgbWVyZ2UgY2hlY2tzXG4gICAgICogYW5kIG9wZW5zIHRoZSByb2xsdXAgb25seSBvbmNlIHRoYXQgbWVyZ2UgaGFzIGxhbmRlZC4gTm90IGEgaG9sZDpcbiAgICAgKiBub3RoaW5nIGlzIGRpc2FybWVkIG9yIHJldGFyZ2V0ZWQuXG4gICAgICovXG4gICAgZGVjaXNpb246IFwiZGVmZXJcIjtcbiAgICByZWFzb246IFwicm91dGUtd2FpdGluZ1wiO1xuICAgIG1pbGVzdG9uZUJyYW5jaDogc3RyaW5nO1xuICAgIGRldGFpbDogc3RyaW5nO1xuICB9XG4gIHwge1xuICAgIGRlY2lzaW9uOiBcImJsb2NrXCI7XG4gICAgcmVhc29uOiBcInJvbGx1cC1tZXJnZWRcIiB8IFwibWlsZXN0b25lLWNsb3NlZFwiO1xuICAgIG1pbGVzdG9uZUJyYW5jaDogc3RyaW5nO1xuICAgIHJvbGx1cFByTnVtYmVyPzogbnVtYmVyO1xuICAgIG1pbGVzdG9uZU51bWJlcj86IG51bWJlcjtcbiAgICBtaWxlc3RvbmVUaXRsZT86IHN0cmluZztcbiAgICBkZXRhaWw6IHN0cmluZztcbiAgfTtcblxuLyoqIE9wdGlvbnMgZm9yIHtAbGluayBkZWNpZGVNaWxlc3RvbmVCYXNlTWVyZ2V9LiAqL1xuZXhwb3J0IGludGVyZmFjZSBNaWxlc3RvbmVCYXNlTWVyZ2VHYXRlT3B0aW9ucyB7XG4gIHJlcG86IHN0cmluZztcbiAgcHJOdW1iZXI6IG51bWJlcjtcbiAgLyoqIFRoZSBQUidzIGJhc2UsIHdoZW4gdGhlIGNhbGxlciBhbHJlYWR5IGhhcyBpdCAoc2F2ZXMgYSBgcHIgdmlld2ApLiAqL1xuICBiYXNlUmVmTmFtZT86IHN0cmluZztcbiAgLyoqXG4gICAqIFRoZSBQUidzIGhlYWQsIHdoZW4gdGhlIGNhbGxlciBhbHJlYWR5IGhhcyBpdCAoc2F2ZXMgYSBgcHIgdmlld2ApLlxuICAgKiBSZWFkIG9ubHkgYnkgdGhlIHN5bmNlZC1iYXNlIGNoZWNrLCB0byBleGVtcHQgdGhlIG1pbGVzdG9uZSBzeW5jIFBSXG4gICAqIChJc3N1ZSAjMTc3OSkg4oCUIGV2ZXJ5IHByb2R1Y3Rpb24gY2FsbGVyIGFscmVhZHkgcGFzc2VzIGl0LlxuICAgKi9cbiAgaGVhZFJlZk5hbWU/OiBzdHJpbmc7XG4gIGdoQ29tbWFuZEZuOiBHaENvbW1hbmRGbjtcbiAgLyoqXG4gICAqIEFsc28gcmVxdWlyZSB0aGUgbWlsZXN0b25lIGJyYW5jaCB0byBiZSBsZXZlbCB3aXRoIHRoZSBkZWZhdWx0IGJyYW5jaFxuICAgKiAoSXNzdWUgIzE3NzkpLiBTZXQgYnkgdGhlIHByZS1tZXJnZSBjYWxsZXJzIOKAlCBhcm1pbmcgb3IgbWVyZ2luZyBhIGNoaWxkXG4gICAqIG9udG8gYSBzdGFsZSBtaWxlc3RvbmUgdGlwIGlzIHdoYXQgdGhpcyBnYXRlIHByZXZlbnRzLlxuICAgKlxuICAgKiBMZWZ0IHVuc2V0IGJ5IHRoZSBwb3N0LW1lcmdlIGxhbmRpbmcgY2hlY2sgKGBtZXJnZV9sYW5kaW5nLnRzYCksIHdoaWNoXG4gICAqIGFza3MgYSBkaWZmZXJlbnQgcXVlc3Rpb246IHRoYXQgUFIgaGFzIGFscmVhZHkgbWVyZ2VkLCBhbmQgaG93IGZhciB0aGVcbiAgICogYnJhbmNoIGhhcyBkcmlmdGVkIHNpbmNlIHNheXMgbm90aGluZyBhYm91dCB3aGV0aGVyIGl0cyB3b3JrIGxhbmRlZC5cbiAgICovXG4gIHJlcXVpcmVTeW5jZWRCYXNlPzogYm9vbGVhbjtcbiAgLyoqIERlZmF1bHQgYnJhbmNoLCB3aGVuIHRoZSBjYWxsZXIgYWxyZWFkeSBoYXMgaXQgKHNhdmVzIGEgbG9va3VwKS4gKi9cbiAgZGVmYXVsdEJyYW5jaD86IHN0cmluZztcbiAgLyoqIERlZmF1bHQtYnJhbmNoIGxvb2t1cCBzZWFtIOKAlCB0ZXN0cyBpbmplY3QuICovXG4gIGdldERlZmF1bHRCcmFuY2hGbj86IChyZXBvOiBzdHJpbmcpID0+IFByb21pc2U8UmVzdWx0PHN0cmluZz4+O1xuICAvKiogQ2xvY2sgc2VhbSBmb3IgdGhlIGNvbXBhcmUgbWVtbyBUVEwg4oCUIHRlc3RzIGluamVjdC4gKi9cbiAgbm93TXM/OiAoKSA9PiBudW1iZXI7XG59XG5cbi8qKlxuICogSG93IGxvbmcgb25lIG1pbGVzdG9uZS12cy1kZWZhdWx0IGNvbXBhcmUgaXMgcmV1c2VkIChJc3N1ZSAjMTc3OSkuXG4gKlxuICogTG9uZyBlbm91Z2ggdGhhdCB0aGUgTiBjaGlsZHJlbiBvZiBvbmUgbWlsZXN0b25lIGluIGEgc2luZ2xlIHByaW9yaXR5IDEuNjVcbiAqIHN3ZWVwIGNvc3Qgb25lIEFQSSBjYWxsLCBzaG9ydCBlbm91Z2ggdGhhdCB0aGUgbmV4dCBjeWNsZSdzIG1pbGVzdG9uZSBzeW5jXG4gKiAoSXNzdWUgIzE3NzYpIGlzIHNlZW4gcmF0aGVyIHRoYW4gYSBzdGFsZSBcImJlaGluZFwiIGhvbGRpbmcgdGhlIGNoaWxkcmVuXG4gKiBmb3IgdGhlIGxpZmUgb2YgdGhlIHByb2Nlc3MuXG4gKi9cbmV4cG9ydCBjb25zdCBNSUxFU1RPTkVfQkVISU5EX01FTU9fVFRMX01TID0gNjBfMDAwO1xuXG5pbnRlcmZhY2UgQmVoaW5kTWVtb0VudHJ5IHtcbiAgcmVhZG9ubHkgcmVhZEF0TXM6IG51bWJlcjtcbiAgcmVhZG9ubHkgcmVhZGluZzogQmVoaW5kUmVhZGluZztcbn1cblxuLyoqIEhvdyBmYXIgYSBicmFuY2ggaXMgYmVoaW5kIGl0cyBiYXNlLCBvciB3aHkgdGhhdCBjb3VsZCBub3QgYmUgcmVhZC4gKi9cbmV4cG9ydCB0eXBlIEJlaGluZFJlYWRpbmcgPVxuICB8IHsgb2s6IHRydWU7IGJlaGluZEJ5OiBudW1iZXIgfVxuICB8IHsgb2s6IGZhbHNlOyBkZXRhaWw6IHN0cmluZyB9O1xuXG5jb25zdCBiZWhpbmRNZW1vID0gbmV3IE1hcDxzdHJpbmcsIEJlaGluZE1lbW9FbnRyeT4oKTtcblxuLyoqIENsZWFyIHRoZSBtaWxlc3RvbmUtYmVoaW5kIGNvbXBhcmUgbWVtbyAodGVzdHMpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIF9yZXNldE1pbGVzdG9uZUJlaGluZE1lbW8oKTogdm9pZCB7XG4gIGJlaGluZE1lbW8uY2xlYXIoKTtcbn1cblxuLyoqXG4gKiBEcm9wIHRoZSBjYWNoZWQgY29tcGFyZSBmb3Igb25lIG1pbGVzdG9uZSBicmFuY2ggKElzc3VlICMyMDA1KS5cbiAqXG4gKiBBbiBpbi1jeWNsZSBzeW5jIHRoYXQganVzdCBsYW5kZWQgd291bGQgb3RoZXJ3aXNlIGJlIGhpZGRlbiBieSB0aGUgNjAgc1xuICogbWVtbywgYW5kIHRoZSByZS1hcm0gd291bGQgc3RpbGwgc2VlIHRoZSBzdGFsZSBcImJlaGluZFwiIHJlYWRpbmcuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpbnZhbGlkYXRlTWlsZXN0b25lQmVoaW5kTWVtb0ZvckJyYW5jaChcbiAgcmVwbzogc3RyaW5nLFxuICBtaWxlc3RvbmVCcmFuY2g6IHN0cmluZyxcbik6IHZvaWQge1xuICBjb25zdCBwcmVmaXggPSBgJHtyZXBvfSNgO1xuICBjb25zdCBzdWZmaXggPSBgLi4uJHttaWxlc3RvbmVCcmFuY2h9YDtcbiAgZm9yIChjb25zdCBrZXkgb2YgYmVoaW5kTWVtby5rZXlzKCkpIHtcbiAgICBpZiAoa2V5LnN0YXJ0c1dpdGgocHJlZml4KSAmJiBrZXkuZW5kc1dpdGgoc3VmZml4KSkge1xuICAgICAgYmVoaW5kTWVtby5kZWxldGUoa2V5KTtcbiAgICB9XG4gIH1cbn1cblxuLyoqXG4gKiBDb21taXRzIGBoZWFkYCBpcyBiZWhpbmQgYGJhc2VgLCByZWFkIHdpdGhvdXQgYW55IGNhY2hlIChJc3N1ZSAjMzU5NikuXG4gKlxuICogTmV2ZXIgdGhyb3dzOiBhbiB1bnJlYWRhYmxlIG9yIGVtcHR5IGFuc3dlciBjb21lcyBiYWNrIGFzIGBvazogZmFsc2VgLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVhZENvbXBhcmVCZWhpbmRCeShcbiAgcmVwbzogc3RyaW5nLFxuICBiYXNlOiBzdHJpbmcsXG4gIGhlYWQ6IHN0cmluZyxcbiAgZ2hDb21tYW5kRm46IEdoQ29tbWFuZEZuLFxuKTogUHJvbWlzZTxCZWhpbmRSZWFkaW5nPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgcmF3ID0gYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgICAgXCJhcGlcIixcbiAgICAgIGByZXBvcy8ke3JlcG99L2NvbXBhcmUvJHtiYXNlfS4uLiR7aGVhZH1gLFxuICAgICAgXCItLWpxXCIsXG4gICAgICBcIi5iZWhpbmRfYnlcIixcbiAgICBdKTtcbiAgICAvLyBgTnVtYmVyKFwiXCIpYCBpcyAwLCBzbyBhbiBlbXB0eSBhbnN3ZXIgbXVzdCBiZSByZWplY3RlZCBCRUZPUkUgdGhlXG4gICAgLy8gY29udmVyc2lvbjogcmVhZCBhcyBcImxldmVsIHdpdGggdGhlIGRlZmF1bHQgYnJhbmNoXCIgaXQgd291bGQgYXJtIHRoZVxuICAgIC8vIHZlcnkgbWVyZ2UgdGhpcyBnYXRlIGV4aXN0cyB0byByZWZ1c2UuXG4gICAgY29uc3QgdGV4dCA9IHJhdy50cmltKCk7XG4gICAgY29uc3QgYmVoaW5kQnkgPSB0ZXh0Lmxlbmd0aCA+IDAgPyBOdW1iZXIodGV4dCkgOiBOdW1iZXIuTmFOO1xuICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUoYmVoaW5kQnkpID8geyBvazogdHJ1ZSwgYmVoaW5kQnkgfSA6IHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGRldGFpbDogYGNvbXBhcmUgJHtiYXNlfS4uLiR7aGVhZH0gcmV0dXJuZWQgbm8gYmVoaW5kX2J5YCxcbiAgICB9O1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZGV0YWlsOiBgY291bGQgbm90IGNvbXBhcmUgJHtiYXNlfS4uLiR7aGVhZH06ICR7XG4gICAgICAgIGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKVxuICAgICAgfWAsXG4gICAgfTtcbiAgfVxufVxuXG4vKipcbiAqIENvbW1pdHMgYG1pbGVzdG9uZUJyYW5jaGAgaXMgYmVoaW5kIGBkZWZhdWx0QnJhbmNoYCwgbWVtb2lzZWQgcGVyXG4gKiAocmVwbywgZGVmYXVsdCBicmFuY2gsIG1pbGVzdG9uZSBicmFuY2gpIGZvciB7QGxpbmsgTUlMRVNUT05FX0JFSElORF9NRU1PX1RUTF9NU30uXG4gKlxuICogT3JpZW50YXRpb24gbWF0dGVycyBhbmQgaGFzIGJlZW4gZ290IHdyb25nIGhlcmUgYmVmb3JlIChJc3N1ZSAjNDcwKTogaW5cbiAqIGBjb21wYXJlL3tiYXNlfS4uLntoZWFkfWAgdGhlIHJlc3BvbnNlIGRlc2NyaWJlcyB0aGUgSEVBRCByZWxhdGl2ZSB0byB0aGVcbiAqIGJhc2UsIHNvIHRoZSBtaWxlc3RvbmUgYnJhbmNoIG11c3QgYmUgdGhlIGhlYWQgZm9yIGBiZWhpbmRfYnlgIHRvIG1lYW5cbiAqIFwiYmVoaW5kIHRoZSBkZWZhdWx0IGJyYW5jaFwiLiBXcml0dGVuIHRoZSBvdGhlciB3YXkgcm91bmQgdGhlIGNhbGwgc3RpbGxcbiAqIHN1Y2NlZWRzIGFuZCByZXR1cm5zIHRoZSBhaGVhZCBjb3VudCBpbnN0ZWFkIOKAlCBldmVyeSBoZWFsdGh5IG1pbGVzdG9uZVxuICogYnJhbmNoIHdvdWxkIHRoZW4gcmVhZCBhcyBiZWhpbmQuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlYWRNaWxlc3RvbmVCZWhpbmRCeShcbiAgcmVwbzogc3RyaW5nLFxuICBtaWxlc3RvbmVCcmFuY2g6IHN0cmluZyxcbiAgZGVmYXVsdEJyYW5jaDogc3RyaW5nLFxuICBnaENvbW1hbmRGbjogR2hDb21tYW5kRm4sXG4gIG5vd01zOiAoKSA9PiBudW1iZXIsXG4pOiBQcm9taXNlPEJlaGluZFJlYWRpbmc+IHtcbiAgY29uc3Qga2V5ID0gYCR7cmVwb30jJHtkZWZhdWx0QnJhbmNofS4uLiR7bWlsZXN0b25lQnJhbmNofWA7XG4gIGNvbnN0IG5vdyA9IG5vd01zKCk7XG4gIGNvbnN0IG1lbW8gPSBiZWhpbmRNZW1vLmdldChrZXkpO1xuICBpZiAobWVtbyAmJiBub3cgLSBtZW1vLnJlYWRBdE1zIDwgTUlMRVNUT05FX0JFSElORF9NRU1PX1RUTF9NUykge1xuICAgIHJldHVybiBtZW1vLnJlYWRpbmc7XG4gIH1cbiAgY29uc3QgcmVhZGluZyA9IGF3YWl0IHJlYWRDb21wYXJlQmVoaW5kQnkoXG4gICAgcmVwbyxcbiAgICBkZWZhdWx0QnJhbmNoLFxuICAgIG1pbGVzdG9uZUJyYW5jaCxcbiAgICBnaENvbW1hbmRGbixcbiAgKTtcbiAgYmVoaW5kTWVtby5zZXQoa2V5LCB7IHJlYWRBdE1zOiBub3csIHJlYWRpbmcgfSk7XG4gIHJldHVybiByZWFkaW5nO1xufVxuXG4vKipcbiAqIGBkZWZlci9taWxlc3RvbmUtYmVoaW5kYCB3aGVuIHRoZSBtaWxlc3RvbmUgYnJhbmNoIGlzIGJlaGluZCB0aGUgZGVmYXVsdFxuICogYnJhbmNoLCBgZGVmZXIvbG9va3VwLWZhaWxlZGAgd2hlbiB0aGUgY29tcGFyaXNvbiBjYW5ub3QgYmUgcmVhZCwgYW5kXG4gKiBgbnVsbGAgd2hlbiB0aGUgYnJhbmNoIGlzIGxldmVsIGFuZCB0aGUgbWVyZ2UgbWF5IHByb2NlZWQgKElzc3VlICMxNzc5KS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gZGVmZXJXaGVuTWlsZXN0b25lQmVoaW5kKFxuICBvcHRpb25zOiBNaWxlc3RvbmVCYXNlTWVyZ2VHYXRlT3B0aW9ucyxcbiAgbWlsZXN0b25lQnJhbmNoOiBzdHJpbmcsXG4pOiBQcm9taXNlPEV4dHJhY3Q8TWlsZXN0b25lQmFzZU1lcmdlRGVjaXNpb24sIHsgZGVjaXNpb246IFwiZGVmZXJcIiB9PiB8IG51bGw+IHtcbiAgY29uc3QgeyByZXBvLCBwck51bWJlciwgZ2hDb21tYW5kRm4gfSA9IG9wdGlvbnM7XG5cbiAgLy8gVGhlIG1pbGVzdG9uZSBzeW5jIFBSIGlzIHRoZSB0aGluZyB0aGF0ICpjbGVhcnMqIFwiYmVoaW5kXCI6IGl0cyBiYXNlIGlzXG4gIC8vIHRoZSBtaWxlc3RvbmUgYnJhbmNoIGFuZCBpdHMgaGVhZCBpcyBgc3luYy9taWxlc3RvbmUtKmAuIERlZmVycmluZyBpdFxuICAvLyBmb3IgdGhlIHZlcnkgc3RhdGUgaXQgZXhpc3RzIHRvIGZpeCB3b3VsZCBkZWFkbG9jayB0aGUgbWlsZXN0b25lIOKAlCB0aGVcbiAgLy8gc3luYyBjb3VsZCBuZXZlciBsYW5kLCBzbyB0aGUgYnJhbmNoIGNvdWxkIG5ldmVyIGNhdGNoIHVwLCBzbyBubyBjaGlsZFxuICAvLyBjb3VsZCBldmVyIG1lcmdlLiBJdCBpcyBleGVtcHQsIGFuZCBjb3N0cyBubyBjb21wYXJlIGNhbGwuXG4gIGNvbnN0IGhlYWRSZWZOYW1lID0gb3B0aW9ucy5oZWFkUmVmTmFtZSA/P1xuICAgIGF3YWl0IHJlc29sdmVIZWFkUmVmKHJlcG8sIHByTnVtYmVyLCBnaENvbW1hbmRGbik7XG4gIGlmIChoZWFkUmVmTmFtZSA9PT0gbnVsbCkge1xuICAgIHJldHVybiB7XG4gICAgICBkZWNpc2lvbjogXCJkZWZlclwiLFxuICAgICAgcmVhc29uOiBcImxvb2t1cC1mYWlsZWRcIixcbiAgICAgIG1pbGVzdG9uZUJyYW5jaCxcbiAgICAgIGRldGFpbDpcbiAgICAgICAgYGNvdWxkIG5vdCByZWFkIHRoZSBoZWFkIGJyYW5jaCBvZiAke3JlcG99IyR7cHJOdW1iZXJ9LCBzbyB0aGUgc3luYyBQUiBgICtcbiAgICAgICAgYGNvdWxkIG5vdCBiZSB0b2xkIGZyb20gYSBjaGlsZGAsXG4gICAgfTtcbiAgfVxuICBpZiAoaXNNaWxlc3RvbmVTeW5jQnJhbmNoKGhlYWRSZWZOYW1lKSkgcmV0dXJuIG51bGw7XG5cbiAgbGV0IGRlZmF1bHRCcmFuY2ggPSBvcHRpb25zLmRlZmF1bHRCcmFuY2g7XG4gIGlmICghZGVmYXVsdEJyYW5jaCkge1xuICAgIGNvbnN0IHJlc29sdmVkID0gYXdhaXQgKG9wdGlvbnMuZ2V0RGVmYXVsdEJyYW5jaEZuID8/XG4gICAgICAoKHI6IHN0cmluZykgPT4gZ2V0UmVwb0RlZmF1bHRCcmFuY2gociwgZ2hDb21tYW5kRm4pKSkocmVwbyk7XG4gICAgaWYgKCFyZXNvbHZlZC5vaykge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgZGVjaXNpb246IFwiZGVmZXJcIixcbiAgICAgICAgcmVhc29uOiBcImxvb2t1cC1mYWlsZWRcIixcbiAgICAgICAgbWlsZXN0b25lQnJhbmNoLFxuICAgICAgICBkZXRhaWw6XG4gICAgICAgICAgYGNvdWxkIG5vdCByZXNvbHZlIHRoZSBkZWZhdWx0IGJyYW5jaCBvZiAke3JlcG99OiAke3Jlc29sdmVkLmVycm9yLm1lc3NhZ2V9YCxcbiAgICAgIH07XG4gICAgfVxuICAgIGRlZmF1bHRCcmFuY2ggPSByZXNvbHZlZC52YWx1ZTtcbiAgfVxuICBpZiAoIUJSQU5DSF9QQVRURVJOLnRlc3QoZGVmYXVsdEJyYW5jaCkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgZGVjaXNpb246IFwiZGVmZXJcIixcbiAgICAgIHJlYXNvbjogXCJsb29rdXAtZmFpbGVkXCIsXG4gICAgICBtaWxlc3RvbmVCcmFuY2gsXG4gICAgICBkZXRhaWw6IGBkZWZhdWx0IGJyYW5jaCBcIiR7ZGVmYXVsdEJyYW5jaH1cIiBmYWlsZWQgdGhlIGFyZ3VtZW50IGFsbG93bGlzdGAsXG4gICAgfTtcbiAgfVxuICBjb25zdCByZWFkaW5nID0gYXdhaXQgcmVhZE1pbGVzdG9uZUJlaGluZEJ5KFxuICAgIHJlcG8sXG4gICAgbWlsZXN0b25lQnJhbmNoLFxuICAgIGRlZmF1bHRCcmFuY2gsXG4gICAgZ2hDb21tYW5kRm4sXG4gICAgb3B0aW9ucy5ub3dNcyA/PyBEYXRlLm5vdyxcbiAgKTtcbiAgaWYgKCFyZWFkaW5nLm9rKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGRlY2lzaW9uOiBcImRlZmVyXCIsXG4gICAgICByZWFzb246IFwibG9va3VwLWZhaWxlZFwiLFxuICAgICAgbWlsZXN0b25lQnJhbmNoLFxuICAgICAgZGV0YWlsOiByZWFkaW5nLmRldGFpbCxcbiAgICB9O1xuICB9XG4gIGlmIChyZWFkaW5nLmJlaGluZEJ5IDw9IDApIHJldHVybiBudWxsO1xuICByZXR1cm4ge1xuICAgIGRlY2lzaW9uOiBcImRlZmVyXCIsXG4gICAgcmVhc29uOiBcIm1pbGVzdG9uZS1iZWhpbmRcIixcbiAgICBtaWxlc3RvbmVCcmFuY2gsXG4gICAgYmVoaW5kQnk6IHJlYWRpbmcuYmVoaW5kQnksXG4gICAgZGV0YWlsOiBgJHttaWxlc3RvbmVCcmFuY2h9IGlzICR7cmVhZGluZy5iZWhpbmRCeX0gY29tbWl0JHtcbiAgICAgIHJlYWRpbmcuYmVoaW5kQnkgPT09IDEgPyBcIlwiIDogXCJzXCJcbiAgICB9IGJlaGluZCAke2RlZmF1bHRCcmFuY2h9YCxcbiAgfTtcbn1cblxuaW50ZXJmYWNlIFJhd1JvbGx1cFByIHtcbiAgbnVtYmVyPzogdW5rbm93bjtcbiAgc3RhdGU/OiB1bmtub3duO1xuICBiYXNlUmVmTmFtZT86IHVua25vd247XG4gIG1lcmdlZEF0PzogdW5rbm93bjtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUJhc2VSZWYoXG4gIHJlcG86IHN0cmluZyxcbiAgcHJOdW1iZXI6IG51bWJlcixcbiAgZ2hDb21tYW5kRm46IEdoQ29tbWFuZEZuLFxuKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIGlmICghUkVQT19QQVRURVJOLnRlc3QocmVwbykpIHJldHVybiBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IHJhdyA9IGF3YWl0IGdoQ29tbWFuZEZuKFtcbiAgICAgIFwicHJcIixcbiAgICAgIFwidmlld1wiLFxuICAgICAgU3RyaW5nKHByTnVtYmVyKSxcbiAgICAgIFwiLS1yZXBvXCIsXG4gICAgICByZXBvLFxuICAgICAgXCItLWpzb25cIixcbiAgICAgIFwiYmFzZVJlZk5hbWVcIixcbiAgICBdKTtcbiAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdykgYXMgeyBiYXNlUmVmTmFtZT86IHVua25vd24gfTtcbiAgICByZXR1cm4gdHlwZW9mIHBhcnNlZC5iYXNlUmVmTmFtZSA9PT0gXCJzdHJpbmdcIiAmJiBwYXJzZWQuYmFzZVJlZk5hbWUgIT09IFwiXCJcbiAgICAgID8gcGFyc2VkLmJhc2VSZWZOYW1lXG4gICAgICA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKlxuICogVGhlIHJvdXRlIHRvIHRoZSBkZWZhdWx0IGJyYW5jaCBpcyBvcGVuLiBNZXJnaW5nIG1heSBzdGlsbCBoYXZlIHRvIHdhaXQ6XG4gKiBhIHByZS1tZXJnZSBjYWxsZXIgYWxzbyByZXF1aXJlcyB0aGUgbWlsZXN0b25lIGJyYW5jaCB0byBiZSBsZXZlbCB3aXRoIHRoZVxuICogZGVmYXVsdCBicmFuY2ggKElzc3VlICMxNzc5KS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcm91dGVPcGVuRGVjaXNpb24oXG4gIG9wdGlvbnM6IE1pbGVzdG9uZUJhc2VNZXJnZUdhdGVPcHRpb25zLFxuICBtaWxlc3RvbmVCcmFuY2g6IHN0cmluZyxcbik6IFByb21pc2U8TWlsZXN0b25lQmFzZU1lcmdlRGVjaXNpb24+IHtcbiAgaWYgKG9wdGlvbnMucmVxdWlyZVN5bmNlZEJhc2UgIT09IHRydWUpIHtcbiAgICByZXR1cm4geyBkZWNpc2lvbjogXCJhbGxvd1wiLCByZWFzb246IFwicm91dGUtb3BlblwiIH07XG4gIH1cbiAgcmV0dXJuIGF3YWl0IGRlZmVyV2hlbk1pbGVzdG9uZUJlaGluZChvcHRpb25zLCBtaWxlc3RvbmVCcmFuY2gpID8/XG4gICAgeyBkZWNpc2lvbjogXCJhbGxvd1wiLCByZWFzb246IFwicm91dGUtb3BlblwiIH07XG59XG5cbi8qKlxuICogV2hldGhlciBhIG1lcmdlZCByb2xsdXAgc3RpbGwgY2xvc2VzIHRoZSByb3V0ZSAoSXNzdWUgIzQxNzUpLlxuICpcbiAqIEFuIG9wZW4gbWlsZXN0b25lIHdpdGggb3BlbiB3b3JrIGRvZXMgbm90OiB0aGUgaGlzdG9yaWNhbCByb2xsdXAgaXMgbm90XG4gKiB0aGUgcm91dGUgYW55IG1vcmUsIGFuZCB0aGUgY2FsbGVyIG9wZW5zIGEgZnJlc2ggb25lIHdoZW4gdGhlIGJyYW5jaCBpc1xuICogYWhlYWQuIEEgY2xvc2VkIG1pbGVzdG9uZSwgb3Igb25lIHdpdGggbm8gb3BlbiB3b3JrLCBzdGF5cyBjbG9zZWQuXG4gKiBBbiB1bnJlYWRhYmxlIG1pbGVzdG9uZSBvciBjaGlsZCBsaXN0IGlzIG5vdCBldmlkZW5jZSBlaXRoZXIgd2F5LlxuICovXG5hc3luYyBmdW5jdGlvbiBtZXJnZWRSb2xsdXBDaGlsZFJvdXRlKFxuICBvcHRpb25zOiBNaWxlc3RvbmVCYXNlTWVyZ2VHYXRlT3B0aW9ucyxcbiAgbWlsZXN0b25lQnJhbmNoOiBzdHJpbmcsXG4pOiBQcm9taXNlPFxuICB8IHsga2luZDogXCJvcGVuLXdvcmtcIiB9XG4gIHwgeyBraW5kOiBcImNsb3NlZFwiIH1cbiAgfCB7IGtpbmQ6IFwidW5yZWFkYWJsZVwiOyBkZXRhaWw6IHN0cmluZyB9XG4+IHtcbiAgY29uc3QgeyByZXBvLCBnaENvbW1hbmRGbiB9ID0gb3B0aW9ucztcbiAgbGV0IG1pbGVzdG9uZXM6IEFycmF5PFxuICAgIHsgbnVtYmVyPzogdW5rbm93bjsgdGl0bGU/OiB1bmtub3duOyBzdGF0ZT86IHVua25vd24gfVxuICA+O1xuICB0cnkge1xuICAgIGNvbnN0IHJhdyA9IGF3YWl0IGdoQ29tbWFuZEZuKFtcbiAgICAgIFwiYXBpXCIsXG4gICAgICBcIi0tcGFnaW5hdGVcIixcbiAgICAgIGByZXBvcy8ke3JlcG99L21pbGVzdG9uZXM/c3RhdGU9YWxsJnBlcl9wYWdlPTEwMGAsXG4gICAgXSk7XG4gICAgbWlsZXN0b25lcyA9IFtdO1xuICAgIGZvciAoY29uc3QgaXRlbSBvZiBwYXJzZUpzb25BcnJheVBhZ2VzKHJhdykpIHtcbiAgICAgIGlmIChpdGVtICYmIHR5cGVvZiBpdGVtID09PSBcIm9iamVjdFwiKSB7XG4gICAgICAgIG1pbGVzdG9uZXMucHVzaChcbiAgICAgICAgICBpdGVtIGFzIHsgbnVtYmVyPzogdW5rbm93bjsgdGl0bGU/OiB1bmtub3duOyBzdGF0ZT86IHVua25vd24gfSxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJldHVybiB7XG4gICAgICBraW5kOiBcInVucmVhZGFibGVcIixcbiAgICAgIGRldGFpbDogYGNvdWxkIG5vdCByZWFkIG1pbGVzdG9uZXM6ICR7XG4gICAgICAgIGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKVxuICAgICAgfWAsXG4gICAgfTtcbiAgfVxuICBjb25zdCBtaWxlc3RvbmUgPSBtaWxlc3RvbmVzLmZpbmQoKGl0ZW0pID0+XG4gICAgdHlwZW9mIGl0ZW0udGl0bGUgPT09IFwic3RyaW5nXCIgJiZcbiAgICBjcmVhdGVNaWxlc3RvbmVCcmFuY2hOYW1lKGl0ZW0udGl0bGUpID09PSBtaWxlc3RvbmVCcmFuY2hcbiAgKTtcbiAgaWYgKCFtaWxlc3RvbmUgfHwgbWlsZXN0b25lLnN0YXRlICE9PSBcIm9wZW5cIikgcmV0dXJuIHsga2luZDogXCJjbG9zZWRcIiB9O1xuICBpZiAodHlwZW9mIG1pbGVzdG9uZS5udW1iZXIgIT09IFwibnVtYmVyXCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAga2luZDogXCJ1bnJlYWRhYmxlXCIsXG4gICAgICBkZXRhaWw6IGBtaWxlc3RvbmUgXCIke21pbGVzdG9uZS50aXRsZX1cIiBoYXMgbm8gbnVtYmVyYCxcbiAgICB9O1xuICB9XG4gIGNvbnN0IGNoaWxkcmVuID0gYXdhaXQgZmV0Y2hPcGVuTWlsZXN0b25lQ2hpbGRyZW4oe1xuICAgIHJlcG8sXG4gICAgbWlsZXN0b25lTnVtYmVyOiBtaWxlc3RvbmUubnVtYmVyLFxuICAgIG1pbGVzdG9uZUJyYW5jaCxcbiAgICBnaENvbW1hbmRGbixcbiAgfSk7XG4gIGlmICghY2hpbGRyZW4ub2spIHtcbiAgICByZXR1cm4geyBraW5kOiBcInVucmVhZGFibGVcIiwgZGV0YWlsOiBjaGlsZHJlbi5lcnJvci5tZXNzYWdlIH07XG4gIH1cbiAgcmV0dXJuIGNoaWxkcmVuLnZhbHVlLmxlbmd0aCA+IDAgPyB7IGtpbmQ6IFwib3Blbi13b3JrXCIgfSA6IHsga2luZDogXCJjbG9zZWRcIiB9O1xufVxuXG4vKiogQW4gb3BlbiBwdWxsIHJlcXVlc3QgZnJvbSB0aGUgbWlsZXN0b25lIGJyYW5jaCB0byBhIG5vbi1taWxlc3RvbmUgYmFzZS4gKi9cbmZ1bmN0aW9uIGlzT3BlblJvdXRlUm9sbHVwKHByOiBSYXdSb2xsdXBQcik6IGJvb2xlYW4ge1xuICByZXR1cm4gdHlwZW9mIHByLnN0YXRlID09PSBcInN0cmluZ1wiICYmIHByLnN0YXRlLnRvVXBwZXJDYXNlKCkgPT09IFwiT1BFTlwiICYmXG4gICAgdHlwZW9mIHByLm51bWJlciA9PT0gXCJudW1iZXJcIiAmJlxuICAgICh0eXBlb2YgcHIuYmFzZVJlZk5hbWUgIT09IFwic3RyaW5nXCIgfHwgIWlzTWlsZXN0b25lQnJhbmNoKHByLmJhc2VSZWZOYW1lKSk7XG59XG5cbi8qKiBSZWZ1c2UgYSBtZXJnZSBpbnRvIGEgbWlsZXN0b25lIGJyYW5jaCB3aG9zZSByb3V0ZSB0byB0aGUgZGVmYXVsdCBicmFuY2ggaGFzIGNsb3NlZC4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkZWNpZGVNaWxlc3RvbmVCYXNlTWVyZ2UoXG4gIG9wdGlvbnM6IE1pbGVzdG9uZUJhc2VNZXJnZUdhdGVPcHRpb25zLFxuKTogUHJvbWlzZTxNaWxlc3RvbmVCYXNlTWVyZ2VEZWNpc2lvbj4ge1xuICBjb25zdCB7IHJlcG8sIHByTnVtYmVyLCBnaENvbW1hbmRGbiB9ID0gb3B0aW9ucztcbiAgY29uc3QgYmFzZSA9IG9wdGlvbnMuYmFzZVJlZk5hbWUgPz9cbiAgICBhd2FpdCByZXNvbHZlQmFzZVJlZihyZXBvLCBwck51bWJlciwgZ2hDb21tYW5kRm4pO1xuICBpZiAoYmFzZSA9PT0gbnVsbCkgcmV0dXJuIHsgZGVjaXNpb246IFwiYWxsb3dcIiwgcmVhc29uOiBcImJhc2UtdW5rbm93blwiIH07XG4gIGlmICghaXNNaWxlc3RvbmVCcmFuY2goYmFzZSkpIHtcbiAgICByZXR1cm4geyBkZWNpc2lvbjogXCJhbGxvd1wiLCByZWFzb246IFwibm90LW1pbGVzdG9uZS1iYXNlXCIgfTtcbiAgfVxuICBpZiAoIVJFUE9fUEFUVEVSTi50ZXN0KHJlcG8pIHx8ICFCUkFOQ0hfUEFUVEVSTi50ZXN0KGJhc2UpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGRlY2lzaW9uOiBcImRlZmVyXCIsXG4gICAgICByZWFzb246IFwibG9va3VwLWZhaWxlZFwiLFxuICAgICAgbWlsZXN0b25lQnJhbmNoOiBiYXNlLFxuICAgICAgZGV0YWlsOiBcInJlcG8gb3IgYnJhbmNoIG5hbWUgZmFpbGVkIHRoZSBhcmd1bWVudCBhbGxvd2xpc3RcIixcbiAgICB9O1xuICB9XG5cbiAgLy8gMS4gSGFzIGEgcm9sbHVwIFBSIChoZWFkID0gdGhlIG1pbGVzdG9uZSBicmFuY2gpIGFscmVhZHkgbWVyZ2VkP1xuICBsZXQgcm9sbHVwczogUmF3Um9sbHVwUHJbXTtcbiAgdHJ5IHtcbiAgICBjb25zdCByYXcgPSBhd2FpdCBnaENvbW1hbmRGbihbXG4gICAgICBcInByXCIsXG4gICAgICBcImxpc3RcIixcbiAgICAgIFwiLS1yZXBvXCIsXG4gICAgICByZXBvLFxuICAgICAgXCItLWhlYWRcIixcbiAgICAgIGJhc2UsXG4gICAgICBcIi0tc3RhdGVcIixcbiAgICAgIFwiYWxsXCIsXG4gICAgICBcIi0tanNvblwiLFxuICAgICAgXCJudW1iZXIsc3RhdGUsYmFzZVJlZk5hbWUsbWVyZ2VkQXRcIixcbiAgICAgIFwiLS1saW1pdFwiLFxuICAgICAgXCI1MFwiLFxuICAgIF0pO1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KTtcbiAgICByb2xsdXBzID0gQXJyYXkuaXNBcnJheShwYXJzZWQpID8gcGFyc2VkIGFzIFJhd1JvbGx1cFByW10gOiBbXTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGRlY2lzaW9uOiBcImRlZmVyXCIsXG4gICAgICByZWFzb246IFwibG9va3VwLWZhaWxlZFwiLFxuICAgICAgbWlsZXN0b25lQnJhbmNoOiBiYXNlLFxuICAgICAgZGV0YWlsOiBgY291bGQgbm90IGxpc3Qgcm9sbHVwIFBScyBmb3IgJHtiYXNlfTogJHtcbiAgICAgICAgZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpXG4gICAgICB9YCxcbiAgICB9O1xuICB9XG4gIGNvbnN0IG1lcmdlZCA9IHJvbGx1cHMuZmluZCgocHIpID0+XG4gICAgdHlwZW9mIHByLnN0YXRlID09PSBcInN0cmluZ1wiICYmIHByLnN0YXRlLnRvVXBwZXJDYXNlKCkgPT09IFwiTUVSR0VEXCJcbiAgKTtcbiAgLy8gQW4gb3BlbiByb2xsdXAgaXMgdGhlIHJvdXRlLCBldmVuIGFmdGVyIGFuIG9sZGVyIG9uZSBtZXJnZWQgKElzc3VlXG4gIC8vICM0MTc1KS4gQSBtZXJnZWQgcm9sbHVwIHdpdGggbm8gb3BlbiBzdWNjZXNzb3Igc3RpbGwgY2xvc2VzIHRoZSByb3V0ZS5cbiAgLy8gT3BlbiB3b3JrIGRvZXMgbm90IG1ha2UgaXQgc2FmZSB0byBtZXJnZTogdGhlIGNoaWxkIHN0YXlzIHVuYXJtZWQgdW50aWxcbiAgLy8gYSByb2xsdXAgaXMgb3Blbiwgc28gdGhlIGlzc3VlIGNhbm5vdCBjbG9zZSBvbiBhIGJyYW5jaCB3aXRoIG5vIHJvdXRlLlxuICBpZiAoXG4gICAgIXJvbGx1cHMuc29tZShpc09wZW5Sb3V0ZVJvbGx1cCkgJiYgbWVyZ2VkICYmXG4gICAgdHlwZW9mIG1lcmdlZC5udW1iZXIgPT09IFwibnVtYmVyXCJcbiAgKSB7XG4gICAgY29uc3QgY2hpbGRSb3V0ZSA9IGF3YWl0IG1lcmdlZFJvbGx1cENoaWxkUm91dGUob3B0aW9ucywgYmFzZSk7XG4gICAgaWYgKGNoaWxkUm91dGUua2luZCA9PT0gXCJ1bnJlYWRhYmxlXCIpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGRlY2lzaW9uOiBcImRlZmVyXCIsXG4gICAgICAgIHJlYXNvbjogXCJsb29rdXAtZmFpbGVkXCIsXG4gICAgICAgIG1pbGVzdG9uZUJyYW5jaDogYmFzZSxcbiAgICAgICAgZGV0YWlsOiBjaGlsZFJvdXRlLmRldGFpbCxcbiAgICAgIH07XG4gICAgfVxuICAgIGlmIChjaGlsZFJvdXRlLmtpbmQgIT09IFwib3Blbi13b3JrXCIpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGRlY2lzaW9uOiBcImJsb2NrXCIsXG4gICAgICAgIHJlYXNvbjogXCJyb2xsdXAtbWVyZ2VkXCIsXG4gICAgICAgIG1pbGVzdG9uZUJyYW5jaDogYmFzZSxcbiAgICAgICAgcm9sbHVwUHJOdW1iZXI6IG1lcmdlZC5udW1iZXIsXG4gICAgICAgIGRldGFpbDogYHJvbGx1cCBQUiAjJHttZXJnZWQubnVtYmVyfSAoJHtiYXNlfSDihpIgJHtcbiAgICAgICAgICB0eXBlb2YgbWVyZ2VkLmJhc2VSZWZOYW1lID09PSBcInN0cmluZ1wiID8gbWVyZ2VkLmJhc2VSZWZOYW1lIDogXCI/XCJcbiAgICAgICAgfSkgbWVyZ2VkJHtcbiAgICAgICAgICB0eXBlb2YgbWVyZ2VkLm1lcmdlZEF0ID09PSBcInN0cmluZ1wiID8gYCBhdCAke21lcmdlZC5tZXJnZWRBdH1gIDogXCJcIlxuICAgICAgICB9YCxcbiAgICAgIH07XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBkZWNpc2lvbjogXCJkZWZlclwiLFxuICAgICAgcmVhc29uOiBcInJvdXRlLXdhaXRpbmdcIixcbiAgICAgIG1pbGVzdG9uZUJyYW5jaDogYmFzZSxcbiAgICAgIGRldGFpbDpcbiAgICAgICAgYHJvbGx1cCBQUiAjJHttZXJnZWQubnVtYmVyfSBoYXMgbWVyZ2VkIGFuZCAke2Jhc2V9IGhhcyBubyBvcGVuIHJvbGx1cCwgc28gdGhlIGNoaWxkIHN0YXlzIHVuYXJtZWQgdW50aWwgYSByb2xsdXAgaXMgb3BlbmAsXG4gICAgfTtcbiAgfVxuXG4gIC8vIDIuIElzIHRoZSBtaWxlc3RvbmUgaXRzZWxmIGNsb3NlZD8gKEEgY2xvc2VkIG1pbGVzdG9uZSBoYXMgbm8gcm91dGVcbiAgLy8gICAgZWl0aGVyLCB3aGV0aGVyIG9yIG5vdCBpdHMgcm9sbHVwIFBSIGlzIG9uIHJlY29yZC4pXG4gIHRyeSB7XG4gICAgY29uc3QgcmF3ID0gYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgICAgXCJhcGlcIixcbiAgICAgIFwiLS1wYWdpbmF0ZVwiLFxuICAgICAgYHJlcG9zLyR7cmVwb30vbWlsZXN0b25lcz9zdGF0ZT1hbGwmcGVyX3BhZ2U9MTAwYCxcbiAgICBdKTtcbiAgICAvLyBwYXJzZUlzc3VlQXJyYXkga2VlcHMgbnVtYmVyL3RpdGxlIG9ubHk7IHRoZSBtaWxlc3RvbmUgU1RBVEUgaXMgdGhlXG4gICAgLy8gcG9pbnQgaGVyZSwgc28gcGFyc2UgdGhlIHBhZ2luYXRlZCBhcnJheXMgdGhlIHNhbWUgd2F5IGFuZCBrZWVwIGl0LlxuICAgIGNvbnN0IG1pbGVzdG9uZXM6IEFycmF5PFxuICAgICAgeyBudW1iZXI/OiB1bmtub3duOyB0aXRsZT86IHVua25vd247IHN0YXRlPzogdW5rbm93biB9XG4gICAgPiA9IFtdO1xuICAgIGZvciAoY29uc3QgaXRlbSBvZiBwYXJzZUpzb25BcnJheVBhZ2VzKHJhdykpIHtcbiAgICAgIGlmIChpdGVtICYmIHR5cGVvZiBpdGVtID09PSBcIm9iamVjdFwiKSB7XG4gICAgICAgIG1pbGVzdG9uZXMucHVzaChcbiAgICAgICAgICBpdGVtIGFzIHsgbnVtYmVyPzogdW5rbm93bjsgdGl0bGU/OiB1bmtub3duOyBzdGF0ZT86IHVua25vd24gfSxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gICAgZm9yIChjb25zdCBtaWxlc3RvbmUgb2YgbWlsZXN0b25lcykge1xuICAgICAgaWYgKHR5cGVvZiBtaWxlc3RvbmUudGl0bGUgIT09IFwic3RyaW5nXCIpIGNvbnRpbnVlO1xuICAgICAgaWYgKGNyZWF0ZU1pbGVzdG9uZUJyYW5jaE5hbWUobWlsZXN0b25lLnRpdGxlKSAhPT0gYmFzZSkgY29udGludWU7XG4gICAgICBpZiAobWlsZXN0b25lLnN0YXRlID09PSBcImNsb3NlZFwiKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgZGVjaXNpb246IFwiYmxvY2tcIixcbiAgICAgICAgICByZWFzb246IFwibWlsZXN0b25lLWNsb3NlZFwiLFxuICAgICAgICAgIG1pbGVzdG9uZUJyYW5jaDogYmFzZSxcbiAgICAgICAgICAuLi4odHlwZW9mIG1pbGVzdG9uZS5udW1iZXIgPT09IFwibnVtYmVyXCJcbiAgICAgICAgICAgID8geyBtaWxlc3RvbmVOdW1iZXI6IG1pbGVzdG9uZS5udW1iZXIgfVxuICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgbWlsZXN0b25lVGl0bGU6IG1pbGVzdG9uZS50aXRsZSxcbiAgICAgICAgICBkZXRhaWw6IGBtaWxlc3RvbmUgXCIke21pbGVzdG9uZS50aXRsZX1cIiBpcyBjbG9zZWRgLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgcmV0dXJuIGF3YWl0IHJvdXRlT3BlbkRlY2lzaW9uKG9wdGlvbnMsIGJhc2UpO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGRlY2lzaW9uOiBcImRlZmVyXCIsXG4gICAgICByZWFzb246IFwibG9va3VwLWZhaWxlZFwiLFxuICAgICAgbWlsZXN0b25lQnJhbmNoOiBiYXNlLFxuICAgICAgZGV0YWlsOiBgY291bGQgbm90IHJlYWQgbWlsZXN0b25lczogJHtcbiAgICAgICAgZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpXG4gICAgICB9YCxcbiAgICB9O1xuICB9XG4gIC8vIE5vIG1pbGVzdG9uZSBtYXRjaGVzIHRoZSBicmFuY2ggYW5kIG5vIHJvbGx1cCBtZXJnZWQ6IGFuIG9ycGhhbiBicmFuY2hcbiAgLy8gYnkgYW5vdGhlciByb3V0ZSwgYnV0IHRoZSBtZXJnZSBpdHNlbGYgaXMgbm90IHdoYXQgbG9zZXMgdGhlIHdvcmsuXG4gIHJldHVybiBhd2FpdCByb3V0ZU9wZW5EZWNpc2lvbihvcHRpb25zLCBiYXNlKTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBDbG9zZSBhbiBvcnBoYW4tYm91bmQgUFIgYW5kIHJlZG8gaXRzIHdvcmsgKElzc3VlICM0Mzk2IGdhdGUsIElzc3VlICM0MzA0KVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBPcHRpb25zIGZvciB7QGxpbmsgYWJhbmRvbk9ycGhhbkJvdW5kUHJ9LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBYmFuZG9uT3JwaGFuQm91bmRQck9wdGlvbnMge1xuICByZXBvOiBzdHJpbmc7XG4gIHByTnVtYmVyOiBudW1iZXI7XG4gIC8qKiBUaGUgUFIncyBoZWFkIGJyYW5jaDsgcmVhZCBmcm9tIEdpdEh1YiB3aGVuIHRoZSBjYWxsZXIgaGFzIG5vbmUuICovXG4gIGhlYWRSZWZOYW1lPzogc3RyaW5nO1xuICBnYXRlOiBFeHRyYWN0PE1pbGVzdG9uZUJhc2VNZXJnZURlY2lzaW9uLCB7IGRlY2lzaW9uOiBcImJsb2NrXCIgfT47XG4gIGdoQ29tbWFuZEZuOiBHaENvbW1hbmRGbjtcbiAgbG9nOiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkO1xuICAvKiogRmxlZXQgaWRlbnRpdHkgdGhlIGFiYW5kb24gcmVhZHMgcmVzdGFydCBjbGFpbXMgYWdhaW5zdCAoSXNzdWUgIzEyNDcpLiAqL1xuICBhdXRob3JPcHRpb25zPzogQWxlcnREZWR1cEF1dGhvck9wdGlvbnM7XG4gIC8qKiBBYmFuZG9uIG92ZXJyaWRlICh0ZXN0cyk7IGRlZmF1bHRzIHRvIHtAbGluayBhYmFuZG9uQW5kUmVzdGFydH0uICovXG4gIGFiYW5kb24/OiAoXG4gICAgcmVxdWVzdDogQWJhbmRvblJlc3RhcnRSZXF1ZXN0LFxuICAgIGRlcHM6IEFiYW5kb25SZXN0YXJ0RGVwcyxcbiAgKSA9PiBQcm9taXNlPEFiYW5kb25SZXN0YXJ0T3V0Y29tZT47XG59XG5cbi8qKlxuICogV2h5IHRoZSBQUiBjYW5ub3QgbGFuZCB3aGVyZSBpdCBpcywgYXMgYSBjbGF1c2UgY29tcGxldGluZyBcIlRoaXMgUFIg4oCmXCIuIEl0XG4gKiBpcyBwb3N0ZWQgaW4gdGhlIHRhcmdldCByZXBvLCBzbyBpdCBjYXJyaWVzIG5vIFZpYmVDb2RlciBpc3N1ZSByZWZlcmVuY2Ug4oCUXG4gKiBHaXRIdWIgd291bGQgYXV0b2xpbmsgYSBiYXJlIGAjTmAgdG8gYW4gdW5yZWxhdGVkIGlzc3VlIHRoZXJlIChJc3N1ZSAjMzUwMSkuXG4gKlxuICogQSBjbG9zZWQgbWlsZXN0b25lIGlzIG5hbWVkIGJ5IHRpdGxlIGFuZCBsaW5rZWQgYnkgVVJMLCBuZXZlciBhcyBgI05gOlxuICogR2l0SHViIHdvdWxkIGF1dG9saW5rIHRoYXQgdG8gYW4gdW5yZWxhdGVkIGlzc3VlIG9yIFBSIChJc3N1ZSAjMzY3MykuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXNjcmliZUNsb3NlZFJvdXRlKFxuICBnYXRlOiBFeHRyYWN0PE1pbGVzdG9uZUJhc2VNZXJnZURlY2lzaW9uLCB7IGRlY2lzaW9uOiBcImJsb2NrXCIgfT4sXG4gIHJlcG86IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIGNvbnN0IG1pbGVzdG9uZU5hbWUgPSBnYXRlLm1pbGVzdG9uZVRpdGxlXG4gICAgPyBnYXRlLm1pbGVzdG9uZU51bWJlclxuICAgICAgPyBgWyR7XG4gICAgICAgIGluZXJ0Q29kZVNwYW4oZ2F0ZS5taWxlc3RvbmVUaXRsZSlcbiAgICAgIH1dKGh0dHBzOi8vZ2l0aHViLmNvbS8ke3JlcG99L21pbGVzdG9uZS8ke2dhdGUubWlsZXN0b25lTnVtYmVyfSlgXG4gICAgICA6IGluZXJ0Q29kZVNwYW4oZ2F0ZS5taWxlc3RvbmVUaXRsZSlcbiAgICA6IFwiXCI7XG4gIGNvbnN0IHdoeSA9IGdhdGUucmVhc29uID09PSBcInJvbGx1cC1tZXJnZWRcIlxuICAgID8gYGl0cyByb2xsdXAgUFIgIyR7Z2F0ZS5yb2xsdXBQck51bWJlcn0gaGFzIGFscmVhZHkgbWVyZ2VkYFxuICAgIDogZ2F0ZS5yZWFzb24gPT09IFwibWlsZXN0b25lLWNsb3NlZFwiXG4gICAgPyBgaXRzIG1pbGVzdG9uZSR7bWlsZXN0b25lTmFtZSA/IGAgJHttaWxlc3RvbmVOYW1lfWAgOiBcIlwifSBpcyBjbG9zZWRgXG4gICAgOiBgaXRzIHN0YXRlIGNvdWxkIG5vdCBiZSB2ZXJpZmllZCAoJHtnYXRlLmRldGFpbH0pYDtcbiAgcmV0dXJuIGB0YXJnZXRzIFxcYCR7Z2F0ZS5taWxlc3RvbmVCcmFuY2h9XFxgLCB3aGljaCBoYXMgbm8gcm91dGUgdG8gdGhlIGAgK1xuICAgIGBkZWZhdWx0IGJyYW5jaCBhbnkgbW9yZSDigJQgJHt3aHl9IOKAlCBzbyBtZXJnaW5nIHRoZXJlIHdvdWxkIG9ycGhhbiB0aGUgd29ya2A7XG59XG5cbi8qKlxuICogQSBQUiB3aG9zZSBtaWxlc3RvbmUgYnJhbmNoIGhhcyBubyByb3V0ZSB0byB0aGUgZGVmYXVsdCBicmFuY2ggaXMgbmV2ZXJcbiAqIG1lcmdlZCB0aGVyZSBhbmQgbmV2ZXIgbW92ZWQgdG8gdGhlIGRlZmF1bHQgYnJhbmNoIChhIFBSIG9mZiBhIG1pbGVzdG9uZVxuICogYnJhbmNoIHdvdWxkIGNhcnJ5IHRoZSBtaWxlc3RvbmUncyB3b3JrIHRoZXJlIHdpdGhvdXQgaXRzIGZpbmFsIHJldmlldykuXG4gKiBOb3IgaXMgaXQgbGVmdCBvbiBob2xkIGZvciBhIGh1bWFuIChJc3N1ZSAjNDMwNCk6IGF1dG8tbWVyZ2UgaXMgZGlzYXJtZWQsXG4gKiB0aGVuIHRoZSBQUiBpcyBjbG9zZWQgYW5kIGl0cyBvcmlnaW5hdGluZyBpc3N1ZSByZWRvbmUgdGhyb3VnaFxuICogYGFiYW5kb25BbmRSZXN0YXJ0YCwgc28gdGhlIHdvcmsgY29tZXMgYmFjayBhZ2FpbnN0IHRoZSBjdXJyZW50IGJhc2UuIE9ubHlcbiAqIGEgZ2F0ZSBjYXJyeWluZyBwb3NpdGl2ZSBldmlkZW5jZSDigJQgYSBtZXJnZWQgcm9sbHVwLCBvciBhIGNsb3NlZCBtaWxlc3RvbmUg4oCUXG4gKiByZWFjaGVzIGhlcmU7IGFuIHVucmVhZGFibGUgcm91dGUgZGVmZXJzIGluc3RlYWQgKElzc3VlICM0NzcpLiBOZXZlciB0aHJvd3M6XG4gKiBhbiBhYmFuZG9uIHRoYXQgZG9lcyBub3QgaGFwcGVuIGlzIGxvZ2dlZCBhbmQgdHJpZWQgYWdhaW4gbmV4dCBzY2FuLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYWJhbmRvbk9ycGhhbkJvdW5kUHIoXG4gIG9wdGlvbnM6IEFiYW5kb25PcnBoYW5Cb3VuZFByT3B0aW9ucyxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB7IHJlcG8sIHByTnVtYmVyLCBnYXRlLCBnaENvbW1hbmRGbiwgbG9nIH0gPSBvcHRpb25zO1xuICBsb2dBdChcbiAgICBsb2csXG4gICAgXCJ3YXJuXCIsXG4gICAgYHJlZnVzaW5nIHRvIG1lcmdlICR7cmVwb30jJHtwck51bWJlcn0gaW50byAke2dhdGUubWlsZXN0b25lQnJhbmNofTogJHtnYXRlLmRldGFpbH0gYCArXG4gICAgICBcIuKAlCBhdXRvLW1lcmdlIGRpc2FybWVkOyBjbG9zaW5nIGl0IGFuZCByZWRvaW5nIGl0cyBpc3N1ZSAoSXNzdWUgIzQzMDQpXCIsXG4gICk7XG4gIGF3YWl0IGRpc2FybUF1dG9NZXJnZShyZXBvLCBwck51bWJlciwgZ2hDb21tYW5kRm4sIGxvZyk7XG4gIHRyeSB7XG4gICAgY29uc3QgYnJhbmNoTmFtZSA9IG9wdGlvbnMuaGVhZFJlZk5hbWUgfHxcbiAgICAgIChhd2FpdCBnaENvbW1hbmRGbihbXG4gICAgICAgIFwicHJcIixcbiAgICAgICAgXCJ2aWV3XCIsXG4gICAgICAgIFN0cmluZyhwck51bWJlciksXG4gICAgICAgIFwiLS1yZXBvXCIsXG4gICAgICAgIHJlcG8sXG4gICAgICAgIFwiLS1qc29uXCIsXG4gICAgICAgIFwiaGVhZFJlZk5hbWVcIixcbiAgICAgICAgXCItLWpxXCIsXG4gICAgICAgIFwiLmhlYWRSZWZOYW1lXCIsXG4gICAgICBdKSkudHJpbSgpO1xuICAgIGlmICghYnJhbmNoTmFtZSkgdGhyb3cgbmV3IEVycm9yKFwiaXRzIGhlYWQgYnJhbmNoIGNvdWxkIG5vdCBiZSByZWFkXCIpO1xuICAgIGNvbnN0IHRydXN0ZWRBdXRob3JzID0gYXdhaXQgcmVzb2x2ZUFsZXJ0RGVkdXBBdXRob3JzKFxuICAgICAgb3B0aW9ucy5hdXRob3JPcHRpb25zID8/IHt9LFxuICAgICAgbG9nLFxuICAgICk7XG4gICAgY29uc3Qgb3V0Y29tZSA9IGF3YWl0IChvcHRpb25zLmFiYW5kb24gPz8gYWJhbmRvbkFuZFJlc3RhcnQpKFxuICAgICAge1xuICAgICAgICByZXBvLFxuICAgICAgICBwck51bWJlcixcbiAgICAgICAgYnJhbmNoTmFtZSxcbiAgICAgICAgYmFzZUJyYW5jaDogZ2F0ZS5taWxlc3RvbmVCcmFuY2gsXG4gICAgICAgIHJlYXNvbjoge1xuICAgICAgICAgIGtpbmQ6IFwic3RhbGxlZFwiLFxuICAgICAgICAgIGRldGFpbDogZGVzY3JpYmVDbG9zZWRSb3V0ZShnYXRlLCByZXBvKSxcbiAgICAgICAgICB0cmllZDogXCJyb3V0ZS1jbG9zZWQtaG9sZFwiLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIHsgZ2g6IGdoQ29tbWFuZEZuLCB0cnVzdGVkQXV0aG9ycyB9LFxuICAgICk7XG4gICAgaWYgKG91dGNvbWUub3V0Y29tZSA9PT0gXCJkZWNsaW5lZFwiIHx8IG91dGNvbWUub3V0Y29tZSA9PT0gXCJmYWlsZWRcIikge1xuICAgICAgbG9nQXQoXG4gICAgICAgIGxvZyxcbiAgICAgICAgXCJ3YXJuXCIsXG4gICAgICAgIGBjb3VsZCBub3QgYWJhbmRvbiAke3JlcG99IyR7cHJOdW1iZXJ9ICgke1xuICAgICAgICAgIG91dGNvbWUub3V0Y29tZSA9PT0gXCJkZWNsaW5lZFwiID8gb3V0Y29tZS5yZWFzb24ua2luZCA6IG91dGNvbWUuc3RlcFxuICAgICAgICB9KSDigJQgcmV0cmllZCBuZXh0IHNjYW4gKElzc3VlICM0MzA0KWAsXG4gICAgICApO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgbG9nQXQoXG4gICAgICBsb2csXG4gICAgICBcIndhcm5cIixcbiAgICAgIGBjb3VsZCBub3QgYWJhbmRvbiAke3JlcG99IyR7cHJOdW1iZXJ9OiAke1xuICAgICAgICBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycilcbiAgICAgIH0g4oCUIHJldHJpZWQgbmV4dCBzY2FuIChJc3N1ZSAjNDMwNClgLFxuICAgICk7XG4gIH1cbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBMkJDLEdBR0QsU0FFRSx3QkFBd0IsRUFDeEIsd0JBQXdCLEVBQ3hCLDJCQUEyQixRQUN0QiwyQkFBMkI7QUFDbEMsU0FDRSxpQkFBaUIsUUFJWixnQ0FBZ0M7QUFDdkMsU0FBUyxlQUFlLFFBQVEseUJBQXlCO0FBQ3pELFNBQVMsaUJBQWlCLFFBQVEsOEJBQThCO0FBQ2hFLFNBQVMseUJBQXlCLFFBQVEsa0JBQWtCO0FBQzVELFNBRUUsMEJBQTBCLFFBQ3JCLGtDQUFrQztBQUN6QyxTQUFTLHFCQUFxQixRQUFRLHlCQUF5QjtBQUMvRCxTQUFTLG1CQUFtQixRQUFRLHdCQUF3QjtBQUM1RCxTQUFTLGFBQWEsUUFBUSw2QkFBNkI7QUFDM0QsU0FBUyxrQkFBa0IsUUFBUSx3QkFBd0I7QUFDM0QsU0FBUyxvQkFBb0IsUUFBUSxxQkFBcUI7QUFDMUQsa0VBQWtFO0FBQ2xFLFNBQ0UseUJBQXlCLEVBQ3pCLGdDQUFnQyxFQUNoQyxpQ0FBaUMsRUFFakMscUNBQXFDLFFBQ2hDLGlDQUFpQztBQUN4QyxTQUFTLEtBQUssUUFBUSxnQkFBZ0I7QUFtQnRDOzs7Q0FHQyxHQUNELE9BQU8sTUFBTSw2QkFDWCwrQ0FBK0M7QUFFakQscUVBQXFFLEdBQ3JFLE1BQU0sZUFBZTtBQUVyQiw2RUFBNkUsR0FDN0UsTUFBTSxpQkFBaUI7QUFFdkIsU0FBUyxpQkFBaUIsR0FBRztBQW1DN0I7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
// denoCacheMetadata=6416658735527826035,10457172387243167487