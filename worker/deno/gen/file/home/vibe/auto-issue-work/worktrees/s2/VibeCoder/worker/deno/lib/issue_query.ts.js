/**
 * GitHub API query functions for issue discovery (Issue #910).
 *
 * Replaces worker/shared/issue_query.sh with type-safe TypeScript.
 * Handles all direct GitHub API interactions for issue finding:
 * querying issues, fetching PRs, checking PR blocking, and
 * verifying label authorship for security.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */ import { assignmentIdFromBody, extractClosingIssueNumbers, extractIssueNumberFromPrTitle } from "./pr_body.ts";
import { extractPartOfIssueNumbers, findMissingCriteria } from "./missing_criterion_close_guard.ts";
import { runGhCommand } from "./github.ts";
import { prTitleMatchesIssue, prTitleReferencesIssue } from "./pr_title_issue_ref.ts";
import { isMilestoneSyncBranch } from "./milestone_sync_branch.ts";
import { issueNumberFromBranch } from "./issue_branch_candidates.ts";
// Issue #2900: re-export the single canonical milestone-branch namer from
// git_branch.ts so PR-blocking uses the same branch name the feature PR
// actually targets (50-char slug cap + trailing-hyphen strip).
import { createMilestoneBranchName } from "./git_branch.ts";
import { isHumanAuthoredPr } from "./fleet_authors.ts";
import { normaliseGhAppLogin } from "./trust_exclusions.ts";
export { createMilestoneBranchName };
import { CLOSED_MILESTONE_CACHE_PREFIX } from "./issue_cache.ts";
import { subAgentTierFromBody } from "./pr_body.ts";
import { isWorkerPlanningHandoff } from "./planning_handoff_trust.ts";
// Issue #4037: fold the per-tick issue-list fetch into the access store.
import { classifyProbeFailure } from "./idle_detect_diagnostics.ts";
import { recordRepoProbeBestEffort } from "./monitored_repo_access.ts";
import { validateIssueLabelsJson, validateTimelineLabelEventsJson } from "./validation.ts";
/**
 * Validate a raw `subIssuesSummary` field from `gh issue list` (Issue #3314).
 *
 * Only `total` and `completed` are kept (`percentCompleted` is derivable and
 * not needed); malformed shapes (non-numbers, negatives) return `undefined`
 * so an absent or broken field behaves exactly like an issue with no
 * sub-issues at all.
 */ export function parseSubIssuesSummary(raw) {
  if (!isRecord(raw)) return undefined;
  const { total, completed } = raw;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0 || typeof completed !== "number" || !Number.isFinite(completed) || completed < 0) {
    return undefined;
  }
  return {
    total,
    completed
  };
}
/**
 * Does `issue` have any open native GitHub sub-issues?
 *
 * Lives here (not in `idle_decision_census.ts`, its only prior home) so both
 * the census and the audit (`idle_detect_diagnostics.ts`) can import it
 * without a circular dependency between those two modules (Issue #3314).
 */ export function hasOpenSubIssues(issue) {
  // SIMPLE-ON-PURPOSE: native sub-issue counts only, not body task-list children or not-planned closures (over-holds safely) — upgrade when an inversion alert names a task-list-only or not-planned-closed parent.
  const summary = issue.subIssuesSummary;
  if (summary === undefined) return false;
  return summary.total > summary.completed;
}
/**
 * Refuse to treat a failed gh list call as an empty list (Issue #4257).
 *
 * `runGh`-style wrappers return `""` on failure (rate limit, network,
 * auth). Parsing that leniently yields `[]`, and caching it poisons the
 * shared iteration cache for the TTL — every downstream reader then sees
 * an empty repo (the #3906/#3908 incident shape). A genuine empty list
 * is the two-byte output `[]`; anything empty or unparseable is a failed
 * call and throws before any cache write.
 */ function assertListOutput(output, context) {
  const trimmed = output.trim();
  if (trimmed === "") {
    throw new Error(`${context}: gh returned no output — treating as a failed call, ` + `not an empty list (Issue #4257)`);
  }
  try {
    JSON.parse(trimmed);
  } catch  {
    throw new Error(`${context}: gh output was not valid JSON — treating as a failed ` + `call (Issue #4257)`);
  }
}
/**
 * Parse raw gh issue list JSON into FilterableIssue array.
 *
 * Reject malformed lists and rows with field context before callers can
 * cache an incomplete snapshot (Issue #4124). Optional absent fields retain
 * their existing defaults; malformed supplied values are never skipped.
 *
 * @param jsonStr - Raw JSON string from gh CLI
 * @returns Parsed issues
 * @throws When the output is invalid JSON, not an array, or has a malformed row.
 */ export function parseIssueListJson(jsonStr) {
  assertListOutput(jsonStr, "parseIssueListJson");
  const raw = JSON.parse(jsonStr);
  if (!Array.isArray(raw)) {
    throw new Error("parseIssueListJson: expected a JSON array");
  }
  // Inline runtime shape guard — gh CLI output at trust boundary (Issue #1532).
  const issues = [];
  for (const [index, item] of raw.entries()){
    const reject = (field)=>{
      throw new Error(`parseIssueListJson: row ${index} — malformed ${field} (Issue #4124)`);
    };
    if (!isRecord(item)) reject("row");
    if (typeof item.number !== "number") reject("number");
    if (typeof item.title !== "string") reject("title");
    const author = singleStringField(item.author, "login");
    if (author === null) {
      reject("author");
    }
    const assignees = stringListField(item.assignees, "login");
    if (assignees === null) {
      reject("assignees");
    }
    const labels = stringListField(item.labels, "name");
    if (labels === null) {
      reject("labels");
    }
    const milestone = singleStringField(item.milestone, "title");
    if (milestone === null) {
      reject("milestone");
    }
    const issue = {
      number: item.number,
      title: item.title,
      url: stringOrEmpty(item.url),
      author,
      assignees,
      labels,
      createdAt: stringOrEmpty(item.createdAt),
      updatedAt: stringOrEmpty(item.updatedAt),
      milestone
    };
    // Body is optional in `FilterableIssue`; include it only when present
    // so older cached payloads remain compatible (Issue #1805).
    if (typeof item.body === "string") {
      issue.body = item.body;
    }
    // Issue #3314: GitHub native sub-issue counts, kept only when valid.
    const subIssuesSummary = parseSubIssuesSummary(item.subIssuesSummary);
    if (subIssuesSummary !== undefined) {
      issue.subIssuesSummary = subIssuesSummary;
    }
    issues.push(issue);
  }
  return issues;
}
/** Type guard for plain objects used by inline validators (Issue #1532). */ function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** `""` when absent, the string under `key` when valid, else `null` (Issue #4110). */ function singleStringField(value, key) {
  if (value === undefined || value === null) return "";
  if (!isRecord(value)) return null;
  const inner = value[key];
  return typeof inner === "string" ? inner : null;
}
/** `[]` when absent, the strings under `key` when every element is valid, else `null` (Issue #4110). */ function stringListField(value, key) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const element of value){
    if (!isRecord(element)) return null;
    const inner = element[key];
    if (typeof inner !== "string") return null;
    out.push(inner);
  }
  return out;
}
/** `value` when it is a string, else `""` (Issue #4110). */ function stringOrEmpty(value) {
  return typeof value === "string" ? value : "";
}
/**
 * Parse raw gh pr list JSON into OpenPR array.
 *
 * @param jsonStr - Raw JSON string from gh CLI
 * @returns Parsed PRs
 */ export function parsePRListJson(jsonStr) {
  try {
    const raw = JSON.parse(jsonStr);
    if (!Array.isArray(raw)) return [];
    // Inline runtime shape guard (Issue #1532).
    const items = [];
    for (const item of raw){
      if (!isRecord(item)) continue;
      if (typeof item.number !== "number") continue;
      const entry = {
        number: item.number,
        title: typeof item.title === "string" ? item.title : "",
        baseRefName: typeof item.baseRefName === "string" ? item.baseRefName : "",
        headRefName: typeof item.headRefName === "string" ? item.headRefName : ""
      };
      // Issue #1264: `author` and `headRepositoryOwner` are nested login
      // objects in the `gh` JSON. Only set when actually present, so an
      // absent field stays `undefined` ("unknown") rather than "".
      const author = isRecord(item.author) ? item.author.login : undefined;
      if (typeof author === "string" && author !== "") entry.author = author;
      const headOwner = isRecord(item.headRepositoryOwner) ? item.headRepositoryOwner.login : undefined;
      if (typeof headOwner === "string" && headOwner !== "") {
        entry.headRepositoryOwner = headOwner;
      }
      if (typeof item.isCrossRepository === "boolean") {
        entry.isCrossRepository = item.isCrossRepository;
      }
      if (typeof item.isDraft === "boolean") entry.isDraft = item.isDraft;
      items.push(entry);
    }
    return items;
  } catch  {
    return [];
  }
}
/**
 * Read an `issues_all` cache payload, tolerating the pre-#1486 bare array.
 *
 * A legacy entry carries no limit, so it is treated as the historical
 * default (100) — the conservative reading, which at worst costs one
 * refetch for a wider caller.
 *
 * @param cached - Whatever the cache returned.
 * @returns The normalised entry, or `null` when there was nothing usable.
 */ function readAllIssuesEntry(cached) {
  if (cached === null || cached === undefined) return null;
  if (Array.isArray(cached)) {
    return {
      limit: LEGACY_ALL_ISSUES_LIMIT,
      issues: cached
    };
  }
  if (!isRecord(cached)) return null;
  if (typeof cached.limit !== "number" || !Array.isArray(cached.issues)) {
    return null;
  }
  return {
    limit: cached.limit,
    issues: cached.issues,
    ...typeof cached.rawCount === "number" ? {
      rawCount: cached.rawCount
    } : {}
  };
}
/** Rows in a `gh issue list` payload, or `null` when it is unreadable. */ function countListRows(output) {
  try {
    const parsed = JSON.parse(output.trim() || "[]");
    return Array.isArray(parsed) ? parsed.length : null;
  } catch  {
    return null;
  }
}
/** The `--limit` a pre-#1486 cache entry was written with. */ const LEGACY_ALL_ISSUES_LIMIT = 100;
/**
 * gh < 2.94.0 doesn't know the `subIssuesSummary` field (added in cli/cli
 * v2.94.0's `issueOnlyFields`) and rejects it with this message (Issue
 * #3318). The worker container pins a newer gh, but `docs/SETUP.md`'s
 * `apt-get install -y gh` gives operators 2.4.0 (Ubuntu 22.04), 2.23.0
 * (Debian 12) or 2.45.0 (Ubuntu 24.04) — all too old — and
 * `fetchAllIssues` backs the host-run `diagnose-repo`/`diagnose-issue`
 * commands.
 */ const SUBISSUES_SUMMARY_UNSUPPORTED = /Unknown JSON field: "subIssuesSummary"/;
const ALL_ISSUES_FIELDS = "number,title,assignees,url,labels,createdAt,updatedAt,author,milestone,body,subIssuesSummary";
/** Same fields, without the field gh < 2.94.0 rejects (Issue #3318). */ const ALL_ISSUES_FIELDS_NO_SUB_ISSUES = "number,title,assignees,url,labels,createdAt,updatedAt,author,milestone,body";
function fetchAllIssuesJson(repo, limit, ghCommandFn, fields) {
  return ghCommandFn([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--json",
    fields,
    "--limit",
    String(limit)
  ]);
}
/**
 * Fetch all open issues for a repo with comprehensive fields.
 *
 * Issue #4037: this is the issue-list fetch the Priority 2 scan already
 * performs for every monitored repo on every tick, so its outcome is
 * folded into the per-repo access store (#4036) — no new API call, and
 * the signal stays fresh on busy ticks when the idle-detect audit never
 * runs. Only a real fetch is recorded: a cache hit returns above, since
 * a cached read is not evidence of current access.
 *
 * Issue #1486: the one `issues_all` entry is shared by callers asking for
 * different limits (200 from `find_oldest_issue`, 100 from `stuck_recovery`
 * and `find_planning_issues`). Whichever call ran first used to decide what
 * every later caller saw, so a pass that asked for 200 could silently be
 * handed a 100-issue listing. The limit the entry was fetched with is now
 * stored beside it and a narrower entry is refetched rather than served —
 * unless GitHub returned fewer rows than that limit, which proves the
 * listing was exhaustive.
 *
 * @param repo - Repository in "owner/repo" format
 * @param cache - Optional cache instance
 * @param limit - Maximum issues to fetch (default: 100)
 * @param ghCommandFn - Optional gh command function for testing
 * @returns Array of filterable issues
 */ export async function fetchAllIssues(repo, cache, limit = 100, ghCommandFn = runGhCommand) {
  const cacheKey = "issues_all";
  if (cache) {
    const entry = readAllIssuesEntry(await cache.read(repo, cacheKey));
    // Serve when the cached listing is at least as wide as this request, or
    // when it came back short of its own limit (so nothing was truncated).
    const rows = entry === null ? 0 : entry.rawCount ?? entry.issues.length;
    if (entry !== null && (entry.limit >= limit || rows < entry.limit)) {
      return entry.issues;
    }
  }
  // Issue #1784: include `updatedAt` so stale-workflow can read from this
  // shared cache without triggering its own per-label gh calls.
  // Issue #1805: include `body` so milestone-health dependency detection
  // can read from the shared cache instead of issuing a second
  // `gh issue list --milestone …` call per milestone.
  // Issue #3314: include `subIssuesSummary` so native sub-issue blocking
  // can be read from this call instead of a per-issue one.
  let output;
  try {
    output = await fetchAllIssuesJson(repo, limit, ghCommandFn, ALL_ISSUES_FIELDS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Issue #3318: gh < 2.94.0 rejects `subIssuesSummary` outright. Retry
    // once without it so host-run `diagnose-repo`/`diagnose-issue` keep
    // working on the gh version `docs/SETUP.md` tells operators to
    // `apt-get install`, exactly as they did before Issue #3314.
    if (SUBISSUES_SUMMARY_UNSUPPORTED.test(message)) {
      try {
        output = await fetchAllIssuesJson(repo, limit, ghCommandFn, ALL_ISSUES_FIELDS_NO_SUB_ISSUES);
      } catch (retryErr) {
        const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
        recordRepoProbeBestEffort(repo, classifyProbeFailure(retryMessage));
        throw retryErr;
      }
    } else {
      // Best-effort bookkeeping only: the error is re-thrown untouched so
      // every caller's control flow is exactly what it was before #4037.
      recordRepoProbeBestEffort(repo, classifyProbeFailure(message));
      throw err;
    }
  }
  recordRepoProbeBestEffort(repo, "ok");
  // Never cache a failure (Issue #4257): a runGh-style "" or garbage
  // payload must surface as an error, not as "repo has no open issues".
  assertListOutput(output, `fetchAllIssues(${repo})`);
  // Issue #4110: a non-array root (e.g. `{}`) is a failed call, not `[]`.
  const rawCount = countListRows(output);
  if (rawCount === null) {
    throw new Error(`fetchAllIssues(${repo}): gh output was not a JSON array — treating as a failed call, not an empty list (Issue #4110)`);
  }
  const issues = parseIssueListJson(output);
  if (cache) {
    const entry = {
      limit,
      issues,
      rawCount
    };
    await cache.write(repo, cacheKey, entry);
  }
  return issues;
}
/**
 * Fetch each open milestone's closed-issue count (Issue #2009).
 *
 * Used by issue selection to recognise a *started* milestone — one that
 * already has at least one closed child — without a per-candidate API
 * call. The listing is the same `repos/<repo>/milestones` payload
 * completion already reads; it is cached under `milestones_open_counts`.
 *
 * A missing `closed_issues` field is treated as 0 (not started). A
 * failed or non-array payload throws rather than reading as "no
 * milestones" (Issue #4257).
 *
 * @param repo - Repository in "owner/repo" format
 * @param cache - Optional cache instance
 * @param ghCommandFn - Optional gh command function for testing
 * @returns Map of milestone title → closed-issue count
 */ export async function fetchOpenMilestoneClosedCounts(repo, cache, ghCommandFn = runGhCommand) {
  const cacheKey = "milestones_open_counts";
  if (cache) {
    const cached = await cache.read(repo, cacheKey);
    if (cached) {
      return new Map(cached.map((row)=>[
          row.title,
          row.closed
        ]));
    }
  }
  const output = await ghCommandFn([
    "api",
    `repos/${repo}/milestones?state=open&per_page=100`
  ]);
  assertListOutput(output, `fetchOpenMilestoneClosedCounts(${repo})`);
  const parsed = JSON.parse(output.trim());
  if (!Array.isArray(parsed)) {
    throw new Error(`fetchOpenMilestoneClosedCounts(${repo}): gh output was not a JSON ` + `array — treating as a failed call, not an empty list (Issue #4257)`);
  }
  const rows = [];
  for (const item of parsed){
    if (!isRecord(item)) continue;
    if (typeof item.title !== "string" || item.title === "") continue;
    const closed = typeof item.closed_issues === "number" && Number.isFinite(item.closed_issues) && item.closed_issues >= 0 ? item.closed_issues : 0;
    rows.push({
      title: item.title,
      closed
    });
  }
  if (cache) {
    await cache.write(repo, cacheKey, rows);
  }
  return new Map(rows.map((row)=>[
      row.title,
      row.closed
    ]));
}
/**
 * Default limit for `fetchAllClosedIssues` — wide enough to cover the
 * typical active-milestone backlog across a repo while still bounding
 * the `gh` call cost. Picked to comfortably exceed the pre-#1908
 * per-milestone limit of 200 multiplied by the small number of
 * concurrent active milestones we see in practice.
 */ const CLOSED_ALL_DEFAULT_LIMIT = 500;
/**
 * Fetch all closed issues for a repo in a single batch and cache them
 * under `issues_closed_all` (Issue #1908).
 *
 * Counterpart to `fetchAllIssues` for closed issues. Each entry carries
 * its milestone title so per-milestone callers can filter locally
 * rather than issuing a fresh `gh issue list --milestone …` per
 * milestone scan. The cache key is repo-scoped (no milestone
 * namespacing) so concurrent milestone scans within a single iteration
 * share one round-trip.
 * Command and validation failures propagate without writing to the cache.
 */ export async function fetchAllClosedIssues(repo, cache, limit = CLOSED_ALL_DEFAULT_LIMIT, ghCommandFn = runGhCommand) {
  const cacheKey = "issues_closed_all";
  if (cache) {
    const cached = await cache.read(repo, cacheKey);
    if (cached) return cached;
  }
  const output = await ghCommandFn([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "closed",
    "--json",
    "number,title,milestone,updatedAt",
    "--limit",
    String(limit)
  ]);
  // Share the open-list validator: neither failures nor partial lists are
  // evidence of an empty repository (Issue #4124).
  const issues = parseIssueListJson(output).map((item)=>({
      number: item.number,
      title: item.title,
      milestone: item.milestone || null,
      ...item.updatedAt ? {
        updatedAt: item.updatedAt
      } : {}
    }));
  if (cache) await cache.write(repo, cacheKey, issues);
  return issues;
}
/**
 * Fetch closed issues for a specific milestone, matched by title (Issue #1786,
 * batched via `fetchAllClosedIssues` in Issue #1908).
 *
 * Callers: `milestone_progress.ts` and `milestone_health.ts`. Milestone
 * completion reads by number instead (`fetchClosedIssuesByMilestoneNumber`).
 *
 * Bounded by the 500-issue repo-wide batch: a milestone whose closed issues
 * are older than the newest 500 closed issues in the repo gets none of them
 * back here. For an unbounded read by milestone number, use
 * `fetchClosedIssuesByMilestoneNumber` (Issue #3662).
 *
 * Pre-#1908 this issued one
 * `gh issue list --milestone X --state closed` per milestone; now it
 * filters the shared `fetchAllClosedIssues` batch so concurrent
 * milestone scans within a single iteration share one round-trip.
 *
 * The shape returned (`number, title`) matches the pre-#1908 contract,
 * so callers do not need to change. `updatedAt` is added only when the batch
 * carries it (PR #3640 review), so a row read from an older cache entry keeps
 * the original two-field shape.
 */ export async function fetchClosedIssuesByMilestone(repo, milestoneTitle, cache, ghCommandFn = runGhCommand) {
  const all = await fetchAllClosedIssues(repo, cache, CLOSED_ALL_DEFAULT_LIMIT, ghCommandFn);
  return all.filter((issue)=>issue.milestone === milestoneTitle).map((issue)=>({
      number: issue.number,
      title: issue.title,
      ...issue.updatedAt !== undefined ? {
        updatedAt: issue.updatedAt
      } : {}
    }));
}
/**
 * Fetch every closed issue in one milestone, read by milestone NUMBER through
 * paginated REST (Issue #3662).
 *
 * Unlike `fetchClosedIssuesByMilestone`, this is not bounded by the 500-issue
 * repo-wide batch: `repos/<repo>/issues?milestone=N&state=closed` pages through
 * every closed issue in the milestone, so an older milestone whose issues have
 * fallen out of the newest-first batch still reads in full. Pull requests are
 * dropped by the `--jq` filter.
 *
 * Failure throws, unlike `fetchClosedIssuesByMilestone` which swallows gh
 * failures into an uncached []. A failed read must not look like "no closed
 * issues", so a blank or unparseable page, or a gh error, propagates to the
 * caller. Nothing is cached on a failure.
 *
 * Cache: stored under `issues_closed_milestone_<N>`, one entry per milestone.
 * A worker close or reopen does not carry the milestone number, so
 * `noteGhIssueClose` drops every `issues_closed_milestone_` key in the repo.
 * Otherwise the entry lives until its TTL (600 seconds by default) or until
 * `invalidateRepo` clears the whole repo.
 *
 * @param repo - Repository in "owner/repo" format
 * @param milestoneNumber - The milestone's number, not its title; must be a
 *   positive integer because it is interpolated into a REST path
 * @param cache - Optional file cache, keyed per milestone
 * @param ghCommandFn - Runs `gh` (injectable for testing)
 * @returns Closed issues in the milestone across every page, in page order
 * @throws When `milestoneNumber` is not a positive integer, when gh fails, or
 *   when any page is blank, not JSON, or not an array
 */ export async function fetchClosedIssuesByMilestoneNumber(repo, milestoneNumber, cache, ghCommandFn = runGhCommand) {
  // Checked before any gh call or cache read: the number goes into a REST path.
  if (!Number.isInteger(milestoneNumber) || milestoneNumber <= 0) {
    throw new Error(`fetchClosedIssuesByMilestoneNumber(${repo}): milestone number must be ` + `a positive integer, got ${milestoneNumber}`);
  }
  const cacheKey = `${CLOSED_MILESTONE_CACHE_PREFIX}${milestoneNumber}`;
  const context = `fetchClosedIssuesByMilestoneNumber(${repo}, ${milestoneNumber})`;
  if (cache) {
    const cached = await cache.read(repo, cacheKey);
    if (Array.isArray(cached)) return cached;
  }
  // Errors propagate: no try/catch here, so a failed read is never an [].
  const output = await ghCommandFn([
    "api",
    `repos/${repo}/issues?milestone=${milestoneNumber}&state=closed&per_page=100`,
    "--paginate",
    "--jq",
    '[.[] | select(has("pull_request") | not) | {number, title, updated_at}]'
  ]);
  // `--paginate` prints one JSON array per page, one per line, so the payload
  // is validated line by line: assertListOutput parses the whole string and
  // would reject a multi-page payload. Blank output has no lines at all and
  // must still throw rather than read as "no closed issues" (Issue #4257).
  const lines = output.split("\n").map((line)=>line.trim()).filter((line)=>line.length > 0);
  if (lines.length === 0) {
    throw new Error(`${context}: gh returned no output — treating as a failed call, ` + `not an empty list (Issue #4257)`);
  }
  const issues = [];
  for (const line of lines){
    assertListOutput(line, context);
    const page = JSON.parse(line);
    if (!Array.isArray(page)) {
      throw new Error(`${context}: a page was not a JSON array`);
    }
    for (const item of page){
      if (!isRecord(item) || typeof item.number !== "number") continue;
      issues.push({
        number: item.number,
        title: typeof item.title === "string" ? item.title : "",
        ...typeof item.updated_at === "string" && item.updated_at !== "" ? {
          updatedAt: item.updated_at
        } : {}
      });
    }
  }
  // Written only after every page parsed: a failure above never reaches here.
  if (cache) await cache.write(repo, cacheKey, issues);
  return issues;
}
/**
 * Filter cached open issues to those in a specific milestone
 * (Issue #1786, extended in Issue #1805).
 *
 * Reads through `fetchAllIssues` so the cached `issues_all` payload is
 * reused, then applies a local milestone-title filter. Returns the
 * `OpenMilestoneIssue` shape — `number` and `title` for progress
 * counting plus `assignees` and `body` for milestone-health
 * classification.
 */ export async function fetchOpenIssuesByMilestone(repo, milestoneTitle, cache, ghCommandFn = runGhCommand) {
  const all = await fetchAllIssues(repo, cache, 200, ghCommandFn);
  return all.filter((issue)=>issue.milestone === milestoneTitle).map((issue)=>({
      number: issue.number,
      title: issue.title,
      assignees: issue.assignees ?? [],
      body: issue.body ?? "",
      author: issue.author ?? ""
    }));
}
/**
 * The width of the open-issue listing the claim scan reads, and the most
 * labelled issues one scan collector considers per label per repo (Issue
 * #4464).
 *
 * The idle-decision census counts claimable work from the same listing, so a
 * per-label cap narrower than this width makes the census count work the scan
 * never looks at. The listing is newest-first, so a narrower cap drops the
 * OLDEST labelled issues: the ones the scan is most likely to have missed.
 */ export const SCAN_LABELLED_ISSUE_LIMIT = 200;
/**
 * Fetch issues with a specific label from the shared `issues_all` batch.
 *
 * Filters the cached `fetchAllIssues` payload locally — one gh call per
 * repo regardless of how many labels are queried within the TTL window.
 *
 * Issue #1909: removed the per-label fallback that fired when the batch
 * was empty. On a quiet repo (zero open issues) the fallback issued one
 * `gh issue list --label X` per label per iteration without any chance
 * of returning a match — the batch is the source of truth, and an empty
 * batch means there are no labelled issues to find.
 *
 * Known limitation: the listing is requested at a width of
 * `Math.max(100, limit)` (Issue #4464), so a caller asking for more than
 * 100 labelled issues is not silently cut to the 100-issue default on a cold
 * cache. A repo with more open issues than that width whose labelled subset
 * falls outside the newest ones will under-report here. The scan collectors
 * pass {@link SCAN_LABELLED_ISSUE_LIMIT}, the same width as the scan's own
 * listing, so they do not inherit that limit. The census reads that same
 * listing, so a narrower request here would let the scan miss work it counts.
 *
 * @param repo - Repository in "owner/repo" format
 * @param label - Label to filter by
 * @param cache - Optional cache instance
 * @param limit - Maximum issues to return (default: 50). The listing filtered
 *   is requested at `Math.max(100, limit)`, so a limit above 100 is honoured.
 * @param ghCommandFn - Optional gh command function for testing
 * @returns Issues with the specified label
 */ export async function fetchIssuesByLabel(repo, label, cache, limit = 50, ghCommandFn = runGhCommand) {
  const allIssues = await fetchAllIssues(repo, cache, Math.max(100, limit), ghCommandFn);
  return allIssues.filter((issue)=>issue.labels.includes(label)).slice(0, limit);
}
/**
 * Fetch open PRs by user with base/head branch info.
 *
 * @param repo - Repository in "owner/repo" format
 * @param githubUser - GitHub username
 * @param cache - Optional cache instance
 * @param ghCommandFn - Optional gh command function for testing
 * @param forceRefresh - When true, bypass the cache read and fetch live
 *   from GitHub, then overwrite the cache with the fresh result (Issue
 *   #3150). Used by the live claim-time re-check so a stale `prs_${user}`
 *   entry written at discovery cannot hide a just-opened sibling PR.
 * @returns Array of open PRs
 */ export async function fetchOpenPRsByUser(repo, githubUser, cache, ghCommandFn = runGhCommand, forceRefresh = false) {
  const cacheKey = `prs_${githubUser}`;
  if (cache && !forceRefresh) {
    const cached = await cache.read(repo, cacheKey);
    if (cached) return cached;
  }
  const output = await ghCommandFn([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--author",
    githubUser,
    "--json",
    // Issue #1800: `isDraft` lets the auto-merge sweep skip a draft PR
    // instead of failing to arm it every cycle.
    "number,title,baseRefName,headRefName,isDraft",
    "--limit",
    String(OPEN_PR_BY_USER_LIMIT)
  ]);
  // Issue #4024: stamp the queried author onto each PR so a blocking
  // decision can report who owns the PR and whether the PR-maintenance
  // scans cover them.
  const prs = parsePRListJson(output).map((pr)=>({
      ...pr,
      author: githubUser
    }));
  if (cache) await cache.write(repo, cacheKey, prs);
  return prs;
}
/**
 * Fetch open PRs across every fleet account (Issue #3100).
 *
 * The open-PR duplicate guard must see PRs raised by *any* fleet account,
 * not just the current host — otherwise a second host opens a duplicate PR
 * for the same issue (Issue #3095). This calls `fetchOpenPRsByUser` once per
 * distinct author and concatenates the results, de-duplicating by PR number.
 *
 * Reusing the per-author helper keeps the per-user cache keys (`prs_${user}`)
 * intact and needs no new GitHub JSON fields. Empty/blank authors are skipped.
 *
 * @param repo - Repository in "owner/repo" format
 * @param authors - Fleet GitHub usernames (deduplicated internally)
 * @param cache - Optional cache instance
 * @param ghCommandFn - Optional gh command function for testing
 * @param perAuthorOut - Optional map populated with each author's open-PR
 *   count (Issue #3138 guard observability). Keyed by the author login as
 *   supplied; existing keys are overwritten.
 * @param forceRefresh - When true, bypass the per-user cache read and fetch
 *   each author's PRs live (Issue #3150). Threaded through to
 *   `fetchOpenPRsByUser` so the live claim-time re-check sees just-opened
 *   sibling PRs regardless of a stale discovery-time cache entry.
 * @returns De-duplicated array of open PRs across all fleet authors
 */ export async function fetchOpenPRsForFleet(repo, authors, cache, ghCommandFn = runGhCommand, perAuthorOut, forceRefresh = false) {
  const distinctAuthors = [
    ...new Set(authors.filter((a)=>a && a.trim().length > 0))
  ];
  const seen = new Set();
  const merged = [];
  for (const author of distinctAuthors){
    const prs = await fetchOpenPRsByUser(repo, author, cache, ghCommandFn, forceRefresh);
    if (perAuthorOut) perAuthorOut[author] = prs.length;
    for (const pr of prs){
      if (!seen.has(pr.number)) {
        seen.add(pr.number);
        merged.push(pr);
      }
    }
  }
  return merged;
}
/**
 * `--json` fields the un-filtered open-PR listing requests (Issue #1846).
 *
 * One listing per repo per cycle serves every consumer, so the field set is
 * the union of what they need: the branch/body fields the PR-link and
 * branch-cleanup helpers read, plus the author and head-ownership fields
 * the bot-PR lookup (`pr_bot_lookup.ts`) decides admission on.
 */ const OPEN_PR_LIST_FIELDS = "number,title,baseRefName,headRefName,body,url,author," + "isCrossRepository,headRefOid,autoMergeRequest,mergeable";
/**
 * {@link OPEN_PR_LIST_FIELDS} plus `labels`, for the one all-authors listing
 * (Issue #2409). Kept off the per-author listings deliberately: nothing reads
 * labels there, and their field list is shared with the cross-repo prefetch.
 */ const ALL_OPEN_PR_LIST_FIELDS = `${OPEN_PR_LIST_FIELDS},labels`;
/**
 * Fetch all open PRs for a repo, regardless of author (Issue #1787).
 *
 * Used by helpers that need to look up PRs by head branch or by issue
 * reference in the title without restricting to worker-authored PRs.
 * Cache key is `prs_open_all`; pair with the iteration-scoped
 * `IssueCache` so the per-iteration `gh pr list` count drops to one.
 */ export async function fetchAllOpenPRs(repo, cache, limit = 50, ghCommandFn = runGhCommand) {
  const cacheKey = "prs_open_all";
  if (cache) {
    const cached = await cache.read(repo, cacheKey);
    if (cached) return cached;
  }
  const output = await ghCommandFn([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--json",
    ALL_OPEN_PR_LIST_FIELDS,
    "--limit",
    String(limit)
  ]);
  // Never cache a failure (Issue #4257): "no open PRs" is the answer that
  // marks a branch deletion safe, so a failed call must throw rather than
  // masquerade as it.
  assertListOutput(output, `fetchAllOpenPRs(${repo})`);
  const parsed = JSON.parse(output.trim());
  if (!Array.isArray(parsed)) {
    // Same rule as the empty/unparseable output above (Issue #1846): an
    // object payload is `gh` reporting a failure (`{"message":"Not Found"}`),
    // not a repo with no open PRs. Throw rather than let it read as one.
    throw new Error(`fetchAllOpenPRs(${repo}): gh output was not a JSON array — ` + `treating as a failed call, not an empty list (Issue #4257)`);
  }
  const prs = [];
  for (const item of parsed){
    if (!isRecord(item)) continue;
    if (typeof item.number !== "number") continue;
    const pr = {
      number: item.number,
      title: typeof item.title === "string" ? item.title : "",
      baseRefName: typeof item.baseRefName === "string" ? item.baseRefName : "",
      headRefName: typeof item.headRefName === "string" ? item.headRefName : "",
      body: typeof item.body === "string" ? item.body : "",
      url: typeof item.url === "string" ? item.url : ""
    };
    // Issue #1846: carried only when `gh` actually reported them, so an
    // absent field stays "unknown" rather than becoming a false negative.
    // Issue #4719: `gh` reports a GitHub App author as `app/<slug>` with
    // `is_bot: true`. Only that shape is rewritten, so an ordinary user's
    // login is never changed.
    const author = isRecord(item.author) ? item.author : undefined;
    const login = typeof author?.login === "string" ? author.login.trim() : "";
    if (login !== "") {
      pr.authorLogin = author?.is_bot === true ? normaliseGhAppLogin(login) : login;
    }
    if (typeof item.isCrossRepository === "boolean") {
      pr.isCrossRepository = item.isCrossRepository;
    }
    if (typeof item.headRefOid === "string") pr.headRefOid = item.headRefOid;
    if (typeof item.mergeable === "string") pr.mergeable = item.mergeable;
    if (item.autoMergeRequest === null) {
      pr.autoMergeRequest = null;
    } else if (isRecord(item.autoMergeRequest)) {
      const method = item.autoMergeRequest.mergeMethod;
      pr.autoMergeRequest = {
        mergeMethod: typeof method === "string" ? method : ""
      };
    }
    // Issue #2409: label names, tolerating a row with none or with junk.
    pr.labels = Array.isArray(item.labels) ? item.labels.flatMap((label)=>isRecord(label) && typeof label.name === "string" ? [
        label.name
      ] : []) : [];
    prs.push(pr);
  }
  if (cache) await cache.write(repo, cacheKey, prs);
  return prs;
}
// ---------------------------------------------------------------------------
// Settled PR listings (Issue #2409)
// ---------------------------------------------------------------------------
/**
 * How long a merged/closed per-author listing may be served while nothing
 * observable could have changed it (Issue #2409).
 */ export const SETTLED_PR_LISTING_MAX_AGE_SECONDS = 3600;
/** Inside this age a settled listing is served as it always was. */ const SETTLED_PR_LISTING_FRESH_SECONDS = 600;
/**
 * The `--limit` `fetchOpenPRsByUser` passes to `gh pr list`. A full listing is
 * truncated, so `openPrNumbersByUser` treats one as unknown. The duplicate
 * guard (the own-PR rule in `getBlockingPRForIssue`, Issue #2663) needs every
 * open PR of the author, or an older own PR is missed (Issue #4518).
 */ export const OPEN_PR_BY_USER_LIMIT = 100;
function isSettledListing(value) {
  return isRecord(value) && value.v === 1 && Array.isArray(value.prs) && typeof value.cachedAt === "number" && Array.isArray(value.openSeen);
}
/**
 * This author's open PR numbers in the repository, or `null` when they cannot
 * be known — the listing failed, or came back full and is therefore truncated.
 */ async function openPrNumbersByUser(repo, githubUser, cache, ghCommandFn) {
  try {
    const open = await fetchOpenPRsByUser(repo, githubUser, cache, ghCommandFn);
    if (open.length >= OPEN_PR_BY_USER_LIMIT) return null;
    return open.map((pr)=>pr.number);
  } catch  {
    return null;
  }
}
/**
 * Read a merged/closed per-author listing that is still known to be current.
 *
 * Such a listing changes only when one of that author's **open** PRs in the
 * repository stops being open, and the open set is already known cheaply (the
 * cross-repo prefetch, Issue #1486). So the listing is served for up to
 * {@link SETTLED_PR_LISTING_MAX_AGE_SECONDS} *while every open PR seen since it
 * was cached is still open*, and is a miss the moment one is gone — at any
 * age, the first ten minutes included. Re-fetching it every ten minutes cost
 * `20 repos × authors × 2 states` GraphQL calls per host per ten minutes, the
 * largest single consumer of a quota the fleet was exhausting ~25 minutes into
 * every hour.
 *
 * Open PRs are remembered as they are seen, so one opened after the listing
 * was cached invalidates it when it goes. Only a PR that opens **and** closes
 * between two consecutive reads is missed, for at most the maximum age — and a
 * stale answer cannot cause duplicate work, because the pickup pre-check looks
 * for an existing PR live (`merged_pr_precheck_phase.ts`).
 *
 * Fails towards asking: an open set that cannot be known serves the listing
 * only inside the old ten-minute window.
 */ async function readSettledListing(repo, githubUser, cacheKey, cache, ghCommandFn, nowSeconds) {
  // An entry written before Issue #2409 is a bare array with no record of the
  // open PRs seen. It is served exactly as it always was — inside the cache's
  // own TTL — so an upgrade throws nothing away; it cannot be extended.
  const legacy = await cache.read(repo, cacheKey);
  if (Array.isArray(legacy)) return legacy;
  const entry = await cache.read(repo, cacheKey, {
    ttlSeconds: SETTLED_PR_LISTING_MAX_AGE_SECONDS
  });
  if (!isSettledListing(entry)) return null;
  const age = nowSeconds - entry.cachedAt;
  if (age < 0 || age >= SETTLED_PR_LISTING_MAX_AGE_SECONDS) return null;
  const open = await openPrNumbersByUser(repo, githubUser, cache, ghCommandFn);
  if (open === null) {
    return age < SETTLED_PR_LISTING_FRESH_SECONDS ? entry.prs : null;
  }
  const openNow = new Set(open);
  if (entry.openSeen.some((number)=>!openNow.has(number))) return null;
  const seen = new Set(entry.openSeen);
  const unseen = open.filter((number)=>!seen.has(number));
  if (unseen.length > 0) {
    await cache.write(repo, cacheKey, {
      ...entry,
      openSeen: [
        ...entry.openSeen,
        ...unseen
      ]
    });
  }
  return entry.prs;
}
/** Cache a freshly fetched merged/closed listing beside the open set. */ async function writeSettledListing(repo, githubUser, cacheKey, prs, cache, ghCommandFn, nowSeconds) {
  const open = await openPrNumbersByUser(repo, githubUser, cache, ghCommandFn);
  const entry = {
    v: 1,
    prs,
    cachedAt: nowSeconds,
    openSeen: open ?? []
  };
  await cache.write(repo, cacheKey, entry);
}
/**
 * Fetch open/closed/merged PRs whose head branch is `branchName`
 * (Issue #1795).
 *
 * Wraps `gh pr list --head <branch> --state <state>`. Cache key is
 * namespaced by both branch and state so per-branch checks across
 * different states do not collide. Pair with the iteration-scoped
 * `IssueCache` so repeated per-branch lookups (e.g. branch-cleanup
 * scans, PR-link checks) collapse to one network call per
 * (branch, state) pair.
 *
 * Returns an empty array on parse failure rather than throwing so
 * callers can apply fail-safe behaviour matching the existing inline
 * implementations. `throwOnError` lets a sweep handle request failures
 * itself, including stopping immediately for a rate-limit cool-down.
 */ export async function fetchPRsByBranch(repo, branchName, state, cache, ghCommandFn = runGhCommand, options = {}) {
  const cacheKey = `prs_branch_${state}_${branchName}`;
  if (cache) {
    const cached = await cache.read(repo, cacheKey);
    if (cached) return cached;
  }
  let output;
  try {
    output = await ghCommandFn([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branchName,
      "--state",
      state,
      "--json",
      // Issue #1264: ownership fields travel with every per-branch listing
      // so a consumer that closes a PR can tell a fleet PR on this repo
      // from an outsider's fork PR that merely shares the branch name.
      "number,title,baseRefName,headRefName,author,headRepositoryOwner," + "isCrossRepository",
      "--limit",
      "50"
    ]);
  } catch (error) {
    if (options.throwOnError) throw error;
    return [];
  }
  const prs = parsePRListJson(output);
  if (cache) await cache.write(repo, cacheKey, prs);
  return prs;
}
/**
 * Fetch closed PRs whose head branch is `branchName`, with merge state
 * (Issue #3152).
 *
 * `gh pr list --state closed` returns BOTH closed-not-merged and merged
 * PRs, so the query includes `mergedAt` to let callers distinguish the
 * two. Used by the PR-creation path to detect a prior attempt's
 * closed-unmerged PR on the deterministic branch and reuse it (reopen)
 * rather than opening a duplicate.
 *
 * Cache key is `prs_branch_closedmerge_${branchName}` — distinct from the
 * state-keyed `fetchPRsByBranch` cache so the two never collide.
 *
 * Returns an empty array on parse failure rather than throwing so callers
 * can apply fail-safe behaviour.
 */ export async function fetchClosedPRsByBranch(repo, branchName, cache, ghCommandFn = runGhCommand) {
  if (!branchName) return [];
  const cacheKey = `prs_branch_closedmerge_${branchName}`;
  if (cache) {
    const cached = await cache.read(repo, cacheKey);
    if (cached) return cached;
  }
  let output;
  try {
    output = await ghCommandFn([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branchName,
      "--state",
      "closed",
      "--json",
      "number,title,mergedAt,closedAt",
      "--limit",
      "50"
    ]);
  } catch  {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(output.trim() || "[]");
  } catch  {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const prs = [];
  for (const item of parsed){
    if (!isRecord(item)) continue;
    if (typeof item.number !== "number") continue;
    prs.push({
      number: item.number,
      title: typeof item.title === "string" ? item.title : "",
      mergedAt: typeof item.mergedAt === "string" ? item.mergedAt : null,
      closedAt: typeof item.closedAt === "string" ? item.closedAt : null
    });
  }
  if (cache) await cache.write(repo, cacheKey, prs);
  return prs;
}
/**
 * Invalidate the `fetchPRsByBranch` cache entry for a given
 * (branch, state) pair (Issue #1795). Use after creating, closing, or
 * merging a PR for that branch.
 */ export async function invalidatePRsByBranch(cache, repo, branchName, state) {
  await cache.invalidate(repo, `prs_branch_${state}_${branchName}`);
}
/**
 * Fetch PRs in the given state whose title references `issueNumber`
 * (Issue #1795).
 *
 * Wraps the standard worker title-search expression
 * `in:title (#N) OR in:title (Issue #N)` so per-issue lookups across
 * `stuck_recovery.ts` and `stuck_detection.ts` share a single cached
 * result per (issue, state) pair. Cache key is
 * `prs_title_${state}_${issueNumber}` — distinct from the user-keyed
 * `prs_${user}` shape so worker-author-only queries do not pollute
 * this all-author cache.
 *
 * Returns an empty array on parse failure rather than throwing.
 * `onUnreadable` distinguishes read/parse failures from a successful empty
 * search for callers that must not cache a verdict from incomplete evidence.
 *
 * **Fork-headed PRs are dropped (Issue #1124).** The search matches an
 * attacker-writable title on a public repository, and every consumer reads
 * a match as "the fleet already has this issue in hand" and stays quiet.
 * The head branch is the part of the row nobody outside the repository can
 * produce: pushing it into the target repository needs write access, so a
 * same-repository head is evidence and a fork head is a claim. The claims
 * are dropped, loudly, and the author GitHub authenticated is named in the
 * log line and kept on the row so consumers can check it too.
 *
 * The fail direction is towards **acting**: a dropped row means "no PR
 * found", so the worker files or recovers. A duplicate PR is recoverable in
 * a moment; an issue silently starved by a planted title is not.
 *
 * @param log - Sink for the dropped-row warning. Defaults to `console.error`.
 */ export async function fetchPRsForIssueByTitle(repo, issueNumber, state, cache, ghCommandFn = runGhCommand, log = console.error, onUnreadable) {
  const cacheKey = `prs_title_${state}_${issueNumber}`;
  if (cache) {
    const cached = await cache.read(repo, cacheKey);
    if (cached) return cached;
  }
  const search = `in:title (#${issueNumber}) OR in:title (Issue #${issueNumber})`;
  let output;
  try {
    output = await ghCommandFn([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      state,
      "--search",
      search,
      "--json",
      "number,title,baseRefName,headRefName,mergedAt,closedAt,author,isCrossRepository",
      "--limit",
      "50"
    ]);
  } catch  {
    onUnreadable?.();
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(output.trim() || "[]");
  } catch  {
    onUnreadable?.();
    return [];
  }
  if (!Array.isArray(parsed)) {
    onUnreadable?.();
    return [];
  }
  const prs = [];
  for (const item of parsed){
    if (!isRecord(item)) continue;
    if (typeof item.number !== "number") continue;
    const author = isRecord(item.author) && typeof item.author.login === "string" ? item.author.login : "";
    const title = typeof item.title === "string" ? item.title : "";
    const headRefName = typeof item.headRefName === "string" ? item.headRefName : "";
    if (item.isCrossRepository === true) {
      log(`[title-search] ${repo}#${issueNumber}: ignoring PR #${item.number} ` + `by ${author || "an unknown author"} — its head branch is in a ` + `fork, so the "(#${issueNumber})" title is not evidence the fleet ` + `opened it. Treating the issue as having no PR.`);
      continue;
    }
    // Issue #3476: GitHub's `in:title` search can match an issue number that
    // appears inside a milestone branch name (e.g. `Sync main into
    // milestone/42-foo`). Only the fleet's own delimited title form is
    // evidence the PR delivers this issue.
    if (!prTitleMatchesIssue(title, issueNumber)) {
      log(`[title-search] ${repo}#${issueNumber}: ignoring PR #${item.number} ` + `"${title}" — its title does not carry "(#${issueNumber})" or ` + `"(Issue #${issueNumber})", so it is not this issue's PR ` + `(Issue #3476).`);
      continue;
    }
    // A milestone sync PR never delivers an individual sub-issue.
    if (isMilestoneSyncBranch(headRefName)) {
      log(`[title-search] ${repo}#${issueNumber}: ignoring PR #${item.number} ` + `"${title}" — its head '${headRefName}' is a milestone sync branch ` + `(Issue #3476).`);
      continue;
    }
    prs.push({
      number: item.number,
      title,
      baseRefName: typeof item.baseRefName === "string" ? item.baseRefName : "",
      headRefName,
      mergedAt: typeof item.mergedAt === "string" ? item.mergedAt : null,
      closedAt: typeof item.closedAt === "string" ? item.closedAt : null,
      author,
      isCrossRepository: false
    });
  }
  if (cache) await cache.write(repo, cacheKey, prs);
  return prs;
}
/**
 * Find merged PRs whose same-repository issue branch names `issueNumber`.
 *
 * This is a separate recovery lookup for adopted PRs whose title predates
 * canonical issue-title repair. GitHub's `head:issue-N` search matches the
 * issue branch prefix; the returned head is parsed again so `issue-42` never
 * claims issue 420. Fork heads and rows without a merge timestamp are ignored.
 * The title-search contract remains limited to canonical title references.
 * Successful results, including empty lists, use the issue cache's TTL;
 * unreadable searches are not cached so the next scan retries them.
 */ export async function fetchMergedPRsByIssueBranch(repo, issueNumber, ghCommandFn = runGhCommand, cache) {
  const cacheKey = `prs_branch_merged_issue_${issueNumber}`;
  if (cache) {
    const cached = await cache.read(repo, cacheKey);
    if (cached) return cached;
  }
  let output;
  try {
    output = await ghCommandFn([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "merged",
      "--search",
      `head:issue-${issueNumber}`,
      "--json",
      "number,title,baseRefName,headRefName,mergedAt,closedAt,author,isCrossRepository",
      "--limit",
      "1000"
    ]);
  } catch  {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(output.trim());
  } catch  {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const prs = [];
  for (const item of parsed){
    if (!isRecord(item) || typeof item.number !== "number" || item.isCrossRepository !== false || typeof item.headRefName !== "string" || issueNumberFromBranch(item.headRefName) !== issueNumber || typeof item.mergedAt !== "string" || item.mergedAt.length === 0) {
      continue;
    }
    prs.push({
      number: item.number,
      title: typeof item.title === "string" ? item.title : "",
      baseRefName: typeof item.baseRefName === "string" ? item.baseRefName : "",
      headRefName: item.headRefName,
      mergedAt: item.mergedAt,
      closedAt: typeof item.closedAt === "string" ? item.closedAt : null,
      author: isRecord(item.author) && typeof item.author.login === "string" ? item.author.login : "",
      isCrossRepository: false
    });
  }
  if (cache) await cache.write(repo, cacheKey, prs);
  return prs;
}
/**
 * Invalidate the `fetchPRsForIssueByTitle` cache entry for a given
 * (issue, state) pair (Issue #1795). Use after creating, closing, or
 * merging a PR linked to that issue.
 */ export async function invalidatePRsForIssueByTitle(cache, repo, issueNumber, state) {
  await cache.invalidate(repo, `prs_title_${state}_${issueNumber}`);
}
/** Cache key for the all-state branch lookup; `v2` retires pre-#3595 entries. */ function allStateBranchCacheKey(branchName) {
  return `prs_all_branch_v2_${branchName}`;
}
/**
 * Fetch all-state PRs whose head branch is `branchName` (Issue #1795).
 *
 * Wraps `gh pr list --state all --head <branch> --limit 100`. Used by
 * `hasExistingMilestoneSummaryPr` (`milestone_completion.ts`) which
 * needs to detect a PR for the milestone branch in any state to avoid
 * recreating one. Cache key is `prs_all_branch_v2_${branchName}` —
 * distinct from the per-state branch helper so an all-state lookup
 * does not poison or get poisoned by single-state caches.
 *
 * Only same-repository PRs are returned (Issue #3595):
 * `gh pr list --head` matches the ref name alone, so a PR from a fork whose
 * branch reuses `branchName` is listed too, and a fork-headed PR proves
 * nothing about this repository's branch. A row whose `isCrossRepository` is
 * not exactly `false` is dropped. The `v2` key means an entry written under
 * the old `prs_all_branch_${branchName}` key, which may hold fork-headed rows,
 * is never read.
 *
 * Each row carries the PR `state` when the read provided it (PR #3640
 * review), so a caller can drop non-open PRs without a per-PR read; a row
 * has none when the gh read omitted it or gave a non-string or empty value. The state is as of
 * the cached read, so a caller that acts on a PR still confirms it live.
 *
 * Returns an empty array on parse failure rather than throwing.
 */ export async function fetchAllStatePRsByBranch(repo, branchName, cache, ghCommandFn = runGhCommand) {
  const cacheKey = allStateBranchCacheKey(branchName);
  if (cache) {
    const cached = await cache.read(repo, cacheKey);
    if (cached) return cached;
  }
  let output;
  try {
    output = await ghCommandFn([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--head",
      branchName,
      "--json",
      "number,title,headRefName,state,isCrossRepository",
      "--limit",
      "100"
    ]);
  } catch  {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(output.trim() || "[]");
  } catch  {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const prs = [];
  for (const item of parsed){
    if (!isRecord(item)) continue;
    if (typeof item.number !== "number") continue;
    // Issue #3595: a fork-headed PR proves nothing; keep only `false`.
    if (item.isCrossRepository !== false) continue;
    prs.push({
      number: item.number,
      title: typeof item.title === "string" ? item.title : "",
      headRefName: typeof item.headRefName === "string" ? item.headRefName : "",
      ...typeof item.state === "string" && item.state !== "" ? {
        state: item.state
      } : {}
    });
  }
  if (cache) await cache.write(repo, cacheKey, prs);
  return prs;
}
/**
 * Invalidate the `fetchAllStatePRsByBranch` cache entry for the given
 * branch (Issue #1795).
 */ export async function invalidateAllStatePRsByBranch(cache, repo, branchName) {
  await cache.invalidate(repo, allStateBranchCacheKey(branchName));
}
/**
 * Fetch all-state issues for a given milestone number (Issue #1795).
 *
 * Wraps `gh issue list --milestone <number> --state all`. Used by
 * `hasExistingMilestoneTrackingIssue` (`milestone_completion.ts`) so
 * the worker can detect an existing tracking issue without re-issuing
 * a global title-search per scan. Cache key is
 * `issues_all_milestone_v2_${milestoneNumber}`.
 *
 * Returns an empty array on parse failure rather than throwing.
 */ export async function fetchAllStateIssuesByMilestone(repo, milestoneNumber, cache, ghCommandFn = runGhCommand) {
  // Issue #1246: the cache key carries the payload shape. The pre-#1246
  // entries hold only `number`/`title`, and a tracker read back without its
  // body and author cannot be verified — which would make the worker file a
  // duplicate tracker until the old entry expired.
  const cacheKey = `issues_all_milestone_v2_${milestoneNumber}`;
  if (cache) {
    const cached = await cache.read(repo, cacheKey);
    if (cached) return cached;
  }
  let output;
  try {
    output = await ghCommandFn([
      "issue",
      "list",
      "--repo",
      repo,
      "--milestone",
      String(milestoneNumber),
      "--state",
      "all",
      "--json",
      // Issue #1246: `body` and `author` are the authenticated evidence that
      // a tracking-shaped issue really is the fleet's own tracker.
      "number,title,body,author",
      "--limit",
      "100"
    ]);
  } catch  {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(output.trim() || "[]");
  } catch  {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const issues = [];
  for (const item of parsed){
    if (!isRecord(item)) continue;
    if (typeof item.number !== "number") continue;
    const author = item.author;
    issues.push({
      number: item.number,
      title: typeof item.title === "string" ? item.title : "",
      body: typeof item.body === "string" ? item.body : "",
      author: isRecord(author) && typeof author.login === "string" ? author.login : ""
    });
  }
  if (cache) await cache.write(repo, cacheKey, issues);
  return issues;
}
/**
 * Invalidate the `fetchAllStateIssuesByMilestone` cache entry for the
 * given milestone number (Issue #1795).
 */ export async function invalidateAllStateIssuesByMilestone(cache, repo, milestoneNumber) {
  await cache.invalidate(repo, `issues_all_milestone_v2_${milestoneNumber}`);
}
/**
 * Fetch recent merged PRs across all authors (Issue #1799).
 *
 * Used by `recent_activity.ts` to summarise recent repository activity
 * for prompt context. Cache key is `prs_recent_merged_${limit}` so
 * different limits do not collide. Cache TTL inherits from the supplied
 * `IssueCache` instance.
 */ export async function fetchRecentMergedPRs(repo, limit = 10, cache, ghCommandFn = runGhCommand) {
  const cacheKey = `prs_recent_merged_${limit}`;
  if (cache) {
    const cached = await cache.read(repo, cacheKey);
    if (cached) return cached;
  }
  const output = await ghCommandFn([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "merged",
    "--json",
    "number,title,changedFiles",
    "--limit",
    String(limit)
  ]);
  let parsed;
  try {
    parsed = JSON.parse(output.trim() || "[]");
  } catch  {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const prs = [];
  for (const item of parsed){
    if (!isRecord(item)) continue;
    if (typeof item.number !== "number") continue;
    prs.push({
      number: item.number,
      title: typeof item.title === "string" ? item.title : "",
      changedFiles: typeof item.changedFiles === "number" ? item.changedFiles : 0
    });
  }
  if (cache) await cache.write(repo, cacheKey, prs);
  return prs;
}
/**
 * `gh pr list` without `--search` orders by creation date, not update
 * recency (Issue #2901): a PR merged or closed after `limit` newer-numbered
 * PRs were created never enters a window ordered that way. Passing this as
 * `--search` orders by update recency instead, so a merge or close always
 * puts the PR back at the front of the window.
 */ export const RECENCY_ORDER_SEARCH = "sort:updated-desc";
/**
 * Fetch merged PRs by a given user (Issue #1787).
 *
 * Used by branch cleanup, merged-PR-driven issue closure, and the
 * closed-PR self-healing path. Cache key is `prs_merged_${user}`. Ordered by
 * update recency, not creation date, so a long-lived PR's merge keeps it in
 * the window (Issue #2901).
 */ export async function fetchMergedPRsByUser(repo, githubUser, cache, limit = 30, ghCommandFn = runGhCommand, /** Clock override, epoch seconds (tests). */ nowSeconds = ()=>Math.floor(Date.now() / 1000)) {
  const cacheKey = `prs_merged_${githubUser}`;
  if (cache) {
    // Issue #2409: served while no open PR of this author has gone.
    const cached = await readSettledListing(repo, githubUser, cacheKey, cache, ghCommandFn, nowSeconds());
    if (cached) return cached;
  }
  const output = await ghCommandFn([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "merged",
    "--author",
    githubUser,
    "--search",
    RECENCY_ORDER_SEARCH,
    "--json",
    "number,title,headRefName,mergedAt,body",
    "--limit",
    String(limit)
  ]);
  // Never cache a failure (Issue #4257): the old `|| "[]"` fallback turned
  // a failed call's empty output into a cacheable empty list, and branch
  // cleanup / close-issues then saw a repo with no merged PRs for the TTL.
  assertListOutput(output, `fetchMergedPRsByUser(${repo})`);
  const prs = parseMergedPrListing(output);
  if (cache) {
    await writeSettledListing(repo, githubUser, cacheKey, prs, cache, ghCommandFn, nowSeconds());
  }
  return prs;
}
/**
 * Parse a `gh pr list --state merged --json
 * number,title,headRefName,mergedAt,body` listing. The body itself is not
 * kept — only the closing references the closers need from it and the
 * sub-agent tier its marker names (`sonnet` when it has none, Issue #3404).
 */ function parseMergedPrListing(output) {
  let parsed;
  try {
    parsed = JSON.parse(output.trim());
  } catch  {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const prs = [];
  for (const item of parsed){
    if (!isRecord(item)) continue;
    if (typeof item.number !== "number") continue;
    const body = typeof item.body === "string" ? item.body : "";
    const missingCriteria = findMissingCriteria(body);
    prs.push({
      number: item.number,
      title: typeof item.title === "string" ? item.title : "",
      headRefName: typeof item.headRefName === "string" ? item.headRefName : "",
      mergedAt: typeof item.mergedAt === "string" ? item.mergedAt : "",
      closingRefs: extractClosingIssueNumbers(body),
      subAgentTier: subAgentTierFromBody(body) ?? "sonnet",
      lifecycleAssignmentId: assignmentIdFromBody(body) ?? null,
      ...missingCriteria.length > 0 ? {
        missingCriteria
      } : {}
    });
  }
  return prs;
}
/**
 * Fetch a repo's most recently merged PRs, **whoever authored them**
 * (Issue #2537).
 *
 * GitHub honours `Closes #N` only on a merge into the default branch, so the
 * worker closes a milestone child itself. That close must not depend on who
 * wrote the PR: a human's PR merged into a milestone branch left GRQ-AutoTrader
 * #824 open for a day, holding three `top-priority` dependants, because every
 * host listed only its own PRs. Merging needs write access, so no author
 * filter is protecting anything here.
 *
 * Cached under `prs_merged_any` for the cache's normal TTL — at worst a close
 * lands one TTL late, and each host spends one listing per repo per TTL.
 * Ordered by update recency, not creation date, so a long-lived PR's merge
 * keeps it in the window (Issue #2901).
 */ export async function fetchMergedPRsAnyAuthor(repo, cache, limit = 30, ghCommandFn = runGhCommand) {
  const cacheKey = "prs_merged_any";
  if (cache) {
    const cached = await cache.read(repo, cacheKey);
    if (Array.isArray(cached)) return cached;
  }
  const output = await ghCommandFn([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "merged",
    "--search",
    RECENCY_ORDER_SEARCH,
    "--json",
    "number,title,headRefName,mergedAt,body",
    "--limit",
    String(limit)
  ]);
  // Never cache a failure (Issue #4257).
  assertListOutput(output, `fetchMergedPRsAnyAuthor(${repo})`);
  const prs = parseMergedPrListing(output);
  if (cache) await cache.write(repo, cacheKey, prs);
  return prs;
}
/**
 * Default number of fleet PRs that may be open at once on a repository's
 * default-branch (non-milestone) stream — `fleet_pr_slots` (Issue #2663).
 *
 * The owner's rule is one fleet PR per slot. No host's config carries the
 * fleet's size (each host knows only its own `max_concurrent_issues`), so the
 * default cannot be derived from config; it is fixed at 8 — the ceiling of
 * `max_concurrent_issues` (1–8), so one host at its maximum never holds itself,
 * and four hosts at the default two slots fill it exactly. Operators set the
 * real figure with `fleet_pr_slots`, per repository with `repo_config`.
 */ export const DEFAULT_FLEET_PR_SLOTS = 8;
/** A usable slot cap: a positive integer, or `fallback`. */ function positiveSlotsOr(value, fallback) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}
/**
 * Resolve the fleet PR cap for a repository's default-branch stream
 * (Issue #2663): `repo_config.<repo>.fleet_pr_slots` wins over the global
 * `fleet_pr_slots`, which wins over {@link DEFAULT_FLEET_PR_SLOTS}. A value
 * that is not a positive integer (config arrives untrusted) falls back a
 * level rather than disabling the gate.
 */ export function resolveFleetPrSlots(config, repo) {
  const globalValue = positiveSlotsOr(config.fleetPrSlots, DEFAULT_FLEET_PR_SLOTS);
  return positiveSlotsOr(config.repoConfig?.[repo]?.fleetPrSlots, globalValue);
}
/**
 * The login that authored an open PR, for the fleet classification.
 *
 * {@link OpenPR.author} is the fleet login the PR was fetched under
 * (`fetchOpenPRsForFleet`). A row from the repo-wide listing
 * (`fetchAllOpenPRs`, which the idle census and the claimable audit read)
 * carries the listing's own author as `authorLogin` instead. Falling back to
 * it lets those consumers classify exactly as the scan does (Issue #2663);
 * with neither, the author is unknown and the PR stays fleet-owned (the
 * fail-safe in {@link isHumanAuthoredPr}).
 */ function prAuthorForGate(pr) {
  if (typeof pr.author === "string" && pr.author.trim() !== "") {
    return pr.author;
  }
  const listed = pr.authorLogin;
  return typeof listed === "string" ? listed : undefined;
}
/**
 * True when `pr` is the fleet's PR for issue `issueNumber`: its title ends in
 * the worker's `(#N)` / `(Issue #N)` suffix, or its head branch is the
 * worker's `issue-N` / `issue-N-…` branch (so `issue-17-…` is not issue 1's).
 */ function isPrForIssue(pr, issueNumber) {
  const fromTitle = extractIssueNumberFromPrTitle(pr.title ?? "");
  if (fromTitle.ok && fromTitle.value === issueNumber) return true;
  const head = pr.headRefName ?? "";
  return head === `issue-${issueNumber}` || head.startsWith(`issue-${issueNumber}-`);
}
/** True when an open PR is on a repo's default-branch (non-milestone) stream. */ function isDefaultStreamPr(pr) {
  const base = pr.baseRefName ?? "";
  const head = pr.headRefName ?? "";
  if (base.startsWith("milestone/")) return false;
  if (head.startsWith("milestone/") || head.includes("merge-milestone")) {
    return false;
  }
  return true;
}
/**
 * Check if a specific issue is blocked by open fleet PRs (milestone-aware).
 *
 * - Only **fleet-authored** PRs count. A human's open PR never defers an
 *   issue: the developer manages their own PR, and one unrelated human PR
 *   must not park a repo's whole `work-on` queue (Issue #4133).
 * - Milestone issues are blocked by a PR targeting their milestone branch —
 *   one PR per milestone stream, so multiple milestones mean multiple PRs.
 * - Non-milestone issues are blocked only while the fleet's open PRs on the
 *   default-branch stream number at least `fleetPrSlots` — one fleet PR per
 *   slot (Issue #2663). Milestone-branch and milestone-merge PRs are not on
 *   that stream and never count.
 *
 * The returned info carries the PR's `author` (Issue #4078); a default-stream
 * hold also carries `fleetPrCap`, the count against the cap, and names the
 * first counted PR only so existing callers keep a PR to point at.
 *
 * @param prs - Array of open PRs
 * @param milestoneTitle - The issue's milestone title (empty if none)
 * @param pushCapableAuthors - The fleet's push-capable logins
 *   (`resolveFleetMaintenanceAuthorSet`: host login + `fleet_pr_authors` ∪
 *   `service_accounts`). PRs authored outside this set are ignored. Pass `[]`
 *   only where the set is genuinely unavailable — an empty set cannot
 *   classify anything, so every PR counts (fail-safe, see
 *   {@link isHumanAuthoredPr}).
 * @param fleetPrSlots - The default-branch cap ({@link resolveFleetPrSlots});
 *   anything but a positive integer means {@link DEFAULT_FLEET_PR_SLOTS}.
 * @returns Blocking PR info, or null if not blocked
 */ export function getBlockingPRForIssue(prs, milestoneTitle, pushCapableAuthors, fleetPrSlots = DEFAULT_FLEET_PR_SLOTS, issueNumber) {
  if (prs.length === 0) return null;
  // Issue #4133: someone else's PR is not the worker's work stream. Issue
  // #4146: neither is the fleet's own DRAFT for this issue — a timed-out run
  // keeps one so the next run can resume the branch and finish the job, and
  // holding the issue on it would strand the work it exists to continue.
  const fleetPrs = prs.filter((pr)=>!isHumanAuthoredPr(prAuthorForGate(pr), pushCapableAuthors) && !(issueNumber !== undefined && pr.isDraft === true && isPrForIssue(pr, issueNumber)));
  if (fleetPrs.length === 0) return null;
  // An issue whose own fleet PR is open is never claimable again, on any
  // stream and whatever the cap (Issue #2663). Before the per-slot cap, any
  // open fleet PR held every non-milestone issue, which hid this; with the
  // cap a lone PR holds nothing, and the issue it delivers was re-claimed
  // while that PR waited for CI or review.
  if (issueNumber !== undefined) {
    const own = fleetPrs.find((pr)=>isPrForIssue(pr, issueNumber));
    if (own) return toBlockingPRInfo(own);
  }
  if (milestoneTitle !== "") {
    // Milestone issue: only blocked by PRs targeting the same milestone branch
    const milestoneBranch = createMilestoneBranchName(milestoneTitle);
    const blocking = fleetPrs.find((pr)=>pr.baseRefName === milestoneBranch);
    return blocking ? toBlockingPRInfo(blocking) : null;
  }
  // Non-milestone issue: one fleet PR per slot on the default-branch stream.
  const cap = positiveSlotsOr(fleetPrSlots, DEFAULT_FLEET_PR_SLOTS);
  const onStream = fleetPrs.filter(isDefaultStreamPr);
  if (onStream.length < cap) return null;
  return {
    ...toBlockingPRInfo(onStream[0]),
    fleetPrCap: {
      open: onStream.length,
      cap
    }
  };
}
/**
 * One-line description of a hold for skip logs (Issue #2663): the PR, and
 * for a default-branch slot hold the count against the cap as well — the
 * count is the gate; the PR is kept so a log grep still finds it.
 */ export function describeBlockingPr(info) {
  if (!info.fleetPrCap) return `PR #${info.number}`;
  const { open, cap } = info.fleetPrCap;
  return `PR #${info.number} (${open} fleet PR${open === 1 ? "" : "s"} ` + `open on the default branch, cap ${cap})`;
}
/** Project an open PR onto the blocking-guard result shape (Issue #4078). */ function toBlockingPRInfo(pr) {
  const author = prAuthorForGate(pr);
  return {
    number: pr.number,
    title: pr.title,
    author: typeof author === "string" ? author.trim() : ""
  };
}
/**
 * Fetch the current labels for a single issue, with optional caching
 * (Issue #1787).
 *
 * Wraps `gh issue view --json labels` so multiple per-issue label
 * checks within one iteration share one network call. The cache key
 * is namespaced by issue number (`issue_labels_${num}`); pair with a
 * short TTL on the supplied `IssueCache` (60–300s recommended) so
 * mutations elsewhere are visible quickly.
 *
 * Returns `null` on parse/validation failure so callers can apply
 * fail-safe behaviour matching the existing inline implementations.
 */ export async function fetchIssueLabels(repo, issueNumber, cache, ghCommandFn = runGhCommand) {
  const cacheKey = `issue_labels_${issueNumber}`;
  if (cache) {
    const cached = await cache.read(repo, cacheKey);
    if (cached) return cached;
  }
  let raw;
  try {
    raw = await ghCommandFn([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "labels"
    ]);
  } catch  {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch  {
    return null;
  }
  const validated = validateIssueLabelsJson(parsed);
  if (!validated.ok) return null;
  const labels = validated.value.labels.map((l)=>l.name);
  if (cache) await cache.write(repo, cacheKey, labels);
  return labels;
}
/**
 * Check if an issue has the ignore-open-prs label added by an allowed author.
 *
 * Issue #1787: routes the per-issue label fetch through the new
 * `fetchIssueLabels` helper so duplicate reads across the candidate
 * collectors (each one calls `hasIgnoreOpenPRsLabel` for blocked
 * issues) collapse to one `gh issue view` call per iteration.
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - Issue number
 * @param ignoreLabel - The ignore-open-prs label name
 * @param allowedAuthors - Authorised GitHub usernames
 * @param ghCommandFn - Optional gh command function for testing
 * @param cache - Optional timeline cache for read-through label-author check
 * @param issueCache - Optional issue cache for read-through label fetch
 * @param listedLabels - The labels the scan's listing already returned for
 *   this issue (Issue #2662). When supplied, no `gh issue view --json labels`
 *   is made; the label's author is still verified against the timeline.
 * @returns True if the label was added by an allowed author
 */ export async function hasIgnoreOpenPRsLabel(repo, issueNumber, ignoreLabel, allowedAuthors, ghCommandFn = runGhCommand, cache, issueCache, listedLabels) {
  const labels = listedLabels ?? await fetchIssueLabels(repo, issueNumber, issueCache, ghCommandFn);
  if (labels === null) return false;
  if (!labels.includes(ignoreLabel)) return false;
  // Verify label was added by an allowed author
  return await wasLabelAddedByAllowedAuthor(repo, issueNumber, ignoreLabel, allowedAuthors, ghCommandFn, cache);
}
/**
 * Fetch (or read from cache) the **complete** parsed timeline for the given
 * issue, returning `null` instead of throwing (Issue #1673, #3327).
 *
 * Every caller asks a "most recent event" question — the latest
 * `needs-human` removal (#1878), the latest trusted re-approval, the latest
 * reopen — so the answer must come from the whole timeline. This used to read
 * `timeline?per_page=100` alone, which is page 1: the **oldest** 100 events.
 * On a busy issue (GRQ-AutoTrader#2089, 131 events) the developer's removal
 * sat on page 2, the lookup returned a removal from four days earlier, and the
 * grill-me processor re-added `needs-human` on every scan (Issue #3327).
 *
 * Delegates to {@link fetchCompleteTimeline}: a complete cache entry is
 * honoured, a partial one is refused, and the REST timeline is paginated to
 * exhaustion. Errors, validation failures and the page cap fall through to a
 * `null` return so each caller keeps its own fail-safe behaviour — a timeline
 * that could not be read in full is never treated as authoritative.
 */ export async function fetchTimelineWithCache(repo, issueNumber, ghCommandFn, cache) {
  try {
    return await fetchCompleteTimeline(repo, issueNumber, ghCommandFn, cache);
  } catch  {
    return null;
  }
}
/**
 * Get information about the most recent "labeled" event for the given label
 * on the given issue (Issue #1561).
 *
 * Used to detect re-approval: if a trusted author re-adds the work-on label
 * after the worker captured a content snapshot, the later label-add event
 * indicates a fresh approval and the stored snapshot should be refreshed
 * rather than triggering a false "Issue Modified After Approval" alarm.
 *
 * Issue #1673: When `cache` is provided, reads from the file-backed TTL
 * cache before issuing a `gh api .../timeline` call.
 *
 * @returns `{ addedAt, addedBy }` when the timeline contains a "labeled"
 *   event for this label with a parseable timestamp, otherwise `null`.
 */ export async function getLabelLastAddInfo(repo, issueNumber, labelName, ghCommandFn = runGhCommand, cache) {
  const timeline = await fetchTimelineWithCache(repo, issueNumber, ghCommandFn, cache);
  if (timeline === null) return null;
  return lastAddInfoFromTimeline(timeline, labelName);
}
/**
 * Extract the most-recent `labeled` event for `labelName` from an already
 * fetched timeline. Shared by {@link getLabelLastAddInfo} (fail-safe `null`)
 * and {@link getLabelLastAddInfoComplete} (errors propagate).
 *
 * Issue #1617: exported so a caller that needs *both* the last add and the
 * last remove — the content-approval gate, which counts a trusted
 * `needs-human` removal as re-approval — can answer both from a single
 * {@link fetchTimelineWithCache} call rather than fetching the timeline twice.
 */ export function lastAddInfoFromTimeline(timeline, labelName) {
  const labelEvents = timeline.filter((e)=>e.event === "labeled" && e.label?.name === labelName);
  const lastEvent = labelEvents[labelEvents.length - 1];
  if (!lastEvent?.actor?.login) return null;
  if (!lastEvent.created_at) return null;
  const ms = Date.parse(lastEvent.created_at);
  if (Number.isNaN(ms)) return null;
  return {
    addedAt: Math.floor(ms / 1000),
    addedBy: lastEvent.actor.login
  };
}
/**
 * Exhaustive variant of {@link getLabelLastAddInfo} for callers that **mutate**
 * on the answer (Issue #3709, SEC-c41e97b60238).
 *
 * Both variants read the fully paginated timeline and refuse partial cache
 * entries (Issue #3327 brought `getLabelLastAddInfo` up to this source of
 * truth). They differ only on failure: `getLabelLastAddInfo` returns `null`,
 * while this variant lets errors and page caps propagate so a caller that
 * removes a label and names the adder in a public comment
 * (`stripUntrustedWorkOnLabel`) can fail closed rather than act on nothing.
 */ export async function getLabelLastAddInfoComplete(repo, issueNumber, labelName, ghCommandFn = runGhCommand, cache) {
  const timeline = await fetchCompleteTimeline(repo, issueNumber, ghCommandFn, cache);
  if (timeline === null) return null;
  return lastAddInfoFromTimeline(timeline, labelName);
}
/**
 * Get information about the most recent "unlabeled" event for the given
 * label on the given issue (Issue #1878).
 *
 * Used by the grill-me processor to detect when a non-worker user has
 * explicitly removed `needs-human` after a Round N comment was posted —
 * that removal is the developer's "go" signal even if no separate reply
 * comment was authored. Without this signal the worker keeps re-adding
 * `needs-human` whenever the user removes it, producing the
 * "constantly labelling as needs-human" loop the issue reports.
 *
 * Mirrors `getLabelLastAddInfo` but inspects `unlabeled` events instead
 * of `labeled`. When `cache` is provided, reads from the file-backed
 * TTL cache before issuing a `gh api .../timeline` call.
 *
 * @returns `{ removedAt, removedBy }` when the timeline contains an
 *   `unlabeled` event for this label with a parseable timestamp,
 *   otherwise `null`.
 */ export async function getLabelLastRemoveInfo(repo, issueNumber, labelName, ghCommandFn = runGhCommand, cache) {
  const timeline = await fetchTimelineWithCache(repo, issueNumber, ghCommandFn, cache);
  if (timeline === null) return null;
  return lastRemoveInfoFromTimeline(timeline, labelName);
}
/**
 * Extract the most-recent `unlabeled` event for `labelName` from an already
 * fetched timeline (Issue #1617).
 *
 * The mirror of {@link lastAddInfoFromTimeline}, extracted from
 * {@link getLabelLastRemoveInfo} so both questions can be answered from one
 * fetched timeline.
 */ export function lastRemoveInfoFromTimeline(timeline, labelName) {
  const labelEvents = timeline.filter((e)=>e.event === "unlabeled" && e.label?.name === labelName);
  const lastEvent = labelEvents[labelEvents.length - 1];
  if (!lastEvent?.actor?.login) return null;
  if (!lastEvent.created_at) return null;
  const ms = Date.parse(lastEvent.created_at);
  if (Number.isNaN(ms)) return null;
  return {
    removedAt: Math.floor(ms / 1000),
    removedBy: lastEvent.actor.login
  };
}
/**
 * The most recent `assigned` event for `login` in a chronological timeline
 * (oldest first), or null when absent (Issue #3476). The last matching event
 * is the latest, matching {@link lastRemoveInfoFromTimeline}.
 */ export function latestAssignedAtFromTimeline(timeline, login) {
  const assigned = timeline.filter((e)=>e.event === "assigned" && e.assignee?.login === login);
  const last = assigned[assigned.length - 1];
  return last?.created_at ?? null;
}
/**
 * The most recent `reopened` event in a chronological timeline (oldest
 * first), or null when absent (Issue #3476).
 */ export function latestReopenedAtFromTimeline(timeline) {
  const reopened = timeline.filter((e)=>e.event === "reopened");
  const last = reopened[reopened.length - 1];
  return last?.created_at ?? null;
}
/**
 * REST timeline page size (the GitHub API maximum) and the hard page cap used
 * by the paginated reserved-label trust gate (Issue #3200). Mirrors the
 * constants in `verifyOperationalLabels` (Issue #3165): a full page at the cap
 * means more events may exist than we can read, so the gate fails closed rather
 * than honour a possibly-stale trusted add.
 */ const TIMELINE_PER_PAGE = 100;
const MAX_TIMELINE_PAGES = 100;
/**
 * Read the REST timeline to exhaustion, writing the result to `cache` as a
 * **complete** entry (Issue #3200, extracted in Issue #3709).
 *
 * Deliberately does not read from the cache: callers differ on what a cached
 * entry may be used for, so the cache-read policy stays with them.
 *
 * @returns every timeline event, or null when a page fails validation.
 * @throws when `ghCommandFn` fails, a page is unparseable, or the timeline
 *   exceeds {@link MAX_TIMELINE_PAGES} — failing closed rather than acting on
 *   a timeline that could not be read in full.
 */ async function paginateTimeline(repo, issueNumber, ghCommandFn, cache) {
  const timeline = [];
  for(let page = 1; page <= MAX_TIMELINE_PAGES; page++){
    const timelineJson = await ghCommandFn([
      "api",
      `repos/${repo}/issues/${issueNumber}/timeline?per_page=${TIMELINE_PER_PAGE}&page=${page}`
    ]);
    const parsedTimeline = JSON.parse(timelineJson);
    const timelineValidated = validateTimelineLabelEventsJson(parsedTimeline);
    if (!timelineValidated.ok) return null;
    const pageEvents = timelineValidated.value;
    timeline.push(...pageEvents);
    if (pageEvents.length < TIMELINE_PER_PAGE) {
      break;
    }
    if (page === MAX_TIMELINE_PAGES) {
      // A full page at the cap means more events may exist beyond what we can
      // read. Throw rather than honour a possibly-stale trusted add — the
      // caller's contract is to surface (not swallow) an unresolvable timeline.
      throw new Error(`timeline exceeded ${MAX_TIMELINE_PAGES} pages — failing closed`);
    }
  }
  // Paginated to exhaustion, so mark the cached entry complete (Issue #3296).
  if (cache) await cache.write(repo, issueNumber, timeline, true);
  return timeline;
}
/**
 * Fetch the full timeline for an issue, preferring a **complete** cache entry
 * (Issue #3709).
 *
 * A partial cache entry is refused and the REST timeline is paginated to
 * exhaustion instead. Errors and the page cap propagate; use
 * {@link fetchTimelineWithCache} for the same read with a fail-safe `null`.
 */ export async function fetchCompleteTimeline(repo, issueNumber, ghCommandFn = runGhCommand, cache) {
  if (cache) {
    const cached = await cache.readComplete(repo, issueNumber);
    if (cached !== null) return cached;
  }
  return await paginateTimeline(repo, issueNumber, ghCommandFn, cache);
}
/**
 * Check if a label was added by an allowed author.
 *
 * Security check: verifies the label was added by an authorised user
 * to prevent unauthorised users from directing the worker.
 *
 * Issue #1673: When `cache` is provided, reads from the file-backed TTL
 * cache before issuing a `gh api .../timeline` call. Cache misses fall
 * through to the API path and store the result for subsequent reads.
 *
 * Fleet-worker exclusion (Issue #3416): in a multi-account fleet, sibling
 * worker logins are required to appear in `allowedAuthors` (the PR-dedup
 * requirement — see `resolveFleetAuthors` / `fleet_pr_authors`). Left
 * unchecked, that lets a reserved discovery label (`work-on`,
 * `top-priority`, `low-priority`) a worker applied directly (bypassing the
 * `addLabelToIssue` allowlist) be honoured fleet-wide instead of stripped —
 * contradicting the documented backstop in `worker_label_guard.ts`. Any
 * login in `fleetWorkerLogins` is therefore treated as untrusted, mirroring
 * `verifyOperationalLabels` (Issue #3225). Defaults to `[]` so non-fleet
 * callers keep the original behaviour exactly.
 *
 * Planning hand-off (Issue #2688): the single exception is `planning`
 * added by a fleet worker to hand off a `work-on` issue a trusted,
 * non-worker author queued — see `isWorkerPlanningHandoff`.
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - Issue number
 * @param labelName - Label to check
 * @param allowedAuthors - Authorised GitHub usernames
 * @param ghCommandFn - Optional gh command function for testing
 * @param cache - Optional timeline cache for read-through
 * @param fleetWorkerLogins - Fleet worker logins (own host + siblings) excluded from label-adder trust (Issue #3416)
 * @returns True if the label was added by an allowed author
 */ export async function wasLabelAddedByAllowedAuthor(repo, issueNumber, labelName, allowedAuthors, ghCommandFn = runGhCommand, cache, fleetWorkerLogins = []) {
  // A cache hit may only *deny* trust, never grant it (Issue #3709,
  // SEC-e70b8134af26).
  //
  // The cache is a file under TMPDIR. `TimelineCache` now binds that directory
  // to the worker's own account (per-user path, 0700, ownership-checked), but
  // a cache is still the wrong sole basis for a trust decision: any path by
  // which an attacker-authored entry reaches the cache would otherwise make an
  // attacker-applied `work-on` label look trusted, with no API call to
  // contradict it. Denials carry no such risk — the worst case is a redundant
  // live read — and denial is the dominant outcome during a scan, so this
  // keeps the Issue #1673 N+1 collapse while removing the escalation path.
  //
  // Issue #3296: only a *complete* (fully paginated) cached timeline is even
  // considered. A partial page-1-only entry — written by
  // `fetchTimelineWithCache` before Issue #3327 — holds the oldest 100 events, so on a
  // busy issue (>100 timeline events) it can hide the genuinely most-recent
  // reserved-label add behind a stale one.
  if (cache) {
    const cached = await cache.readComplete(repo, issueNumber);
    if (cached !== null && !labelMatchesAllowedAuthor(cached, labelName, allowedAuthors, fleetWorkerLogins)) {
      return false;
    }
  }
  // No cache, a cache miss, or a cached entry that would have granted trust —
  // confirm against the API. We deliberately do NOT use
  // `fetchTimelineWithCache` here because the historical contract is to
  // surface API errors to the caller (assertRejects in existing tests),
  // whereas the cache-then-API helper swallows them.
  //
  // `paginateTimeline` reads the REST timeline to exhaustion (mirroring
  // verifyOperationalLabels, Issue #3165). The timeline API returns events
  // oldest-first, capped at 100 per page (the API maximum). Issue #3089 raised
  // the page size from 30 to 100 but still read only a single page, so on a
  // busy issue the genuinely most-recent reserved-label add (work-on /
  // top-priority / low-priority) could fall beyond page 1 and be missed —
  // leaving only a stale trusted add inside the window and bypassing this
  // trust gate (Issue #3200). Reading every page guarantees the last
  // `labeled` event is the true most-recent one.
  const timeline = await paginateTimeline(repo, issueNumber, ghCommandFn, cache);
  if (timeline === null) return false;
  return labelMatchesAllowedAuthor(timeline, labelName, allowedAuthors, fleetWorkerLogins);
}
/**
 * Shared timeline-search logic used by both the cached and uncached
 * paths of `wasLabelAddedByAllowedAuthor`.
 */ function labelMatchesAllowedAuthor(timeline, labelName, allowedAuthors, fleetWorkerLogins = []) {
  const labelEvents = timeline.filter((e)=>e.event === "labeled" && e.label?.name === labelName);
  const lastEvent = labelEvents[labelEvents.length - 1];
  if (!lastEvent?.actor?.login) return false;
  const adder = lastEvent.actor.login.toLowerCase();
  // Issue #2688: the one fleet-worker add honoured — `planning` handed off
  // from a `work-on` issue a trusted human queued.
  if (isWorkerPlanningHandoff(timeline, labelName, allowedAuthors, fleetWorkerLogins)) return true;
  // Issue #3416: a fleet worker login (own host + siblings) must appear in
  // allowedAuthors for PR-dedup, but must never be trusted to self-apply a
  // reserved discovery label — treat it as untrusted so it is stripped,
  // mirroring the operational-label backstop (verifyOperationalLabels, #3225).
  if (fleetWorkerLogins.some((a)=>a.toLowerCase() === adder)) return false;
  return allowedAuthors.some((a)=>a.toLowerCase() === adder);
}
/**
 * Timestamp (ISO-8601) of the most recent `labeled` event for `labelName`
 * whose actor is a trusted adder — an `allowedAuthors` login that is not a
 * fleet worker (same trust rule as {@link wasLabelAddedByAllowedAuthor}).
 * Returns null when the last add is untrusted or carries no timestamp.
 */ export function trustedLabelAddedAt(timeline, labelName, allowedAuthors, fleetWorkerLogins = []) {
  if (!labelMatchesAllowedAuthor(timeline, labelName, allowedAuthors, fleetWorkerLogins)) {
    return null;
  }
  const labelEvents = timeline.filter((e)=>e.event === "labeled" && e.label?.name === labelName);
  const last = labelEvents[labelEvents.length - 1];
  return typeof last?.created_at === "string" && last.created_at !== "" ? last.created_at : null;
}
/**
 * True when `labelAddedAt` is a valid timestamp strictly after the PR's
 * close/merge time — i.e. a human re-applied the discovery label after the
 * fleet's PR landed, which reopens the issue for the fleet (VibeCoder#42).
 * A PR with no usable `closedAt` cannot be compared and keeps blocking.
 */ export function isRelabelledAfterClosedPR(closedPR, labelAddedAt) {
  if (labelAddedAt === null) return false;
  const closed = Date.parse(closedPR.closedAt);
  const added = Date.parse(labelAddedAt);
  if (!Number.isFinite(closed) || !Number.isFinite(added)) return false;
  return added > closed;
}
/**
 * Did a trusted author re-apply `labelName` to the issue AFTER `closedPR`
 * closed or merged? (VibeCoder#42)
 *
 * The closed-PR gate marks an issue whose fleet PR merged as done for the
 * fleet, permanently. Its documented escape hatch is "a human re-opens the
 * issue or re-applies the discovery label" — but the gate matched on the PR
 * title alone and never looked at the timeline, so a re-label (e.g.
 * `work-on` → `top-priority` after two partial PRs landed) was silently
 * ignored and the issue could never be picked up again. This helper supplies
 * the missing comparison.
 *
 * Cache trust follows {@link wasLabelAddedByAllowedAuthor} (Issue #3709): a
 * complete cached timeline may only *deny* a reopen (no trusted add after
 * the PR). A cached entry that would grant it is re-confirmed live, because
 * granting a pickup from a file under TMPDIR is exactly the escalation path
 * that finding closed. Denial dominates during a scan, so the N+1 collapse
 * is kept where it matters.
 */ export async function wasLabelReappliedAfterClosedPR(repo, issueNumber, labelName, allowedAuthors, closedPR, ghCommandFn = runGhCommand, cache, fleetWorkerLogins = []) {
  if (cache) {
    const cached = await cache.readComplete(repo, issueNumber);
    if (cached !== null && !isRelabelledAfterClosedPR(closedPR, trustedLabelAddedAt(cached, labelName, allowedAuthors, fleetWorkerLogins))) {
      return false;
    }
  }
  const timeline = await paginateTimeline(repo, issueNumber, ghCommandFn, cache);
  if (timeline === null) return false;
  return isRelabelledAfterClosedPR(closedPR, trustedLabelAddedAt(timeline, labelName, allowedAuthors, fleetWorkerLogins));
}
// =============================================================================
// Recently-closed PR blocking (Issue #1427)
// =============================================================================
/**
 * Parse raw gh pr list JSON for closed PRs into ClosedPR array.
 *
 * @param jsonStr - Raw JSON string from gh CLI
 * @returns Parsed closed PRs
 */ export function parseClosedPRListJson(jsonStr) {
  try {
    const raw = JSON.parse(jsonStr);
    if (!Array.isArray(raw)) return [];
    // Inline runtime shape guard (Issue #1532).
    const items = [];
    for (const item of raw){
      if (!isRecord(item)) continue;
      if (typeof item.number !== "number") continue;
      if (typeof item.title !== "string") continue;
      items.push({
        number: item.number,
        title: item.title,
        closedAt: typeof item.closedAt === "string" ? item.closedAt : ""
      });
    }
    return items;
  } catch  {
    return [];
  }
}
/**
 * Fetch closed PRs by a user (Issue #1809).
 *
 * Used by repo-wide closed-PR scans (e.g. stuck_recovery's
 * `detectAssignedWithClosedPr`) so per-issue title-search calls
 * collapse to one `gh pr list` per repo. Cache key is
 * `prs_closed_${user}`. Pair with the iteration-scoped `IssueCache`.
 *
 * The richer `{ number, title, mergedAt, closedAt }` shape is also
 * read by `fetchRecentlyClosedPRsByUser` (Issue #1427) which filters
 * locally by cooldown, so both helpers share one network call.
 *
 * @param repo - Repository in "owner/repo" format
 * @param githubUser - GitHub username
 * @param limit - Maximum PRs to fetch (default: 100)
 * @param cache - Optional cache instance
 * @param ghCommandFn - Optional gh command function for testing
 * @returns Array of closed PRs with merge state
 *
 * Ordered by update recency, not creation date, so a long-lived PR's close
 * or merge keeps it in the window (Issue #2901).
 */ export async function fetchClosedPRsByUser(repo, githubUser, limit = 100, cache, ghCommandFn = runGhCommand, /** Clock override, epoch seconds (tests). */ nowSeconds = ()=>Math.floor(Date.now() / 1000)) {
  const cacheKey = `prs_closed_${githubUser}`;
  if (cache) {
    // Issue #2409: served while no open PR of this author has gone.
    const cached = await readSettledListing(repo, githubUser, cacheKey, cache, ghCommandFn, nowSeconds());
    if (cached) return cached;
  }
  const output = await ghCommandFn([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "closed",
    "--author",
    githubUser,
    "--search",
    RECENCY_ORDER_SEARCH,
    "--json",
    "number,title,mergedAt,closedAt,body",
    "--limit",
    String(limit)
  ]);
  let parsed;
  try {
    parsed = JSON.parse(output.trim() || "[]");
  } catch  {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const prs = [];
  for (const item of parsed){
    if (!isRecord(item)) continue;
    if (typeof item.number !== "number") continue;
    prs.push({
      number: item.number,
      title: typeof item.title === "string" ? item.title : "",
      mergedAt: typeof item.mergedAt === "string" ? item.mergedAt : null,
      closedAt: typeof item.closedAt === "string" ? item.closedAt : null,
      lifecycleAssignmentId: assignmentIdFromBody(typeof item.body === "string" ? item.body : "") ?? null,
      // Issue #1528: what the body's closing keywords name, not the body.
      closingRefs: extractClosingIssueNumbers(typeof item.body === "string" ? item.body : ""),
      partOfRefs: extractPartOfIssueNumbers(typeof item.body === "string" ? item.body : ""),
      missingCriteria: findMissingCriteria(typeof item.body === "string" ? item.body : "")
    });
  }
  if (cache) {
    await writeSettledListing(repo, githubUser, cacheKey, prs, cache, ghCommandFn, nowSeconds());
  }
  return prs;
}
/**
 * Invalidate the `fetchClosedPRsByUser` / `fetchRecentlyClosedPRsByUser`
 * cache entry (Issue #1809). Use after closing or merging a PR authored
 * by `githubUser` so a follow-up scan in the same iteration sees the
 * fresh state.
 */ export async function invalidateClosedPRsByUser(repo, githubUser, cache) {
  await cache.invalidate(repo, `prs_closed_${githubUser}`);
}
/**
 * Fetch recently-closed (not merged) PRs by a user within a cooldown window.
 *
 * Used to prevent the worker from immediately re-creating a PR for an issue
 * whose previous PR was just closed (Issue #1427).
 *
 * Issue #1809: reads through `fetchClosedPRsByUser` so this helper and
 * the repo-wide closed-PR scan in `stuck_recovery.ts` share one
 * `prs_closed_${user}` cache and one network call per iteration.
 *
 * @param repo - Repository in "owner/repo" format
 * @param githubUser - GitHub username
 * @param cooldownSeconds - Only return PRs closed within this many seconds
 * @param cache - Optional cache instance
 * @param ghCommandFn - Optional gh command function for testing
 * @returns Array of recently-closed PRs
 */ export async function fetchRecentlyClosedPRsByUser(repo, githubUser, cooldownSeconds, cache, ghCommandFn = runGhCommand) {
  const all = await fetchClosedPRsByUser(repo, githubUser, 100, cache, ghCommandFn);
  // Filter to only include PRs closed within the cooldown window.
  const cutoffMs = Date.now() - cooldownSeconds * 1000;
  const recent = [];
  for (const pr of all){
    if (!pr.closedAt) continue;
    if (new Date(pr.closedAt).getTime() < cutoffMs) continue;
    recent.push({
      number: pr.number,
      title: pr.title,
      closedAt: pr.closedAt,
      merged: pr.mergedAt !== null && pr.mergedAt !== ""
    });
  }
  return recent;
}
/**
 * Fetch the fleet-wide set of PRs that should block re-picking up an issue
 * (Issue #3151).
 *
 * Mirrors `fetchOpenPRsForFleet` for the closed/merged side of the
 * duplicate-PR guard. The single-account `fetchRecentlyClosedPRsByUser`
 * missed a PR merged or closed by a **sibling** fleet account, so after a
 * sibling merged a PR the issue was re-picked-up and a second PR opened
 * (the Failure Mode B in #3136). Unions across every supplied fleet author
 * (typically `[githubUser, ...allowedAuthors, ...fleetPrAuthors]`) two
 * classes of PR:
 *
 *   - **Merged** PRs — included regardless of age. Once any fleet PR for an
 *     issue merges, that issue is done for the fleet: re-pickup requires a
 *     human to re-open the issue or re-apply the discovery label (the
 *     collectors honour a re-label dated after the merge via
 *     {@link wasLabelReappliedAfterClosedPR}, VibeCoder#42). Marked
 *     `merged: true` so the skip is otherwise *permanent*, not
 *     cooldown-windowed.
 *   - **Closed-unmerged** PRs — included only when closed within
 *     `cooldownSeconds`, so the retry path stays available once the window
 *     elapses. Marked `merged: false`.
 *
 * `gh pr list --state closed` returns both closed-unmerged and merged PRs
 * (merged PRs carry a non-null `mergedAt`), so one `fetchClosedPRsByUser`
 * call per author covers both classes — no extra `gh` calls beyond the
 * per-author closed-PR fetch the guard already makes. Results are
 * de-duplicated by PR number; a merged classification always wins over a
 * closed-unmerged one for the same number. Empty/blank authors are skipped.
 *
 * @param repo - Repository in "owner/repo" format
 * @param authors - Fleet GitHub usernames (deduplicated internally)
 * @param cooldownSeconds - Closed-unmerged PRs older than this are excluded;
 *   merged PRs are always included regardless
 * @param cache - Optional cache instance
 * @param ghCommandFn - Optional gh command function for testing
 * @returns De-duplicated closed/merged PRs across all fleet authors
 */ export async function fetchRecentlyClosedPRsForFleet(repo, authors, cooldownSeconds, cache, ghCommandFn = runGhCommand) {
  const distinctAuthors = [
    ...new Set(authors.filter((a)=>a && a.trim().length > 0))
  ];
  const cutoffMs = Date.now() - cooldownSeconds * 1000;
  const byNumber = new Map();
  for (const author of distinctAuthors){
    const all = await fetchClosedPRsByUser(repo, author, 100, cache, ghCommandFn);
    for (const pr of all){
      const isMerged = pr.mergedAt !== null && pr.mergedAt !== "";
      if (isMerged) {
        // Merged fleet PR → permanent skip, regardless of cooldown window.
        byNumber.set(pr.number, {
          number: pr.number,
          title: pr.title,
          closedAt: pr.closedAt ?? pr.mergedAt ?? "",
          merged: true,
          ...pr.closingRefs ? {
            closingRefs: pr.closingRefs
          } : {},
          ...pr.partOfRefs ? {
            partOfRefs: pr.partOfRefs
          } : {},
          ...pr.missingCriteria?.length ? {
            missingCriteria: pr.missingCriteria
          } : {}
        });
        continue;
      }
      // Closed-unmerged → retry path: only block within the cooldown window.
      if (!pr.closedAt) continue;
      if (new Date(pr.closedAt).getTime() < cutoffMs) continue;
      // Never downgrade a PR already classified as merged for this number.
      if (byNumber.get(pr.number)?.merged) continue;
      byNumber.set(pr.number, {
        number: pr.number,
        title: pr.title,
        closedAt: pr.closedAt,
        merged: false,
        ...pr.closingRefs ? {
          closingRefs: pr.closingRefs
        } : {}
      });
    }
  }
  return [
    ...byNumber.values()
  ];
}
/**
 * Whether a **merged** PR positively names `issueNumber` (Issue #4478).
 *
 * Positive identification is the PR body's closing keywords (`closingRefs`)
 * or the canonical delimited title form `(Issue #N)`, `(#N)`, `[#N]`. A bare
 * `#N` in a title is only a mention, e.g. a PR that *filed* the issue, and
 * must not decide a merged verdict, which is permanent (Issue #3151).
 */ export function mergedPrNamesIssue(pr, issueNumber) {
  // Issue #3177: the closers leave an issue open, queued to finish, when the
  // merged PR's closure block marks a criterion `partial` or `missing` —
  // even under `Closes #N`. The scan must agree, or
  // the issue and every issue that depends on it are stranded for good.
  if ((pr.missingCriteria ?? []).length > 0) return false;
  if ((pr.closingRefs ?? []).includes(issueNumber)) return true;
  // Issue #3177: a body that says only `Part of #N` left the work unfinished
  // on purpose, and the closers keep the issue open to resume it. The title
  // still says `(Issue #N)`, so letting it decide stranded the issue for good.
  if ((pr.partOfRefs ?? []).includes(issueNumber)) return false;
  return prTitleMatchesIssue(pr.title, issueNumber);
}
/**
 * Check if an issue is blocked by a recently-closed PR (Issue #1427).
 *
 * A **merged** PR blocks only on positive identification (Issue #4478), via
 * {@link mergedPrNamesIssue}, because its verdict is permanent (Issue #3151).
 * A **closed-unmerged** PR keeps the over-matching
 * {@link prTitleReferencesIssue}, since its cooldown lapses and the retry
 * path is the safer side to over-match on.
 *
 * Issue #319: this used to test the title for a bare `#N` with a `RegExp`
 * built from the issue number, which knows nothing about *which* issue a PR
 * was for. PR #212 — "…stservice's open PR #188 did not block VibeCoderST
 * claiming NEAT-AI-Lamarck#187 … (Issue #209)" — was a PR for issue #209, yet
 * it blocked #178, #184, #187, #188 and #209 alike. Because a **merged** PR
 * stays in this set permanently (Issue #3151), those issues were stranded for
 * good, under a skip reason that reads as a passing "cooldown". Issue #4478
 * closed that gap for the merged verdict: a bare `#N` in a merged PR's title
 * no longer blocks, so only {@link mergedPrNamesIssue} decides it.
 *
 * @param closedPRs - Array of recently-closed PRs
 * @param issueNumber - The issue number to check
 * @returns The blocking closed PR, or null if not blocked
 */ export function isBlockedByRecentlyClosedPR(closedPRs, issueNumber) {
  if (closedPRs.length === 0) return null;
  return closedPRs.find((pr)=>pr.merged === true ? mergedPrNamesIssue(pr, issueNumber) : prTitleReferencesIssue(pr.title, issueNumber)) ?? null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9pc3N1ZV9xdWVyeS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEdpdEh1YiBBUEkgcXVlcnkgZnVuY3Rpb25zIGZvciBpc3N1ZSBkaXNjb3ZlcnkgKElzc3VlICM5MTApLlxuICpcbiAqIFJlcGxhY2VzIHdvcmtlci9zaGFyZWQvaXNzdWVfcXVlcnkuc2ggd2l0aCB0eXBlLXNhZmUgVHlwZVNjcmlwdC5cbiAqIEhhbmRsZXMgYWxsIGRpcmVjdCBHaXRIdWIgQVBJIGludGVyYWN0aW9ucyBmb3IgaXNzdWUgZmluZGluZzpcbiAqIHF1ZXJ5aW5nIGlzc3VlcywgZmV0Y2hpbmcgUFJzLCBjaGVja2luZyBQUiBibG9ja2luZywgYW5kXG4gKiB2ZXJpZnlpbmcgbGFiZWwgYXV0aG9yc2hpcCBmb3Igc2VjdXJpdHkuXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggc3BlbGxpbmcgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pXG4gKi9cblxuaW1wb3J0IHtcbiAgYXNzaWdubWVudElkRnJvbUJvZHksXG4gIGV4dHJhY3RDbG9zaW5nSXNzdWVOdW1iZXJzLFxuICBleHRyYWN0SXNzdWVOdW1iZXJGcm9tUHJUaXRsZSxcbn0gZnJvbSBcIi4vcHJfYm9keS50c1wiO1xuaW1wb3J0IHtcbiAgZXh0cmFjdFBhcnRPZklzc3VlTnVtYmVycyxcbiAgZmluZE1pc3NpbmdDcml0ZXJpYSxcbn0gZnJvbSBcIi4vbWlzc2luZ19jcml0ZXJpb25fY2xvc2VfZ3VhcmQudHNcIjtcbmltcG9ydCB7IHJ1bkdoQ29tbWFuZCB9IGZyb20gXCIuL2dpdGh1Yi50c1wiO1xuaW1wb3J0IHtcbiAgcHJUaXRsZU1hdGNoZXNJc3N1ZSxcbiAgcHJUaXRsZVJlZmVyZW5jZXNJc3N1ZSxcbn0gZnJvbSBcIi4vcHJfdGl0bGVfaXNzdWVfcmVmLnRzXCI7XG5pbXBvcnQgeyBpc01pbGVzdG9uZVN5bmNCcmFuY2ggfSBmcm9tIFwiLi9taWxlc3RvbmVfc3luY19icmFuY2gudHNcIjtcbmltcG9ydCB7IGlzc3VlTnVtYmVyRnJvbUJyYW5jaCB9IGZyb20gXCIuL2lzc3VlX2JyYW5jaF9jYW5kaWRhdGVzLnRzXCI7XG4vLyBJc3N1ZSAjMjkwMDogcmUtZXhwb3J0IHRoZSBzaW5nbGUgY2Fub25pY2FsIG1pbGVzdG9uZS1icmFuY2ggbmFtZXIgZnJvbVxuLy8gZ2l0X2JyYW5jaC50cyBzbyBQUi1ibG9ja2luZyB1c2VzIHRoZSBzYW1lIGJyYW5jaCBuYW1lIHRoZSBmZWF0dXJlIFBSXG4vLyBhY3R1YWxseSB0YXJnZXRzICg1MC1jaGFyIHNsdWcgY2FwICsgdHJhaWxpbmctaHlwaGVuIHN0cmlwKS5cbmltcG9ydCB7IGNyZWF0ZU1pbGVzdG9uZUJyYW5jaE5hbWUgfSBmcm9tIFwiLi9naXRfYnJhbmNoLnRzXCI7XG5pbXBvcnQgeyBpc0h1bWFuQXV0aG9yZWRQciB9IGZyb20gXCIuL2ZsZWV0X2F1dGhvcnMudHNcIjtcbmltcG9ydCB7IG5vcm1hbGlzZUdoQXBwTG9naW4gfSBmcm9tIFwiLi90cnVzdF9leGNsdXNpb25zLnRzXCI7XG5leHBvcnQgeyBjcmVhdGVNaWxlc3RvbmVCcmFuY2hOYW1lIH07XG5pbXBvcnQgeyBDTE9TRURfTUlMRVNUT05FX0NBQ0hFX1BSRUZJWCwgSXNzdWVDYWNoZSB9IGZyb20gXCIuL2lzc3VlX2NhY2hlLnRzXCI7XG5pbXBvcnQgdHlwZSB7IElzc3VlU3ViQWdlbnRUaWVyLCBXb3JrZXJDb25maWcgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB7IHN1YkFnZW50VGllckZyb21Cb2R5IH0gZnJvbSBcIi4vcHJfYm9keS50c1wiO1xuaW1wb3J0IHR5cGUgeyBGaWx0ZXJhYmxlSXNzdWUgfSBmcm9tIFwiLi9pc3N1ZV9maWx0ZXIudHNcIjtcbmltcG9ydCB7IFRpbWVsaW5lQ2FjaGUgfSBmcm9tIFwiLi90aW1lbGluZV9jYWNoZS50c1wiO1xuaW1wb3J0IHsgaXNXb3JrZXJQbGFubmluZ0hhbmRvZmYgfSBmcm9tIFwiLi9wbGFubmluZ19oYW5kb2ZmX3RydXN0LnRzXCI7XG4vLyBJc3N1ZSAjNDAzNzogZm9sZCB0aGUgcGVyLXRpY2sgaXNzdWUtbGlzdCBmZXRjaCBpbnRvIHRoZSBhY2Nlc3Mgc3RvcmUuXG5pbXBvcnQgeyBjbGFzc2lmeVByb2JlRmFpbHVyZSB9IGZyb20gXCIuL2lkbGVfZGV0ZWN0X2RpYWdub3N0aWNzLnRzXCI7XG5pbXBvcnQgeyByZWNvcmRSZXBvUHJvYmVCZXN0RWZmb3J0IH0gZnJvbSBcIi4vbW9uaXRvcmVkX3JlcG9fYWNjZXNzLnRzXCI7XG5pbXBvcnQge1xuICB0eXBlIFRpbWVsaW5lTGFiZWxFdmVudEpzb24sXG4gIHZhbGlkYXRlSXNzdWVMYWJlbHNKc29uLFxuICB2YWxpZGF0ZVRpbWVsaW5lTGFiZWxFdmVudHNKc29uLFxufSBmcm9tIFwiLi92YWxpZGF0aW9uLnRzXCI7XG5cbi8qKlxuICogT3BlbiBQUiBkYXRhIGZvciBibG9ja2luZyBjaGVja3MuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgT3BlblBSIHtcbiAgbnVtYmVyOiBudW1iZXI7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGJhc2VSZWZOYW1lOiBzdHJpbmc7XG4gIGhlYWRSZWZOYW1lOiBzdHJpbmc7XG4gIC8qKlxuICAgKiBUaGUgZmxlZXQgbG9naW4gdGhpcyBQUiB3YXMgZmV0Y2hlZCB1bmRlciAoSXNzdWUgIzQwMjQpLiBTdGFtcGVkIGJ5XG4gICAqIGBmZXRjaE9wZW5QUnNCeVVzZXJgIGZyb20gdGhlIGAtLWF1dGhvcmAgaXQgcXVlcmllZCwgc28gYSBibG9ja2luZ1xuICAgKiBkZWNpc2lvbiBjYW4gbmFtZSB0aGUgYXV0aG9yIGFuZCBjaGVjayBpdCBhZ2FpbnN0IHRoZSBQUi1tYWludGVuYW5jZVxuICAgKiBzY2FuIHNldC4gT3B0aW9uYWw6IGNhY2hlIGVudHJpZXMgd3JpdHRlbiBiZWZvcmUgIzQwMjQgbGFjayBpdC5cbiAgICovXG4gIGF1dGhvcj86IHN0cmluZztcbiAgLyoqXG4gICAqIFRoZSBsb2dpbiBvZiB0aGUgaGVhZCByZXBvc2l0b3J5J3Mgb3duZXIsIHdoZW4gdGhlIHF1ZXJ5IGFza2VkIGZvciBpdFxuICAgKiAoSXNzdWUgIzEyNjQpLiBgZ2ggcHIgbGlzdCAtLWhlYWQgPGJyYW5jaD5gIG1hdGNoZXMgb24gYGhlYWRSZWZOYW1lYFxuICAgKiBhbG9uZSwgc28gYSBmb3JrJ3MgUFIgYXBwZWFycyBpbiBhIHBlci1icmFuY2ggbGlzdGluZyBleGFjdGx5IGxpa2UgYVxuICAgKiBQUiBmcm9tIHRoZSB0YXJnZXQgcmVwby4gQW55IGNvbnN1bWVyIHRoYXQgYWN0cyAqZGVzdHJ1Y3RpdmVseSogb24gYVxuICAgKiBsaXN0ZWQgUFIgbXVzdCBjb21wYXJlIHRoaXMgYWdhaW5zdCB0aGUgdGFyZ2V0IHJlcG8ncyBvd25lci4gT3B0aW9uYWw6XG4gICAqIHF1ZXJpZXMgdGhhdCBkbyBub3QgcmVxdWVzdCB0aGUgZmllbGQsIGFuZCBjYWNoZSBlbnRyaWVzIHdyaXR0ZW5cbiAgICogYmVmb3JlICMxMjY0LCBsZWF2ZSBpdCB1bnNldCDigJQgdHJlYXQgdW5zZXQgYXMgXCJvd25lcnNoaXAgdW5rbm93blwiIGFuZFxuICAgKiByZWZ1c2UgdG8gYWN0LlxuICAgKi9cbiAgaGVhZFJlcG9zaXRvcnlPd25lcj86IHN0cmluZztcbiAgLyoqXG4gICAqIFRydWUgd2hlbiB0aGUgaGVhZCBicmFuY2ggbGl2ZXMgaW4gYSAqKmRpZmZlcmVudCoqIHJlcG9zaXRvcnkg4oCUIGEgZm9ya1xuICAgKiAoSXNzdWUgIzEyNjQpLiBTZXQgb25seSB3aGVuIHRoZSBxdWVyeSBhc2tlZCBmb3IgaXQ7IHVuc2V0IG1lYW5zXG4gICAqIFwidW5rbm93blwiLCB3aGljaCBhIGRlc3RydWN0aXZlIGNvbnN1bWVyIG11c3QgdHJlYXQgYXMgXCJub3Qgb3Vyc1wiLlxuICAgKi9cbiAgaXNDcm9zc1JlcG9zaXRvcnk/OiBib29sZWFuO1xuICAvKipcbiAgICogVHJ1ZSB3aGVuIHRoZSBQUiBpcyBhIGRyYWZ0IChJc3N1ZSAjMTgwMCkuIEdpdEh1YiByZWZ1c2VzIHRvIGFybVxuICAgKiBhdXRvLW1lcmdlIG9uIGEgZHJhZnQsIHNvIHRoZSBzd2VlcCBza2lwcyBvbmUgcmF0aGVyIHRoYW4gZmFpbGluZyBvblxuICAgKiBpdCBldmVyeSBjeWNsZS4gU2V0IG9ubHkgd2hlbiB0aGUgcXVlcnkgYXNrZWQgZm9yIGl0OyBjYWNoZSBlbnRyaWVzXG4gICAqIHdyaXR0ZW4gYmVmb3JlICMxODAwIGxlYXZlIGl0IHVuc2V0LCB3aGljaCBtZWFucyBcInVua25vd25cIiBhbmQgaXNcbiAgICogdHJlYXRlZCBhcyBub3QgYSBkcmFmdC5cbiAgICovXG4gIGlzRHJhZnQ/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIE9wZW4gUFIgd2l0aCBib2R5IGNvbnRlbnQsIHVzZWQgYnkgaGVscGVycyB0aGF0IG5lZWQgdG8gaWRlbnRpZnlcbiAqIHdvcmtlciBQUnMgYnkgYm9keSBtYXJrZXIgKElzc3VlICMxNzg3KS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBPcGVuUFJXaXRoQm9keSBleHRlbmRzIE9wZW5QUiB7XG4gIGJvZHk6IHN0cmluZztcbiAgdXJsOiBzdHJpbmc7XG4gIC8qKlxuICAgKiBUaGUgUFIncyBsYWJlbCBuYW1lcyAoSXNzdWUgIzI0MDkpLiBDYXJyaWVkIGJ5IHtAbGluayBmZXRjaEFsbE9wZW5QUnN9XG4gICAqIG9ubHksIHNvIGEgcGFzcyB0aGF0IHdvdWxkIG90aGVyd2lzZSBhc2sgZWFjaCByZXBvc2l0b3J5IFwid2hpY2ggb3BlbiBQUnNcbiAgICogY2FycnkgbGFiZWwgWD9cIiBldmVyeSBjeWNsZSBjYW4gcmVhZCB0aGUgYW5zd2VyIG9mZiB0aGUgbGlzdGluZyB0aGUgc2NhblxuICAgKiBhbHJlYWR5IGhvbGRzLiBBYnNlbnQgb24gcm93cyBmcm9tIGEgbGlzdGluZyB0aGF0IGRpZCBub3QgYXNrIGZvciBsYWJlbHMuXG4gICAqL1xuICBsYWJlbHM/OiBzdHJpbmdbXTtcbiAgLyoqXG4gICAqIFRoZSBsaXN0aW5nIGF1dGhvcidzIGxvZ2luLCB3aGVuIGBnaGAgcmVwb3J0ZWQgb25lIChJc3N1ZSAjMTg0NikuXG4gICAqXG4gICAqIEEgR2l0SHViIEFwcCBhdXRob3IgaXMgcmVjb3JkZWQgYXMgYDxzbHVnPltib3RdYCwgdGhlIFJFU1QgZm9ybSwgbm90IHRoZVxuICAgKiBgYXBwLzxzbHVnPmAgdGhhdCBgZ2ggcHIgbGlzdCAtLWpzb24gYXV0aG9yYCByZXBvcnRzIChJc3N1ZSAjNDcxOSkuIEFuXG4gICAqIG9yZGluYXJ5IHVzZXIncyBsb2dpbiBpcyByZWNvcmRlZCBhcyByZXBvcnRlZC5cbiAgICpcbiAgICogTmFtZWQgYXBhcnQgZnJvbSB7QGxpbmsgT3BlblBSLmF1dGhvcn0gZGVsaWJlcmF0ZWx5OiB0aGF0IGZpZWxkIGNhcnJpZXNcbiAgICogdGhlICpmbGVldCBsb2dpbiB0aGUgUFIgd2FzIGZldGNoZWQgdW5kZXIqIChJc3N1ZSAjNDAyNCkgYW5kIGZlZWRzXG4gICAqIGBnZXRCbG9ja2luZ1BSRm9ySXNzdWVgLCBzbyBvdmVybG9hZGluZyBpdCB3aXRoIHRoZSBsaXN0aW5nJ3Mgb3duIGF1dGhvclxuICAgKiB3b3VsZCBzaWxlbnRseSBjaGFuZ2Ugd2hpY2ggUFJzIGJsb2NrIGlzc3VlIHBpY2t1cC4gVW5zZXQgbWVhbnMgdGhlXG4gICAqIGF1dGhvciBjb3VsZCBub3QgYmUgZXN0YWJsaXNoZWQg4oCUIGEgY29uc3VtZXIgdGhhdCBhY3RzIG9uIGF1dGhvcnNoaXBcbiAgICogbXVzdCB0cmVhdCB0aGF0IGFzIFwidW5rbm93blwiIGFuZCByZWZ1c2UgdG8gYWN0LlxuICAgKi9cbiAgYXV0aG9yTG9naW4/OiBzdHJpbmc7XG4gIC8qKiBIZWFkIGNvbW1pdCBTSEEsIHdoZW4gdGhlIHF1ZXJ5IGFza2VkIGZvciBpdCAoSXNzdWUgIzE4NDYpLiAqL1xuICBoZWFkUmVmT2lkPzogc3RyaW5nO1xuICAvKipcbiAgICogVGhlIFBSJ3MgYXJtZWQgYXV0by1tZXJnZSByZXF1ZXN0LCB3aGVuIHRoZSBxdWVyeSBhc2tlZCBmb3IgaXRcbiAgICogKElzc3VlICMxODQ2KS4gYG51bGxgIG1lYW5zIFwiYXNrZWQgZm9yLCBub3QgYXJtZWRcIjsgdW5zZXQgbWVhbnMgdGhlXG4gICAqIHF1ZXJ5IGRpZCBub3QgYXNrLlxuICAgKi9cbiAgYXV0b01lcmdlUmVxdWVzdD86IHsgbWVyZ2VNZXRob2Q6IHN0cmluZyB9IHwgbnVsbDtcbiAgLyoqIGBNRVJHRUFCTEVgIC8gYENPTkZMSUNUSU5HYCAvIGBVTktOT1dOYCwgd2hlbiBhc2tlZCBmb3IgKElzc3VlICMxODQ2KS4gKi9cbiAgbWVyZ2VhYmxlPzogc3RyaW5nO1xufVxuXG4vKipcbiAqIE1lcmdlZCBQUiB3aXRoIGhlYWQgYnJhbmNoIGluZm8gKElzc3VlICMxNzg3KS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBNZXJnZWRQUiB7XG4gIC8qKiBOdWxsIG1lYW5zIG5vIG1hcmtlcjsgYWJzZW50IG9uIG9sZGVyIGNhY2hlIHJvd3MsIHdoaWNoIGNhbGxlcnMgcmUtcmVhZC4gKi9cbiAgbGlmZWN5Y2xlQXNzaWdubWVudElkPzogc3RyaW5nIHwgbnVsbDtcbiAgbnVtYmVyOiBudW1iZXI7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGhlYWRSZWZOYW1lOiBzdHJpbmc7XG4gIC8qKlxuICAgKiBJU08tODYwMSBtZXJnZSB0aW1lc3RhbXAsIG9yIGBcIlwiYCB3aGVuIGl0IGNvdWxkIG5vdCBiZSByZWFkIOKAlCBpbmNsdWRpbmdcbiAgICogZnJvbSBhIGNhY2hlIGVudHJ5IHdyaXR0ZW4gYmVmb3JlIHRoaXMgZmllbGQgd2FzIGNvbGxlY3RlZCAoSXNzdWUgIzQ4MikuXG4gICAqXG4gICAqIENvbnN1bWVycyB0aGF0IGFjdCBkZXN0cnVjdGl2ZWx5IG9uIHRoZSBQUi9pc3N1ZSBsaW5rIG11c3QgdHJlYXQgYFwiXCJgIGFzXG4gICAqIFwib3JkZXJpbmcgdW5rbm93blwiIGFuZCBkZWZlciwgbmV2ZXIgYXMgcGVybWlzc2lvbiB0byBwcm9jZWVkOiBhbiBpc3N1ZVxuICAgKiBmaWxlZCBhZnRlciB0aGUgbWVyZ2UgY2Fubm90IGJlIHRoZSBtZXJnZSdzIHN1YmplY3QsIGFuZCB0aGF0IGlzIG9ubHlcbiAgICogZGVjaWRhYmxlIHdpdGggdGhpcyB0aW1lc3RhbXAuXG4gICAqL1xuICBtZXJnZWRBdDogc3RyaW5nO1xuICAvKipcbiAgICogSXNzdWVzIHRoZSBQUiBib2R5J3MgY2xvc2luZyBrZXl3b3JkcyBuYW1lIChgRml4ZXMgI05gLCBgQ2xvc2VzICNOYCwg4oCmKSxcbiAgICogc2FtZS1yZXBvc2l0b3J5IG9ubHkgKElzc3VlICMxNTI4KS4gR2l0SHViIGhvbm91cnMgdGhlbSBvbmx5IG9uIGEgbWVyZ2VcbiAgICogaW50byB0aGUgZGVmYXVsdCBicmFuY2gsIHNvIGEgc3ViLWlzc3VlIFBSIG1lcmdlZCBpbnRvIGEgbWlsZXN0b25lXG4gICAqIGJyYW5jaCBuZXZlciBjbG9zZWQgaXRzIGlzc3VlIGFuZCBoZWxkIHRoZSByb2xsdXAgc2h1dDsgdGhlIGNsb3NlcnMgcmVhZFxuICAgKiB0aGVtIGhlcmUgaW5zdGVhZC4gQWJzZW50IG9uIGEgY2FjaGUgZW50cnkgd3JpdHRlbiBiZWZvcmUgdGhpcyBmaWVsZCB3YXNcbiAgICogY29sbGVjdGVkIOKAlCB0cmVhdCBhcyBubyByZWZlcmVuY2VzLCBuZXZlciBhcyBcIm5vIGZpeFwiLlxuICAgKi9cbiAgY2xvc2luZ1JlZnM/OiBudW1iZXJbXTtcbiAgLyoqXG4gICAqIFRoZSBgcGFydGlhbGAgYW5kIGBtaXNzaW5nYCBlbnRyaWVzIG9mIHRoZSBQUiBib2R5J3MgYCMjIEFjY2VwdGFuY2VcbiAgICogQ3JpdGVyaWFgIGJsb2NrIChJc3N1ZXMgIzMxNzcsICM0NjQ0KTogYSBtZXJnZWQgUFIgd2hvc2Ugb3duIHN1bW1hcnkgbWFya3NcbiAgICogYSBjcml0ZXJpb24gcGFydGlhbCBvciBtaXNzaW5nIGRvZXMgbm90IGNsb3NlIGl0cyBpc3N1ZS4gQWJzZW50IG9uIGEgY2FjaGVcbiAgICogZW50cnkgd3JpdHRlbiBiZWZvcmUgdGhpcyBmaWVsZCB3YXMgY29sbGVjdGVkIOKAlCB0cmVhdCBhcyBub25lLlxuICAgKi9cbiAgbWlzc2luZ0NyaXRlcmlhPzogc3RyaW5nW107XG4gIC8qKlxuICAgKiBUaGUgc3ViLWFnZW50IHRpZXIgZnJvbSB0aGUgUFIgYm9keSdzIGB2aWJlLXN1Yi1hZ2VudC10aWVyYCBtYXJrZXIsXG4gICAqIGBzb25uZXRgIHdoZW4gdGhlIGJvZHkgaGFzIG5vbmUgKElzc3VlICMzNDA0KS4gQWJzZW50IG9uIGEgY2FjaGUgZW50cnlcbiAgICogd3JpdHRlbiBiZWZvcmUgdGhpcyBmaWVsZCB3YXMgY29sbGVjdGVkIOKAlCBjb25zdW1lcnMgdHJlYXQgYWJzZW50IGFzXG4gICAqIHVua25vd24sIG5vdCBhcyBzb25uZXQuXG4gICAqL1xuICBzdWJBZ2VudFRpZXI/OiBJc3N1ZVN1YkFnZW50VGllcjtcbn1cblxuLyoqXG4gKiBSZWNlbnRseS1jbG9zZWQgUFIgZGF0YSBmb3IgZHVwbGljYXRlIHByZXZlbnRpb24gKElzc3VlICMxNDI3KS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBDbG9zZWRQUiB7XG4gIG51bWJlcjogbnVtYmVyO1xuICB0aXRsZTogc3RyaW5nO1xuICBjbG9zZWRBdDogc3RyaW5nO1xuICAvKipcbiAgICogSXNzdWUgIzMxNTE6IGRpc3Rpbmd1aXNoZXMgYSAqKm1lcmdlZCoqIGZsZWV0IFBSIChwZXJtYW5lbnQgc2tpcCDigJQgYW5cbiAgICogaXNzdWUgd2hvc2UgZmxlZXQgUFIgbWVyZ2VkIGlzIGRvbmUgZm9yIHRoZSBmbGVldCwgcmVnYXJkbGVzcyBvZiB0aGVcbiAgICogY29vbGRvd24gd2luZG93KSBmcm9tIGEgKipjbG9zZWQtdW5tZXJnZWQqKiBQUiAoY29vbGRvd24td2luZG93ZWQgcmV0cnlcbiAgICogcGF0aCkuIE9wdGlvbmFsIHNvIG9sZGVyIGNhY2hlZCBgQ2xvc2VkUFJbXWAgcGF5bG9hZHMgcmVtYWluIHZhbGlkOyBhXG4gICAqIG1pc3NpbmcgdmFsdWUgaXMgdHJlYXRlZCBhcyBjbG9zZWQtdW5tZXJnZWQuXG4gICAqL1xuICBtZXJnZWQ/OiBib29sZWFuO1xuICAvKiogSXNzdWVzIHRoZSBQUiBib2R5J3MgY2xvc2luZyBrZXl3b3JkcyBuYW1lIChJc3N1ZSAjMTUyOCk7IHNlZSBNZXJnZWRQUi4gKi9cbiAgY2xvc2luZ1JlZnM/OiBudW1iZXJbXTtcbiAgLyoqXG4gICAqIElzc3VlcyB0aGUgUFIgYm9keSBuYW1lcyBvbmx5IGFzIGBQYXJ0IG9mICNOYCAoSXNzdWUgIzMxNzcpOiB3b3JrIGxlZnRcbiAgICogdW5maW5pc2hlZCwgc28gYSBtZXJnZSBkb2VzIG5vdCBlbmQgdGhlIGlzc3VlIGZvciB0aGUgZmxlZXQuIEFic2VudCBvblxuICAgKiBhbiBvbGRlciBjYWNoZSByb3cg4oCUIHRyZWF0IGFzIG5vbmUuXG4gICAqL1xuICBwYXJ0T2ZSZWZzPzogbnVtYmVyW107XG4gIC8qKlxuICAgKiBUaGUgYm9keSdzIGBwYXJ0aWFsYCAvIGBtaXNzaW5nYCBjbG9zdXJlIGVudHJpZXMgKElzc3VlICMzMTc3KS4gVGhlXG4gICAqIGNsb3NlcnMgbGVhdmUgZXZlcnkgaXNzdWUgc3VjaCBhIG1lcmdlZCBQUiBuYW1lcyBvcGVuLCBxdWV1ZWQgdG8gZmluaXNoLFxuICAgKiBzbyBpdHMgbWVyZ2UgZG9lcyBub3QgZW5kIHRoZSBpc3N1ZSBmb3IgdGhlIGZsZWV0IGVpdGhlci4gQWJzZW50IG9uIGFuXG4gICAqIG9sZGVyIGNhY2hlIHJvdyDigJQgdHJlYXQgYXMgbm9uZS5cbiAgICovXG4gIG1pc3NpbmdDcml0ZXJpYT86IHN0cmluZ1tdO1xufVxuXG4vKipcbiAqIENsb3NlZCBQUiB3aXRoIG1lcmdlIHN0YXRlIChJc3N1ZSAjMTgwOSkuXG4gKlxuICogVXNlZCBieSByZXBvLXdpZGUgY2xvc2VkLVBSIHNjYW5zIChlLmcuIHN0dWNrX3JlY292ZXJ5J3NcbiAqIGBkZXRlY3RBc3NpZ25lZFdpdGhDbG9zZWRQcmApIHNvIGNhbGxlcnMgY2FuIGRpc3Rpbmd1aXNoXG4gKiBjbG9zZWQtbm90LW1lcmdlZCBmcm9tIG1lcmdlZCBQUnMgd2l0aG91dCBhbiBleHRyYSBgZ2ggcHIgdmlld2AuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ2xvc2VkUFJXaXRoTWVyZ2Uge1xuICAvKiogTnVsbCBtZWFucyBubyBtYXJrZXI7IGFic2VudCBvbiBvbGRlciBjYWNoZSByb3dzLCB3aGljaCBjYWxsZXJzIHJlLXJlYWQuICovXG4gIGxpZmVjeWNsZUFzc2lnbm1lbnRJZD86IHN0cmluZyB8IG51bGw7XG4gIG51bWJlcjogbnVtYmVyO1xuICB0aXRsZTogc3RyaW5nO1xuICBtZXJnZWRBdDogc3RyaW5nIHwgbnVsbDtcbiAgY2xvc2VkQXQ6IHN0cmluZyB8IG51bGw7XG4gIC8qKiBJc3N1ZXMgdGhlIFBSIGJvZHkncyBjbG9zaW5nIGtleXdvcmRzIG5hbWUgKElzc3VlICMxNTI4KTsgc2VlIE1lcmdlZFBSLiAqL1xuICBjbG9zaW5nUmVmcz86IG51bWJlcltdO1xuICAvKiogSXNzdWVzIHRoZSBib2R5IG5hbWVzIG9ubHkgYXMgYFBhcnQgb2YgI05gIChJc3N1ZSAjMzE3Nyk7IHNlZSBDbG9zZWRQUi4gKi9cbiAgcGFydE9mUmVmcz86IG51bWJlcltdO1xuICAvKiogVGhlIGJvZHkncyB1bm1ldCBjbG9zdXJlIGVudHJpZXMgKElzc3VlICMzMTc3KTsgc2VlIENsb3NlZFBSLiAqL1xuICBtaXNzaW5nQ3JpdGVyaWE/OiBzdHJpbmdbXTtcbn1cblxuLyoqXG4gKiBCbG9ja2luZyBQUiBpbmZvcm1hdGlvbi5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBCbG9ja2luZ1BSSW5mbyB7XG4gIG51bWJlcjogbnVtYmVyO1xuICB0aXRsZTogc3RyaW5nO1xuICAvKipcbiAgICogVGhlIGxvZ2luIHRoZSBibG9ja2luZyBQUiB3YXMgZmV0Y2hlZCB1bmRlciAoSXNzdWUgIzQwNzgpLCBjYXJyaWVkXG4gICAqIHRocm91Z2ggZnJvbSB7QGxpbmsgT3BlblBSLmF1dGhvcn0uIENhbGxlcnMgY2xhc3NpZnkgdGhlIGJsb2NrIHdpdGhcbiAgICogaXQ6IGEgUFIgYXV0aG9yZWQgb3V0c2lkZSB0aGUgZmxlZXQncyBwdXNoLWNhcGFibGUgYWNjb3VudHMgaXMgb25lXG4gICAqIG5vIG1haW50ZW5hbmNlIHNjYW4gd2lsbCBldmVyIGZpeCwgYW5zd2VyLCBvciBtZXJnZSwgc28gdGhlIGJsb2NrZWRcbiAgICogaXNzdWUgaXMgZXNjYWxhdGVkIGluc3RlYWQgb2YgbGVmdCB0byBzdGFsbCBzaWxlbnRseSAoIzQwMjMpLlxuICAgKiBFbXB0eSB3aGVuIHRoZSBmZXRjaCBuZXZlciBzdGFtcGVkIGl0IChhIHByZS0jNDAyNCBjYWNoZSBlbnRyeSkuXG4gICAqL1xuICBhdXRob3I6IHN0cmluZztcbiAgLyoqXG4gICAqIFNldCBvbmx5IHdoZW4gYSAqKm5vbi1taWxlc3RvbmUqKiBpc3N1ZSBpcyBoZWxkIGJlY2F1c2UgdGhlIGZsZWV0J3Mgb3BlblxuICAgKiBQUnMgb24gdGhlIHJlcG8ncyBkZWZhdWx0LWJyYW5jaCBzdHJlYW0gaGF2ZSByZWFjaGVkIHRoZSBzbG90IGNhcFxuICAgKiAoSXNzdWUgIzI2NjMpLiBObyBzaW5nbGUgUFIgaXMgXCJ0aGVcIiBibG9ja2VyIHRoZW4g4oCUIHRoZSBjb3VudCBpcyDigJQgc28gYVxuICAgKiByZXBvcnRlciBzdGF0ZXMgYG9wZW5gIGFnYWluc3QgYGNhcGAgcmF0aGVyIHRoYW4gbmFtaW5nIHtAbGluayBudW1iZXJ9LlxuICAgKiBBYnNlbnQgZm9yIGEgbWlsZXN0b25lLWJyYW5jaCBob2xkLCB3aGljaCBpcyBzdGlsbCBvbmUgUFIgcGVyIG1pbGVzdG9uZS5cbiAgICovXG4gIGZsZWV0UHJDYXA/OiB7IG9wZW46IG51bWJlcjsgY2FwOiBudW1iZXIgfTtcbn1cblxuLyoqXG4gKiBWYWxpZGF0ZSBhIHJhdyBgc3ViSXNzdWVzU3VtbWFyeWAgZmllbGQgZnJvbSBgZ2ggaXNzdWUgbGlzdGAgKElzc3VlICMzMzE0KS5cbiAqXG4gKiBPbmx5IGB0b3RhbGAgYW5kIGBjb21wbGV0ZWRgIGFyZSBrZXB0IChgcGVyY2VudENvbXBsZXRlZGAgaXMgZGVyaXZhYmxlIGFuZFxuICogbm90IG5lZWRlZCk7IG1hbGZvcm1lZCBzaGFwZXMgKG5vbi1udW1iZXJzLCBuZWdhdGl2ZXMpIHJldHVybiBgdW5kZWZpbmVkYFxuICogc28gYW4gYWJzZW50IG9yIGJyb2tlbiBmaWVsZCBiZWhhdmVzIGV4YWN0bHkgbGlrZSBhbiBpc3N1ZSB3aXRoIG5vXG4gKiBzdWItaXNzdWVzIGF0IGFsbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU3ViSXNzdWVzU3VtbWFyeShcbiAgcmF3OiB1bmtub3duLFxuKTogeyB0b3RhbDogbnVtYmVyOyBjb21wbGV0ZWQ6IG51bWJlciB9IHwgdW5kZWZpbmVkIHtcbiAgaWYgKCFpc1JlY29yZChyYXcpKSByZXR1cm4gdW5kZWZpbmVkO1xuICBjb25zdCB7IHRvdGFsLCBjb21wbGV0ZWQgfSA9IHJhdztcbiAgaWYgKFxuICAgIHR5cGVvZiB0b3RhbCAhPT0gXCJudW1iZXJcIiB8fCAhTnVtYmVyLmlzRmluaXRlKHRvdGFsKSB8fCB0b3RhbCA8IDAgfHxcbiAgICB0eXBlb2YgY29tcGxldGVkICE9PSBcIm51bWJlclwiIHx8ICFOdW1iZXIuaXNGaW5pdGUoY29tcGxldGVkKSB8fFxuICAgIGNvbXBsZXRlZCA8IDBcbiAgKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuICByZXR1cm4geyB0b3RhbCwgY29tcGxldGVkIH07XG59XG5cbi8qKlxuICogRG9lcyBgaXNzdWVgIGhhdmUgYW55IG9wZW4gbmF0aXZlIEdpdEh1YiBzdWItaXNzdWVzP1xuICpcbiAqIExpdmVzIGhlcmUgKG5vdCBpbiBgaWRsZV9kZWNpc2lvbl9jZW5zdXMudHNgLCBpdHMgb25seSBwcmlvciBob21lKSBzbyBib3RoXG4gKiB0aGUgY2Vuc3VzIGFuZCB0aGUgYXVkaXQgKGBpZGxlX2RldGVjdF9kaWFnbm9zdGljcy50c2ApIGNhbiBpbXBvcnQgaXRcbiAqIHdpdGhvdXQgYSBjaXJjdWxhciBkZXBlbmRlbmN5IGJldHdlZW4gdGhvc2UgdHdvIG1vZHVsZXMgKElzc3VlICMzMzE0KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhhc09wZW5TdWJJc3N1ZXMoXG4gIGlzc3VlOiB7IHN1Yklzc3Vlc1N1bW1hcnk/OiB7IHRvdGFsOiBudW1iZXI7IGNvbXBsZXRlZDogbnVtYmVyIH0gfSxcbik6IGJvb2xlYW4ge1xuICAvLyBTSU1QTEUtT04tUFVSUE9TRTogbmF0aXZlIHN1Yi1pc3N1ZSBjb3VudHMgb25seSwgbm90IGJvZHkgdGFzay1saXN0IGNoaWxkcmVuIG9yIG5vdC1wbGFubmVkIGNsb3N1cmVzIChvdmVyLWhvbGRzIHNhZmVseSkg4oCUIHVwZ3JhZGUgd2hlbiBhbiBpbnZlcnNpb24gYWxlcnQgbmFtZXMgYSB0YXNrLWxpc3Qtb25seSBvciBub3QtcGxhbm5lZC1jbG9zZWQgcGFyZW50LlxuICBjb25zdCBzdW1tYXJ5ID0gaXNzdWUuc3ViSXNzdWVzU3VtbWFyeTtcbiAgaWYgKHN1bW1hcnkgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gc3VtbWFyeS50b3RhbCA+IHN1bW1hcnkuY29tcGxldGVkO1xufVxuXG4vKipcbiAqIFJlZnVzZSB0byB0cmVhdCBhIGZhaWxlZCBnaCBsaXN0IGNhbGwgYXMgYW4gZW1wdHkgbGlzdCAoSXNzdWUgIzQyNTcpLlxuICpcbiAqIGBydW5HaGAtc3R5bGUgd3JhcHBlcnMgcmV0dXJuIGBcIlwiYCBvbiBmYWlsdXJlIChyYXRlIGxpbWl0LCBuZXR3b3JrLFxuICogYXV0aCkuIFBhcnNpbmcgdGhhdCBsZW5pZW50bHkgeWllbGRzIGBbXWAsIGFuZCBjYWNoaW5nIGl0IHBvaXNvbnMgdGhlXG4gKiBzaGFyZWQgaXRlcmF0aW9uIGNhY2hlIGZvciB0aGUgVFRMIOKAlCBldmVyeSBkb3duc3RyZWFtIHJlYWRlciB0aGVuIHNlZXNcbiAqIGFuIGVtcHR5IHJlcG8gKHRoZSAjMzkwNi8jMzkwOCBpbmNpZGVudCBzaGFwZSkuIEEgZ2VudWluZSBlbXB0eSBsaXN0XG4gKiBpcyB0aGUgdHdvLWJ5dGUgb3V0cHV0IGBbXWA7IGFueXRoaW5nIGVtcHR5IG9yIHVucGFyc2VhYmxlIGlzIGEgZmFpbGVkXG4gKiBjYWxsIGFuZCB0aHJvd3MgYmVmb3JlIGFueSBjYWNoZSB3cml0ZS5cbiAqL1xuZnVuY3Rpb24gYXNzZXJ0TGlzdE91dHB1dChvdXRwdXQ6IHN0cmluZywgY29udGV4dDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHRyaW1tZWQgPSBvdXRwdXQudHJpbSgpO1xuICBpZiAodHJpbW1lZCA9PT0gXCJcIikge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGAke2NvbnRleHR9OiBnaCByZXR1cm5lZCBubyBvdXRwdXQg4oCUIHRyZWF0aW5nIGFzIGEgZmFpbGVkIGNhbGwsIGAgK1xuICAgICAgICBgbm90IGFuIGVtcHR5IGxpc3QgKElzc3VlICM0MjU3KWAsXG4gICAgKTtcbiAgfVxuICB0cnkge1xuICAgIEpTT04ucGFyc2UodHJpbW1lZCk7XG4gIH0gY2F0Y2gge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGAke2NvbnRleHR9OiBnaCBvdXRwdXQgd2FzIG5vdCB2YWxpZCBKU09OIOKAlCB0cmVhdGluZyBhcyBhIGZhaWxlZCBgICtcbiAgICAgICAgYGNhbGwgKElzc3VlICM0MjU3KWAsXG4gICAgKTtcbiAgfVxufVxuXG4vKipcbiAqIFBhcnNlIHJhdyBnaCBpc3N1ZSBsaXN0IEpTT04gaW50byBGaWx0ZXJhYmxlSXNzdWUgYXJyYXkuXG4gKlxuICogUmVqZWN0IG1hbGZvcm1lZCBsaXN0cyBhbmQgcm93cyB3aXRoIGZpZWxkIGNvbnRleHQgYmVmb3JlIGNhbGxlcnMgY2FuXG4gKiBjYWNoZSBhbiBpbmNvbXBsZXRlIHNuYXBzaG90IChJc3N1ZSAjNDEyNCkuIE9wdGlvbmFsIGFic2VudCBmaWVsZHMgcmV0YWluXG4gKiB0aGVpciBleGlzdGluZyBkZWZhdWx0czsgbWFsZm9ybWVkIHN1cHBsaWVkIHZhbHVlcyBhcmUgbmV2ZXIgc2tpcHBlZC5cbiAqXG4gKiBAcGFyYW0ganNvblN0ciAtIFJhdyBKU09OIHN0cmluZyBmcm9tIGdoIENMSVxuICogQHJldHVybnMgUGFyc2VkIGlzc3Vlc1xuICogQHRocm93cyBXaGVuIHRoZSBvdXRwdXQgaXMgaW52YWxpZCBKU09OLCBub3QgYW4gYXJyYXksIG9yIGhhcyBhIG1hbGZvcm1lZCByb3cuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUlzc3VlTGlzdEpzb24oanNvblN0cjogc3RyaW5nKTogRmlsdGVyYWJsZUlzc3VlW10ge1xuICBhc3NlcnRMaXN0T3V0cHV0KGpzb25TdHIsIFwicGFyc2VJc3N1ZUxpc3RKc29uXCIpO1xuICBjb25zdCByYXc6IHVua25vd24gPSBKU09OLnBhcnNlKGpzb25TdHIpO1xuICBpZiAoIUFycmF5LmlzQXJyYXkocmF3KSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcInBhcnNlSXNzdWVMaXN0SnNvbjogZXhwZWN0ZWQgYSBKU09OIGFycmF5XCIpO1xuICB9XG4gIC8vIElubGluZSBydW50aW1lIHNoYXBlIGd1YXJkIOKAlCBnaCBDTEkgb3V0cHV0IGF0IHRydXN0IGJvdW5kYXJ5IChJc3N1ZSAjMTUzMikuXG4gIGNvbnN0IGlzc3VlczogRmlsdGVyYWJsZUlzc3VlW10gPSBbXTtcbiAgZm9yIChjb25zdCBbaW5kZXgsIGl0ZW1dIG9mIHJhdy5lbnRyaWVzKCkpIHtcbiAgICBjb25zdCByZWplY3Q6IChmaWVsZDogc3RyaW5nKSA9PiBuZXZlciA9IChmaWVsZCkgPT4ge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgcGFyc2VJc3N1ZUxpc3RKc29uOiByb3cgJHtpbmRleH0g4oCUIG1hbGZvcm1lZCAke2ZpZWxkfSAoSXNzdWUgIzQxMjQpYCxcbiAgICAgICk7XG4gICAgfTtcbiAgICBpZiAoIWlzUmVjb3JkKGl0ZW0pKSByZWplY3QoXCJyb3dcIik7XG4gICAgaWYgKHR5cGVvZiBpdGVtLm51bWJlciAhPT0gXCJudW1iZXJcIikgcmVqZWN0KFwibnVtYmVyXCIpO1xuICAgIGlmICh0eXBlb2YgaXRlbS50aXRsZSAhPT0gXCJzdHJpbmdcIikgcmVqZWN0KFwidGl0bGVcIik7XG4gICAgY29uc3QgYXV0aG9yID0gc2luZ2xlU3RyaW5nRmllbGQoaXRlbS5hdXRob3IsIFwibG9naW5cIik7XG4gICAgaWYgKGF1dGhvciA9PT0gbnVsbCkge1xuICAgICAgcmVqZWN0KFwiYXV0aG9yXCIpO1xuICAgIH1cbiAgICBjb25zdCBhc3NpZ25lZXMgPSBzdHJpbmdMaXN0RmllbGQoaXRlbS5hc3NpZ25lZXMsIFwibG9naW5cIik7XG4gICAgaWYgKGFzc2lnbmVlcyA9PT0gbnVsbCkge1xuICAgICAgcmVqZWN0KFwiYXNzaWduZWVzXCIpO1xuICAgIH1cbiAgICBjb25zdCBsYWJlbHMgPSBzdHJpbmdMaXN0RmllbGQoaXRlbS5sYWJlbHMsIFwibmFtZVwiKTtcbiAgICBpZiAobGFiZWxzID09PSBudWxsKSB7XG4gICAgICByZWplY3QoXCJsYWJlbHNcIik7XG4gICAgfVxuICAgIGNvbnN0IG1pbGVzdG9uZSA9IHNpbmdsZVN0cmluZ0ZpZWxkKGl0ZW0ubWlsZXN0b25lLCBcInRpdGxlXCIpO1xuICAgIGlmIChtaWxlc3RvbmUgPT09IG51bGwpIHtcbiAgICAgIHJlamVjdChcIm1pbGVzdG9uZVwiKTtcbiAgICB9XG4gICAgY29uc3QgaXNzdWU6IEZpbHRlcmFibGVJc3N1ZSA9IHtcbiAgICAgIG51bWJlcjogaXRlbS5udW1iZXIsXG4gICAgICB0aXRsZTogaXRlbS50aXRsZSxcbiAgICAgIHVybDogc3RyaW5nT3JFbXB0eShpdGVtLnVybCksXG4gICAgICBhdXRob3IsXG4gICAgICBhc3NpZ25lZXMsXG4gICAgICBsYWJlbHMsXG4gICAgICBjcmVhdGVkQXQ6IHN0cmluZ09yRW1wdHkoaXRlbS5jcmVhdGVkQXQpLFxuICAgICAgdXBkYXRlZEF0OiBzdHJpbmdPckVtcHR5KGl0ZW0udXBkYXRlZEF0KSxcbiAgICAgIG1pbGVzdG9uZSxcbiAgICB9O1xuICAgIC8vIEJvZHkgaXMgb3B0aW9uYWwgaW4gYEZpbHRlcmFibGVJc3N1ZWA7IGluY2x1ZGUgaXQgb25seSB3aGVuIHByZXNlbnRcbiAgICAvLyBzbyBvbGRlciBjYWNoZWQgcGF5bG9hZHMgcmVtYWluIGNvbXBhdGlibGUgKElzc3VlICMxODA1KS5cbiAgICBpZiAodHlwZW9mIGl0ZW0uYm9keSA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgaXNzdWUuYm9keSA9IGl0ZW0uYm9keTtcbiAgICB9XG4gICAgLy8gSXNzdWUgIzMzMTQ6IEdpdEh1YiBuYXRpdmUgc3ViLWlzc3VlIGNvdW50cywga2VwdCBvbmx5IHdoZW4gdmFsaWQuXG4gICAgY29uc3Qgc3ViSXNzdWVzU3VtbWFyeSA9IHBhcnNlU3ViSXNzdWVzU3VtbWFyeShpdGVtLnN1Yklzc3Vlc1N1bW1hcnkpO1xuICAgIGlmIChzdWJJc3N1ZXNTdW1tYXJ5ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlzc3VlLnN1Yklzc3Vlc1N1bW1hcnkgPSBzdWJJc3N1ZXNTdW1tYXJ5O1xuICAgIH1cbiAgICBpc3N1ZXMucHVzaChpc3N1ZSk7XG4gIH1cbiAgcmV0dXJuIGlzc3Vlcztcbn1cblxuLyoqIFR5cGUgZ3VhcmQgZm9yIHBsYWluIG9iamVjdHMgdXNlZCBieSBpbmxpbmUgdmFsaWRhdG9ycyAoSXNzdWUgIzE1MzIpLiAqL1xuZnVuY3Rpb24gaXNSZWNvcmQodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIHJldHVybiB0eXBlb2YgdmFsdWUgPT09IFwib2JqZWN0XCIgJiYgdmFsdWUgIT09IG51bGwgJiYgIUFycmF5LmlzQXJyYXkodmFsdWUpO1xufVxuXG4vKiogYFwiXCJgIHdoZW4gYWJzZW50LCB0aGUgc3RyaW5nIHVuZGVyIGBrZXlgIHdoZW4gdmFsaWQsIGVsc2UgYG51bGxgIChJc3N1ZSAjNDExMCkuICovXG5mdW5jdGlvbiBzaW5nbGVTdHJpbmdGaWVsZCh2YWx1ZTogdW5rbm93biwga2V5OiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQgfHwgdmFsdWUgPT09IG51bGwpIHJldHVybiBcIlwiO1xuICBpZiAoIWlzUmVjb3JkKHZhbHVlKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGlubmVyID0gdmFsdWVba2V5XTtcbiAgcmV0dXJuIHR5cGVvZiBpbm5lciA9PT0gXCJzdHJpbmdcIiA/IGlubmVyIDogbnVsbDtcbn1cblxuLyoqIGBbXWAgd2hlbiBhYnNlbnQsIHRoZSBzdHJpbmdzIHVuZGVyIGBrZXlgIHdoZW4gZXZlcnkgZWxlbWVudCBpcyB2YWxpZCwgZWxzZSBgbnVsbGAgKElzc3VlICM0MTEwKS4gKi9cbmZ1bmN0aW9uIHN0cmluZ0xpc3RGaWVsZCh2YWx1ZTogdW5rbm93biwga2V5OiBzdHJpbmcpOiBzdHJpbmdbXSB8IG51bGwge1xuICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCB8fCB2YWx1ZSA9PT0gbnVsbCkgcmV0dXJuIFtdO1xuICBpZiAoIUFycmF5LmlzQXJyYXkodmFsdWUpKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGVsZW1lbnQgb2YgdmFsdWUpIHtcbiAgICBpZiAoIWlzUmVjb3JkKGVsZW1lbnQpKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBpbm5lciA9IGVsZW1lbnRba2V5XTtcbiAgICBpZiAodHlwZW9mIGlubmVyICE9PSBcInN0cmluZ1wiKSByZXR1cm4gbnVsbDtcbiAgICBvdXQucHVzaChpbm5lcik7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIGB2YWx1ZWAgd2hlbiBpdCBpcyBhIHN0cmluZywgZWxzZSBgXCJcImAgKElzc3VlICM0MTEwKS4gKi9cbmZ1bmN0aW9uIHN0cmluZ09yRW1wdHkodmFsdWU6IHVua25vd24pOiBzdHJpbmcge1xuICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSBcInN0cmluZ1wiID8gdmFsdWUgOiBcIlwiO1xufVxuXG4vKipcbiAqIFBhcnNlIHJhdyBnaCBwciBsaXN0IEpTT04gaW50byBPcGVuUFIgYXJyYXkuXG4gKlxuICogQHBhcmFtIGpzb25TdHIgLSBSYXcgSlNPTiBzdHJpbmcgZnJvbSBnaCBDTElcbiAqIEByZXR1cm5zIFBhcnNlZCBQUnNcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUFJMaXN0SnNvbihqc29uU3RyOiBzdHJpbmcpOiBPcGVuUFJbXSB7XG4gIHRyeSB7XG4gICAgY29uc3QgcmF3OiB1bmtub3duID0gSlNPTi5wYXJzZShqc29uU3RyKTtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkocmF3KSkgcmV0dXJuIFtdO1xuICAgIC8vIElubGluZSBydW50aW1lIHNoYXBlIGd1YXJkIChJc3N1ZSAjMTUzMikuXG4gICAgY29uc3QgaXRlbXM6IE9wZW5QUltdID0gW107XG4gICAgZm9yIChjb25zdCBpdGVtIG9mIHJhdykge1xuICAgICAgaWYgKCFpc1JlY29yZChpdGVtKSkgY29udGludWU7XG4gICAgICBpZiAodHlwZW9mIGl0ZW0ubnVtYmVyICE9PSBcIm51bWJlclwiKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IGVudHJ5OiBPcGVuUFIgPSB7XG4gICAgICAgIG51bWJlcjogaXRlbS5udW1iZXIsXG4gICAgICAgIHRpdGxlOiB0eXBlb2YgaXRlbS50aXRsZSA9PT0gXCJzdHJpbmdcIiA/IGl0ZW0udGl0bGUgOiBcIlwiLFxuICAgICAgICBiYXNlUmVmTmFtZTogdHlwZW9mIGl0ZW0uYmFzZVJlZk5hbWUgPT09IFwic3RyaW5nXCJcbiAgICAgICAgICA/IGl0ZW0uYmFzZVJlZk5hbWVcbiAgICAgICAgICA6IFwiXCIsXG4gICAgICAgIGhlYWRSZWZOYW1lOiB0eXBlb2YgaXRlbS5oZWFkUmVmTmFtZSA9PT0gXCJzdHJpbmdcIlxuICAgICAgICAgID8gaXRlbS5oZWFkUmVmTmFtZVxuICAgICAgICAgIDogXCJcIixcbiAgICAgIH07XG4gICAgICAvLyBJc3N1ZSAjMTI2NDogYGF1dGhvcmAgYW5kIGBoZWFkUmVwb3NpdG9yeU93bmVyYCBhcmUgbmVzdGVkIGxvZ2luXG4gICAgICAvLyBvYmplY3RzIGluIHRoZSBgZ2hgIEpTT04uIE9ubHkgc2V0IHdoZW4gYWN0dWFsbHkgcHJlc2VudCwgc28gYW5cbiAgICAgIC8vIGFic2VudCBmaWVsZCBzdGF5cyBgdW5kZWZpbmVkYCAoXCJ1bmtub3duXCIpIHJhdGhlciB0aGFuIFwiXCIuXG4gICAgICBjb25zdCBhdXRob3IgPSBpc1JlY29yZChpdGVtLmF1dGhvcikgPyBpdGVtLmF1dGhvci5sb2dpbiA6IHVuZGVmaW5lZDtcbiAgICAgIGlmICh0eXBlb2YgYXV0aG9yID09PSBcInN0cmluZ1wiICYmIGF1dGhvciAhPT0gXCJcIikgZW50cnkuYXV0aG9yID0gYXV0aG9yO1xuICAgICAgY29uc3QgaGVhZE93bmVyID0gaXNSZWNvcmQoaXRlbS5oZWFkUmVwb3NpdG9yeU93bmVyKVxuICAgICAgICA/IGl0ZW0uaGVhZFJlcG9zaXRvcnlPd25lci5sb2dpblxuICAgICAgICA6IHVuZGVmaW5lZDtcbiAgICAgIGlmICh0eXBlb2YgaGVhZE93bmVyID09PSBcInN0cmluZ1wiICYmIGhlYWRPd25lciAhPT0gXCJcIikge1xuICAgICAgICBlbnRyeS5oZWFkUmVwb3NpdG9yeU93bmVyID0gaGVhZE93bmVyO1xuICAgICAgfVxuICAgICAgaWYgKHR5cGVvZiBpdGVtLmlzQ3Jvc3NSZXBvc2l0b3J5ID09PSBcImJvb2xlYW5cIikge1xuICAgICAgICBlbnRyeS5pc0Nyb3NzUmVwb3NpdG9yeSA9IGl0ZW0uaXNDcm9zc1JlcG9zaXRvcnk7XG4gICAgICB9XG4gICAgICBpZiAodHlwZW9mIGl0ZW0uaXNEcmFmdCA9PT0gXCJib29sZWFuXCIpIGVudHJ5LmlzRHJhZnQgPSBpdGVtLmlzRHJhZnQ7XG4gICAgICBpdGVtcy5wdXNoKGVudHJ5KTtcbiAgICB9XG4gICAgcmV0dXJuIGl0ZW1zO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gW107XG4gIH1cbn1cblxuLyoqXG4gKiBUaGUgYGlzc3Vlc19hbGxgIGNhY2hlIHBheWxvYWQgKElzc3VlICMxNDg2KS5cbiAqXG4gKiBUaGUgbGlzdGluZyBpcyBzdG9yZWQgd2l0aCB0aGUgYC0tbGltaXRgIGl0IHdhcyBmZXRjaGVkIHdpdGgsIHNvIGEgY2FsbGVyXG4gKiBhc2tpbmcgZm9yIGEgd2lkZXIgbGlzdGluZyBpcyBuZXZlciBoYW5kZWQgYSBuYXJyb3dlciBjYWNoZWQgb25lLlxuICovXG5pbnRlcmZhY2UgQWxsSXNzdWVzQ2FjaGVFbnRyeSB7XG4gIC8qKiBUaGUgYC0tbGltaXRgIHRoaXMgbGlzdGluZyB3YXMgZmV0Y2hlZCB3aXRoLiAqL1xuICBsaW1pdDogbnVtYmVyO1xuICAvKiogVGhlIGlzc3VlcyByZXR1cm5lZCBieSB0aGF0IGxpc3RpbmcuICovXG4gIGlzc3VlczogRmlsdGVyYWJsZUlzc3VlW107XG4gIC8qKlxuICAgKiBSb3dzIEdpdEh1YiByZXR1cm5lZC4gT2xkZXIgY2FjaGUgZW50cmllcyBtYXkgaGF2ZSBkcm9wcGVkIG1hbGZvcm1lZCByb3dzLlxuICAgKlxuICAgKiBFeGhhdXN0aW9uIGlzIGp1ZGdlZCBvbiB0aGlzLCBub3Qgb24gYGlzc3Vlcy5sZW5ndGhgOiBhIGxpc3RpbmcgdGhhdCBoaXRcbiAgICogaXRzIGxpbWl0IGJ1dCBsb3N0IG9uZSB1bnBhcnNlYWJsZSByb3cgd291bGQgb3RoZXJ3aXNlIGxvb2sgc2hvcnQgLSBhbmRcbiAgICogdGhlcmVmb3JlIGNvbXBsZXRlIC0gdG8gYSB3aWRlciBjYWxsZXIuIEFic2VudCBvbiBhIGxlZ2FjeSBlbnRyeS5cbiAgICovXG4gIHJhd0NvdW50PzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFJlYWQgYW4gYGlzc3Vlc19hbGxgIGNhY2hlIHBheWxvYWQsIHRvbGVyYXRpbmcgdGhlIHByZS0jMTQ4NiBiYXJlIGFycmF5LlxuICpcbiAqIEEgbGVnYWN5IGVudHJ5IGNhcnJpZXMgbm8gbGltaXQsIHNvIGl0IGlzIHRyZWF0ZWQgYXMgdGhlIGhpc3RvcmljYWxcbiAqIGRlZmF1bHQgKDEwMCkg4oCUIHRoZSBjb25zZXJ2YXRpdmUgcmVhZGluZywgd2hpY2ggYXQgd29yc3QgY29zdHMgb25lXG4gKiByZWZldGNoIGZvciBhIHdpZGVyIGNhbGxlci5cbiAqXG4gKiBAcGFyYW0gY2FjaGVkIC0gV2hhdGV2ZXIgdGhlIGNhY2hlIHJldHVybmVkLlxuICogQHJldHVybnMgVGhlIG5vcm1hbGlzZWQgZW50cnksIG9yIGBudWxsYCB3aGVuIHRoZXJlIHdhcyBub3RoaW5nIHVzYWJsZS5cbiAqL1xuZnVuY3Rpb24gcmVhZEFsbElzc3Vlc0VudHJ5KGNhY2hlZDogdW5rbm93bik6IEFsbElzc3Vlc0NhY2hlRW50cnkgfCBudWxsIHtcbiAgaWYgKGNhY2hlZCA9PT0gbnVsbCB8fCBjYWNoZWQgPT09IHVuZGVmaW5lZCkgcmV0dXJuIG51bGw7XG4gIGlmIChBcnJheS5pc0FycmF5KGNhY2hlZCkpIHtcbiAgICByZXR1cm4geyBsaW1pdDogTEVHQUNZX0FMTF9JU1NVRVNfTElNSVQsIGlzc3VlczogY2FjaGVkIH07XG4gIH1cbiAgaWYgKCFpc1JlY29yZChjYWNoZWQpKSByZXR1cm4gbnVsbDtcbiAgaWYgKHR5cGVvZiBjYWNoZWQubGltaXQgIT09IFwibnVtYmVyXCIgfHwgIUFycmF5LmlzQXJyYXkoY2FjaGVkLmlzc3VlcykpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICByZXR1cm4ge1xuICAgIGxpbWl0OiBjYWNoZWQubGltaXQsXG4gICAgaXNzdWVzOiBjYWNoZWQuaXNzdWVzIGFzIEZpbHRlcmFibGVJc3N1ZVtdLFxuICAgIC4uLih0eXBlb2YgY2FjaGVkLnJhd0NvdW50ID09PSBcIm51bWJlclwiXG4gICAgICA/IHsgcmF3Q291bnQ6IGNhY2hlZC5yYXdDb3VudCB9XG4gICAgICA6IHt9KSxcbiAgfTtcbn1cblxuLyoqIFJvd3MgaW4gYSBgZ2ggaXNzdWUgbGlzdGAgcGF5bG9hZCwgb3IgYG51bGxgIHdoZW4gaXQgaXMgdW5yZWFkYWJsZS4gKi9cbmZ1bmN0aW9uIGNvdW50TGlzdFJvd3Mob3V0cHV0OiBzdHJpbmcpOiBudW1iZXIgfCBudWxsIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwYXJzZWQ6IHVua25vd24gPSBKU09OLnBhcnNlKG91dHB1dC50cmltKCkgfHwgXCJbXVwiKTtcbiAgICByZXR1cm4gQXJyYXkuaXNBcnJheShwYXJzZWQpID8gcGFyc2VkLmxlbmd0aCA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKiBUaGUgYC0tbGltaXRgIGEgcHJlLSMxNDg2IGNhY2hlIGVudHJ5IHdhcyB3cml0dGVuIHdpdGguICovXG5jb25zdCBMRUdBQ1lfQUxMX0lTU1VFU19MSU1JVCA9IDEwMDtcblxuLyoqXG4gKiBnaCA8IDIuOTQuMCBkb2Vzbid0IGtub3cgdGhlIGBzdWJJc3N1ZXNTdW1tYXJ5YCBmaWVsZCAoYWRkZWQgaW4gY2xpL2NsaVxuICogdjIuOTQuMCdzIGBpc3N1ZU9ubHlGaWVsZHNgKSBhbmQgcmVqZWN0cyBpdCB3aXRoIHRoaXMgbWVzc2FnZSAoSXNzdWVcbiAqICMzMzE4KS4gVGhlIHdvcmtlciBjb250YWluZXIgcGlucyBhIG5ld2VyIGdoLCBidXQgYGRvY3MvU0VUVVAubWRgJ3NcbiAqIGBhcHQtZ2V0IGluc3RhbGwgLXkgZ2hgIGdpdmVzIG9wZXJhdG9ycyAyLjQuMCAoVWJ1bnR1IDIyLjA0KSwgMi4yMy4wXG4gKiAoRGViaWFuIDEyKSBvciAyLjQ1LjAgKFVidW50dSAyNC4wNCkg4oCUIGFsbCB0b28gb2xkIOKAlCBhbmRcbiAqIGBmZXRjaEFsbElzc3Vlc2AgYmFja3MgdGhlIGhvc3QtcnVuIGBkaWFnbm9zZS1yZXBvYC9gZGlhZ25vc2UtaXNzdWVgXG4gKiBjb21tYW5kcy5cbiAqL1xuY29uc3QgU1VCSVNTVUVTX1NVTU1BUllfVU5TVVBQT1JURUQgPSAvVW5rbm93biBKU09OIGZpZWxkOiBcInN1Yklzc3Vlc1N1bW1hcnlcIi87XG5cbmNvbnN0IEFMTF9JU1NVRVNfRklFTERTID1cbiAgXCJudW1iZXIsdGl0bGUsYXNzaWduZWVzLHVybCxsYWJlbHMsY3JlYXRlZEF0LHVwZGF0ZWRBdCxhdXRob3IsbWlsZXN0b25lLGJvZHksc3ViSXNzdWVzU3VtbWFyeVwiO1xuLyoqIFNhbWUgZmllbGRzLCB3aXRob3V0IHRoZSBmaWVsZCBnaCA8IDIuOTQuMCByZWplY3RzIChJc3N1ZSAjMzMxOCkuICovXG5jb25zdCBBTExfSVNTVUVTX0ZJRUxEU19OT19TVUJfSVNTVUVTID1cbiAgXCJudW1iZXIsdGl0bGUsYXNzaWduZWVzLHVybCxsYWJlbHMsY3JlYXRlZEF0LHVwZGF0ZWRBdCxhdXRob3IsbWlsZXN0b25lLGJvZHlcIjtcblxuZnVuY3Rpb24gZmV0Y2hBbGxJc3N1ZXNKc29uKFxuICByZXBvOiBzdHJpbmcsXG4gIGxpbWl0OiBudW1iZXIsXG4gIGdoQ29tbWFuZEZuOiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPixcbiAgZmllbGRzOiBzdHJpbmcsXG4pOiBQcm9taXNlPHN0cmluZz4ge1xuICByZXR1cm4gZ2hDb21tYW5kRm4oW1xuICAgIFwiaXNzdWVcIixcbiAgICBcImxpc3RcIixcbiAgICBcIi0tcmVwb1wiLFxuICAgIHJlcG8sXG4gICAgXCItLXN0YXRlXCIsXG4gICAgXCJvcGVuXCIsXG4gICAgXCItLWpzb25cIixcbiAgICBmaWVsZHMsXG4gICAgXCItLWxpbWl0XCIsXG4gICAgU3RyaW5nKGxpbWl0KSxcbiAgXSk7XG59XG5cbi8qKlxuICogRmV0Y2ggYWxsIG9wZW4gaXNzdWVzIGZvciBhIHJlcG8gd2l0aCBjb21wcmVoZW5zaXZlIGZpZWxkcy5cbiAqXG4gKiBJc3N1ZSAjNDAzNzogdGhpcyBpcyB0aGUgaXNzdWUtbGlzdCBmZXRjaCB0aGUgUHJpb3JpdHkgMiBzY2FuIGFscmVhZHlcbiAqIHBlcmZvcm1zIGZvciBldmVyeSBtb25pdG9yZWQgcmVwbyBvbiBldmVyeSB0aWNrLCBzbyBpdHMgb3V0Y29tZSBpc1xuICogZm9sZGVkIGludG8gdGhlIHBlci1yZXBvIGFjY2VzcyBzdG9yZSAoIzQwMzYpIOKAlCBubyBuZXcgQVBJIGNhbGwsIGFuZFxuICogdGhlIHNpZ25hbCBzdGF5cyBmcmVzaCBvbiBidXN5IHRpY2tzIHdoZW4gdGhlIGlkbGUtZGV0ZWN0IGF1ZGl0IG5ldmVyXG4gKiBydW5zLiBPbmx5IGEgcmVhbCBmZXRjaCBpcyByZWNvcmRlZDogYSBjYWNoZSBoaXQgcmV0dXJucyBhYm92ZSwgc2luY2VcbiAqIGEgY2FjaGVkIHJlYWQgaXMgbm90IGV2aWRlbmNlIG9mIGN1cnJlbnQgYWNjZXNzLlxuICpcbiAqIElzc3VlICMxNDg2OiB0aGUgb25lIGBpc3N1ZXNfYWxsYCBlbnRyeSBpcyBzaGFyZWQgYnkgY2FsbGVycyBhc2tpbmcgZm9yXG4gKiBkaWZmZXJlbnQgbGltaXRzICgyMDAgZnJvbSBgZmluZF9vbGRlc3RfaXNzdWVgLCAxMDAgZnJvbSBgc3R1Y2tfcmVjb3ZlcnlgXG4gKiBhbmQgYGZpbmRfcGxhbm5pbmdfaXNzdWVzYCkuIFdoaWNoZXZlciBjYWxsIHJhbiBmaXJzdCB1c2VkIHRvIGRlY2lkZSB3aGF0XG4gKiBldmVyeSBsYXRlciBjYWxsZXIgc2F3LCBzbyBhIHBhc3MgdGhhdCBhc2tlZCBmb3IgMjAwIGNvdWxkIHNpbGVudGx5IGJlXG4gKiBoYW5kZWQgYSAxMDAtaXNzdWUgbGlzdGluZy4gVGhlIGxpbWl0IHRoZSBlbnRyeSB3YXMgZmV0Y2hlZCB3aXRoIGlzIG5vd1xuICogc3RvcmVkIGJlc2lkZSBpdCBhbmQgYSBuYXJyb3dlciBlbnRyeSBpcyByZWZldGNoZWQgcmF0aGVyIHRoYW4gc2VydmVkIOKAlFxuICogdW5sZXNzIEdpdEh1YiByZXR1cm5lZCBmZXdlciByb3dzIHRoYW4gdGhhdCBsaW1pdCwgd2hpY2ggcHJvdmVzIHRoZVxuICogbGlzdGluZyB3YXMgZXhoYXVzdGl2ZS5cbiAqXG4gKiBAcGFyYW0gcmVwbyAtIFJlcG9zaXRvcnkgaW4gXCJvd25lci9yZXBvXCIgZm9ybWF0XG4gKiBAcGFyYW0gY2FjaGUgLSBPcHRpb25hbCBjYWNoZSBpbnN0YW5jZVxuICogQHBhcmFtIGxpbWl0IC0gTWF4aW11bSBpc3N1ZXMgdG8gZmV0Y2ggKGRlZmF1bHQ6IDEwMClcbiAqIEBwYXJhbSBnaENvbW1hbmRGbiAtIE9wdGlvbmFsIGdoIGNvbW1hbmQgZnVuY3Rpb24gZm9yIHRlc3RpbmdcbiAqIEByZXR1cm5zIEFycmF5IG9mIGZpbHRlcmFibGUgaXNzdWVzXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaEFsbElzc3VlcyhcbiAgcmVwbzogc3RyaW5nLFxuICBjYWNoZT86IElzc3VlQ2FjaGUsXG4gIGxpbWl0ID0gMTAwLFxuICBnaENvbW1hbmRGbjogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz4gPSBydW5HaENvbW1hbmQsXG4pOiBQcm9taXNlPEZpbHRlcmFibGVJc3N1ZVtdPiB7XG4gIGNvbnN0IGNhY2hlS2V5ID0gXCJpc3N1ZXNfYWxsXCI7XG5cbiAgaWYgKGNhY2hlKSB7XG4gICAgY29uc3QgZW50cnkgPSByZWFkQWxsSXNzdWVzRW50cnkoYXdhaXQgY2FjaGUucmVhZDx1bmtub3duPihyZXBvLCBjYWNoZUtleSkpO1xuICAgIC8vIFNlcnZlIHdoZW4gdGhlIGNhY2hlZCBsaXN0aW5nIGlzIGF0IGxlYXN0IGFzIHdpZGUgYXMgdGhpcyByZXF1ZXN0LCBvclxuICAgIC8vIHdoZW4gaXQgY2FtZSBiYWNrIHNob3J0IG9mIGl0cyBvd24gbGltaXQgKHNvIG5vdGhpbmcgd2FzIHRydW5jYXRlZCkuXG4gICAgY29uc3Qgcm93cyA9IGVudHJ5ID09PSBudWxsID8gMCA6IGVudHJ5LnJhd0NvdW50ID8/IGVudHJ5Lmlzc3Vlcy5sZW5ndGg7XG4gICAgaWYgKGVudHJ5ICE9PSBudWxsICYmIChlbnRyeS5saW1pdCA+PSBsaW1pdCB8fCByb3dzIDwgZW50cnkubGltaXQpKSB7XG4gICAgICByZXR1cm4gZW50cnkuaXNzdWVzO1xuICAgIH1cbiAgfVxuXG4gIC8vIElzc3VlICMxNzg0OiBpbmNsdWRlIGB1cGRhdGVkQXRgIHNvIHN0YWxlLXdvcmtmbG93IGNhbiByZWFkIGZyb20gdGhpc1xuICAvLyBzaGFyZWQgY2FjaGUgd2l0aG91dCB0cmlnZ2VyaW5nIGl0cyBvd24gcGVyLWxhYmVsIGdoIGNhbGxzLlxuICAvLyBJc3N1ZSAjMTgwNTogaW5jbHVkZSBgYm9keWAgc28gbWlsZXN0b25lLWhlYWx0aCBkZXBlbmRlbmN5IGRldGVjdGlvblxuICAvLyBjYW4gcmVhZCBmcm9tIHRoZSBzaGFyZWQgY2FjaGUgaW5zdGVhZCBvZiBpc3N1aW5nIGEgc2Vjb25kXG4gIC8vIGBnaCBpc3N1ZSBsaXN0IC0tbWlsZXN0b25lIOKApmAgY2FsbCBwZXIgbWlsZXN0b25lLlxuICAvLyBJc3N1ZSAjMzMxNDogaW5jbHVkZSBgc3ViSXNzdWVzU3VtbWFyeWAgc28gbmF0aXZlIHN1Yi1pc3N1ZSBibG9ja2luZ1xuICAvLyBjYW4gYmUgcmVhZCBmcm9tIHRoaXMgY2FsbCBpbnN0ZWFkIG9mIGEgcGVyLWlzc3VlIG9uZS5cbiAgbGV0IG91dHB1dDogc3RyaW5nO1xuICB0cnkge1xuICAgIG91dHB1dCA9IGF3YWl0IGZldGNoQWxsSXNzdWVzSnNvbihcbiAgICAgIHJlcG8sXG4gICAgICBsaW1pdCxcbiAgICAgIGdoQ29tbWFuZEZuLFxuICAgICAgQUxMX0lTU1VFU19GSUVMRFMsXG4gICAgKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICAvLyBJc3N1ZSAjMzMxODogZ2ggPCAyLjk0LjAgcmVqZWN0cyBgc3ViSXNzdWVzU3VtbWFyeWAgb3V0cmlnaHQuIFJldHJ5XG4gICAgLy8gb25jZSB3aXRob3V0IGl0IHNvIGhvc3QtcnVuIGBkaWFnbm9zZS1yZXBvYC9gZGlhZ25vc2UtaXNzdWVgIGtlZXBcbiAgICAvLyB3b3JraW5nIG9uIHRoZSBnaCB2ZXJzaW9uIGBkb2NzL1NFVFVQLm1kYCB0ZWxscyBvcGVyYXRvcnMgdG9cbiAgICAvLyBgYXB0LWdldCBpbnN0YWxsYCwgZXhhY3RseSBhcyB0aGV5IGRpZCBiZWZvcmUgSXNzdWUgIzMzMTQuXG4gICAgaWYgKFNVQklTU1VFU19TVU1NQVJZX1VOU1VQUE9SVEVELnRlc3QobWVzc2FnZSkpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIG91dHB1dCA9IGF3YWl0IGZldGNoQWxsSXNzdWVzSnNvbihcbiAgICAgICAgICByZXBvLFxuICAgICAgICAgIGxpbWl0LFxuICAgICAgICAgIGdoQ29tbWFuZEZuLFxuICAgICAgICAgIEFMTF9JU1NVRVNfRklFTERTX05PX1NVQl9JU1NVRVMsXG4gICAgICAgICk7XG4gICAgICB9IGNhdGNoIChyZXRyeUVycikge1xuICAgICAgICBjb25zdCByZXRyeU1lc3NhZ2UgPSByZXRyeUVyciBpbnN0YW5jZW9mIEVycm9yXG4gICAgICAgICAgPyByZXRyeUVyci5tZXNzYWdlXG4gICAgICAgICAgOiBTdHJpbmcocmV0cnlFcnIpO1xuICAgICAgICByZWNvcmRSZXBvUHJvYmVCZXN0RWZmb3J0KHJlcG8sIGNsYXNzaWZ5UHJvYmVGYWlsdXJlKHJldHJ5TWVzc2FnZSkpO1xuICAgICAgICB0aHJvdyByZXRyeUVycjtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgLy8gQmVzdC1lZmZvcnQgYm9va2tlZXBpbmcgb25seTogdGhlIGVycm9yIGlzIHJlLXRocm93biB1bnRvdWNoZWQgc29cbiAgICAgIC8vIGV2ZXJ5IGNhbGxlcidzIGNvbnRyb2wgZmxvdyBpcyBleGFjdGx5IHdoYXQgaXQgd2FzIGJlZm9yZSAjNDAzNy5cbiAgICAgIHJlY29yZFJlcG9Qcm9iZUJlc3RFZmZvcnQocmVwbywgY2xhc3NpZnlQcm9iZUZhaWx1cmUobWVzc2FnZSkpO1xuICAgICAgdGhyb3cgZXJyO1xuICAgIH1cbiAgfVxuICByZWNvcmRSZXBvUHJvYmVCZXN0RWZmb3J0KHJlcG8sIFwib2tcIik7XG5cbiAgLy8gTmV2ZXIgY2FjaGUgYSBmYWlsdXJlIChJc3N1ZSAjNDI1Nyk6IGEgcnVuR2gtc3R5bGUgXCJcIiBvciBnYXJiYWdlXG4gIC8vIHBheWxvYWQgbXVzdCBzdXJmYWNlIGFzIGFuIGVycm9yLCBub3QgYXMgXCJyZXBvIGhhcyBubyBvcGVuIGlzc3Vlc1wiLlxuICBhc3NlcnRMaXN0T3V0cHV0KG91dHB1dCwgYGZldGNoQWxsSXNzdWVzKCR7cmVwb30pYCk7XG4gIC8vIElzc3VlICM0MTEwOiBhIG5vbi1hcnJheSByb290IChlLmcuIGB7fWApIGlzIGEgZmFpbGVkIGNhbGwsIG5vdCBgW11gLlxuICBjb25zdCByYXdDb3VudCA9IGNvdW50TGlzdFJvd3Mob3V0cHV0KTtcbiAgaWYgKHJhd0NvdW50ID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYGZldGNoQWxsSXNzdWVzKCR7cmVwb30pOiBnaCBvdXRwdXQgd2FzIG5vdCBhIEpTT04gYXJyYXkg4oCUIHRyZWF0aW5nIGFzIGEgZmFpbGVkIGNhbGwsIG5vdCBhbiBlbXB0eSBsaXN0IChJc3N1ZSAjNDExMClgLFxuICAgICk7XG4gIH1cblxuICBjb25zdCBpc3N1ZXMgPSBwYXJzZUlzc3VlTGlzdEpzb24ob3V0cHV0KTtcbiAgaWYgKGNhY2hlKSB7XG4gICAgY29uc3QgZW50cnk6IEFsbElzc3Vlc0NhY2hlRW50cnkgPSB7IGxpbWl0LCBpc3N1ZXMsIHJhd0NvdW50IH07XG4gICAgYXdhaXQgY2FjaGUud3JpdGUocmVwbywgY2FjaGVLZXksIGVudHJ5KTtcbiAgfVxuICByZXR1cm4gaXNzdWVzO1xufVxuXG4vKiogQ2FjaGVkIHJvdyBmb3Ige0BsaW5rIGZldGNoT3Blbk1pbGVzdG9uZUNsb3NlZENvdW50c30gKElzc3VlICMyMDA5KS4gKi9cbmludGVyZmFjZSBNaWxlc3RvbmVDbG9zZWRDb3VudCB7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGNsb3NlZDogbnVtYmVyO1xufVxuXG4vKipcbiAqIEZldGNoIGVhY2ggb3BlbiBtaWxlc3RvbmUncyBjbG9zZWQtaXNzdWUgY291bnQgKElzc3VlICMyMDA5KS5cbiAqXG4gKiBVc2VkIGJ5IGlzc3VlIHNlbGVjdGlvbiB0byByZWNvZ25pc2UgYSAqc3RhcnRlZCogbWlsZXN0b25lIOKAlCBvbmUgdGhhdFxuICogYWxyZWFkeSBoYXMgYXQgbGVhc3Qgb25lIGNsb3NlZCBjaGlsZCDigJQgd2l0aG91dCBhIHBlci1jYW5kaWRhdGUgQVBJXG4gKiBjYWxsLiBUaGUgbGlzdGluZyBpcyB0aGUgc2FtZSBgcmVwb3MvPHJlcG8+L21pbGVzdG9uZXNgIHBheWxvYWRcbiAqIGNvbXBsZXRpb24gYWxyZWFkeSByZWFkczsgaXQgaXMgY2FjaGVkIHVuZGVyIGBtaWxlc3RvbmVzX29wZW5fY291bnRzYC5cbiAqXG4gKiBBIG1pc3NpbmcgYGNsb3NlZF9pc3N1ZXNgIGZpZWxkIGlzIHRyZWF0ZWQgYXMgMCAobm90IHN0YXJ0ZWQpLiBBXG4gKiBmYWlsZWQgb3Igbm9uLWFycmF5IHBheWxvYWQgdGhyb3dzIHJhdGhlciB0aGFuIHJlYWRpbmcgYXMgXCJub1xuICogbWlsZXN0b25lc1wiIChJc3N1ZSAjNDI1NykuXG4gKlxuICogQHBhcmFtIHJlcG8gLSBSZXBvc2l0b3J5IGluIFwib3duZXIvcmVwb1wiIGZvcm1hdFxuICogQHBhcmFtIGNhY2hlIC0gT3B0aW9uYWwgY2FjaGUgaW5zdGFuY2VcbiAqIEBwYXJhbSBnaENvbW1hbmRGbiAtIE9wdGlvbmFsIGdoIGNvbW1hbmQgZnVuY3Rpb24gZm9yIHRlc3RpbmdcbiAqIEByZXR1cm5zIE1hcCBvZiBtaWxlc3RvbmUgdGl0bGUg4oaSIGNsb3NlZC1pc3N1ZSBjb3VudFxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hPcGVuTWlsZXN0b25lQ2xvc2VkQ291bnRzKFxuICByZXBvOiBzdHJpbmcsXG4gIGNhY2hlPzogSXNzdWVDYWNoZSxcbiAgZ2hDb21tYW5kRm46IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+ID0gcnVuR2hDb21tYW5kLFxuKTogUHJvbWlzZTxNYXA8c3RyaW5nLCBudW1iZXI+PiB7XG4gIGNvbnN0IGNhY2hlS2V5ID0gXCJtaWxlc3RvbmVzX29wZW5fY291bnRzXCI7XG5cbiAgaWYgKGNhY2hlKSB7XG4gICAgY29uc3QgY2FjaGVkID0gYXdhaXQgY2FjaGUucmVhZDxNaWxlc3RvbmVDbG9zZWRDb3VudFtdPihyZXBvLCBjYWNoZUtleSk7XG4gICAgaWYgKGNhY2hlZCkge1xuICAgICAgcmV0dXJuIG5ldyBNYXAoY2FjaGVkLm1hcCgocm93KSA9PiBbcm93LnRpdGxlLCByb3cuY2xvc2VkXSkpO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IG91dHB1dCA9IGF3YWl0IGdoQ29tbWFuZEZuKFtcbiAgICBcImFwaVwiLFxuICAgIGByZXBvcy8ke3JlcG99L21pbGVzdG9uZXM/c3RhdGU9b3BlbiZwZXJfcGFnZT0xMDBgLFxuICBdKTtcbiAgYXNzZXJ0TGlzdE91dHB1dChvdXRwdXQsIGBmZXRjaE9wZW5NaWxlc3RvbmVDbG9zZWRDb3VudHMoJHtyZXBvfSlgKTtcblxuICBjb25zdCBwYXJzZWQ6IHVua25vd24gPSBKU09OLnBhcnNlKG91dHB1dC50cmltKCkpO1xuICBpZiAoIUFycmF5LmlzQXJyYXkocGFyc2VkKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBmZXRjaE9wZW5NaWxlc3RvbmVDbG9zZWRDb3VudHMoJHtyZXBvfSk6IGdoIG91dHB1dCB3YXMgbm90IGEgSlNPTiBgICtcbiAgICAgICAgYGFycmF5IOKAlCB0cmVhdGluZyBhcyBhIGZhaWxlZCBjYWxsLCBub3QgYW4gZW1wdHkgbGlzdCAoSXNzdWUgIzQyNTcpYCxcbiAgICApO1xuICB9XG5cbiAgY29uc3Qgcm93czogTWlsZXN0b25lQ2xvc2VkQ291bnRbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGl0ZW0gb2YgcGFyc2VkKSB7XG4gICAgaWYgKCFpc1JlY29yZChpdGVtKSkgY29udGludWU7XG4gICAgaWYgKHR5cGVvZiBpdGVtLnRpdGxlICE9PSBcInN0cmluZ1wiIHx8IGl0ZW0udGl0bGUgPT09IFwiXCIpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGNsb3NlZCA9IHR5cGVvZiBpdGVtLmNsb3NlZF9pc3N1ZXMgPT09IFwibnVtYmVyXCIgJiZcbiAgICAgICAgTnVtYmVyLmlzRmluaXRlKGl0ZW0uY2xvc2VkX2lzc3VlcykgJiZcbiAgICAgICAgaXRlbS5jbG9zZWRfaXNzdWVzID49IDBcbiAgICAgID8gaXRlbS5jbG9zZWRfaXNzdWVzXG4gICAgICA6IDA7XG4gICAgcm93cy5wdXNoKHsgdGl0bGU6IGl0ZW0udGl0bGUsIGNsb3NlZCB9KTtcbiAgfVxuXG4gIGlmIChjYWNoZSkge1xuICAgIGF3YWl0IGNhY2hlLndyaXRlKHJlcG8sIGNhY2hlS2V5LCByb3dzKTtcbiAgfVxuICByZXR1cm4gbmV3IE1hcChyb3dzLm1hcCgocm93KSA9PiBbcm93LnRpdGxlLCByb3cuY2xvc2VkXSkpO1xufVxuXG4vKipcbiAqIEEgY2xvc2VkIGlzc3VlIHdpdGggaXRzIG1pbGVzdG9uZSB0aXRsZSwgcmV0dXJuZWQgYnlcbiAqIGBmZXRjaEFsbENsb3NlZElzc3Vlc2AgKElzc3VlICMxOTA4KS5cbiAqL1xuaW50ZXJmYWNlIENsb3NlZElzc3VlQWxsIHtcbiAgbnVtYmVyOiBudW1iZXI7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIG1pbGVzdG9uZTogc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIExhc3QtdXBkYXRlIHRpbWVzdGFtcCAoUFIgIzM2NDAgcmV2aWV3KS4gT3B0aW9uYWw6IGEgY2FjaGUgZW50cnkgd3JpdHRlblxuICAgKiBiZWZvcmUgdGhpcyBmaWVsZCBleGlzdGVkIGxhY2tzIGl0LCBhbmQgYSByZWFkZXIgbXVzdCB0cmVhdCB0aGF0IGFzXG4gICAqIFwidW5rbm93blwiIHJhdGhlciB0aGFuIGFzc3VtZSBhIHZhbHVlLlxuICAgKi9cbiAgdXBkYXRlZEF0Pzogc3RyaW5nO1xufVxuXG4vKipcbiAqIERlZmF1bHQgbGltaXQgZm9yIGBmZXRjaEFsbENsb3NlZElzc3Vlc2Ag4oCUIHdpZGUgZW5vdWdoIHRvIGNvdmVyIHRoZVxuICogdHlwaWNhbCBhY3RpdmUtbWlsZXN0b25lIGJhY2tsb2cgYWNyb3NzIGEgcmVwbyB3aGlsZSBzdGlsbCBib3VuZGluZ1xuICogdGhlIGBnaGAgY2FsbCBjb3N0LiBQaWNrZWQgdG8gY29tZm9ydGFibHkgZXhjZWVkIHRoZSBwcmUtIzE5MDhcbiAqIHBlci1taWxlc3RvbmUgbGltaXQgb2YgMjAwIG11bHRpcGxpZWQgYnkgdGhlIHNtYWxsIG51bWJlciBvZlxuICogY29uY3VycmVudCBhY3RpdmUgbWlsZXN0b25lcyB3ZSBzZWUgaW4gcHJhY3RpY2UuXG4gKi9cbmNvbnN0IENMT1NFRF9BTExfREVGQVVMVF9MSU1JVCA9IDUwMDtcblxuLyoqXG4gKiBGZXRjaCBhbGwgY2xvc2VkIGlzc3VlcyBmb3IgYSByZXBvIGluIGEgc2luZ2xlIGJhdGNoIGFuZCBjYWNoZSB0aGVtXG4gKiB1bmRlciBgaXNzdWVzX2Nsb3NlZF9hbGxgIChJc3N1ZSAjMTkwOCkuXG4gKlxuICogQ291bnRlcnBhcnQgdG8gYGZldGNoQWxsSXNzdWVzYCBmb3IgY2xvc2VkIGlzc3Vlcy4gRWFjaCBlbnRyeSBjYXJyaWVzXG4gKiBpdHMgbWlsZXN0b25lIHRpdGxlIHNvIHBlci1taWxlc3RvbmUgY2FsbGVycyBjYW4gZmlsdGVyIGxvY2FsbHlcbiAqIHJhdGhlciB0aGFuIGlzc3VpbmcgYSBmcmVzaCBgZ2ggaXNzdWUgbGlzdCAtLW1pbGVzdG9uZSDigKZgIHBlclxuICogbWlsZXN0b25lIHNjYW4uIFRoZSBjYWNoZSBrZXkgaXMgcmVwby1zY29wZWQgKG5vIG1pbGVzdG9uZVxuICogbmFtZXNwYWNpbmcpIHNvIGNvbmN1cnJlbnQgbWlsZXN0b25lIHNjYW5zIHdpdGhpbiBhIHNpbmdsZSBpdGVyYXRpb25cbiAqIHNoYXJlIG9uZSByb3VuZC10cmlwLlxuICogQ29tbWFuZCBhbmQgdmFsaWRhdGlvbiBmYWlsdXJlcyBwcm9wYWdhdGUgd2l0aG91dCB3cml0aW5nIHRvIHRoZSBjYWNoZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoQWxsQ2xvc2VkSXNzdWVzKFxuICByZXBvOiBzdHJpbmcsXG4gIGNhY2hlPzogSXNzdWVDYWNoZSxcbiAgbGltaXQgPSBDTE9TRURfQUxMX0RFRkFVTFRfTElNSVQsXG4gIGdoQ29tbWFuZEZuOiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPiA9IHJ1bkdoQ29tbWFuZCxcbik6IFByb21pc2U8Q2xvc2VkSXNzdWVBbGxbXT4ge1xuICBjb25zdCBjYWNoZUtleSA9IFwiaXNzdWVzX2Nsb3NlZF9hbGxcIjtcblxuICBpZiAoY2FjaGUpIHtcbiAgICBjb25zdCBjYWNoZWQgPSBhd2FpdCBjYWNoZS5yZWFkPENsb3NlZElzc3VlQWxsW10+KHJlcG8sIGNhY2hlS2V5KTtcbiAgICBpZiAoY2FjaGVkKSByZXR1cm4gY2FjaGVkO1xuICB9XG5cbiAgY29uc3Qgb3V0cHV0ID0gYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgIFwiaXNzdWVcIixcbiAgICBcImxpc3RcIixcbiAgICBcIi0tcmVwb1wiLFxuICAgIHJlcG8sXG4gICAgXCItLXN0YXRlXCIsXG4gICAgXCJjbG9zZWRcIixcbiAgICBcIi0tanNvblwiLFxuICAgIFwibnVtYmVyLHRpdGxlLG1pbGVzdG9uZSx1cGRhdGVkQXRcIixcbiAgICBcIi0tbGltaXRcIixcbiAgICBTdHJpbmcobGltaXQpLFxuICBdKTtcblxuICAvLyBTaGFyZSB0aGUgb3Blbi1saXN0IHZhbGlkYXRvcjogbmVpdGhlciBmYWlsdXJlcyBub3IgcGFydGlhbCBsaXN0cyBhcmVcbiAgLy8gZXZpZGVuY2Ugb2YgYW4gZW1wdHkgcmVwb3NpdG9yeSAoSXNzdWUgIzQxMjQpLlxuICBjb25zdCBpc3N1ZXM6IENsb3NlZElzc3VlQWxsW10gPSBwYXJzZUlzc3VlTGlzdEpzb24ob3V0cHV0KS5tYXAoKGl0ZW0pID0+ICh7XG4gICAgbnVtYmVyOiBpdGVtLm51bWJlcixcbiAgICB0aXRsZTogaXRlbS50aXRsZSxcbiAgICBtaWxlc3RvbmU6IGl0ZW0ubWlsZXN0b25lIHx8IG51bGwsXG4gICAgLi4uKGl0ZW0udXBkYXRlZEF0ID8geyB1cGRhdGVkQXQ6IGl0ZW0udXBkYXRlZEF0IH0gOiB7fSksXG4gIH0pKTtcbiAgaWYgKGNhY2hlKSBhd2FpdCBjYWNoZS53cml0ZShyZXBvLCBjYWNoZUtleSwgaXNzdWVzKTtcbiAgcmV0dXJuIGlzc3Vlcztcbn1cblxuLyoqXG4gKiBGZXRjaCBjbG9zZWQgaXNzdWVzIGZvciBhIHNwZWNpZmljIG1pbGVzdG9uZSwgbWF0Y2hlZCBieSB0aXRsZSAoSXNzdWUgIzE3ODYsXG4gKiBiYXRjaGVkIHZpYSBgZmV0Y2hBbGxDbG9zZWRJc3N1ZXNgIGluIElzc3VlICMxOTA4KS5cbiAqXG4gKiBDYWxsZXJzOiBgbWlsZXN0b25lX3Byb2dyZXNzLnRzYCBhbmQgYG1pbGVzdG9uZV9oZWFsdGgudHNgLiBNaWxlc3RvbmVcbiAqIGNvbXBsZXRpb24gcmVhZHMgYnkgbnVtYmVyIGluc3RlYWQgKGBmZXRjaENsb3NlZElzc3Vlc0J5TWlsZXN0b25lTnVtYmVyYCkuXG4gKlxuICogQm91bmRlZCBieSB0aGUgNTAwLWlzc3VlIHJlcG8td2lkZSBiYXRjaDogYSBtaWxlc3RvbmUgd2hvc2UgY2xvc2VkIGlzc3Vlc1xuICogYXJlIG9sZGVyIHRoYW4gdGhlIG5ld2VzdCA1MDAgY2xvc2VkIGlzc3VlcyBpbiB0aGUgcmVwbyBnZXRzIG5vbmUgb2YgdGhlbVxuICogYmFjayBoZXJlLiBGb3IgYW4gdW5ib3VuZGVkIHJlYWQgYnkgbWlsZXN0b25lIG51bWJlciwgdXNlXG4gKiBgZmV0Y2hDbG9zZWRJc3N1ZXNCeU1pbGVzdG9uZU51bWJlcmAgKElzc3VlICMzNjYyKS5cbiAqXG4gKiBQcmUtIzE5MDggdGhpcyBpc3N1ZWQgb25lXG4gKiBgZ2ggaXNzdWUgbGlzdCAtLW1pbGVzdG9uZSBYIC0tc3RhdGUgY2xvc2VkYCBwZXIgbWlsZXN0b25lOyBub3cgaXRcbiAqIGZpbHRlcnMgdGhlIHNoYXJlZCBgZmV0Y2hBbGxDbG9zZWRJc3N1ZXNgIGJhdGNoIHNvIGNvbmN1cnJlbnRcbiAqIG1pbGVzdG9uZSBzY2FucyB3aXRoaW4gYSBzaW5nbGUgaXRlcmF0aW9uIHNoYXJlIG9uZSByb3VuZC10cmlwLlxuICpcbiAqIFRoZSBzaGFwZSByZXR1cm5lZCAoYG51bWJlciwgdGl0bGVgKSBtYXRjaGVzIHRoZSBwcmUtIzE5MDggY29udHJhY3QsXG4gKiBzbyBjYWxsZXJzIGRvIG5vdCBuZWVkIHRvIGNoYW5nZS4gYHVwZGF0ZWRBdGAgaXMgYWRkZWQgb25seSB3aGVuIHRoZSBiYXRjaFxuICogY2FycmllcyBpdCAoUFIgIzM2NDAgcmV2aWV3KSwgc28gYSByb3cgcmVhZCBmcm9tIGFuIG9sZGVyIGNhY2hlIGVudHJ5IGtlZXBzXG4gKiB0aGUgb3JpZ2luYWwgdHdvLWZpZWxkIHNoYXBlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hDbG9zZWRJc3N1ZXNCeU1pbGVzdG9uZShcbiAgcmVwbzogc3RyaW5nLFxuICBtaWxlc3RvbmVUaXRsZTogc3RyaW5nLFxuICBjYWNoZT86IElzc3VlQ2FjaGUsXG4gIGdoQ29tbWFuZEZuOiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPiA9IHJ1bkdoQ29tbWFuZCxcbik6IFByb21pc2U8QXJyYXk8eyBudW1iZXI6IG51bWJlcjsgdGl0bGU6IHN0cmluZzsgdXBkYXRlZEF0Pzogc3RyaW5nIH0+PiB7XG4gIGNvbnN0IGFsbCA9IGF3YWl0IGZldGNoQWxsQ2xvc2VkSXNzdWVzKFxuICAgIHJlcG8sXG4gICAgY2FjaGUsXG4gICAgQ0xPU0VEX0FMTF9ERUZBVUxUX0xJTUlULFxuICAgIGdoQ29tbWFuZEZuLFxuICApO1xuICByZXR1cm4gYWxsXG4gICAgLmZpbHRlcigoaXNzdWUpID0+IGlzc3VlLm1pbGVzdG9uZSA9PT0gbWlsZXN0b25lVGl0bGUpXG4gICAgLm1hcCgoaXNzdWUpID0+ICh7XG4gICAgICBudW1iZXI6IGlzc3VlLm51bWJlcixcbiAgICAgIHRpdGxlOiBpc3N1ZS50aXRsZSxcbiAgICAgIC4uLihpc3N1ZS51cGRhdGVkQXQgIT09IHVuZGVmaW5lZCA/IHsgdXBkYXRlZEF0OiBpc3N1ZS51cGRhdGVkQXQgfSA6IHt9KSxcbiAgICB9KSk7XG59XG5cbi8qKlxuICogRmV0Y2ggZXZlcnkgY2xvc2VkIGlzc3VlIGluIG9uZSBtaWxlc3RvbmUsIHJlYWQgYnkgbWlsZXN0b25lIE5VTUJFUiB0aHJvdWdoXG4gKiBwYWdpbmF0ZWQgUkVTVCAoSXNzdWUgIzM2NjIpLlxuICpcbiAqIFVubGlrZSBgZmV0Y2hDbG9zZWRJc3N1ZXNCeU1pbGVzdG9uZWAsIHRoaXMgaXMgbm90IGJvdW5kZWQgYnkgdGhlIDUwMC1pc3N1ZVxuICogcmVwby13aWRlIGJhdGNoOiBgcmVwb3MvPHJlcG8+L2lzc3Vlcz9taWxlc3RvbmU9TiZzdGF0ZT1jbG9zZWRgIHBhZ2VzIHRocm91Z2hcbiAqIGV2ZXJ5IGNsb3NlZCBpc3N1ZSBpbiB0aGUgbWlsZXN0b25lLCBzbyBhbiBvbGRlciBtaWxlc3RvbmUgd2hvc2UgaXNzdWVzIGhhdmVcbiAqIGZhbGxlbiBvdXQgb2YgdGhlIG5ld2VzdC1maXJzdCBiYXRjaCBzdGlsbCByZWFkcyBpbiBmdWxsLiBQdWxsIHJlcXVlc3RzIGFyZVxuICogZHJvcHBlZCBieSB0aGUgYC0tanFgIGZpbHRlci5cbiAqXG4gKiBGYWlsdXJlIHRocm93cywgdW5saWtlIGBmZXRjaENsb3NlZElzc3Vlc0J5TWlsZXN0b25lYCB3aGljaCBzd2FsbG93cyBnaFxuICogZmFpbHVyZXMgaW50byBhbiB1bmNhY2hlZCBbXS4gQSBmYWlsZWQgcmVhZCBtdXN0IG5vdCBsb29rIGxpa2UgXCJubyBjbG9zZWRcbiAqIGlzc3Vlc1wiLCBzbyBhIGJsYW5rIG9yIHVucGFyc2VhYmxlIHBhZ2UsIG9yIGEgZ2ggZXJyb3IsIHByb3BhZ2F0ZXMgdG8gdGhlXG4gKiBjYWxsZXIuIE5vdGhpbmcgaXMgY2FjaGVkIG9uIGEgZmFpbHVyZS5cbiAqXG4gKiBDYWNoZTogc3RvcmVkIHVuZGVyIGBpc3N1ZXNfY2xvc2VkX21pbGVzdG9uZV88Tj5gLCBvbmUgZW50cnkgcGVyIG1pbGVzdG9uZS5cbiAqIEEgd29ya2VyIGNsb3NlIG9yIHJlb3BlbiBkb2VzIG5vdCBjYXJyeSB0aGUgbWlsZXN0b25lIG51bWJlciwgc29cbiAqIGBub3RlR2hJc3N1ZUNsb3NlYCBkcm9wcyBldmVyeSBgaXNzdWVzX2Nsb3NlZF9taWxlc3RvbmVfYCBrZXkgaW4gdGhlIHJlcG8uXG4gKiBPdGhlcndpc2UgdGhlIGVudHJ5IGxpdmVzIHVudGlsIGl0cyBUVEwgKDYwMCBzZWNvbmRzIGJ5IGRlZmF1bHQpIG9yIHVudGlsXG4gKiBgaW52YWxpZGF0ZVJlcG9gIGNsZWFycyB0aGUgd2hvbGUgcmVwby5cbiAqXG4gKiBAcGFyYW0gcmVwbyAtIFJlcG9zaXRvcnkgaW4gXCJvd25lci9yZXBvXCIgZm9ybWF0XG4gKiBAcGFyYW0gbWlsZXN0b25lTnVtYmVyIC0gVGhlIG1pbGVzdG9uZSdzIG51bWJlciwgbm90IGl0cyB0aXRsZTsgbXVzdCBiZSBhXG4gKiAgIHBvc2l0aXZlIGludGVnZXIgYmVjYXVzZSBpdCBpcyBpbnRlcnBvbGF0ZWQgaW50byBhIFJFU1QgcGF0aFxuICogQHBhcmFtIGNhY2hlIC0gT3B0aW9uYWwgZmlsZSBjYWNoZSwga2V5ZWQgcGVyIG1pbGVzdG9uZVxuICogQHBhcmFtIGdoQ29tbWFuZEZuIC0gUnVucyBgZ2hgIChpbmplY3RhYmxlIGZvciB0ZXN0aW5nKVxuICogQHJldHVybnMgQ2xvc2VkIGlzc3VlcyBpbiB0aGUgbWlsZXN0b25lIGFjcm9zcyBldmVyeSBwYWdlLCBpbiBwYWdlIG9yZGVyXG4gKiBAdGhyb3dzIFdoZW4gYG1pbGVzdG9uZU51bWJlcmAgaXMgbm90IGEgcG9zaXRpdmUgaW50ZWdlciwgd2hlbiBnaCBmYWlscywgb3JcbiAqICAgd2hlbiBhbnkgcGFnZSBpcyBibGFuaywgbm90IEpTT04sIG9yIG5vdCBhbiBhcnJheVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hDbG9zZWRJc3N1ZXNCeU1pbGVzdG9uZU51bWJlcihcbiAgcmVwbzogc3RyaW5nLFxuICBtaWxlc3RvbmVOdW1iZXI6IG51bWJlcixcbiAgY2FjaGU/OiBJc3N1ZUNhY2hlLFxuICBnaENvbW1hbmRGbjogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz4gPSBydW5HaENvbW1hbmQsXG4pOiBQcm9taXNlPEFycmF5PHsgbnVtYmVyOiBudW1iZXI7IHRpdGxlOiBzdHJpbmc7IHVwZGF0ZWRBdD86IHN0cmluZyB9Pj4ge1xuICAvLyBDaGVja2VkIGJlZm9yZSBhbnkgZ2ggY2FsbCBvciBjYWNoZSByZWFkOiB0aGUgbnVtYmVyIGdvZXMgaW50byBhIFJFU1QgcGF0aC5cbiAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKG1pbGVzdG9uZU51bWJlcikgfHwgbWlsZXN0b25lTnVtYmVyIDw9IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgZmV0Y2hDbG9zZWRJc3N1ZXNCeU1pbGVzdG9uZU51bWJlcigke3JlcG99KTogbWlsZXN0b25lIG51bWJlciBtdXN0IGJlIGAgK1xuICAgICAgICBgYSBwb3NpdGl2ZSBpbnRlZ2VyLCBnb3QgJHttaWxlc3RvbmVOdW1iZXJ9YCxcbiAgICApO1xuICB9XG5cbiAgY29uc3QgY2FjaGVLZXkgPSBgJHtDTE9TRURfTUlMRVNUT05FX0NBQ0hFX1BSRUZJWH0ke21pbGVzdG9uZU51bWJlcn1gO1xuICBjb25zdCBjb250ZXh0ID1cbiAgICBgZmV0Y2hDbG9zZWRJc3N1ZXNCeU1pbGVzdG9uZU51bWJlcigke3JlcG99LCAke21pbGVzdG9uZU51bWJlcn0pYDtcblxuICBpZiAoY2FjaGUpIHtcbiAgICBjb25zdCBjYWNoZWQgPSBhd2FpdCBjYWNoZS5yZWFkPFxuICAgICAgQXJyYXk8eyBudW1iZXI6IG51bWJlcjsgdGl0bGU6IHN0cmluZzsgdXBkYXRlZEF0Pzogc3RyaW5nIH0+XG4gICAgPihyZXBvLCBjYWNoZUtleSk7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkoY2FjaGVkKSkgcmV0dXJuIGNhY2hlZDtcbiAgfVxuXG4gIC8vIEVycm9ycyBwcm9wYWdhdGU6IG5vIHRyeS9jYXRjaCBoZXJlLCBzbyBhIGZhaWxlZCByZWFkIGlzIG5ldmVyIGFuIFtdLlxuICBjb25zdCBvdXRwdXQgPSBhd2FpdCBnaENvbW1hbmRGbihbXG4gICAgXCJhcGlcIixcbiAgICBgcmVwb3MvJHtyZXBvfS9pc3N1ZXM/bWlsZXN0b25lPSR7bWlsZXN0b25lTnVtYmVyfSZzdGF0ZT1jbG9zZWQmcGVyX3BhZ2U9MTAwYCxcbiAgICBcIi0tcGFnaW5hdGVcIixcbiAgICBcIi0tanFcIixcbiAgICAnWy5bXSB8IHNlbGVjdChoYXMoXCJwdWxsX3JlcXVlc3RcIikgfCBub3QpIHwge251bWJlciwgdGl0bGUsIHVwZGF0ZWRfYXR9XScsXG4gIF0pO1xuXG4gIC8vIGAtLXBhZ2luYXRlYCBwcmludHMgb25lIEpTT04gYXJyYXkgcGVyIHBhZ2UsIG9uZSBwZXIgbGluZSwgc28gdGhlIHBheWxvYWRcbiAgLy8gaXMgdmFsaWRhdGVkIGxpbmUgYnkgbGluZTogYXNzZXJ0TGlzdE91dHB1dCBwYXJzZXMgdGhlIHdob2xlIHN0cmluZyBhbmRcbiAgLy8gd291bGQgcmVqZWN0IGEgbXVsdGktcGFnZSBwYXlsb2FkLiBCbGFuayBvdXRwdXQgaGFzIG5vIGxpbmVzIGF0IGFsbCBhbmRcbiAgLy8gbXVzdCBzdGlsbCB0aHJvdyByYXRoZXIgdGhhbiByZWFkIGFzIFwibm8gY2xvc2VkIGlzc3Vlc1wiIChJc3N1ZSAjNDI1NykuXG4gIGNvbnN0IGxpbmVzID0gb3V0cHV0LnNwbGl0KFwiXFxuXCIpXG4gICAgLm1hcCgobGluZSkgPT4gbGluZS50cmltKCkpXG4gICAgLmZpbHRlcigobGluZSkgPT4gbGluZS5sZW5ndGggPiAwKTtcbiAgaWYgKGxpbmVzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGAke2NvbnRleHR9OiBnaCByZXR1cm5lZCBubyBvdXRwdXQg4oCUIHRyZWF0aW5nIGFzIGEgZmFpbGVkIGNhbGwsIGAgK1xuICAgICAgICBgbm90IGFuIGVtcHR5IGxpc3QgKElzc3VlICM0MjU3KWAsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGlzc3VlczogQXJyYXk8eyBudW1iZXI6IG51bWJlcjsgdGl0bGU6IHN0cmluZzsgdXBkYXRlZEF0Pzogc3RyaW5nIH0+ID1cbiAgICBbXTtcbiAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XG4gICAgYXNzZXJ0TGlzdE91dHB1dChsaW5lLCBjb250ZXh0KTtcbiAgICBjb25zdCBwYWdlOiB1bmtub3duID0gSlNPTi5wYXJzZShsaW5lKTtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkocGFnZSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgJHtjb250ZXh0fTogYSBwYWdlIHdhcyBub3QgYSBKU09OIGFycmF5YCk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgaXRlbSBvZiBwYWdlKSB7XG4gICAgICBpZiAoIWlzUmVjb3JkKGl0ZW0pIHx8IHR5cGVvZiBpdGVtLm51bWJlciAhPT0gXCJudW1iZXJcIikgY29udGludWU7XG4gICAgICBpc3N1ZXMucHVzaCh7XG4gICAgICAgIG51bWJlcjogaXRlbS5udW1iZXIsXG4gICAgICAgIHRpdGxlOiB0eXBlb2YgaXRlbS50aXRsZSA9PT0gXCJzdHJpbmdcIiA/IGl0ZW0udGl0bGUgOiBcIlwiLFxuICAgICAgICAuLi4odHlwZW9mIGl0ZW0udXBkYXRlZF9hdCA9PT0gXCJzdHJpbmdcIiAmJiBpdGVtLnVwZGF0ZWRfYXQgIT09IFwiXCJcbiAgICAgICAgICA/IHsgdXBkYXRlZEF0OiBpdGVtLnVwZGF0ZWRfYXQgfVxuICAgICAgICAgIDoge30pLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgLy8gV3JpdHRlbiBvbmx5IGFmdGVyIGV2ZXJ5IHBhZ2UgcGFyc2VkOiBhIGZhaWx1cmUgYWJvdmUgbmV2ZXIgcmVhY2hlcyBoZXJlLlxuICBpZiAoY2FjaGUpIGF3YWl0IGNhY2hlLndyaXRlKHJlcG8sIGNhY2hlS2V5LCBpc3N1ZXMpO1xuICByZXR1cm4gaXNzdWVzO1xufVxuXG4vKipcbiAqIE9wZW4gaXNzdWUgcGF5bG9hZCByZXR1cm5lZCBieSBgZmV0Y2hPcGVuSXNzdWVzQnlNaWxlc3RvbmVgIChJc3N1ZSAjMTgwNSkuXG4gKlxuICogYG51bWJlcmAgYW5kIGB0aXRsZWAgYXJlIHJlcXVpcmVkIGZvciB0aGUgbWlsZXN0b25lIHByb2dyZXNzL2NvbXBsZXRpb25cbiAqIGhlbHBlcnMuIGBhc3NpZ25lZXNgIGFuZCBgYm9keWAgYXJlIHBvcHVsYXRlZCBmcm9tIHRoZSBzaGFyZWRcbiAqIGBpc3N1ZXNfYWxsYCBjYWNoZSBzbyBtaWxlc3RvbmUtaGVhbHRoIGNhbiBjbGFzc2lmeSBpc3N1ZXMgd2l0aG91dCBhXG4gKiBzZWNvbmQgYGdoIGlzc3VlIGxpc3RgIGNhbGwuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgT3Blbk1pbGVzdG9uZUlzc3VlIHtcbiAgbnVtYmVyOiBudW1iZXI7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGFzc2lnbmVlczogc3RyaW5nW107XG4gIGJvZHk6IHN0cmluZztcbiAgLyoqXG4gICAqIExvZ2luIG9mIHRoZSBhY2NvdW50IHRoYXQgb3BlbmVkIHRoZSBpc3N1ZSAoSXNzdWUgIzEyNDYpLiBBbHJlYWR5IHByZXNlbnRcbiAgICogaW4gdGhlIHNoYXJlZCBgaXNzdWVzX2FsbGAgcGF5bG9hZDsgcHJvamVjdGVkIGhlcmUgc28gdGhlIG1pbGVzdG9uZVxuICAgKiBoZWxwZXJzIGNhbiB0ZWxsIHRoZSBmbGVldCdzIG93biB0cmFja2luZyBpc3N1ZSBmcm9tIGEgbG9vay1hbGlrZSB3aXRob3V0XG4gICAqIGEgc2Vjb25kIGBnaGAgY2FsbC5cbiAgICovXG4gIGF1dGhvcjogc3RyaW5nO1xufVxuXG4vKipcbiAqIEZpbHRlciBjYWNoZWQgb3BlbiBpc3N1ZXMgdG8gdGhvc2UgaW4gYSBzcGVjaWZpYyBtaWxlc3RvbmVcbiAqIChJc3N1ZSAjMTc4NiwgZXh0ZW5kZWQgaW4gSXNzdWUgIzE4MDUpLlxuICpcbiAqIFJlYWRzIHRocm91Z2ggYGZldGNoQWxsSXNzdWVzYCBzbyB0aGUgY2FjaGVkIGBpc3N1ZXNfYWxsYCBwYXlsb2FkIGlzXG4gKiByZXVzZWQsIHRoZW4gYXBwbGllcyBhIGxvY2FsIG1pbGVzdG9uZS10aXRsZSBmaWx0ZXIuIFJldHVybnMgdGhlXG4gKiBgT3Blbk1pbGVzdG9uZUlzc3VlYCBzaGFwZSDigJQgYG51bWJlcmAgYW5kIGB0aXRsZWAgZm9yIHByb2dyZXNzXG4gKiBjb3VudGluZyBwbHVzIGBhc3NpZ25lZXNgIGFuZCBgYm9keWAgZm9yIG1pbGVzdG9uZS1oZWFsdGhcbiAqIGNsYXNzaWZpY2F0aW9uLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hPcGVuSXNzdWVzQnlNaWxlc3RvbmUoXG4gIHJlcG86IHN0cmluZyxcbiAgbWlsZXN0b25lVGl0bGU6IHN0cmluZyxcbiAgY2FjaGU/OiBJc3N1ZUNhY2hlLFxuICBnaENvbW1hbmRGbjogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz4gPSBydW5HaENvbW1hbmQsXG4pOiBQcm9taXNlPE9wZW5NaWxlc3RvbmVJc3N1ZVtdPiB7XG4gIGNvbnN0IGFsbCA9IGF3YWl0IGZldGNoQWxsSXNzdWVzKHJlcG8sIGNhY2hlLCAyMDAsIGdoQ29tbWFuZEZuKTtcbiAgcmV0dXJuIGFsbFxuICAgIC5maWx0ZXIoKGlzc3VlKSA9PiBpc3N1ZS5taWxlc3RvbmUgPT09IG1pbGVzdG9uZVRpdGxlKVxuICAgIC5tYXAoKGlzc3VlKSA9PiAoe1xuICAgICAgbnVtYmVyOiBpc3N1ZS5udW1iZXIsXG4gICAgICB0aXRsZTogaXNzdWUudGl0bGUsXG4gICAgICBhc3NpZ25lZXM6IGlzc3VlLmFzc2lnbmVlcyA/PyBbXSxcbiAgICAgIGJvZHk6IGlzc3VlLmJvZHkgPz8gXCJcIixcbiAgICAgIGF1dGhvcjogaXNzdWUuYXV0aG9yID8/IFwiXCIsXG4gICAgfSkpO1xufVxuXG4vKipcbiAqIFRoZSB3aWR0aCBvZiB0aGUgb3Blbi1pc3N1ZSBsaXN0aW5nIHRoZSBjbGFpbSBzY2FuIHJlYWRzLCBhbmQgdGhlIG1vc3RcbiAqIGxhYmVsbGVkIGlzc3VlcyBvbmUgc2NhbiBjb2xsZWN0b3IgY29uc2lkZXJzIHBlciBsYWJlbCBwZXIgcmVwbyAoSXNzdWVcbiAqICM0NDY0KS5cbiAqXG4gKiBUaGUgaWRsZS1kZWNpc2lvbiBjZW5zdXMgY291bnRzIGNsYWltYWJsZSB3b3JrIGZyb20gdGhlIHNhbWUgbGlzdGluZywgc28gYVxuICogcGVyLWxhYmVsIGNhcCBuYXJyb3dlciB0aGFuIHRoaXMgd2lkdGggbWFrZXMgdGhlIGNlbnN1cyBjb3VudCB3b3JrIHRoZSBzY2FuXG4gKiBuZXZlciBsb29rcyBhdC4gVGhlIGxpc3RpbmcgaXMgbmV3ZXN0LWZpcnN0LCBzbyBhIG5hcnJvd2VyIGNhcCBkcm9wcyB0aGVcbiAqIE9MREVTVCBsYWJlbGxlZCBpc3N1ZXM6IHRoZSBvbmVzIHRoZSBzY2FuIGlzIG1vc3QgbGlrZWx5IHRvIGhhdmUgbWlzc2VkLlxuICovXG5leHBvcnQgY29uc3QgU0NBTl9MQUJFTExFRF9JU1NVRV9MSU1JVCA9IDIwMDtcblxuLyoqXG4gKiBGZXRjaCBpc3N1ZXMgd2l0aCBhIHNwZWNpZmljIGxhYmVsIGZyb20gdGhlIHNoYXJlZCBgaXNzdWVzX2FsbGAgYmF0Y2guXG4gKlxuICogRmlsdGVycyB0aGUgY2FjaGVkIGBmZXRjaEFsbElzc3Vlc2AgcGF5bG9hZCBsb2NhbGx5IOKAlCBvbmUgZ2ggY2FsbCBwZXJcbiAqIHJlcG8gcmVnYXJkbGVzcyBvZiBob3cgbWFueSBsYWJlbHMgYXJlIHF1ZXJpZWQgd2l0aGluIHRoZSBUVEwgd2luZG93LlxuICpcbiAqIElzc3VlICMxOTA5OiByZW1vdmVkIHRoZSBwZXItbGFiZWwgZmFsbGJhY2sgdGhhdCBmaXJlZCB3aGVuIHRoZSBiYXRjaFxuICogd2FzIGVtcHR5LiBPbiBhIHF1aWV0IHJlcG8gKHplcm8gb3BlbiBpc3N1ZXMpIHRoZSBmYWxsYmFjayBpc3N1ZWQgb25lXG4gKiBgZ2ggaXNzdWUgbGlzdCAtLWxhYmVsIFhgIHBlciBsYWJlbCBwZXIgaXRlcmF0aW9uIHdpdGhvdXQgYW55IGNoYW5jZVxuICogb2YgcmV0dXJuaW5nIGEgbWF0Y2gg4oCUIHRoZSBiYXRjaCBpcyB0aGUgc291cmNlIG9mIHRydXRoLCBhbmQgYW4gZW1wdHlcbiAqIGJhdGNoIG1lYW5zIHRoZXJlIGFyZSBubyBsYWJlbGxlZCBpc3N1ZXMgdG8gZmluZC5cbiAqXG4gKiBLbm93biBsaW1pdGF0aW9uOiB0aGUgbGlzdGluZyBpcyByZXF1ZXN0ZWQgYXQgYSB3aWR0aCBvZlxuICogYE1hdGgubWF4KDEwMCwgbGltaXQpYCAoSXNzdWUgIzQ0NjQpLCBzbyBhIGNhbGxlciBhc2tpbmcgZm9yIG1vcmUgdGhhblxuICogMTAwIGxhYmVsbGVkIGlzc3VlcyBpcyBub3Qgc2lsZW50bHkgY3V0IHRvIHRoZSAxMDAtaXNzdWUgZGVmYXVsdCBvbiBhIGNvbGRcbiAqIGNhY2hlLiBBIHJlcG8gd2l0aCBtb3JlIG9wZW4gaXNzdWVzIHRoYW4gdGhhdCB3aWR0aCB3aG9zZSBsYWJlbGxlZCBzdWJzZXRcbiAqIGZhbGxzIG91dHNpZGUgdGhlIG5ld2VzdCBvbmVzIHdpbGwgdW5kZXItcmVwb3J0IGhlcmUuIFRoZSBzY2FuIGNvbGxlY3RvcnNcbiAqIHBhc3Mge0BsaW5rIFNDQU5fTEFCRUxMRURfSVNTVUVfTElNSVR9LCB0aGUgc2FtZSB3aWR0aCBhcyB0aGUgc2NhbidzIG93blxuICogbGlzdGluZywgc28gdGhleSBkbyBub3QgaW5oZXJpdCB0aGF0IGxpbWl0LiBUaGUgY2Vuc3VzIHJlYWRzIHRoYXQgc2FtZVxuICogbGlzdGluZywgc28gYSBuYXJyb3dlciByZXF1ZXN0IGhlcmUgd291bGQgbGV0IHRoZSBzY2FuIG1pc3Mgd29yayBpdCBjb3VudHMuXG4gKlxuICogQHBhcmFtIHJlcG8gLSBSZXBvc2l0b3J5IGluIFwib3duZXIvcmVwb1wiIGZvcm1hdFxuICogQHBhcmFtIGxhYmVsIC0gTGFiZWwgdG8gZmlsdGVyIGJ5XG4gKiBAcGFyYW0gY2FjaGUgLSBPcHRpb25hbCBjYWNoZSBpbnN0YW5jZVxuICogQHBhcmFtIGxpbWl0IC0gTWF4aW11bSBpc3N1ZXMgdG8gcmV0dXJuIChkZWZhdWx0OiA1MCkuIFRoZSBsaXN0aW5nIGZpbHRlcmVkXG4gKiAgIGlzIHJlcXVlc3RlZCBhdCBgTWF0aC5tYXgoMTAwLCBsaW1pdClgLCBzbyBhIGxpbWl0IGFib3ZlIDEwMCBpcyBob25vdXJlZC5cbiAqIEBwYXJhbSBnaENvbW1hbmRGbiAtIE9wdGlvbmFsIGdoIGNvbW1hbmQgZnVuY3Rpb24gZm9yIHRlc3RpbmdcbiAqIEByZXR1cm5zIElzc3VlcyB3aXRoIHRoZSBzcGVjaWZpZWQgbGFiZWxcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoSXNzdWVzQnlMYWJlbChcbiAgcmVwbzogc3RyaW5nLFxuICBsYWJlbDogc3RyaW5nLFxuICBjYWNoZT86IElzc3VlQ2FjaGUsXG4gIGxpbWl0ID0gNTAsXG4gIGdoQ29tbWFuZEZuOiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPiA9IHJ1bkdoQ29tbWFuZCxcbik6IFByb21pc2U8RmlsdGVyYWJsZUlzc3VlW10+IHtcbiAgY29uc3QgYWxsSXNzdWVzID0gYXdhaXQgZmV0Y2hBbGxJc3N1ZXMoXG4gICAgcmVwbyxcbiAgICBjYWNoZSxcbiAgICBNYXRoLm1heCgxMDAsIGxpbWl0KSxcbiAgICBnaENvbW1hbmRGbixcbiAgKTtcbiAgcmV0dXJuIGFsbElzc3Vlc1xuICAgIC5maWx0ZXIoKGlzc3VlKSA9PiBpc3N1ZS5sYWJlbHMuaW5jbHVkZXMobGFiZWwpKVxuICAgIC5zbGljZSgwLCBsaW1pdCk7XG59XG5cbi8qKlxuICogRmV0Y2ggb3BlbiBQUnMgYnkgdXNlciB3aXRoIGJhc2UvaGVhZCBicmFuY2ggaW5mby5cbiAqXG4gKiBAcGFyYW0gcmVwbyAtIFJlcG9zaXRvcnkgaW4gXCJvd25lci9yZXBvXCIgZm9ybWF0XG4gKiBAcGFyYW0gZ2l0aHViVXNlciAtIEdpdEh1YiB1c2VybmFtZVxuICogQHBhcmFtIGNhY2hlIC0gT3B0aW9uYWwgY2FjaGUgaW5zdGFuY2VcbiAqIEBwYXJhbSBnaENvbW1hbmRGbiAtIE9wdGlvbmFsIGdoIGNvbW1hbmQgZnVuY3Rpb24gZm9yIHRlc3RpbmdcbiAqIEBwYXJhbSBmb3JjZVJlZnJlc2ggLSBXaGVuIHRydWUsIGJ5cGFzcyB0aGUgY2FjaGUgcmVhZCBhbmQgZmV0Y2ggbGl2ZVxuICogICBmcm9tIEdpdEh1YiwgdGhlbiBvdmVyd3JpdGUgdGhlIGNhY2hlIHdpdGggdGhlIGZyZXNoIHJlc3VsdCAoSXNzdWVcbiAqICAgIzMxNTApLiBVc2VkIGJ5IHRoZSBsaXZlIGNsYWltLXRpbWUgcmUtY2hlY2sgc28gYSBzdGFsZSBgcHJzXyR7dXNlcn1gXG4gKiAgIGVudHJ5IHdyaXR0ZW4gYXQgZGlzY292ZXJ5IGNhbm5vdCBoaWRlIGEganVzdC1vcGVuZWQgc2libGluZyBQUi5cbiAqIEByZXR1cm5zIEFycmF5IG9mIG9wZW4gUFJzXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaE9wZW5QUnNCeVVzZXIoXG4gIHJlcG86IHN0cmluZyxcbiAgZ2l0aHViVXNlcjogc3RyaW5nLFxuICBjYWNoZT86IElzc3VlQ2FjaGUsXG4gIGdoQ29tbWFuZEZuOiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPiA9IHJ1bkdoQ29tbWFuZCxcbiAgZm9yY2VSZWZyZXNoID0gZmFsc2UsXG4pOiBQcm9taXNlPE9wZW5QUltdPiB7XG4gIGNvbnN0IGNhY2hlS2V5ID0gYHByc18ke2dpdGh1YlVzZXJ9YDtcblxuICBpZiAoY2FjaGUgJiYgIWZvcmNlUmVmcmVzaCkge1xuICAgIGNvbnN0IGNhY2hlZCA9IGF3YWl0IGNhY2hlLnJlYWQ8T3BlblBSW10+KHJlcG8sIGNhY2hlS2V5KTtcbiAgICBpZiAoY2FjaGVkKSByZXR1cm4gY2FjaGVkO1xuICB9XG5cbiAgY29uc3Qgb3V0cHV0ID0gYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgIFwicHJcIixcbiAgICBcImxpc3RcIixcbiAgICBcIi0tcmVwb1wiLFxuICAgIHJlcG8sXG4gICAgXCItLXN0YXRlXCIsXG4gICAgXCJvcGVuXCIsXG4gICAgXCItLWF1dGhvclwiLFxuICAgIGdpdGh1YlVzZXIsXG4gICAgXCItLWpzb25cIixcbiAgICAvLyBJc3N1ZSAjMTgwMDogYGlzRHJhZnRgIGxldHMgdGhlIGF1dG8tbWVyZ2Ugc3dlZXAgc2tpcCBhIGRyYWZ0IFBSXG4gICAgLy8gaW5zdGVhZCBvZiBmYWlsaW5nIHRvIGFybSBpdCBldmVyeSBjeWNsZS5cbiAgICBcIm51bWJlcix0aXRsZSxiYXNlUmVmTmFtZSxoZWFkUmVmTmFtZSxpc0RyYWZ0XCIsXG4gICAgXCItLWxpbWl0XCIsXG4gICAgU3RyaW5nKE9QRU5fUFJfQllfVVNFUl9MSU1JVCksXG4gIF0pO1xuXG4gIC8vIElzc3VlICM0MDI0OiBzdGFtcCB0aGUgcXVlcmllZCBhdXRob3Igb250byBlYWNoIFBSIHNvIGEgYmxvY2tpbmdcbiAgLy8gZGVjaXNpb24gY2FuIHJlcG9ydCB3aG8gb3ducyB0aGUgUFIgYW5kIHdoZXRoZXIgdGhlIFBSLW1haW50ZW5hbmNlXG4gIC8vIHNjYW5zIGNvdmVyIHRoZW0uXG4gIGNvbnN0IHBycyA9IHBhcnNlUFJMaXN0SnNvbihvdXRwdXQpLm1hcCgocHIpID0+ICh7XG4gICAgLi4ucHIsXG4gICAgYXV0aG9yOiBnaXRodWJVc2VyLFxuICB9KSk7XG4gIGlmIChjYWNoZSkgYXdhaXQgY2FjaGUud3JpdGUocmVwbywgY2FjaGVLZXksIHBycyk7XG4gIHJldHVybiBwcnM7XG59XG5cbi8qKlxuICogRmV0Y2ggb3BlbiBQUnMgYWNyb3NzIGV2ZXJ5IGZsZWV0IGFjY291bnQgKElzc3VlICMzMTAwKS5cbiAqXG4gKiBUaGUgb3Blbi1QUiBkdXBsaWNhdGUgZ3VhcmQgbXVzdCBzZWUgUFJzIHJhaXNlZCBieSAqYW55KiBmbGVldCBhY2NvdW50LFxuICogbm90IGp1c3QgdGhlIGN1cnJlbnQgaG9zdCDigJQgb3RoZXJ3aXNlIGEgc2Vjb25kIGhvc3Qgb3BlbnMgYSBkdXBsaWNhdGUgUFJcbiAqIGZvciB0aGUgc2FtZSBpc3N1ZSAoSXNzdWUgIzMwOTUpLiBUaGlzIGNhbGxzIGBmZXRjaE9wZW5QUnNCeVVzZXJgIG9uY2UgcGVyXG4gKiBkaXN0aW5jdCBhdXRob3IgYW5kIGNvbmNhdGVuYXRlcyB0aGUgcmVzdWx0cywgZGUtZHVwbGljYXRpbmcgYnkgUFIgbnVtYmVyLlxuICpcbiAqIFJldXNpbmcgdGhlIHBlci1hdXRob3IgaGVscGVyIGtlZXBzIHRoZSBwZXItdXNlciBjYWNoZSBrZXlzIChgcHJzXyR7dXNlcn1gKVxuICogaW50YWN0IGFuZCBuZWVkcyBubyBuZXcgR2l0SHViIEpTT04gZmllbGRzLiBFbXB0eS9ibGFuayBhdXRob3JzIGFyZSBza2lwcGVkLlxuICpcbiAqIEBwYXJhbSByZXBvIC0gUmVwb3NpdG9yeSBpbiBcIm93bmVyL3JlcG9cIiBmb3JtYXRcbiAqIEBwYXJhbSBhdXRob3JzIC0gRmxlZXQgR2l0SHViIHVzZXJuYW1lcyAoZGVkdXBsaWNhdGVkIGludGVybmFsbHkpXG4gKiBAcGFyYW0gY2FjaGUgLSBPcHRpb25hbCBjYWNoZSBpbnN0YW5jZVxuICogQHBhcmFtIGdoQ29tbWFuZEZuIC0gT3B0aW9uYWwgZ2ggY29tbWFuZCBmdW5jdGlvbiBmb3IgdGVzdGluZ1xuICogQHBhcmFtIHBlckF1dGhvck91dCAtIE9wdGlvbmFsIG1hcCBwb3B1bGF0ZWQgd2l0aCBlYWNoIGF1dGhvcidzIG9wZW4tUFJcbiAqICAgY291bnQgKElzc3VlICMzMTM4IGd1YXJkIG9ic2VydmFiaWxpdHkpLiBLZXllZCBieSB0aGUgYXV0aG9yIGxvZ2luIGFzXG4gKiAgIHN1cHBsaWVkOyBleGlzdGluZyBrZXlzIGFyZSBvdmVyd3JpdHRlbi5cbiAqIEBwYXJhbSBmb3JjZVJlZnJlc2ggLSBXaGVuIHRydWUsIGJ5cGFzcyB0aGUgcGVyLXVzZXIgY2FjaGUgcmVhZCBhbmQgZmV0Y2hcbiAqICAgZWFjaCBhdXRob3IncyBQUnMgbGl2ZSAoSXNzdWUgIzMxNTApLiBUaHJlYWRlZCB0aHJvdWdoIHRvXG4gKiAgIGBmZXRjaE9wZW5QUnNCeVVzZXJgIHNvIHRoZSBsaXZlIGNsYWltLXRpbWUgcmUtY2hlY2sgc2VlcyBqdXN0LW9wZW5lZFxuICogICBzaWJsaW5nIFBScyByZWdhcmRsZXNzIG9mIGEgc3RhbGUgZGlzY292ZXJ5LXRpbWUgY2FjaGUgZW50cnkuXG4gKiBAcmV0dXJucyBEZS1kdXBsaWNhdGVkIGFycmF5IG9mIG9wZW4gUFJzIGFjcm9zcyBhbGwgZmxlZXQgYXV0aG9yc1xuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hPcGVuUFJzRm9yRmxlZXQoXG4gIHJlcG86IHN0cmluZyxcbiAgYXV0aG9yczogc3RyaW5nW10sXG4gIGNhY2hlPzogSXNzdWVDYWNoZSxcbiAgZ2hDb21tYW5kRm46IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+ID0gcnVuR2hDb21tYW5kLFxuICBwZXJBdXRob3JPdXQ/OiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+LFxuICBmb3JjZVJlZnJlc2ggPSBmYWxzZSxcbik6IFByb21pc2U8T3BlblBSW10+IHtcbiAgY29uc3QgZGlzdGluY3RBdXRob3JzID0gW1xuICAgIC4uLm5ldyBTZXQoYXV0aG9ycy5maWx0ZXIoKGEpID0+IGEgJiYgYS50cmltKCkubGVuZ3RoID4gMCkpLFxuICBdO1xuXG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PG51bWJlcj4oKTtcbiAgY29uc3QgbWVyZ2VkOiBPcGVuUFJbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGF1dGhvciBvZiBkaXN0aW5jdEF1dGhvcnMpIHtcbiAgICBjb25zdCBwcnMgPSBhd2FpdCBmZXRjaE9wZW5QUnNCeVVzZXIoXG4gICAgICByZXBvLFxuICAgICAgYXV0aG9yLFxuICAgICAgY2FjaGUsXG4gICAgICBnaENvbW1hbmRGbixcbiAgICAgIGZvcmNlUmVmcmVzaCxcbiAgICApO1xuICAgIGlmIChwZXJBdXRob3JPdXQpIHBlckF1dGhvck91dFthdXRob3JdID0gcHJzLmxlbmd0aDtcbiAgICBmb3IgKGNvbnN0IHByIG9mIHBycykge1xuICAgICAgaWYgKCFzZWVuLmhhcyhwci5udW1iZXIpKSB7XG4gICAgICAgIHNlZW4uYWRkKHByLm51bWJlcik7XG4gICAgICAgIG1lcmdlZC5wdXNoKHByKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgcmV0dXJuIG1lcmdlZDtcbn1cblxuLyoqXG4gKiBgLS1qc29uYCBmaWVsZHMgdGhlIHVuLWZpbHRlcmVkIG9wZW4tUFIgbGlzdGluZyByZXF1ZXN0cyAoSXNzdWUgIzE4NDYpLlxuICpcbiAqIE9uZSBsaXN0aW5nIHBlciByZXBvIHBlciBjeWNsZSBzZXJ2ZXMgZXZlcnkgY29uc3VtZXIsIHNvIHRoZSBmaWVsZCBzZXQgaXNcbiAqIHRoZSB1bmlvbiBvZiB3aGF0IHRoZXkgbmVlZDogdGhlIGJyYW5jaC9ib2R5IGZpZWxkcyB0aGUgUFItbGluayBhbmRcbiAqIGJyYW5jaC1jbGVhbnVwIGhlbHBlcnMgcmVhZCwgcGx1cyB0aGUgYXV0aG9yIGFuZCBoZWFkLW93bmVyc2hpcCBmaWVsZHNcbiAqIHRoZSBib3QtUFIgbG9va3VwIChgcHJfYm90X2xvb2t1cC50c2ApIGRlY2lkZXMgYWRtaXNzaW9uIG9uLlxuICovXG5jb25zdCBPUEVOX1BSX0xJU1RfRklFTERTID1cbiAgXCJudW1iZXIsdGl0bGUsYmFzZVJlZk5hbWUsaGVhZFJlZk5hbWUsYm9keSx1cmwsYXV0aG9yLFwiICtcbiAgXCJpc0Nyb3NzUmVwb3NpdG9yeSxoZWFkUmVmT2lkLGF1dG9NZXJnZVJlcXVlc3QsbWVyZ2VhYmxlXCI7XG5cbi8qKlxuICoge0BsaW5rIE9QRU5fUFJfTElTVF9GSUVMRFN9IHBsdXMgYGxhYmVsc2AsIGZvciB0aGUgb25lIGFsbC1hdXRob3JzIGxpc3RpbmdcbiAqIChJc3N1ZSAjMjQwOSkuIEtlcHQgb2ZmIHRoZSBwZXItYXV0aG9yIGxpc3RpbmdzIGRlbGliZXJhdGVseTogbm90aGluZyByZWFkc1xuICogbGFiZWxzIHRoZXJlLCBhbmQgdGhlaXIgZmllbGQgbGlzdCBpcyBzaGFyZWQgd2l0aCB0aGUgY3Jvc3MtcmVwbyBwcmVmZXRjaC5cbiAqL1xuY29uc3QgQUxMX09QRU5fUFJfTElTVF9GSUVMRFMgPSBgJHtPUEVOX1BSX0xJU1RfRklFTERTfSxsYWJlbHNgO1xuXG4vKipcbiAqIEZldGNoIGFsbCBvcGVuIFBScyBmb3IgYSByZXBvLCByZWdhcmRsZXNzIG9mIGF1dGhvciAoSXNzdWUgIzE3ODcpLlxuICpcbiAqIFVzZWQgYnkgaGVscGVycyB0aGF0IG5lZWQgdG8gbG9vayB1cCBQUnMgYnkgaGVhZCBicmFuY2ggb3IgYnkgaXNzdWVcbiAqIHJlZmVyZW5jZSBpbiB0aGUgdGl0bGUgd2l0aG91dCByZXN0cmljdGluZyB0byB3b3JrZXItYXV0aG9yZWQgUFJzLlxuICogQ2FjaGUga2V5IGlzIGBwcnNfb3Blbl9hbGxgOyBwYWlyIHdpdGggdGhlIGl0ZXJhdGlvbi1zY29wZWRcbiAqIGBJc3N1ZUNhY2hlYCBzbyB0aGUgcGVyLWl0ZXJhdGlvbiBgZ2ggcHIgbGlzdGAgY291bnQgZHJvcHMgdG8gb25lLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hBbGxPcGVuUFJzKFxuICByZXBvOiBzdHJpbmcsXG4gIGNhY2hlPzogSXNzdWVDYWNoZSxcbiAgbGltaXQgPSA1MCxcbiAgZ2hDb21tYW5kRm46IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+ID0gcnVuR2hDb21tYW5kLFxuKTogUHJvbWlzZTxPcGVuUFJXaXRoQm9keVtdPiB7XG4gIGNvbnN0IGNhY2hlS2V5ID0gXCJwcnNfb3Blbl9hbGxcIjtcblxuICBpZiAoY2FjaGUpIHtcbiAgICBjb25zdCBjYWNoZWQgPSBhd2FpdCBjYWNoZS5yZWFkPE9wZW5QUldpdGhCb2R5W10+KHJlcG8sIGNhY2hlS2V5KTtcbiAgICBpZiAoY2FjaGVkKSByZXR1cm4gY2FjaGVkO1xuICB9XG5cbiAgY29uc3Qgb3V0cHV0ID0gYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgIFwicHJcIixcbiAgICBcImxpc3RcIixcbiAgICBcIi0tcmVwb1wiLFxuICAgIHJlcG8sXG4gICAgXCItLXN0YXRlXCIsXG4gICAgXCJvcGVuXCIsXG4gICAgXCItLWpzb25cIixcbiAgICBBTExfT1BFTl9QUl9MSVNUX0ZJRUxEUyxcbiAgICBcIi0tbGltaXRcIixcbiAgICBTdHJpbmcobGltaXQpLFxuICBdKTtcblxuICAvLyBOZXZlciBjYWNoZSBhIGZhaWx1cmUgKElzc3VlICM0MjU3KTogXCJubyBvcGVuIFBSc1wiIGlzIHRoZSBhbnN3ZXIgdGhhdFxuICAvLyBtYXJrcyBhIGJyYW5jaCBkZWxldGlvbiBzYWZlLCBzbyBhIGZhaWxlZCBjYWxsIG11c3QgdGhyb3cgcmF0aGVyIHRoYW5cbiAgLy8gbWFzcXVlcmFkZSBhcyBpdC5cbiAgYXNzZXJ0TGlzdE91dHB1dChvdXRwdXQsIGBmZXRjaEFsbE9wZW5QUnMoJHtyZXBvfSlgKTtcblxuICBjb25zdCBwYXJzZWQ6IHVua25vd24gPSBKU09OLnBhcnNlKG91dHB1dC50cmltKCkpO1xuICBpZiAoIUFycmF5LmlzQXJyYXkocGFyc2VkKSkge1xuICAgIC8vIFNhbWUgcnVsZSBhcyB0aGUgZW1wdHkvdW5wYXJzZWFibGUgb3V0cHV0IGFib3ZlIChJc3N1ZSAjMTg0Nik6IGFuXG4gICAgLy8gb2JqZWN0IHBheWxvYWQgaXMgYGdoYCByZXBvcnRpbmcgYSBmYWlsdXJlIChge1wibWVzc2FnZVwiOlwiTm90IEZvdW5kXCJ9YCksXG4gICAgLy8gbm90IGEgcmVwbyB3aXRoIG5vIG9wZW4gUFJzLiBUaHJvdyByYXRoZXIgdGhhbiBsZXQgaXQgcmVhZCBhcyBvbmUuXG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYGZldGNoQWxsT3BlblBScygke3JlcG99KTogZ2ggb3V0cHV0IHdhcyBub3QgYSBKU09OIGFycmF5IOKAlCBgICtcbiAgICAgICAgYHRyZWF0aW5nIGFzIGEgZmFpbGVkIGNhbGwsIG5vdCBhbiBlbXB0eSBsaXN0IChJc3N1ZSAjNDI1NylgLFxuICAgICk7XG4gIH1cblxuICBjb25zdCBwcnM6IE9wZW5QUldpdGhCb2R5W10gPSBbXTtcbiAgZm9yIChjb25zdCBpdGVtIG9mIHBhcnNlZCkge1xuICAgIGlmICghaXNSZWNvcmQoaXRlbSkpIGNvbnRpbnVlO1xuICAgIGlmICh0eXBlb2YgaXRlbS5udW1iZXIgIT09IFwibnVtYmVyXCIpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHByOiBPcGVuUFJXaXRoQm9keSA9IHtcbiAgICAgIG51bWJlcjogaXRlbS5udW1iZXIsXG4gICAgICB0aXRsZTogdHlwZW9mIGl0ZW0udGl0bGUgPT09IFwic3RyaW5nXCIgPyBpdGVtLnRpdGxlIDogXCJcIixcbiAgICAgIGJhc2VSZWZOYW1lOiB0eXBlb2YgaXRlbS5iYXNlUmVmTmFtZSA9PT0gXCJzdHJpbmdcIiA/IGl0ZW0uYmFzZVJlZk5hbWUgOiBcIlwiLFxuICAgICAgaGVhZFJlZk5hbWU6IHR5cGVvZiBpdGVtLmhlYWRSZWZOYW1lID09PSBcInN0cmluZ1wiID8gaXRlbS5oZWFkUmVmTmFtZSA6IFwiXCIsXG4gICAgICBib2R5OiB0eXBlb2YgaXRlbS5ib2R5ID09PSBcInN0cmluZ1wiID8gaXRlbS5ib2R5IDogXCJcIixcbiAgICAgIHVybDogdHlwZW9mIGl0ZW0udXJsID09PSBcInN0cmluZ1wiID8gaXRlbS51cmwgOiBcIlwiLFxuICAgIH07XG4gICAgLy8gSXNzdWUgIzE4NDY6IGNhcnJpZWQgb25seSB3aGVuIGBnaGAgYWN0dWFsbHkgcmVwb3J0ZWQgdGhlbSwgc28gYW5cbiAgICAvLyBhYnNlbnQgZmllbGQgc3RheXMgXCJ1bmtub3duXCIgcmF0aGVyIHRoYW4gYmVjb21pbmcgYSBmYWxzZSBuZWdhdGl2ZS5cbiAgICAvLyBJc3N1ZSAjNDcxOTogYGdoYCByZXBvcnRzIGEgR2l0SHViIEFwcCBhdXRob3IgYXMgYGFwcC88c2x1Zz5gIHdpdGhcbiAgICAvLyBgaXNfYm90OiB0cnVlYC4gT25seSB0aGF0IHNoYXBlIGlzIHJld3JpdHRlbiwgc28gYW4gb3JkaW5hcnkgdXNlcidzXG4gICAgLy8gbG9naW4gaXMgbmV2ZXIgY2hhbmdlZC5cbiAgICBjb25zdCBhdXRob3IgPSBpc1JlY29yZChpdGVtLmF1dGhvcikgPyBpdGVtLmF1dGhvciA6IHVuZGVmaW5lZDtcbiAgICBjb25zdCBsb2dpbiA9IHR5cGVvZiBhdXRob3I/LmxvZ2luID09PSBcInN0cmluZ1wiID8gYXV0aG9yLmxvZ2luLnRyaW0oKSA6IFwiXCI7XG4gICAgaWYgKGxvZ2luICE9PSBcIlwiKSB7XG4gICAgICBwci5hdXRob3JMb2dpbiA9IGF1dGhvcj8uaXNfYm90ID09PSB0cnVlXG4gICAgICAgID8gbm9ybWFsaXNlR2hBcHBMb2dpbihsb2dpbilcbiAgICAgICAgOiBsb2dpbjtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBpdGVtLmlzQ3Jvc3NSZXBvc2l0b3J5ID09PSBcImJvb2xlYW5cIikge1xuICAgICAgcHIuaXNDcm9zc1JlcG9zaXRvcnkgPSBpdGVtLmlzQ3Jvc3NSZXBvc2l0b3J5O1xuICAgIH1cbiAgICBpZiAodHlwZW9mIGl0ZW0uaGVhZFJlZk9pZCA9PT0gXCJzdHJpbmdcIikgcHIuaGVhZFJlZk9pZCA9IGl0ZW0uaGVhZFJlZk9pZDtcbiAgICBpZiAodHlwZW9mIGl0ZW0ubWVyZ2VhYmxlID09PSBcInN0cmluZ1wiKSBwci5tZXJnZWFibGUgPSBpdGVtLm1lcmdlYWJsZTtcbiAgICBpZiAoaXRlbS5hdXRvTWVyZ2VSZXF1ZXN0ID09PSBudWxsKSB7XG4gICAgICBwci5hdXRvTWVyZ2VSZXF1ZXN0ID0gbnVsbDtcbiAgICB9IGVsc2UgaWYgKGlzUmVjb3JkKGl0ZW0uYXV0b01lcmdlUmVxdWVzdCkpIHtcbiAgICAgIGNvbnN0IG1ldGhvZCA9IGl0ZW0uYXV0b01lcmdlUmVxdWVzdC5tZXJnZU1ldGhvZDtcbiAgICAgIHByLmF1dG9NZXJnZVJlcXVlc3QgPSB7XG4gICAgICAgIG1lcmdlTWV0aG9kOiB0eXBlb2YgbWV0aG9kID09PSBcInN0cmluZ1wiID8gbWV0aG9kIDogXCJcIixcbiAgICAgIH07XG4gICAgfVxuICAgIC8vIElzc3VlICMyNDA5OiBsYWJlbCBuYW1lcywgdG9sZXJhdGluZyBhIHJvdyB3aXRoIG5vbmUgb3Igd2l0aCBqdW5rLlxuICAgIHByLmxhYmVscyA9IEFycmF5LmlzQXJyYXkoaXRlbS5sYWJlbHMpXG4gICAgICA/IGl0ZW0ubGFiZWxzLmZsYXRNYXAoKGxhYmVsKSA9PlxuICAgICAgICBpc1JlY29yZChsYWJlbCkgJiYgdHlwZW9mIGxhYmVsLm5hbWUgPT09IFwic3RyaW5nXCIgPyBbbGFiZWwubmFtZV0gOiBbXVxuICAgICAgKVxuICAgICAgOiBbXTtcbiAgICBwcnMucHVzaChwcik7XG4gIH1cblxuICBpZiAoY2FjaGUpIGF3YWl0IGNhY2hlLndyaXRlKHJlcG8sIGNhY2hlS2V5LCBwcnMpO1xuICByZXR1cm4gcHJzO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFNldHRsZWQgUFIgbGlzdGluZ3MgKElzc3VlICMyNDA5KVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogSG93IGxvbmcgYSBtZXJnZWQvY2xvc2VkIHBlci1hdXRob3IgbGlzdGluZyBtYXkgYmUgc2VydmVkIHdoaWxlIG5vdGhpbmdcbiAqIG9ic2VydmFibGUgY291bGQgaGF2ZSBjaGFuZ2VkIGl0IChJc3N1ZSAjMjQwOSkuXG4gKi9cbmV4cG9ydCBjb25zdCBTRVRUTEVEX1BSX0xJU1RJTkdfTUFYX0FHRV9TRUNPTkRTID0gMzYwMDtcblxuLyoqIEluc2lkZSB0aGlzIGFnZSBhIHNldHRsZWQgbGlzdGluZyBpcyBzZXJ2ZWQgYXMgaXQgYWx3YXlzIHdhcy4gKi9cbmNvbnN0IFNFVFRMRURfUFJfTElTVElOR19GUkVTSF9TRUNPTkRTID0gNjAwO1xuXG4vKipcbiAqIFRoZSBgLS1saW1pdGAgYGZldGNoT3BlblBSc0J5VXNlcmAgcGFzc2VzIHRvIGBnaCBwciBsaXN0YC4gQSBmdWxsIGxpc3RpbmcgaXNcbiAqIHRydW5jYXRlZCwgc28gYG9wZW5Qck51bWJlcnNCeVVzZXJgIHRyZWF0cyBvbmUgYXMgdW5rbm93bi4gVGhlIGR1cGxpY2F0ZVxuICogZ3VhcmQgKHRoZSBvd24tUFIgcnVsZSBpbiBgZ2V0QmxvY2tpbmdQUkZvcklzc3VlYCwgSXNzdWUgIzI2NjMpIG5lZWRzIGV2ZXJ5XG4gKiBvcGVuIFBSIG9mIHRoZSBhdXRob3IsIG9yIGFuIG9sZGVyIG93biBQUiBpcyBtaXNzZWQgKElzc3VlICM0NTE4KS5cbiAqL1xuZXhwb3J0IGNvbnN0IE9QRU5fUFJfQllfVVNFUl9MSU1JVCA9IDEwMDtcblxuLyoqIEEgbWVyZ2VkL2Nsb3NlZCBsaXN0aW5nLCB3aXRoIHRoZSBvcGVuIFBScyBzZWVuIHdoaWxlIGl0IGhhcyBiZWVuIGNhY2hlZC4gKi9cbmludGVyZmFjZSBTZXR0bGVkTGlzdGluZzxUPiB7XG4gIHY6IDE7XG4gIHByczogVFtdO1xuICAvKiogRXBvY2ggc2Vjb25kcyB0aGUgbGlzdGluZyB3YXMgZmV0Y2hlZCDigJQgbm90IHJlZnJlc2hlZCBieSBib29ra2VlcGluZy4gKi9cbiAgY2FjaGVkQXQ6IG51bWJlcjtcbiAgLyoqIEV2ZXJ5IG9wZW4gUFIgb2YgdGhpcyBhdXRob3Igc2VlbiBzaW5jZTsgb25lIGdvaW5nIG1pc3NpbmcgaW52YWxpZGF0ZXMuICovXG4gIG9wZW5TZWVuOiBudW1iZXJbXTtcbn1cblxuZnVuY3Rpb24gaXNTZXR0bGVkTGlzdGluZzxUPih2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFNldHRsZWRMaXN0aW5nPFQ+IHtcbiAgcmV0dXJuIGlzUmVjb3JkKHZhbHVlKSAmJiB2YWx1ZS52ID09PSAxICYmIEFycmF5LmlzQXJyYXkodmFsdWUucHJzKSAmJlxuICAgIHR5cGVvZiB2YWx1ZS5jYWNoZWRBdCA9PT0gXCJudW1iZXJcIiAmJiBBcnJheS5pc0FycmF5KHZhbHVlLm9wZW5TZWVuKTtcbn1cblxuLyoqXG4gKiBUaGlzIGF1dGhvcidzIG9wZW4gUFIgbnVtYmVycyBpbiB0aGUgcmVwb3NpdG9yeSwgb3IgYG51bGxgIHdoZW4gdGhleSBjYW5ub3RcbiAqIGJlIGtub3duIOKAlCB0aGUgbGlzdGluZyBmYWlsZWQsIG9yIGNhbWUgYmFjayBmdWxsIGFuZCBpcyB0aGVyZWZvcmUgdHJ1bmNhdGVkLlxuICovXG5hc3luYyBmdW5jdGlvbiBvcGVuUHJOdW1iZXJzQnlVc2VyKFxuICByZXBvOiBzdHJpbmcsXG4gIGdpdGh1YlVzZXI6IHN0cmluZyxcbiAgY2FjaGU6IElzc3VlQ2FjaGUsXG4gIGdoQ29tbWFuZEZuOiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPixcbik6IFByb21pc2U8bnVtYmVyW10gfCBudWxsPiB7XG4gIHRyeSB7XG4gICAgY29uc3Qgb3BlbiA9IGF3YWl0IGZldGNoT3BlblBSc0J5VXNlcihyZXBvLCBnaXRodWJVc2VyLCBjYWNoZSwgZ2hDb21tYW5kRm4pO1xuICAgIGlmIChvcGVuLmxlbmd0aCA+PSBPUEVOX1BSX0JZX1VTRVJfTElNSVQpIHJldHVybiBudWxsO1xuICAgIHJldHVybiBvcGVuLm1hcCgocHIpID0+IHByLm51bWJlcik7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKlxuICogUmVhZCBhIG1lcmdlZC9jbG9zZWQgcGVyLWF1dGhvciBsaXN0aW5nIHRoYXQgaXMgc3RpbGwga25vd24gdG8gYmUgY3VycmVudC5cbiAqXG4gKiBTdWNoIGEgbGlzdGluZyBjaGFuZ2VzIG9ubHkgd2hlbiBvbmUgb2YgdGhhdCBhdXRob3IncyAqKm9wZW4qKiBQUnMgaW4gdGhlXG4gKiByZXBvc2l0b3J5IHN0b3BzIGJlaW5nIG9wZW4sIGFuZCB0aGUgb3BlbiBzZXQgaXMgYWxyZWFkeSBrbm93biBjaGVhcGx5ICh0aGVcbiAqIGNyb3NzLXJlcG8gcHJlZmV0Y2gsIElzc3VlICMxNDg2KS4gU28gdGhlIGxpc3RpbmcgaXMgc2VydmVkIGZvciB1cCB0b1xuICoge0BsaW5rIFNFVFRMRURfUFJfTElTVElOR19NQVhfQUdFX1NFQ09ORFN9ICp3aGlsZSBldmVyeSBvcGVuIFBSIHNlZW4gc2luY2UgaXRcbiAqIHdhcyBjYWNoZWQgaXMgc3RpbGwgb3BlbiosIGFuZCBpcyBhIG1pc3MgdGhlIG1vbWVudCBvbmUgaXMgZ29uZSDigJQgYXQgYW55XG4gKiBhZ2UsIHRoZSBmaXJzdCB0ZW4gbWludXRlcyBpbmNsdWRlZC4gUmUtZmV0Y2hpbmcgaXQgZXZlcnkgdGVuIG1pbnV0ZXMgY29zdFxuICogYDIwIHJlcG9zIMOXIGF1dGhvcnMgw5cgMiBzdGF0ZXNgIEdyYXBoUUwgY2FsbHMgcGVyIGhvc3QgcGVyIHRlbiBtaW51dGVzLCB0aGVcbiAqIGxhcmdlc3Qgc2luZ2xlIGNvbnN1bWVyIG9mIGEgcXVvdGEgdGhlIGZsZWV0IHdhcyBleGhhdXN0aW5nIH4yNSBtaW51dGVzIGludG9cbiAqIGV2ZXJ5IGhvdXIuXG4gKlxuICogT3BlbiBQUnMgYXJlIHJlbWVtYmVyZWQgYXMgdGhleSBhcmUgc2Vlbiwgc28gb25lIG9wZW5lZCBhZnRlciB0aGUgbGlzdGluZ1xuICogd2FzIGNhY2hlZCBpbnZhbGlkYXRlcyBpdCB3aGVuIGl0IGdvZXMuIE9ubHkgYSBQUiB0aGF0IG9wZW5zICoqYW5kKiogY2xvc2VzXG4gKiBiZXR3ZWVuIHR3byBjb25zZWN1dGl2ZSByZWFkcyBpcyBtaXNzZWQsIGZvciBhdCBtb3N0IHRoZSBtYXhpbXVtIGFnZSDigJQgYW5kIGFcbiAqIHN0YWxlIGFuc3dlciBjYW5ub3QgY2F1c2UgZHVwbGljYXRlIHdvcmssIGJlY2F1c2UgdGhlIHBpY2t1cCBwcmUtY2hlY2sgbG9va3NcbiAqIGZvciBhbiBleGlzdGluZyBQUiBsaXZlIChgbWVyZ2VkX3ByX3ByZWNoZWNrX3BoYXNlLnRzYCkuXG4gKlxuICogRmFpbHMgdG93YXJkcyBhc2tpbmc6IGFuIG9wZW4gc2V0IHRoYXQgY2Fubm90IGJlIGtub3duIHNlcnZlcyB0aGUgbGlzdGluZ1xuICogb25seSBpbnNpZGUgdGhlIG9sZCB0ZW4tbWludXRlIHdpbmRvdy5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVhZFNldHRsZWRMaXN0aW5nPFQ+KFxuICByZXBvOiBzdHJpbmcsXG4gIGdpdGh1YlVzZXI6IHN0cmluZyxcbiAgY2FjaGVLZXk6IHN0cmluZyxcbiAgY2FjaGU6IElzc3VlQ2FjaGUsXG4gIGdoQ29tbWFuZEZuOiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPixcbiAgbm93U2Vjb25kczogbnVtYmVyLFxuKTogUHJvbWlzZTxUW10gfCBudWxsPiB7XG4gIC8vIEFuIGVudHJ5IHdyaXR0ZW4gYmVmb3JlIElzc3VlICMyNDA5IGlzIGEgYmFyZSBhcnJheSB3aXRoIG5vIHJlY29yZCBvZiB0aGVcbiAgLy8gb3BlbiBQUnMgc2Vlbi4gSXQgaXMgc2VydmVkIGV4YWN0bHkgYXMgaXQgYWx3YXlzIHdhcyDigJQgaW5zaWRlIHRoZSBjYWNoZSdzXG4gIC8vIG93biBUVEwg4oCUIHNvIGFuIHVwZ3JhZGUgdGhyb3dzIG5vdGhpbmcgYXdheTsgaXQgY2Fubm90IGJlIGV4dGVuZGVkLlxuICBjb25zdCBsZWdhY3kgPSBhd2FpdCBjYWNoZS5yZWFkPHVua25vd24+KHJlcG8sIGNhY2hlS2V5KTtcbiAgaWYgKEFycmF5LmlzQXJyYXkobGVnYWN5KSkgcmV0dXJuIGxlZ2FjeSBhcyBUW107XG5cbiAgY29uc3QgZW50cnkgPSBhd2FpdCBjYWNoZS5yZWFkPHVua25vd24+KHJlcG8sIGNhY2hlS2V5LCB7XG4gICAgdHRsU2Vjb25kczogU0VUVExFRF9QUl9MSVNUSU5HX01BWF9BR0VfU0VDT05EUyxcbiAgfSk7XG4gIGlmICghaXNTZXR0bGVkTGlzdGluZzxUPihlbnRyeSkpIHJldHVybiBudWxsO1xuICBjb25zdCBhZ2UgPSBub3dTZWNvbmRzIC0gZW50cnkuY2FjaGVkQXQ7XG4gIGlmIChhZ2UgPCAwIHx8IGFnZSA+PSBTRVRUTEVEX1BSX0xJU1RJTkdfTUFYX0FHRV9TRUNPTkRTKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCBvcGVuID0gYXdhaXQgb3BlblByTnVtYmVyc0J5VXNlcihyZXBvLCBnaXRodWJVc2VyLCBjYWNoZSwgZ2hDb21tYW5kRm4pO1xuICBpZiAob3BlbiA9PT0gbnVsbCkge1xuICAgIHJldHVybiBhZ2UgPCBTRVRUTEVEX1BSX0xJU1RJTkdfRlJFU0hfU0VDT05EUyA/IGVudHJ5LnBycyA6IG51bGw7XG4gIH1cbiAgY29uc3Qgb3Blbk5vdyA9IG5ldyBTZXQob3Blbik7XG4gIGlmIChlbnRyeS5vcGVuU2Vlbi5zb21lKChudW1iZXIpID0+ICFvcGVuTm93LmhhcyhudW1iZXIpKSkgcmV0dXJuIG51bGw7XG5cbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQoZW50cnkub3BlblNlZW4pO1xuICBjb25zdCB1bnNlZW4gPSBvcGVuLmZpbHRlcigobnVtYmVyKSA9PiAhc2Vlbi5oYXMobnVtYmVyKSk7XG4gIGlmICh1bnNlZW4ubGVuZ3RoID4gMCkge1xuICAgIGF3YWl0IGNhY2hlLndyaXRlKHJlcG8sIGNhY2hlS2V5LCB7XG4gICAgICAuLi5lbnRyeSxcbiAgICAgIG9wZW5TZWVuOiBbLi4uZW50cnkub3BlblNlZW4sIC4uLnVuc2Vlbl0sXG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIGVudHJ5LnBycztcbn1cblxuLyoqIENhY2hlIGEgZnJlc2hseSBmZXRjaGVkIG1lcmdlZC9jbG9zZWQgbGlzdGluZyBiZXNpZGUgdGhlIG9wZW4gc2V0LiAqL1xuYXN5bmMgZnVuY3Rpb24gd3JpdGVTZXR0bGVkTGlzdGluZzxUPihcbiAgcmVwbzogc3RyaW5nLFxuICBnaXRodWJVc2VyOiBzdHJpbmcsXG4gIGNhY2hlS2V5OiBzdHJpbmcsXG4gIHByczogVFtdLFxuICBjYWNoZTogSXNzdWVDYWNoZSxcbiAgZ2hDb21tYW5kRm46IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+LFxuICBub3dTZWNvbmRzOiBudW1iZXIsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgb3BlbiA9IGF3YWl0IG9wZW5Qck51bWJlcnNCeVVzZXIocmVwbywgZ2l0aHViVXNlciwgY2FjaGUsIGdoQ29tbWFuZEZuKTtcbiAgY29uc3QgZW50cnk6IFNldHRsZWRMaXN0aW5nPFQ+ID0ge1xuICAgIHY6IDEsXG4gICAgcHJzLFxuICAgIGNhY2hlZEF0OiBub3dTZWNvbmRzLFxuICAgIG9wZW5TZWVuOiBvcGVuID8/IFtdLFxuICB9O1xuICBhd2FpdCBjYWNoZS53cml0ZShyZXBvLCBjYWNoZUtleSwgZW50cnkpO1xufVxuXG4vKipcbiAqIFBSIHN0YXRlIHZhbHVlcyBhY2NlcHRlZCBieSBicmFuY2gta2V5ZWQgYW5kIHRpdGxlLXNlYXJjaCBoZWxwZXJzXG4gKiAoSXNzdWUgIzE3OTUpLiBUaGUgbmFycm93IHVuaW9uIG1pcnJvcnMgdGhlIHZhbHVlcyBgZ2ggcHIgbGlzdFxuICogLS1zdGF0ZWAgYWNjZXB0cy5cbiAqL1xuZXhwb3J0IHR5cGUgUFJTdGF0ZUZpbHRlciA9IFwib3BlblwiIHwgXCJjbG9zZWRcIiB8IFwibWVyZ2VkXCI7XG5cbi8qKlxuICogUFIgc2hhcGUgcmV0dXJuZWQgYnkgdGhlIHRpdGxlLXNlYXJjaCBoZWxwZXIgKElzc3VlICMxNzk1KS4gSW5jbHVkZXNcbiAqIGBtZXJnZWRBdGAgc28gY2FsbGVycyBjYW4gZGlzdGluZ3Vpc2ggY2xvc2VkLW5vdC1tZXJnZWQgZnJvbSBtZXJnZWRcbiAqIFBScyB3aXRob3V0IGFuIGV4dHJhIGBnaCBwciB2aWV3YCBjYWxsLiBgY2xvc2VkQXRgIGxldHMgY2FsbGVycyBhcHBseVxuICogYSBjb29sZG93biB3aW5kb3cgZm9yIGNsb3NlZCBQUnMgKElzc3VlICMxNzk2KS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBUaXRsZVNlYXJjaFBSIHtcbiAgbnVtYmVyOiBudW1iZXI7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGJhc2VSZWZOYW1lOiBzdHJpbmc7XG4gIGhlYWRSZWZOYW1lOiBzdHJpbmc7XG4gIG1lcmdlZEF0OiBzdHJpbmcgfCBudWxsO1xuICBjbG9zZWRBdDogc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIFRoZSBQUiBhdXRob3IncyBsb2dpbiwgb3IgYFwiXCJgIHdoZW4gR2l0SHViIGRpZCBub3QgcmVwb3J0IG9uZVxuICAgKiAoSXNzdWUgIzExMjQpLlxuICAgKlxuICAgKiBBIFBSIHRpdGxlIGlzIHRleHQgYW55Ym9keSB3aG8gY2FuIG9wZW4gYSBQUiBjaG9vc2VzLCBzbyBhIHRpdGxlXG4gICAqIG1hdGNoIG9uIGl0cyBvd24gcHJvdmVzIG5vdGhpbmc7IHRoZSBhdXRob3IgaXMgdGhlIG9ubHlcbiAgICogYXV0aGVudGljYXRlZCBwYXJ0IG9mIHRoZSByb3cuIENvbnN1bWVycyB0aGF0IHRyZWF0IGEgbWF0Y2ggYXNcbiAgICogXCJ0aGUgZmxlZXQgYWxyZWFkeSBoYXMgdGhpcyBpbiBoYW5kXCIgY2hlY2sgdGhpcyBhZ2FpbnN0IHRoZSBmbGVldFxuICAgKiBpZGVudGl0eSBiZWZvcmUgYmVsaWV2aW5nIGl0LlxuICAgKi9cbiAgYXV0aG9yOiBzdHJpbmc7XG4gIC8qKlxuICAgKiBUcnVlIHdoZW4gdGhlIFBSJ3MgaGVhZCBicmFuY2ggbGl2ZXMgaW4gYSBmb3JrIHJhdGhlciB0aGFuIGluIHRoZVxuICAgKiB0YXJnZXQgcmVwb3NpdG9yeSAoSXNzdWUgIzExMjQpLlxuICAgKlxuICAgKiBUaGlzIGlzIHRoZSBoZWFkLWJyYW5jaCBjaGVjay4gUHVzaGluZyB0aGUgaGVhZCBicmFuY2ggaW50byB0aGVcbiAgICogdGFyZ2V0IHJlcG9zaXRvcnkgbmVlZHMgd3JpdGUgYWNjZXNzIHRoZXJlLCBzbyBhIHNhbWUtcmVwb3NpdG9yeVxuICAgKiBoZWFkIGlzIGV2aWRlbmNlIG5vIHVucHJpdmlsZWdlZCBhY2NvdW50IGNvdWxkIG1hbnVmYWN0dXJlOyBhIGZvcmtcbiAgICogaGVhZCBpcyBleGFjdGx5IHdoYXQgYW4gYXR0YWNrZXIgcGxhbnRpbmcgYSBgKCNOKWAgdGl0bGUgb24gYVxuICAgKiBwdWJsaWMgcmVwb3NpdG9yeSBoYXMuIEFic2VudCBmcm9tIGNhY2hlIGVudHJpZXMgd3JpdHRlbiBiZWZvcmVcbiAgICogIzExMjQsIHdoZXJlIGl0IHJlYWRzIGFzIGBmYWxzZWAg4oCUIHRoZSBiZWhhdmlvdXIgdGhvc2UgZW50cmllcyB3ZXJlXG4gICAqIHdyaXR0ZW4gdW5kZXIuXG4gICAqL1xuICBpc0Nyb3NzUmVwb3NpdG9yeTogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBNaW5pbWFsIFBSIHNoYXBlIHJldHVybmVkIGJ5IHRoZSBhbGwtc3RhdGUgYnJhbmNoIGhlbHBlclxuICogKElzc3VlICMxNzk1KS4gUm93cyBhcmUgc2FtZS1yZXBvc2l0b3J5IFBScyBvbmx5IChJc3N1ZSAjMzU5NSk6IHRoZVxuICogZm9yay1oZWFkZWQgb25lcyBhcmUgZHJvcHBlZCBiZWZvcmUgY2FjaGluZywgc28gbm8gcmVhZGVyIG5lZWRzIGFuXG4gKiBgaXNDcm9zc1JlcG9zaXRvcnlgIGZpZWxkLiBDYXJyaWVzIGBudW1iZXJgLCBgdGl0bGVgLCBgaGVhZFJlZk5hbWVgIGFuZCxcbiAqIHdoZW4gdGhlIHJlYWQgcHJvdmlkZWQgaXQsIGBzdGF0ZWAuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQnJhbmNoUFIge1xuICBudW1iZXI6IG51bWJlcjtcbiAgdGl0bGU6IHN0cmluZztcbiAgaGVhZFJlZk5hbWU6IHN0cmluZztcbiAgLyoqXG4gICAqIEdpdEh1YiBQUiBzdGF0ZSAoYE9QRU5gLCBgTUVSR0VEYCwgYENMT1NFRGApIGFzIG9mIHRoZSByZWFkIHRoYXQgZmlsbGVkIHRoZVxuICAgKiBjYWNoZSAoUFIgIzM2NDAgcmV2aWV3KS4gT3B0aW9uYWw6IGEgcm93IGxhY2tzIGl0IHdoZW4gdGhlIGdoIHJlYWQgb21pdHRlZFxuICAgKiBpdCBvciBnYXZlIGEgbm9uLXN0cmluZyBvciBlbXB0eSB2YWx1ZSwgYW5kIGEgcmVhZGVyIG11c3QgdHJlYXQgdGhhdCBhc1xuICAgKiBcInVua25vd25cIiBhbmQgcmVhZCB0aGUgUFIgbGl2ZSByYXRoZXIgdGhhbiBhc3N1bWUgYSBzdGF0ZS5cbiAgICovXG4gIHN0YXRlPzogc3RyaW5nO1xufVxuXG4vKipcbiAqIEZldGNoIG9wZW4vY2xvc2VkL21lcmdlZCBQUnMgd2hvc2UgaGVhZCBicmFuY2ggaXMgYGJyYW5jaE5hbWVgXG4gKiAoSXNzdWUgIzE3OTUpLlxuICpcbiAqIFdyYXBzIGBnaCBwciBsaXN0IC0taGVhZCA8YnJhbmNoPiAtLXN0YXRlIDxzdGF0ZT5gLiBDYWNoZSBrZXkgaXNcbiAqIG5hbWVzcGFjZWQgYnkgYm90aCBicmFuY2ggYW5kIHN0YXRlIHNvIHBlci1icmFuY2ggY2hlY2tzIGFjcm9zc1xuICogZGlmZmVyZW50IHN0YXRlcyBkbyBub3QgY29sbGlkZS4gUGFpciB3aXRoIHRoZSBpdGVyYXRpb24tc2NvcGVkXG4gKiBgSXNzdWVDYWNoZWAgc28gcmVwZWF0ZWQgcGVyLWJyYW5jaCBsb29rdXBzIChlLmcuIGJyYW5jaC1jbGVhbnVwXG4gKiBzY2FucywgUFItbGluayBjaGVja3MpIGNvbGxhcHNlIHRvIG9uZSBuZXR3b3JrIGNhbGwgcGVyXG4gKiAoYnJhbmNoLCBzdGF0ZSkgcGFpci5cbiAqXG4gKiBSZXR1cm5zIGFuIGVtcHR5IGFycmF5IG9uIHBhcnNlIGZhaWx1cmUgcmF0aGVyIHRoYW4gdGhyb3dpbmcgc29cbiAqIGNhbGxlcnMgY2FuIGFwcGx5IGZhaWwtc2FmZSBiZWhhdmlvdXIgbWF0Y2hpbmcgdGhlIGV4aXN0aW5nIGlubGluZVxuICogaW1wbGVtZW50YXRpb25zLiBgdGhyb3dPbkVycm9yYCBsZXRzIGEgc3dlZXAgaGFuZGxlIHJlcXVlc3QgZmFpbHVyZXNcbiAqIGl0c2VsZiwgaW5jbHVkaW5nIHN0b3BwaW5nIGltbWVkaWF0ZWx5IGZvciBhIHJhdGUtbGltaXQgY29vbC1kb3duLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hQUnNCeUJyYW5jaChcbiAgcmVwbzogc3RyaW5nLFxuICBicmFuY2hOYW1lOiBzdHJpbmcsXG4gIHN0YXRlOiBQUlN0YXRlRmlsdGVyLFxuICBjYWNoZT86IElzc3VlQ2FjaGUsXG4gIGdoQ29tbWFuZEZuOiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPiA9IHJ1bkdoQ29tbWFuZCxcbiAgb3B0aW9uczogeyB0aHJvd09uRXJyb3I/OiBib29sZWFuIH0gPSB7fSxcbik6IFByb21pc2U8T3BlblBSW10+IHtcbiAgY29uc3QgY2FjaGVLZXkgPSBgcHJzX2JyYW5jaF8ke3N0YXRlfV8ke2JyYW5jaE5hbWV9YDtcblxuICBpZiAoY2FjaGUpIHtcbiAgICBjb25zdCBjYWNoZWQgPSBhd2FpdCBjYWNoZS5yZWFkPE9wZW5QUltdPihyZXBvLCBjYWNoZUtleSk7XG4gICAgaWYgKGNhY2hlZCkgcmV0dXJuIGNhY2hlZDtcbiAgfVxuXG4gIGxldCBvdXRwdXQ6IHN0cmluZztcbiAgdHJ5IHtcbiAgICBvdXRwdXQgPSBhd2FpdCBnaENvbW1hbmRGbihbXG4gICAgICBcInByXCIsXG4gICAgICBcImxpc3RcIixcbiAgICAgIFwiLS1yZXBvXCIsXG4gICAgICByZXBvLFxuICAgICAgXCItLWhlYWRcIixcbiAgICAgIGJyYW5jaE5hbWUsXG4gICAgICBcIi0tc3RhdGVcIixcbiAgICAgIHN0YXRlLFxuICAgICAgXCItLWpzb25cIixcbiAgICAgIC8vIElzc3VlICMxMjY0OiBvd25lcnNoaXAgZmllbGRzIHRyYXZlbCB3aXRoIGV2ZXJ5IHBlci1icmFuY2ggbGlzdGluZ1xuICAgICAgLy8gc28gYSBjb25zdW1lciB0aGF0IGNsb3NlcyBhIFBSIGNhbiB0ZWxsIGEgZmxlZXQgUFIgb24gdGhpcyByZXBvXG4gICAgICAvLyBmcm9tIGFuIG91dHNpZGVyJ3MgZm9yayBQUiB0aGF0IG1lcmVseSBzaGFyZXMgdGhlIGJyYW5jaCBuYW1lLlxuICAgICAgXCJudW1iZXIsdGl0bGUsYmFzZVJlZk5hbWUsaGVhZFJlZk5hbWUsYXV0aG9yLGhlYWRSZXBvc2l0b3J5T3duZXIsXCIgK1xuICAgICAgXCJpc0Nyb3NzUmVwb3NpdG9yeVwiLFxuICAgICAgXCItLWxpbWl0XCIsXG4gICAgICBcIjUwXCIsXG4gICAgXSk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgaWYgKG9wdGlvbnMudGhyb3dPbkVycm9yKSB0aHJvdyBlcnJvcjtcbiAgICByZXR1cm4gW107XG4gIH1cblxuICBjb25zdCBwcnMgPSBwYXJzZVBSTGlzdEpzb24ob3V0cHV0KTtcbiAgaWYgKGNhY2hlKSBhd2FpdCBjYWNoZS53cml0ZShyZXBvLCBjYWNoZUtleSwgcHJzKTtcbiAgcmV0dXJuIHBycztcbn1cblxuLyoqXG4gKiBGZXRjaCBjbG9zZWQgUFJzIHdob3NlIGhlYWQgYnJhbmNoIGlzIGBicmFuY2hOYW1lYCwgd2l0aCBtZXJnZSBzdGF0ZVxuICogKElzc3VlICMzMTUyKS5cbiAqXG4gKiBgZ2ggcHIgbGlzdCAtLXN0YXRlIGNsb3NlZGAgcmV0dXJucyBCT1RIIGNsb3NlZC1ub3QtbWVyZ2VkIGFuZCBtZXJnZWRcbiAqIFBScywgc28gdGhlIHF1ZXJ5IGluY2x1ZGVzIGBtZXJnZWRBdGAgdG8gbGV0IGNhbGxlcnMgZGlzdGluZ3Vpc2ggdGhlXG4gKiB0d28uIFVzZWQgYnkgdGhlIFBSLWNyZWF0aW9uIHBhdGggdG8gZGV0ZWN0IGEgcHJpb3IgYXR0ZW1wdCdzXG4gKiBjbG9zZWQtdW5tZXJnZWQgUFIgb24gdGhlIGRldGVybWluaXN0aWMgYnJhbmNoIGFuZCByZXVzZSBpdCAocmVvcGVuKVxuICogcmF0aGVyIHRoYW4gb3BlbmluZyBhIGR1cGxpY2F0ZS5cbiAqXG4gKiBDYWNoZSBrZXkgaXMgYHByc19icmFuY2hfY2xvc2VkbWVyZ2VfJHticmFuY2hOYW1lfWAg4oCUIGRpc3RpbmN0IGZyb20gdGhlXG4gKiBzdGF0ZS1rZXllZCBgZmV0Y2hQUnNCeUJyYW5jaGAgY2FjaGUgc28gdGhlIHR3byBuZXZlciBjb2xsaWRlLlxuICpcbiAqIFJldHVybnMgYW4gZW1wdHkgYXJyYXkgb24gcGFyc2UgZmFpbHVyZSByYXRoZXIgdGhhbiB0aHJvd2luZyBzbyBjYWxsZXJzXG4gKiBjYW4gYXBwbHkgZmFpbC1zYWZlIGJlaGF2aW91ci5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoQ2xvc2VkUFJzQnlCcmFuY2goXG4gIHJlcG86IHN0cmluZyxcbiAgYnJhbmNoTmFtZTogc3RyaW5nLFxuICBjYWNoZT86IElzc3VlQ2FjaGUsXG4gIGdoQ29tbWFuZEZuOiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPiA9IHJ1bkdoQ29tbWFuZCxcbik6IFByb21pc2U8Q2xvc2VkUFJXaXRoTWVyZ2VbXT4ge1xuICBpZiAoIWJyYW5jaE5hbWUpIHJldHVybiBbXTtcblxuICBjb25zdCBjYWNoZUtleSA9IGBwcnNfYnJhbmNoX2Nsb3NlZG1lcmdlXyR7YnJhbmNoTmFtZX1gO1xuICBpZiAoY2FjaGUpIHtcbiAgICBjb25zdCBjYWNoZWQgPSBhd2FpdCBjYWNoZS5yZWFkPENsb3NlZFBSV2l0aE1lcmdlW10+KHJlcG8sIGNhY2hlS2V5KTtcbiAgICBpZiAoY2FjaGVkKSByZXR1cm4gY2FjaGVkO1xuICB9XG5cbiAgbGV0IG91dHB1dDogc3RyaW5nO1xuICB0cnkge1xuICAgIG91dHB1dCA9IGF3YWl0IGdoQ29tbWFuZEZuKFtcbiAgICAgIFwicHJcIixcbiAgICAgIFwibGlzdFwiLFxuICAgICAgXCItLXJlcG9cIixcbiAgICAgIHJlcG8sXG4gICAgICBcIi0taGVhZFwiLFxuICAgICAgYnJhbmNoTmFtZSxcbiAgICAgIFwiLS1zdGF0ZVwiLFxuICAgICAgXCJjbG9zZWRcIixcbiAgICAgIFwiLS1qc29uXCIsXG4gICAgICBcIm51bWJlcix0aXRsZSxtZXJnZWRBdCxjbG9zZWRBdFwiLFxuICAgICAgXCItLWxpbWl0XCIsXG4gICAgICBcIjUwXCIsXG4gICAgXSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbXTtcbiAgfVxuXG4gIGxldCBwYXJzZWQ6IHVua25vd247XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gSlNPTi5wYXJzZShvdXRwdXQudHJpbSgpIHx8IFwiW11cIik7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbXTtcbiAgfVxuICBpZiAoIUFycmF5LmlzQXJyYXkocGFyc2VkKSkgcmV0dXJuIFtdO1xuXG4gIGNvbnN0IHByczogQ2xvc2VkUFJXaXRoTWVyZ2VbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGl0ZW0gb2YgcGFyc2VkKSB7XG4gICAgaWYgKCFpc1JlY29yZChpdGVtKSkgY29udGludWU7XG4gICAgaWYgKHR5cGVvZiBpdGVtLm51bWJlciAhPT0gXCJudW1iZXJcIikgY29udGludWU7XG4gICAgcHJzLnB1c2goe1xuICAgICAgbnVtYmVyOiBpdGVtLm51bWJlcixcbiAgICAgIHRpdGxlOiB0eXBlb2YgaXRlbS50aXRsZSA9PT0gXCJzdHJpbmdcIiA/IGl0ZW0udGl0bGUgOiBcIlwiLFxuICAgICAgbWVyZ2VkQXQ6IHR5cGVvZiBpdGVtLm1lcmdlZEF0ID09PSBcInN0cmluZ1wiID8gaXRlbS5tZXJnZWRBdCA6IG51bGwsXG4gICAgICBjbG9zZWRBdDogdHlwZW9mIGl0ZW0uY2xvc2VkQXQgPT09IFwic3RyaW5nXCIgPyBpdGVtLmNsb3NlZEF0IDogbnVsbCxcbiAgICB9KTtcbiAgfVxuXG4gIGlmIChjYWNoZSkgYXdhaXQgY2FjaGUud3JpdGUocmVwbywgY2FjaGVLZXksIHBycyk7XG4gIHJldHVybiBwcnM7XG59XG5cbi8qKlxuICogSW52YWxpZGF0ZSB0aGUgYGZldGNoUFJzQnlCcmFuY2hgIGNhY2hlIGVudHJ5IGZvciBhIGdpdmVuXG4gKiAoYnJhbmNoLCBzdGF0ZSkgcGFpciAoSXNzdWUgIzE3OTUpLiBVc2UgYWZ0ZXIgY3JlYXRpbmcsIGNsb3NpbmcsIG9yXG4gKiBtZXJnaW5nIGEgUFIgZm9yIHRoYXQgYnJhbmNoLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaW52YWxpZGF0ZVBSc0J5QnJhbmNoKFxuICBjYWNoZTogSXNzdWVDYWNoZSxcbiAgcmVwbzogc3RyaW5nLFxuICBicmFuY2hOYW1lOiBzdHJpbmcsXG4gIHN0YXRlOiBQUlN0YXRlRmlsdGVyLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IGNhY2hlLmludmFsaWRhdGUocmVwbywgYHByc19icmFuY2hfJHtzdGF0ZX1fJHticmFuY2hOYW1lfWApO1xufVxuXG4vKipcbiAqIEZldGNoIFBScyBpbiB0aGUgZ2l2ZW4gc3RhdGUgd2hvc2UgdGl0bGUgcmVmZXJlbmNlcyBgaXNzdWVOdW1iZXJgXG4gKiAoSXNzdWUgIzE3OTUpLlxuICpcbiAqIFdyYXBzIHRoZSBzdGFuZGFyZCB3b3JrZXIgdGl0bGUtc2VhcmNoIGV4cHJlc3Npb25cbiAqIGBpbjp0aXRsZSAoI04pIE9SIGluOnRpdGxlIChJc3N1ZSAjTilgIHNvIHBlci1pc3N1ZSBsb29rdXBzIGFjcm9zc1xuICogYHN0dWNrX3JlY292ZXJ5LnRzYCBhbmQgYHN0dWNrX2RldGVjdGlvbi50c2Agc2hhcmUgYSBzaW5nbGUgY2FjaGVkXG4gKiByZXN1bHQgcGVyIChpc3N1ZSwgc3RhdGUpIHBhaXIuIENhY2hlIGtleSBpc1xuICogYHByc190aXRsZV8ke3N0YXRlfV8ke2lzc3VlTnVtYmVyfWAg4oCUIGRpc3RpbmN0IGZyb20gdGhlIHVzZXIta2V5ZWRcbiAqIGBwcnNfJHt1c2VyfWAgc2hhcGUgc28gd29ya2VyLWF1dGhvci1vbmx5IHF1ZXJpZXMgZG8gbm90IHBvbGx1dGVcbiAqIHRoaXMgYWxsLWF1dGhvciBjYWNoZS5cbiAqXG4gKiBSZXR1cm5zIGFuIGVtcHR5IGFycmF5IG9uIHBhcnNlIGZhaWx1cmUgcmF0aGVyIHRoYW4gdGhyb3dpbmcuXG4gKiBgb25VbnJlYWRhYmxlYCBkaXN0aW5ndWlzaGVzIHJlYWQvcGFyc2UgZmFpbHVyZXMgZnJvbSBhIHN1Y2Nlc3NmdWwgZW1wdHlcbiAqIHNlYXJjaCBmb3IgY2FsbGVycyB0aGF0IG11c3Qgbm90IGNhY2hlIGEgdmVyZGljdCBmcm9tIGluY29tcGxldGUgZXZpZGVuY2UuXG4gKlxuICogKipGb3JrLWhlYWRlZCBQUnMgYXJlIGRyb3BwZWQgKElzc3VlICMxMTI0KS4qKiBUaGUgc2VhcmNoIG1hdGNoZXMgYW5cbiAqIGF0dGFja2VyLXdyaXRhYmxlIHRpdGxlIG9uIGEgcHVibGljIHJlcG9zaXRvcnksIGFuZCBldmVyeSBjb25zdW1lciByZWFkc1xuICogYSBtYXRjaCBhcyBcInRoZSBmbGVldCBhbHJlYWR5IGhhcyB0aGlzIGlzc3VlIGluIGhhbmRcIiBhbmQgc3RheXMgcXVpZXQuXG4gKiBUaGUgaGVhZCBicmFuY2ggaXMgdGhlIHBhcnQgb2YgdGhlIHJvdyBub2JvZHkgb3V0c2lkZSB0aGUgcmVwb3NpdG9yeSBjYW5cbiAqIHByb2R1Y2U6IHB1c2hpbmcgaXQgaW50byB0aGUgdGFyZ2V0IHJlcG9zaXRvcnkgbmVlZHMgd3JpdGUgYWNjZXNzLCBzbyBhXG4gKiBzYW1lLXJlcG9zaXRvcnkgaGVhZCBpcyBldmlkZW5jZSBhbmQgYSBmb3JrIGhlYWQgaXMgYSBjbGFpbS4gVGhlIGNsYWltc1xuICogYXJlIGRyb3BwZWQsIGxvdWRseSwgYW5kIHRoZSBhdXRob3IgR2l0SHViIGF1dGhlbnRpY2F0ZWQgaXMgbmFtZWQgaW4gdGhlXG4gKiBsb2cgbGluZSBhbmQga2VwdCBvbiB0aGUgcm93IHNvIGNvbnN1bWVycyBjYW4gY2hlY2sgaXQgdG9vLlxuICpcbiAqIFRoZSBmYWlsIGRpcmVjdGlvbiBpcyB0b3dhcmRzICoqYWN0aW5nKio6IGEgZHJvcHBlZCByb3cgbWVhbnMgXCJubyBQUlxuICogZm91bmRcIiwgc28gdGhlIHdvcmtlciBmaWxlcyBvciByZWNvdmVycy4gQSBkdXBsaWNhdGUgUFIgaXMgcmVjb3ZlcmFibGUgaW5cbiAqIGEgbW9tZW50OyBhbiBpc3N1ZSBzaWxlbnRseSBzdGFydmVkIGJ5IGEgcGxhbnRlZCB0aXRsZSBpcyBub3QuXG4gKlxuICogQHBhcmFtIGxvZyAtIFNpbmsgZm9yIHRoZSBkcm9wcGVkLXJvdyB3YXJuaW5nLiBEZWZhdWx0cyB0byBgY29uc29sZS5lcnJvcmAuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaFBSc0Zvcklzc3VlQnlUaXRsZShcbiAgcmVwbzogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuICBzdGF0ZTogUFJTdGF0ZUZpbHRlcixcbiAgY2FjaGU/OiBJc3N1ZUNhY2hlLFxuICBnaENvbW1hbmRGbjogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz4gPSBydW5HaENvbW1hbmQsXG4gIGxvZzogKG1lc3NhZ2U6IHN0cmluZykgPT4gdm9pZCA9IGNvbnNvbGUuZXJyb3IsXG4gIG9uVW5yZWFkYWJsZT86ICgpID0+IHZvaWQsXG4pOiBQcm9taXNlPFRpdGxlU2VhcmNoUFJbXT4ge1xuICBjb25zdCBjYWNoZUtleSA9IGBwcnNfdGl0bGVfJHtzdGF0ZX1fJHtpc3N1ZU51bWJlcn1gO1xuXG4gIGlmIChjYWNoZSkge1xuICAgIGNvbnN0IGNhY2hlZCA9IGF3YWl0IGNhY2hlLnJlYWQ8VGl0bGVTZWFyY2hQUltdPihyZXBvLCBjYWNoZUtleSk7XG4gICAgaWYgKGNhY2hlZCkgcmV0dXJuIGNhY2hlZDtcbiAgfVxuXG4gIGNvbnN0IHNlYXJjaCA9XG4gICAgYGluOnRpdGxlICgjJHtpc3N1ZU51bWJlcn0pIE9SIGluOnRpdGxlIChJc3N1ZSAjJHtpc3N1ZU51bWJlcn0pYDtcblxuICBsZXQgb3V0cHV0OiBzdHJpbmc7XG4gIHRyeSB7XG4gICAgb3V0cHV0ID0gYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgICAgXCJwclwiLFxuICAgICAgXCJsaXN0XCIsXG4gICAgICBcIi0tcmVwb1wiLFxuICAgICAgcmVwbyxcbiAgICAgIFwiLS1zdGF0ZVwiLFxuICAgICAgc3RhdGUsXG4gICAgICBcIi0tc2VhcmNoXCIsXG4gICAgICBzZWFyY2gsXG4gICAgICBcIi0tanNvblwiLFxuICAgICAgXCJudW1iZXIsdGl0bGUsYmFzZVJlZk5hbWUsaGVhZFJlZk5hbWUsbWVyZ2VkQXQsY2xvc2VkQXQsYXV0aG9yLGlzQ3Jvc3NSZXBvc2l0b3J5XCIsXG4gICAgICBcIi0tbGltaXRcIixcbiAgICAgIFwiNTBcIixcbiAgICBdKTtcbiAgfSBjYXRjaCB7XG4gICAgb25VbnJlYWRhYmxlPy4oKTtcbiAgICByZXR1cm4gW107XG4gIH1cblxuICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICB0cnkge1xuICAgIHBhcnNlZCA9IEpTT04ucGFyc2Uob3V0cHV0LnRyaW0oKSB8fCBcIltdXCIpO1xuICB9IGNhdGNoIHtcbiAgICBvblVucmVhZGFibGU/LigpO1xuICAgIHJldHVybiBbXTtcbiAgfVxuICBpZiAoIUFycmF5LmlzQXJyYXkocGFyc2VkKSkge1xuICAgIG9uVW5yZWFkYWJsZT8uKCk7XG4gICAgcmV0dXJuIFtdO1xuICB9XG5cbiAgY29uc3QgcHJzOiBUaXRsZVNlYXJjaFBSW10gPSBbXTtcbiAgZm9yIChjb25zdCBpdGVtIG9mIHBhcnNlZCkge1xuICAgIGlmICghaXNSZWNvcmQoaXRlbSkpIGNvbnRpbnVlO1xuICAgIGlmICh0eXBlb2YgaXRlbS5udW1iZXIgIT09IFwibnVtYmVyXCIpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGF1dGhvciA9XG4gICAgICBpc1JlY29yZChpdGVtLmF1dGhvcikgJiYgdHlwZW9mIGl0ZW0uYXV0aG9yLmxvZ2luID09PSBcInN0cmluZ1wiXG4gICAgICAgID8gaXRlbS5hdXRob3IubG9naW5cbiAgICAgICAgOiBcIlwiO1xuICAgIGNvbnN0IHRpdGxlID0gdHlwZW9mIGl0ZW0udGl0bGUgPT09IFwic3RyaW5nXCIgPyBpdGVtLnRpdGxlIDogXCJcIjtcbiAgICBjb25zdCBoZWFkUmVmTmFtZSA9IHR5cGVvZiBpdGVtLmhlYWRSZWZOYW1lID09PSBcInN0cmluZ1wiXG4gICAgICA/IGl0ZW0uaGVhZFJlZk5hbWVcbiAgICAgIDogXCJcIjtcbiAgICBpZiAoaXRlbS5pc0Nyb3NzUmVwb3NpdG9yeSA9PT0gdHJ1ZSkge1xuICAgICAgbG9nKFxuICAgICAgICBgW3RpdGxlLXNlYXJjaF0gJHtyZXBvfSMke2lzc3VlTnVtYmVyfTogaWdub3JpbmcgUFIgIyR7aXRlbS5udW1iZXJ9IGAgK1xuICAgICAgICAgIGBieSAke2F1dGhvciB8fCBcImFuIHVua25vd24gYXV0aG9yXCJ9IOKAlCBpdHMgaGVhZCBicmFuY2ggaXMgaW4gYSBgICtcbiAgICAgICAgICBgZm9yaywgc28gdGhlIFwiKCMke2lzc3VlTnVtYmVyfSlcIiB0aXRsZSBpcyBub3QgZXZpZGVuY2UgdGhlIGZsZWV0IGAgK1xuICAgICAgICAgIGBvcGVuZWQgaXQuIFRyZWF0aW5nIHRoZSBpc3N1ZSBhcyBoYXZpbmcgbm8gUFIuYCxcbiAgICAgICk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgLy8gSXNzdWUgIzM0NzY6IEdpdEh1YidzIGBpbjp0aXRsZWAgc2VhcmNoIGNhbiBtYXRjaCBhbiBpc3N1ZSBudW1iZXIgdGhhdFxuICAgIC8vIGFwcGVhcnMgaW5zaWRlIGEgbWlsZXN0b25lIGJyYW5jaCBuYW1lIChlLmcuIGBTeW5jIG1haW4gaW50b1xuICAgIC8vIG1pbGVzdG9uZS80Mi1mb29gKS4gT25seSB0aGUgZmxlZXQncyBvd24gZGVsaW1pdGVkIHRpdGxlIGZvcm0gaXNcbiAgICAvLyBldmlkZW5jZSB0aGUgUFIgZGVsaXZlcnMgdGhpcyBpc3N1ZS5cbiAgICBpZiAoIXByVGl0bGVNYXRjaGVzSXNzdWUodGl0bGUsIGlzc3VlTnVtYmVyKSkge1xuICAgICAgbG9nKFxuICAgICAgICBgW3RpdGxlLXNlYXJjaF0gJHtyZXBvfSMke2lzc3VlTnVtYmVyfTogaWdub3JpbmcgUFIgIyR7aXRlbS5udW1iZXJ9IGAgK1xuICAgICAgICAgIGBcIiR7dGl0bGV9XCIg4oCUIGl0cyB0aXRsZSBkb2VzIG5vdCBjYXJyeSBcIigjJHtpc3N1ZU51bWJlcn0pXCIgb3IgYCArXG4gICAgICAgICAgYFwiKElzc3VlICMke2lzc3VlTnVtYmVyfSlcIiwgc28gaXQgaXMgbm90IHRoaXMgaXNzdWUncyBQUiBgICtcbiAgICAgICAgICBgKElzc3VlICMzNDc2KS5gLFxuICAgICAgKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICAvLyBBIG1pbGVzdG9uZSBzeW5jIFBSIG5ldmVyIGRlbGl2ZXJzIGFuIGluZGl2aWR1YWwgc3ViLWlzc3VlLlxuICAgIGlmIChpc01pbGVzdG9uZVN5bmNCcmFuY2goaGVhZFJlZk5hbWUpKSB7XG4gICAgICBsb2coXG4gICAgICAgIGBbdGl0bGUtc2VhcmNoXSAke3JlcG99IyR7aXNzdWVOdW1iZXJ9OiBpZ25vcmluZyBQUiAjJHtpdGVtLm51bWJlcn0gYCArXG4gICAgICAgICAgYFwiJHt0aXRsZX1cIiDigJQgaXRzIGhlYWQgJyR7aGVhZFJlZk5hbWV9JyBpcyBhIG1pbGVzdG9uZSBzeW5jIGJyYW5jaCBgICtcbiAgICAgICAgICBgKElzc3VlICMzNDc2KS5gLFxuICAgICAgKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBwcnMucHVzaCh7XG4gICAgICBudW1iZXI6IGl0ZW0ubnVtYmVyLFxuICAgICAgdGl0bGUsXG4gICAgICBiYXNlUmVmTmFtZTogdHlwZW9mIGl0ZW0uYmFzZVJlZk5hbWUgPT09IFwic3RyaW5nXCIgPyBpdGVtLmJhc2VSZWZOYW1lIDogXCJcIixcbiAgICAgIGhlYWRSZWZOYW1lLFxuICAgICAgbWVyZ2VkQXQ6IHR5cGVvZiBpdGVtLm1lcmdlZEF0ID09PSBcInN0cmluZ1wiID8gaXRlbS5tZXJnZWRBdCA6IG51bGwsXG4gICAgICBjbG9zZWRBdDogdHlwZW9mIGl0ZW0uY2xvc2VkQXQgPT09IFwic3RyaW5nXCIgPyBpdGVtLmNsb3NlZEF0IDogbnVsbCxcbiAgICAgIGF1dGhvcixcbiAgICAgIGlzQ3Jvc3NSZXBvc2l0b3J5OiBmYWxzZSxcbiAgICB9KTtcbiAgfVxuXG4gIGlmIChjYWNoZSkgYXdhaXQgY2FjaGUud3JpdGUocmVwbywgY2FjaGVLZXksIHBycyk7XG4gIHJldHVybiBwcnM7XG59XG5cbi8qKlxuICogRmluZCBtZXJnZWQgUFJzIHdob3NlIHNhbWUtcmVwb3NpdG9yeSBpc3N1ZSBicmFuY2ggbmFtZXMgYGlzc3VlTnVtYmVyYC5cbiAqXG4gKiBUaGlzIGlzIGEgc2VwYXJhdGUgcmVjb3ZlcnkgbG9va3VwIGZvciBhZG9wdGVkIFBScyB3aG9zZSB0aXRsZSBwcmVkYXRlc1xuICogY2Fub25pY2FsIGlzc3VlLXRpdGxlIHJlcGFpci4gR2l0SHViJ3MgYGhlYWQ6aXNzdWUtTmAgc2VhcmNoIG1hdGNoZXMgdGhlXG4gKiBpc3N1ZSBicmFuY2ggcHJlZml4OyB0aGUgcmV0dXJuZWQgaGVhZCBpcyBwYXJzZWQgYWdhaW4gc28gYGlzc3VlLTQyYCBuZXZlclxuICogY2xhaW1zIGlzc3VlIDQyMC4gRm9yayBoZWFkcyBhbmQgcm93cyB3aXRob3V0IGEgbWVyZ2UgdGltZXN0YW1wIGFyZSBpZ25vcmVkLlxuICogVGhlIHRpdGxlLXNlYXJjaCBjb250cmFjdCByZW1haW5zIGxpbWl0ZWQgdG8gY2Fub25pY2FsIHRpdGxlIHJlZmVyZW5jZXMuXG4gKiBTdWNjZXNzZnVsIHJlc3VsdHMsIGluY2x1ZGluZyBlbXB0eSBsaXN0cywgdXNlIHRoZSBpc3N1ZSBjYWNoZSdzIFRUTDtcbiAqIHVucmVhZGFibGUgc2VhcmNoZXMgYXJlIG5vdCBjYWNoZWQgc28gdGhlIG5leHQgc2NhbiByZXRyaWVzIHRoZW0uXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaE1lcmdlZFBSc0J5SXNzdWVCcmFuY2goXG4gIHJlcG86IHN0cmluZyxcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbiAgZ2hDb21tYW5kRm46IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+ID0gcnVuR2hDb21tYW5kLFxuICBjYWNoZT86IElzc3VlQ2FjaGUsXG4pOiBQcm9taXNlPFRpdGxlU2VhcmNoUFJbXSB8IG51bGw+IHtcbiAgY29uc3QgY2FjaGVLZXkgPSBgcHJzX2JyYW5jaF9tZXJnZWRfaXNzdWVfJHtpc3N1ZU51bWJlcn1gO1xuICBpZiAoY2FjaGUpIHtcbiAgICBjb25zdCBjYWNoZWQgPSBhd2FpdCBjYWNoZS5yZWFkPFRpdGxlU2VhcmNoUFJbXT4ocmVwbywgY2FjaGVLZXkpO1xuICAgIGlmIChjYWNoZWQpIHJldHVybiBjYWNoZWQ7XG4gIH1cbiAgbGV0IG91dHB1dDogc3RyaW5nO1xuICB0cnkge1xuICAgIG91dHB1dCA9IGF3YWl0IGdoQ29tbWFuZEZuKFtcbiAgICAgIFwicHJcIixcbiAgICAgIFwibGlzdFwiLFxuICAgICAgXCItLXJlcG9cIixcbiAgICAgIHJlcG8sXG4gICAgICBcIi0tc3RhdGVcIixcbiAgICAgIFwibWVyZ2VkXCIsXG4gICAgICBcIi0tc2VhcmNoXCIsXG4gICAgICBgaGVhZDppc3N1ZS0ke2lzc3VlTnVtYmVyfWAsXG4gICAgICBcIi0tanNvblwiLFxuICAgICAgXCJudW1iZXIsdGl0bGUsYmFzZVJlZk5hbWUsaGVhZFJlZk5hbWUsbWVyZ2VkQXQsY2xvc2VkQXQsYXV0aG9yLGlzQ3Jvc3NSZXBvc2l0b3J5XCIsXG4gICAgICBcIi0tbGltaXRcIixcbiAgICAgIFwiMTAwMFwiLFxuICAgIF0pO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIGxldCBwYXJzZWQ6IHVua25vd247XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gSlNPTi5wYXJzZShvdXRwdXQudHJpbSgpKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgaWYgKCFBcnJheS5pc0FycmF5KHBhcnNlZCkpIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IHByczogVGl0bGVTZWFyY2hQUltdID0gW107XG4gIGZvciAoY29uc3QgaXRlbSBvZiBwYXJzZWQpIHtcbiAgICBpZiAoXG4gICAgICAhaXNSZWNvcmQoaXRlbSkgfHwgdHlwZW9mIGl0ZW0ubnVtYmVyICE9PSBcIm51bWJlclwiIHx8XG4gICAgICBpdGVtLmlzQ3Jvc3NSZXBvc2l0b3J5ICE9PSBmYWxzZSB8fFxuICAgICAgdHlwZW9mIGl0ZW0uaGVhZFJlZk5hbWUgIT09IFwic3RyaW5nXCIgfHxcbiAgICAgIGlzc3VlTnVtYmVyRnJvbUJyYW5jaChpdGVtLmhlYWRSZWZOYW1lKSAhPT0gaXNzdWVOdW1iZXIgfHxcbiAgICAgIHR5cGVvZiBpdGVtLm1lcmdlZEF0ICE9PSBcInN0cmluZ1wiIHx8IGl0ZW0ubWVyZ2VkQXQubGVuZ3RoID09PSAwXG4gICAgKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgcHJzLnB1c2goe1xuICAgICAgbnVtYmVyOiBpdGVtLm51bWJlcixcbiAgICAgIHRpdGxlOiB0eXBlb2YgaXRlbS50aXRsZSA9PT0gXCJzdHJpbmdcIiA/IGl0ZW0udGl0bGUgOiBcIlwiLFxuICAgICAgYmFzZVJlZk5hbWU6IHR5cGVvZiBpdGVtLmJhc2VSZWZOYW1lID09PSBcInN0cmluZ1wiID8gaXRlbS5iYXNlUmVmTmFtZSA6IFwiXCIsXG4gICAgICBoZWFkUmVmTmFtZTogaXRlbS5oZWFkUmVmTmFtZSxcbiAgICAgIG1lcmdlZEF0OiBpdGVtLm1lcmdlZEF0LFxuICAgICAgY2xvc2VkQXQ6IHR5cGVvZiBpdGVtLmNsb3NlZEF0ID09PSBcInN0cmluZ1wiID8gaXRlbS5jbG9zZWRBdCA6IG51bGwsXG4gICAgICBhdXRob3I6IGlzUmVjb3JkKGl0ZW0uYXV0aG9yKSAmJiB0eXBlb2YgaXRlbS5hdXRob3IubG9naW4gPT09IFwic3RyaW5nXCJcbiAgICAgICAgPyBpdGVtLmF1dGhvci5sb2dpblxuICAgICAgICA6IFwiXCIsXG4gICAgICBpc0Nyb3NzUmVwb3NpdG9yeTogZmFsc2UsXG4gICAgfSk7XG4gIH1cbiAgaWYgKGNhY2hlKSBhd2FpdCBjYWNoZS53cml0ZShyZXBvLCBjYWNoZUtleSwgcHJzKTtcbiAgcmV0dXJuIHBycztcbn1cblxuLyoqXG4gKiBJbnZhbGlkYXRlIHRoZSBgZmV0Y2hQUnNGb3JJc3N1ZUJ5VGl0bGVgIGNhY2hlIGVudHJ5IGZvciBhIGdpdmVuXG4gKiAoaXNzdWUsIHN0YXRlKSBwYWlyIChJc3N1ZSAjMTc5NSkuIFVzZSBhZnRlciBjcmVhdGluZywgY2xvc2luZywgb3JcbiAqIG1lcmdpbmcgYSBQUiBsaW5rZWQgdG8gdGhhdCBpc3N1ZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGludmFsaWRhdGVQUnNGb3JJc3N1ZUJ5VGl0bGUoXG4gIGNhY2hlOiBJc3N1ZUNhY2hlLFxuICByZXBvOiBzdHJpbmcsXG4gIGlzc3VlTnVtYmVyOiBudW1iZXIsXG4gIHN0YXRlOiBQUlN0YXRlRmlsdGVyLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IGNhY2hlLmludmFsaWRhdGUocmVwbywgYHByc190aXRsZV8ke3N0YXRlfV8ke2lzc3VlTnVtYmVyfWApO1xufVxuXG4vKiogQ2FjaGUga2V5IGZvciB0aGUgYWxsLXN0YXRlIGJyYW5jaCBsb29rdXA7IGB2MmAgcmV0aXJlcyBwcmUtIzM1OTUgZW50cmllcy4gKi9cbmZ1bmN0aW9uIGFsbFN0YXRlQnJhbmNoQ2FjaGVLZXkoYnJhbmNoTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBwcnNfYWxsX2JyYW5jaF92Ml8ke2JyYW5jaE5hbWV9YDtcbn1cblxuLyoqXG4gKiBGZXRjaCBhbGwtc3RhdGUgUFJzIHdob3NlIGhlYWQgYnJhbmNoIGlzIGBicmFuY2hOYW1lYCAoSXNzdWUgIzE3OTUpLlxuICpcbiAqIFdyYXBzIGBnaCBwciBsaXN0IC0tc3RhdGUgYWxsIC0taGVhZCA8YnJhbmNoPiAtLWxpbWl0IDEwMGAuIFVzZWQgYnlcbiAqIGBoYXNFeGlzdGluZ01pbGVzdG9uZVN1bW1hcnlQcmAgKGBtaWxlc3RvbmVfY29tcGxldGlvbi50c2ApIHdoaWNoXG4gKiBuZWVkcyB0byBkZXRlY3QgYSBQUiBmb3IgdGhlIG1pbGVzdG9uZSBicmFuY2ggaW4gYW55IHN0YXRlIHRvIGF2b2lkXG4gKiByZWNyZWF0aW5nIG9uZS4gQ2FjaGUga2V5IGlzIGBwcnNfYWxsX2JyYW5jaF92Ml8ke2JyYW5jaE5hbWV9YCDigJRcbiAqIGRpc3RpbmN0IGZyb20gdGhlIHBlci1zdGF0ZSBicmFuY2ggaGVscGVyIHNvIGFuIGFsbC1zdGF0ZSBsb29rdXBcbiAqIGRvZXMgbm90IHBvaXNvbiBvciBnZXQgcG9pc29uZWQgYnkgc2luZ2xlLXN0YXRlIGNhY2hlcy5cbiAqXG4gKiBPbmx5IHNhbWUtcmVwb3NpdG9yeSBQUnMgYXJlIHJldHVybmVkIChJc3N1ZSAjMzU5NSk6XG4gKiBgZ2ggcHIgbGlzdCAtLWhlYWRgIG1hdGNoZXMgdGhlIHJlZiBuYW1lIGFsb25lLCBzbyBhIFBSIGZyb20gYSBmb3JrIHdob3NlXG4gKiBicmFuY2ggcmV1c2VzIGBicmFuY2hOYW1lYCBpcyBsaXN0ZWQgdG9vLCBhbmQgYSBmb3JrLWhlYWRlZCBQUiBwcm92ZXNcbiAqIG5vdGhpbmcgYWJvdXQgdGhpcyByZXBvc2l0b3J5J3MgYnJhbmNoLiBBIHJvdyB3aG9zZSBgaXNDcm9zc1JlcG9zaXRvcnlgIGlzXG4gKiBub3QgZXhhY3RseSBgZmFsc2VgIGlzIGRyb3BwZWQuIFRoZSBgdjJgIGtleSBtZWFucyBhbiBlbnRyeSB3cml0dGVuIHVuZGVyXG4gKiB0aGUgb2xkIGBwcnNfYWxsX2JyYW5jaF8ke2JyYW5jaE5hbWV9YCBrZXksIHdoaWNoIG1heSBob2xkIGZvcmstaGVhZGVkIHJvd3MsXG4gKiBpcyBuZXZlciByZWFkLlxuICpcbiAqIEVhY2ggcm93IGNhcnJpZXMgdGhlIFBSIGBzdGF0ZWAgd2hlbiB0aGUgcmVhZCBwcm92aWRlZCBpdCAoUFIgIzM2NDBcbiAqIHJldmlldyksIHNvIGEgY2FsbGVyIGNhbiBkcm9wIG5vbi1vcGVuIFBScyB3aXRob3V0IGEgcGVyLVBSIHJlYWQ7IGEgcm93XG4gKiBoYXMgbm9uZSB3aGVuIHRoZSBnaCByZWFkIG9taXR0ZWQgaXQgb3IgZ2F2ZSBhIG5vbi1zdHJpbmcgb3IgZW1wdHkgdmFsdWUuIFRoZSBzdGF0ZSBpcyBhcyBvZlxuICogdGhlIGNhY2hlZCByZWFkLCBzbyBhIGNhbGxlciB0aGF0IGFjdHMgb24gYSBQUiBzdGlsbCBjb25maXJtcyBpdCBsaXZlLlxuICpcbiAqIFJldHVybnMgYW4gZW1wdHkgYXJyYXkgb24gcGFyc2UgZmFpbHVyZSByYXRoZXIgdGhhbiB0aHJvd2luZy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoQWxsU3RhdGVQUnNCeUJyYW5jaChcbiAgcmVwbzogc3RyaW5nLFxuICBicmFuY2hOYW1lOiBzdHJpbmcsXG4gIGNhY2hlPzogSXNzdWVDYWNoZSxcbiAgZ2hDb21tYW5kRm46IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+ID0gcnVuR2hDb21tYW5kLFxuKTogUHJvbWlzZTxCcmFuY2hQUltdPiB7XG4gIGNvbnN0IGNhY2hlS2V5ID0gYWxsU3RhdGVCcmFuY2hDYWNoZUtleShicmFuY2hOYW1lKTtcblxuICBpZiAoY2FjaGUpIHtcbiAgICBjb25zdCBjYWNoZWQgPSBhd2FpdCBjYWNoZS5yZWFkPEJyYW5jaFBSW10+KHJlcG8sIGNhY2hlS2V5KTtcbiAgICBpZiAoY2FjaGVkKSByZXR1cm4gY2FjaGVkO1xuICB9XG5cbiAgbGV0IG91dHB1dDogc3RyaW5nO1xuICB0cnkge1xuICAgIG91dHB1dCA9IGF3YWl0IGdoQ29tbWFuZEZuKFtcbiAgICAgIFwicHJcIixcbiAgICAgIFwibGlzdFwiLFxuICAgICAgXCItLXJlcG9cIixcbiAgICAgIHJlcG8sXG4gICAgICBcIi0tc3RhdGVcIixcbiAgICAgIFwiYWxsXCIsXG4gICAgICBcIi0taGVhZFwiLFxuICAgICAgYnJhbmNoTmFtZSxcbiAgICAgIFwiLS1qc29uXCIsXG4gICAgICBcIm51bWJlcix0aXRsZSxoZWFkUmVmTmFtZSxzdGF0ZSxpc0Nyb3NzUmVwb3NpdG9yeVwiLFxuICAgICAgXCItLWxpbWl0XCIsXG4gICAgICBcIjEwMFwiLFxuICAgIF0pO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gW107XG4gIH1cblxuICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICB0cnkge1xuICAgIHBhcnNlZCA9IEpTT04ucGFyc2Uob3V0cHV0LnRyaW0oKSB8fCBcIltdXCIpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gW107XG4gIH1cbiAgaWYgKCFBcnJheS5pc0FycmF5KHBhcnNlZCkpIHJldHVybiBbXTtcblxuICBjb25zdCBwcnM6IEJyYW5jaFBSW10gPSBbXTtcbiAgZm9yIChjb25zdCBpdGVtIG9mIHBhcnNlZCkge1xuICAgIGlmICghaXNSZWNvcmQoaXRlbSkpIGNvbnRpbnVlO1xuICAgIGlmICh0eXBlb2YgaXRlbS5udW1iZXIgIT09IFwibnVtYmVyXCIpIGNvbnRpbnVlO1xuICAgIC8vIElzc3VlICMzNTk1OiBhIGZvcmstaGVhZGVkIFBSIHByb3ZlcyBub3RoaW5nOyBrZWVwIG9ubHkgYGZhbHNlYC5cbiAgICBpZiAoaXRlbS5pc0Nyb3NzUmVwb3NpdG9yeSAhPT0gZmFsc2UpIGNvbnRpbnVlO1xuICAgIHBycy5wdXNoKHtcbiAgICAgIG51bWJlcjogaXRlbS5udW1iZXIsXG4gICAgICB0aXRsZTogdHlwZW9mIGl0ZW0udGl0bGUgPT09IFwic3RyaW5nXCIgPyBpdGVtLnRpdGxlIDogXCJcIixcbiAgICAgIGhlYWRSZWZOYW1lOiB0eXBlb2YgaXRlbS5oZWFkUmVmTmFtZSA9PT0gXCJzdHJpbmdcIiA/IGl0ZW0uaGVhZFJlZk5hbWUgOiBcIlwiLFxuICAgICAgLi4uKHR5cGVvZiBpdGVtLnN0YXRlID09PSBcInN0cmluZ1wiICYmIGl0ZW0uc3RhdGUgIT09IFwiXCJcbiAgICAgICAgPyB7IHN0YXRlOiBpdGVtLnN0YXRlIH1cbiAgICAgICAgOiB7fSksXG4gICAgfSk7XG4gIH1cblxuICBpZiAoY2FjaGUpIGF3YWl0IGNhY2hlLndyaXRlKHJlcG8sIGNhY2hlS2V5LCBwcnMpO1xuICByZXR1cm4gcHJzO1xufVxuXG4vKipcbiAqIEludmFsaWRhdGUgdGhlIGBmZXRjaEFsbFN0YXRlUFJzQnlCcmFuY2hgIGNhY2hlIGVudHJ5IGZvciB0aGUgZ2l2ZW5cbiAqIGJyYW5jaCAoSXNzdWUgIzE3OTUpLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaW52YWxpZGF0ZUFsbFN0YXRlUFJzQnlCcmFuY2goXG4gIGNhY2hlOiBJc3N1ZUNhY2hlLFxuICByZXBvOiBzdHJpbmcsXG4gIGJyYW5jaE5hbWU6IHN0cmluZyxcbik6IFByb21pc2U8dm9pZD4ge1xuICBhd2FpdCBjYWNoZS5pbnZhbGlkYXRlKHJlcG8sIGFsbFN0YXRlQnJhbmNoQ2FjaGVLZXkoYnJhbmNoTmFtZSkpO1xufVxuXG4vKipcbiAqIE9uZSByb3cgb2Yge0BsaW5rIGZldGNoQWxsU3RhdGVJc3N1ZXNCeU1pbGVzdG9uZX0uXG4gKlxuICogYGJvZHlgIGFuZCBgYXV0aG9yYCBhcmUgY2FycmllZCBzbyBgbWlsZXN0b25lX2NvbXBsZXRpb24udHNgIGNhbiBwcm92ZSBhXG4gKiB0cmFja2luZy1zaGFwZWQgaXNzdWUgaXMgdGhlIGZsZWV0J3Mgb3duIHRyYWNrZXIgYmVmb3JlIGFkb3B0aW5nIGl0XG4gKiAoSXNzdWUgIzEyNDYpLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFsbFN0YXRlTWlsZXN0b25lSXNzdWUge1xuICBudW1iZXI6IG51bWJlcjtcbiAgdGl0bGU6IHN0cmluZztcbiAgYm9keTogc3RyaW5nO1xuICBhdXRob3I6IHN0cmluZztcbn1cblxuLyoqXG4gKiBGZXRjaCBhbGwtc3RhdGUgaXNzdWVzIGZvciBhIGdpdmVuIG1pbGVzdG9uZSBudW1iZXIgKElzc3VlICMxNzk1KS5cbiAqXG4gKiBXcmFwcyBgZ2ggaXNzdWUgbGlzdCAtLW1pbGVzdG9uZSA8bnVtYmVyPiAtLXN0YXRlIGFsbGAuIFVzZWQgYnlcbiAqIGBoYXNFeGlzdGluZ01pbGVzdG9uZVRyYWNraW5nSXNzdWVgIChgbWlsZXN0b25lX2NvbXBsZXRpb24udHNgKSBzb1xuICogdGhlIHdvcmtlciBjYW4gZGV0ZWN0IGFuIGV4aXN0aW5nIHRyYWNraW5nIGlzc3VlIHdpdGhvdXQgcmUtaXNzdWluZ1xuICogYSBnbG9iYWwgdGl0bGUtc2VhcmNoIHBlciBzY2FuLiBDYWNoZSBrZXkgaXNcbiAqIGBpc3N1ZXNfYWxsX21pbGVzdG9uZV92Ml8ke21pbGVzdG9uZU51bWJlcn1gLlxuICpcbiAqIFJldHVybnMgYW4gZW1wdHkgYXJyYXkgb24gcGFyc2UgZmFpbHVyZSByYXRoZXIgdGhhbiB0aHJvd2luZy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoQWxsU3RhdGVJc3N1ZXNCeU1pbGVzdG9uZShcbiAgcmVwbzogc3RyaW5nLFxuICBtaWxlc3RvbmVOdW1iZXI6IG51bWJlcixcbiAgY2FjaGU/OiBJc3N1ZUNhY2hlLFxuICBnaENvbW1hbmRGbjogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz4gPSBydW5HaENvbW1hbmQsXG4pOiBQcm9taXNlPEFsbFN0YXRlTWlsZXN0b25lSXNzdWVbXT4ge1xuICAvLyBJc3N1ZSAjMTI0NjogdGhlIGNhY2hlIGtleSBjYXJyaWVzIHRoZSBwYXlsb2FkIHNoYXBlLiBUaGUgcHJlLSMxMjQ2XG4gIC8vIGVudHJpZXMgaG9sZCBvbmx5IGBudW1iZXJgL2B0aXRsZWAsIGFuZCBhIHRyYWNrZXIgcmVhZCBiYWNrIHdpdGhvdXQgaXRzXG4gIC8vIGJvZHkgYW5kIGF1dGhvciBjYW5ub3QgYmUgdmVyaWZpZWQg4oCUIHdoaWNoIHdvdWxkIG1ha2UgdGhlIHdvcmtlciBmaWxlIGFcbiAgLy8gZHVwbGljYXRlIHRyYWNrZXIgdW50aWwgdGhlIG9sZCBlbnRyeSBleHBpcmVkLlxuICBjb25zdCBjYWNoZUtleSA9IGBpc3N1ZXNfYWxsX21pbGVzdG9uZV92Ml8ke21pbGVzdG9uZU51bWJlcn1gO1xuXG4gIGlmIChjYWNoZSkge1xuICAgIGNvbnN0IGNhY2hlZCA9IGF3YWl0IGNhY2hlLnJlYWQ8QWxsU3RhdGVNaWxlc3RvbmVJc3N1ZVtdPihyZXBvLCBjYWNoZUtleSk7XG4gICAgaWYgKGNhY2hlZCkgcmV0dXJuIGNhY2hlZDtcbiAgfVxuXG4gIGxldCBvdXRwdXQ6IHN0cmluZztcbiAgdHJ5IHtcbiAgICBvdXRwdXQgPSBhd2FpdCBnaENvbW1hbmRGbihbXG4gICAgICBcImlzc3VlXCIsXG4gICAgICBcImxpc3RcIixcbiAgICAgIFwiLS1yZXBvXCIsXG4gICAgICByZXBvLFxuICAgICAgXCItLW1pbGVzdG9uZVwiLFxuICAgICAgU3RyaW5nKG1pbGVzdG9uZU51bWJlciksXG4gICAgICBcIi0tc3RhdGVcIixcbiAgICAgIFwiYWxsXCIsXG4gICAgICBcIi0tanNvblwiLFxuICAgICAgLy8gSXNzdWUgIzEyNDY6IGBib2R5YCBhbmQgYGF1dGhvcmAgYXJlIHRoZSBhdXRoZW50aWNhdGVkIGV2aWRlbmNlIHRoYXRcbiAgICAgIC8vIGEgdHJhY2tpbmctc2hhcGVkIGlzc3VlIHJlYWxseSBpcyB0aGUgZmxlZXQncyBvd24gdHJhY2tlci5cbiAgICAgIFwibnVtYmVyLHRpdGxlLGJvZHksYXV0aG9yXCIsXG4gICAgICBcIi0tbGltaXRcIixcbiAgICAgIFwiMTAwXCIsXG4gICAgXSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbXTtcbiAgfVxuXG4gIGxldCBwYXJzZWQ6IHVua25vd247XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gSlNPTi5wYXJzZShvdXRwdXQudHJpbSgpIHx8IFwiW11cIik7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbXTtcbiAgfVxuICBpZiAoIUFycmF5LmlzQXJyYXkocGFyc2VkKSkgcmV0dXJuIFtdO1xuXG4gIGNvbnN0IGlzc3VlczogQWxsU3RhdGVNaWxlc3RvbmVJc3N1ZVtdID0gW107XG4gIGZvciAoY29uc3QgaXRlbSBvZiBwYXJzZWQpIHtcbiAgICBpZiAoIWlzUmVjb3JkKGl0ZW0pKSBjb250aW51ZTtcbiAgICBpZiAodHlwZW9mIGl0ZW0ubnVtYmVyICE9PSBcIm51bWJlclwiKSBjb250aW51ZTtcbiAgICBjb25zdCBhdXRob3IgPSBpdGVtLmF1dGhvcjtcbiAgICBpc3N1ZXMucHVzaCh7XG4gICAgICBudW1iZXI6IGl0ZW0ubnVtYmVyLFxuICAgICAgdGl0bGU6IHR5cGVvZiBpdGVtLnRpdGxlID09PSBcInN0cmluZ1wiID8gaXRlbS50aXRsZSA6IFwiXCIsXG4gICAgICBib2R5OiB0eXBlb2YgaXRlbS5ib2R5ID09PSBcInN0cmluZ1wiID8gaXRlbS5ib2R5IDogXCJcIixcbiAgICAgIGF1dGhvcjogaXNSZWNvcmQoYXV0aG9yKSAmJiB0eXBlb2YgYXV0aG9yLmxvZ2luID09PSBcInN0cmluZ1wiXG4gICAgICAgID8gYXV0aG9yLmxvZ2luXG4gICAgICAgIDogXCJcIixcbiAgICB9KTtcbiAgfVxuXG4gIGlmIChjYWNoZSkgYXdhaXQgY2FjaGUud3JpdGUocmVwbywgY2FjaGVLZXksIGlzc3Vlcyk7XG4gIHJldHVybiBpc3N1ZXM7XG59XG5cbi8qKlxuICogSW52YWxpZGF0ZSB0aGUgYGZldGNoQWxsU3RhdGVJc3N1ZXNCeU1pbGVzdG9uZWAgY2FjaGUgZW50cnkgZm9yIHRoZVxuICogZ2l2ZW4gbWlsZXN0b25lIG51bWJlciAoSXNzdWUgIzE3OTUpLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaW52YWxpZGF0ZUFsbFN0YXRlSXNzdWVzQnlNaWxlc3RvbmUoXG4gIGNhY2hlOiBJc3N1ZUNhY2hlLFxuICByZXBvOiBzdHJpbmcsXG4gIG1pbGVzdG9uZU51bWJlcjogbnVtYmVyLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IGNhY2hlLmludmFsaWRhdGUocmVwbywgYGlzc3Vlc19hbGxfbWlsZXN0b25lX3YyXyR7bWlsZXN0b25lTnVtYmVyfWApO1xufVxuXG4vKipcbiAqIFJlY2VudCBtZXJnZWQgUFIgd2l0aCBmaWxlLWNoYW5nZSBjb3VudCAoSXNzdWUgIzE3OTkpLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFJlY2VudE1lcmdlZFBSIHtcbiAgbnVtYmVyOiBudW1iZXI7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGNoYW5nZWRGaWxlczogbnVtYmVyO1xufVxuXG4vKipcbiAqIEZldGNoIHJlY2VudCBtZXJnZWQgUFJzIGFjcm9zcyBhbGwgYXV0aG9ycyAoSXNzdWUgIzE3OTkpLlxuICpcbiAqIFVzZWQgYnkgYHJlY2VudF9hY3Rpdml0eS50c2AgdG8gc3VtbWFyaXNlIHJlY2VudCByZXBvc2l0b3J5IGFjdGl2aXR5XG4gKiBmb3IgcHJvbXB0IGNvbnRleHQuIENhY2hlIGtleSBpcyBgcHJzX3JlY2VudF9tZXJnZWRfJHtsaW1pdH1gIHNvXG4gKiBkaWZmZXJlbnQgbGltaXRzIGRvIG5vdCBjb2xsaWRlLiBDYWNoZSBUVEwgaW5oZXJpdHMgZnJvbSB0aGUgc3VwcGxpZWRcbiAqIGBJc3N1ZUNhY2hlYCBpbnN0YW5jZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoUmVjZW50TWVyZ2VkUFJzKFxuICByZXBvOiBzdHJpbmcsXG4gIGxpbWl0ID0gMTAsXG4gIGNhY2hlPzogSXNzdWVDYWNoZSxcbiAgZ2hDb21tYW5kRm46IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+ID0gcnVuR2hDb21tYW5kLFxuKTogUHJvbWlzZTxSZWNlbnRNZXJnZWRQUltdPiB7XG4gIGNvbnN0IGNhY2hlS2V5ID0gYHByc19yZWNlbnRfbWVyZ2VkXyR7bGltaXR9YDtcblxuICBpZiAoY2FjaGUpIHtcbiAgICBjb25zdCBjYWNoZWQgPSBhd2FpdCBjYWNoZS5yZWFkPFJlY2VudE1lcmdlZFBSW10+KHJlcG8sIGNhY2hlS2V5KTtcbiAgICBpZiAoY2FjaGVkKSByZXR1cm4gY2FjaGVkO1xuICB9XG5cbiAgY29uc3Qgb3V0cHV0ID0gYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgIFwicHJcIixcbiAgICBcImxpc3RcIixcbiAgICBcIi0tcmVwb1wiLFxuICAgIHJlcG8sXG4gICAgXCItLXN0YXRlXCIsXG4gICAgXCJtZXJnZWRcIixcbiAgICBcIi0tanNvblwiLFxuICAgIFwibnVtYmVyLHRpdGxlLGNoYW5nZWRGaWxlc1wiLFxuICAgIFwiLS1saW1pdFwiLFxuICAgIFN0cmluZyhsaW1pdCksXG4gIF0pO1xuXG4gIGxldCBwYXJzZWQ6IHVua25vd247XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gSlNPTi5wYXJzZShvdXRwdXQudHJpbSgpIHx8IFwiW11cIik7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbXTtcbiAgfVxuICBpZiAoIUFycmF5LmlzQXJyYXkocGFyc2VkKSkgcmV0dXJuIFtdO1xuXG4gIGNvbnN0IHByczogUmVjZW50TWVyZ2VkUFJbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGl0ZW0gb2YgcGFyc2VkKSB7XG4gICAgaWYgKCFpc1JlY29yZChpdGVtKSkgY29udGludWU7XG4gICAgaWYgKHR5cGVvZiBpdGVtLm51bWJlciAhPT0gXCJudW1iZXJcIikgY29udGludWU7XG4gICAgcHJzLnB1c2goe1xuICAgICAgbnVtYmVyOiBpdGVtLm51bWJlcixcbiAgICAgIHRpdGxlOiB0eXBlb2YgaXRlbS50aXRsZSA9PT0gXCJzdHJpbmdcIiA/IGl0ZW0udGl0bGUgOiBcIlwiLFxuICAgICAgY2hhbmdlZEZpbGVzOiB0eXBlb2YgaXRlbS5jaGFuZ2VkRmlsZXMgPT09IFwibnVtYmVyXCJcbiAgICAgICAgPyBpdGVtLmNoYW5nZWRGaWxlc1xuICAgICAgICA6IDAsXG4gICAgfSk7XG4gIH1cblxuICBpZiAoY2FjaGUpIGF3YWl0IGNhY2hlLndyaXRlKHJlcG8sIGNhY2hlS2V5LCBwcnMpO1xuICByZXR1cm4gcHJzO1xufVxuXG4vKipcbiAqIGBnaCBwciBsaXN0YCB3aXRob3V0IGAtLXNlYXJjaGAgb3JkZXJzIGJ5IGNyZWF0aW9uIGRhdGUsIG5vdCB1cGRhdGVcbiAqIHJlY2VuY3kgKElzc3VlICMyOTAxKTogYSBQUiBtZXJnZWQgb3IgY2xvc2VkIGFmdGVyIGBsaW1pdGAgbmV3ZXItbnVtYmVyZWRcbiAqIFBScyB3ZXJlIGNyZWF0ZWQgbmV2ZXIgZW50ZXJzIGEgd2luZG93IG9yZGVyZWQgdGhhdCB3YXkuIFBhc3NpbmcgdGhpcyBhc1xuICogYC0tc2VhcmNoYCBvcmRlcnMgYnkgdXBkYXRlIHJlY2VuY3kgaW5zdGVhZCwgc28gYSBtZXJnZSBvciBjbG9zZSBhbHdheXNcbiAqIHB1dHMgdGhlIFBSIGJhY2sgYXQgdGhlIGZyb250IG9mIHRoZSB3aW5kb3cuXG4gKi9cbmV4cG9ydCBjb25zdCBSRUNFTkNZX09SREVSX1NFQVJDSCA9IFwic29ydDp1cGRhdGVkLWRlc2NcIjtcblxuLyoqXG4gKiBGZXRjaCBtZXJnZWQgUFJzIGJ5IGEgZ2l2ZW4gdXNlciAoSXNzdWUgIzE3ODcpLlxuICpcbiAqIFVzZWQgYnkgYnJhbmNoIGNsZWFudXAsIG1lcmdlZC1QUi1kcml2ZW4gaXNzdWUgY2xvc3VyZSwgYW5kIHRoZVxuICogY2xvc2VkLVBSIHNlbGYtaGVhbGluZyBwYXRoLiBDYWNoZSBrZXkgaXMgYHByc19tZXJnZWRfJHt1c2VyfWAuIE9yZGVyZWQgYnlcbiAqIHVwZGF0ZSByZWNlbmN5LCBub3QgY3JlYXRpb24gZGF0ZSwgc28gYSBsb25nLWxpdmVkIFBSJ3MgbWVyZ2Uga2VlcHMgaXQgaW5cbiAqIHRoZSB3aW5kb3cgKElzc3VlICMyOTAxKS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoTWVyZ2VkUFJzQnlVc2VyKFxuICByZXBvOiBzdHJpbmcsXG4gIGdpdGh1YlVzZXI6IHN0cmluZyxcbiAgY2FjaGU/OiBJc3N1ZUNhY2hlLFxuICBsaW1pdCA9IDMwLFxuICBnaENvbW1hbmRGbjogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz4gPSBydW5HaENvbW1hbmQsXG4gIC8qKiBDbG9jayBvdmVycmlkZSwgZXBvY2ggc2Vjb25kcyAodGVzdHMpLiAqL1xuICBub3dTZWNvbmRzOiAoKSA9PiBudW1iZXIgPSAoKSA9PiBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSxcbik6IFByb21pc2U8TWVyZ2VkUFJbXT4ge1xuICBjb25zdCBjYWNoZUtleSA9IGBwcnNfbWVyZ2VkXyR7Z2l0aHViVXNlcn1gO1xuXG4gIGlmIChjYWNoZSkge1xuICAgIC8vIElzc3VlICMyNDA5OiBzZXJ2ZWQgd2hpbGUgbm8gb3BlbiBQUiBvZiB0aGlzIGF1dGhvciBoYXMgZ29uZS5cbiAgICBjb25zdCBjYWNoZWQgPSBhd2FpdCByZWFkU2V0dGxlZExpc3Rpbmc8TWVyZ2VkUFI+KFxuICAgICAgcmVwbyxcbiAgICAgIGdpdGh1YlVzZXIsXG4gICAgICBjYWNoZUtleSxcbiAgICAgIGNhY2hlLFxuICAgICAgZ2hDb21tYW5kRm4sXG4gICAgICBub3dTZWNvbmRzKCksXG4gICAgKTtcbiAgICBpZiAoY2FjaGVkKSByZXR1cm4gY2FjaGVkO1xuICB9XG5cbiAgY29uc3Qgb3V0cHV0ID0gYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgIFwicHJcIixcbiAgICBcImxpc3RcIixcbiAgICBcIi0tcmVwb1wiLFxuICAgIHJlcG8sXG4gICAgXCItLXN0YXRlXCIsXG4gICAgXCJtZXJnZWRcIixcbiAgICBcIi0tYXV0aG9yXCIsXG4gICAgZ2l0aHViVXNlcixcbiAgICBcIi0tc2VhcmNoXCIsXG4gICAgUkVDRU5DWV9PUkRFUl9TRUFSQ0gsXG4gICAgXCItLWpzb25cIixcbiAgICBcIm51bWJlcix0aXRsZSxoZWFkUmVmTmFtZSxtZXJnZWRBdCxib2R5XCIsXG4gICAgXCItLWxpbWl0XCIsXG4gICAgU3RyaW5nKGxpbWl0KSxcbiAgXSk7XG5cbiAgLy8gTmV2ZXIgY2FjaGUgYSBmYWlsdXJlIChJc3N1ZSAjNDI1Nyk6IHRoZSBvbGQgYHx8IFwiW11cImAgZmFsbGJhY2sgdHVybmVkXG4gIC8vIGEgZmFpbGVkIGNhbGwncyBlbXB0eSBvdXRwdXQgaW50byBhIGNhY2hlYWJsZSBlbXB0eSBsaXN0LCBhbmQgYnJhbmNoXG4gIC8vIGNsZWFudXAgLyBjbG9zZS1pc3N1ZXMgdGhlbiBzYXcgYSByZXBvIHdpdGggbm8gbWVyZ2VkIFBScyBmb3IgdGhlIFRUTC5cbiAgYXNzZXJ0TGlzdE91dHB1dChvdXRwdXQsIGBmZXRjaE1lcmdlZFBSc0J5VXNlcigke3JlcG99KWApO1xuXG4gIGNvbnN0IHBycyA9IHBhcnNlTWVyZ2VkUHJMaXN0aW5nKG91dHB1dCk7XG5cbiAgaWYgKGNhY2hlKSB7XG4gICAgYXdhaXQgd3JpdGVTZXR0bGVkTGlzdGluZyhcbiAgICAgIHJlcG8sXG4gICAgICBnaXRodWJVc2VyLFxuICAgICAgY2FjaGVLZXksXG4gICAgICBwcnMsXG4gICAgICBjYWNoZSxcbiAgICAgIGdoQ29tbWFuZEZuLFxuICAgICAgbm93U2Vjb25kcygpLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHBycztcbn1cblxuLyoqXG4gKiBQYXJzZSBhIGBnaCBwciBsaXN0IC0tc3RhdGUgbWVyZ2VkIC0tanNvblxuICogbnVtYmVyLHRpdGxlLGhlYWRSZWZOYW1lLG1lcmdlZEF0LGJvZHlgIGxpc3RpbmcuIFRoZSBib2R5IGl0c2VsZiBpcyBub3RcbiAqIGtlcHQg4oCUIG9ubHkgdGhlIGNsb3NpbmcgcmVmZXJlbmNlcyB0aGUgY2xvc2VycyBuZWVkIGZyb20gaXQgYW5kIHRoZVxuICogc3ViLWFnZW50IHRpZXIgaXRzIG1hcmtlciBuYW1lcyAoYHNvbm5ldGAgd2hlbiBpdCBoYXMgbm9uZSwgSXNzdWUgIzM0MDQpLlxuICovXG5mdW5jdGlvbiBwYXJzZU1lcmdlZFByTGlzdGluZyhvdXRwdXQ6IHN0cmluZyk6IE1lcmdlZFBSW10ge1xuICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICB0cnkge1xuICAgIHBhcnNlZCA9IEpTT04ucGFyc2Uob3V0cHV0LnRyaW0oKSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbXTtcbiAgfVxuICBpZiAoIUFycmF5LmlzQXJyYXkocGFyc2VkKSkgcmV0dXJuIFtdO1xuXG4gIGNvbnN0IHByczogTWVyZ2VkUFJbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGl0ZW0gb2YgcGFyc2VkKSB7XG4gICAgaWYgKCFpc1JlY29yZChpdGVtKSkgY29udGludWU7XG4gICAgaWYgKHR5cGVvZiBpdGVtLm51bWJlciAhPT0gXCJudW1iZXJcIikgY29udGludWU7XG4gICAgY29uc3QgYm9keSA9IHR5cGVvZiBpdGVtLmJvZHkgPT09IFwic3RyaW5nXCIgPyBpdGVtLmJvZHkgOiBcIlwiO1xuICAgIGNvbnN0IG1pc3NpbmdDcml0ZXJpYSA9IGZpbmRNaXNzaW5nQ3JpdGVyaWEoYm9keSk7XG4gICAgcHJzLnB1c2goe1xuICAgICAgbnVtYmVyOiBpdGVtLm51bWJlcixcbiAgICAgIHRpdGxlOiB0eXBlb2YgaXRlbS50aXRsZSA9PT0gXCJzdHJpbmdcIiA/IGl0ZW0udGl0bGUgOiBcIlwiLFxuICAgICAgaGVhZFJlZk5hbWU6IHR5cGVvZiBpdGVtLmhlYWRSZWZOYW1lID09PSBcInN0cmluZ1wiID8gaXRlbS5oZWFkUmVmTmFtZSA6IFwiXCIsXG4gICAgICBtZXJnZWRBdDogdHlwZW9mIGl0ZW0ubWVyZ2VkQXQgPT09IFwic3RyaW5nXCIgPyBpdGVtLm1lcmdlZEF0IDogXCJcIixcbiAgICAgIGNsb3NpbmdSZWZzOiBleHRyYWN0Q2xvc2luZ0lzc3VlTnVtYmVycyhib2R5KSxcbiAgICAgIHN1YkFnZW50VGllcjogc3ViQWdlbnRUaWVyRnJvbUJvZHkoYm9keSkgPz8gXCJzb25uZXRcIixcbiAgICAgIGxpZmVjeWNsZUFzc2lnbm1lbnRJZDogYXNzaWdubWVudElkRnJvbUJvZHkoYm9keSkgPz8gbnVsbCxcbiAgICAgIC4uLihtaXNzaW5nQ3JpdGVyaWEubGVuZ3RoID4gMCA/IHsgbWlzc2luZ0NyaXRlcmlhIH0gOiB7fSksXG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIHBycztcbn1cblxuLyoqXG4gKiBGZXRjaCBhIHJlcG8ncyBtb3N0IHJlY2VudGx5IG1lcmdlZCBQUnMsICoqd2hvZXZlciBhdXRob3JlZCB0aGVtKipcbiAqIChJc3N1ZSAjMjUzNykuXG4gKlxuICogR2l0SHViIGhvbm91cnMgYENsb3NlcyAjTmAgb25seSBvbiBhIG1lcmdlIGludG8gdGhlIGRlZmF1bHQgYnJhbmNoLCBzbyB0aGVcbiAqIHdvcmtlciBjbG9zZXMgYSBtaWxlc3RvbmUgY2hpbGQgaXRzZWxmLiBUaGF0IGNsb3NlIG11c3Qgbm90IGRlcGVuZCBvbiB3aG9cbiAqIHdyb3RlIHRoZSBQUjogYSBodW1hbidzIFBSIG1lcmdlZCBpbnRvIGEgbWlsZXN0b25lIGJyYW5jaCBsZWZ0IEdSUS1BdXRvVHJhZGVyXG4gKiAjODI0IG9wZW4gZm9yIGEgZGF5LCBob2xkaW5nIHRocmVlIGB0b3AtcHJpb3JpdHlgIGRlcGVuZGFudHMsIGJlY2F1c2UgZXZlcnlcbiAqIGhvc3QgbGlzdGVkIG9ubHkgaXRzIG93biBQUnMuIE1lcmdpbmcgbmVlZHMgd3JpdGUgYWNjZXNzLCBzbyBubyBhdXRob3JcbiAqIGZpbHRlciBpcyBwcm90ZWN0aW5nIGFueXRoaW5nIGhlcmUuXG4gKlxuICogQ2FjaGVkIHVuZGVyIGBwcnNfbWVyZ2VkX2FueWAgZm9yIHRoZSBjYWNoZSdzIG5vcm1hbCBUVEwg4oCUIGF0IHdvcnN0IGEgY2xvc2VcbiAqIGxhbmRzIG9uZSBUVEwgbGF0ZSwgYW5kIGVhY2ggaG9zdCBzcGVuZHMgb25lIGxpc3RpbmcgcGVyIHJlcG8gcGVyIFRUTC5cbiAqIE9yZGVyZWQgYnkgdXBkYXRlIHJlY2VuY3ksIG5vdCBjcmVhdGlvbiBkYXRlLCBzbyBhIGxvbmctbGl2ZWQgUFIncyBtZXJnZVxuICoga2VlcHMgaXQgaW4gdGhlIHdpbmRvdyAoSXNzdWUgIzI5MDEpLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hNZXJnZWRQUnNBbnlBdXRob3IoXG4gIHJlcG86IHN0cmluZyxcbiAgY2FjaGU/OiBJc3N1ZUNhY2hlLFxuICBsaW1pdCA9IDMwLFxuICBnaENvbW1hbmRGbjogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz4gPSBydW5HaENvbW1hbmQsXG4pOiBQcm9taXNlPE1lcmdlZFBSW10+IHtcbiAgY29uc3QgY2FjaGVLZXkgPSBcInByc19tZXJnZWRfYW55XCI7XG4gIGlmIChjYWNoZSkge1xuICAgIGNvbnN0IGNhY2hlZCA9IGF3YWl0IGNhY2hlLnJlYWQ8TWVyZ2VkUFJbXT4ocmVwbywgY2FjaGVLZXkpO1xuICAgIGlmIChBcnJheS5pc0FycmF5KGNhY2hlZCkpIHJldHVybiBjYWNoZWQ7XG4gIH1cblxuICBjb25zdCBvdXRwdXQgPSBhd2FpdCBnaENvbW1hbmRGbihbXG4gICAgXCJwclwiLFxuICAgIFwibGlzdFwiLFxuICAgIFwiLS1yZXBvXCIsXG4gICAgcmVwbyxcbiAgICBcIi0tc3RhdGVcIixcbiAgICBcIm1lcmdlZFwiLFxuICAgIFwiLS1zZWFyY2hcIixcbiAgICBSRUNFTkNZX09SREVSX1NFQVJDSCxcbiAgICBcIi0tanNvblwiLFxuICAgIFwibnVtYmVyLHRpdGxlLGhlYWRSZWZOYW1lLG1lcmdlZEF0LGJvZHlcIixcbiAgICBcIi0tbGltaXRcIixcbiAgICBTdHJpbmcobGltaXQpLFxuICBdKTtcbiAgLy8gTmV2ZXIgY2FjaGUgYSBmYWlsdXJlIChJc3N1ZSAjNDI1NykuXG4gIGFzc2VydExpc3RPdXRwdXQob3V0cHV0LCBgZmV0Y2hNZXJnZWRQUnNBbnlBdXRob3IoJHtyZXBvfSlgKTtcblxuICBjb25zdCBwcnMgPSBwYXJzZU1lcmdlZFByTGlzdGluZyhvdXRwdXQpO1xuICBpZiAoY2FjaGUpIGF3YWl0IGNhY2hlLndyaXRlKHJlcG8sIGNhY2hlS2V5LCBwcnMpO1xuICByZXR1cm4gcHJzO1xufVxuXG4vKipcbiAqIERlZmF1bHQgbnVtYmVyIG9mIGZsZWV0IFBScyB0aGF0IG1heSBiZSBvcGVuIGF0IG9uY2Ugb24gYSByZXBvc2l0b3J5J3NcbiAqIGRlZmF1bHQtYnJhbmNoIChub24tbWlsZXN0b25lKSBzdHJlYW0g4oCUIGBmbGVldF9wcl9zbG90c2AgKElzc3VlICMyNjYzKS5cbiAqXG4gKiBUaGUgb3duZXIncyBydWxlIGlzIG9uZSBmbGVldCBQUiBwZXIgc2xvdC4gTm8gaG9zdCdzIGNvbmZpZyBjYXJyaWVzIHRoZVxuICogZmxlZXQncyBzaXplIChlYWNoIGhvc3Qga25vd3Mgb25seSBpdHMgb3duIGBtYXhfY29uY3VycmVudF9pc3N1ZXNgKSwgc28gdGhlXG4gKiBkZWZhdWx0IGNhbm5vdCBiZSBkZXJpdmVkIGZyb20gY29uZmlnOyBpdCBpcyBmaXhlZCBhdCA4IOKAlCB0aGUgY2VpbGluZyBvZlxuICogYG1heF9jb25jdXJyZW50X2lzc3Vlc2AgKDHigJM4KSwgc28gb25lIGhvc3QgYXQgaXRzIG1heGltdW0gbmV2ZXIgaG9sZHMgaXRzZWxmLFxuICogYW5kIGZvdXIgaG9zdHMgYXQgdGhlIGRlZmF1bHQgdHdvIHNsb3RzIGZpbGwgaXQgZXhhY3RseS4gT3BlcmF0b3JzIHNldCB0aGVcbiAqIHJlYWwgZmlndXJlIHdpdGggYGZsZWV0X3ByX3Nsb3RzYCwgcGVyIHJlcG9zaXRvcnkgd2l0aCBgcmVwb19jb25maWdgLlxuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9GTEVFVF9QUl9TTE9UUyA9IDg7XG5cbi8qKiBBIHVzYWJsZSBzbG90IGNhcDogYSBwb3NpdGl2ZSBpbnRlZ2VyLCBvciBgZmFsbGJhY2tgLiAqL1xuZnVuY3Rpb24gcG9zaXRpdmVTbG90c09yKHZhbHVlOiB1bmtub3duLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJudW1iZXJcIiB8fCAhTnVtYmVyLmlzSW50ZWdlcih2YWx1ZSkgfHwgdmFsdWUgPD0gMCkge1xuICAgIHJldHVybiBmYWxsYmFjaztcbiAgfVxuICByZXR1cm4gdmFsdWU7XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgZmxlZXQgUFIgY2FwIGZvciBhIHJlcG9zaXRvcnkncyBkZWZhdWx0LWJyYW5jaCBzdHJlYW1cbiAqIChJc3N1ZSAjMjY2Myk6IGByZXBvX2NvbmZpZy48cmVwbz4uZmxlZXRfcHJfc2xvdHNgIHdpbnMgb3ZlciB0aGUgZ2xvYmFsXG4gKiBgZmxlZXRfcHJfc2xvdHNgLCB3aGljaCB3aW5zIG92ZXIge0BsaW5rIERFRkFVTFRfRkxFRVRfUFJfU0xPVFN9LiBBIHZhbHVlXG4gKiB0aGF0IGlzIG5vdCBhIHBvc2l0aXZlIGludGVnZXIgKGNvbmZpZyBhcnJpdmVzIHVudHJ1c3RlZCkgZmFsbHMgYmFjayBhXG4gKiBsZXZlbCByYXRoZXIgdGhhbiBkaXNhYmxpbmcgdGhlIGdhdGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlRmxlZXRQclNsb3RzKFxuICBjb25maWc6IFBhcnRpYWw8UGljazxXb3JrZXJDb25maWcsIFwiZmxlZXRQclNsb3RzXCIgfCBcInJlcG9Db25maWdcIj4+LFxuICByZXBvOiBzdHJpbmcsXG4pOiBudW1iZXIge1xuICBjb25zdCBnbG9iYWxWYWx1ZSA9IHBvc2l0aXZlU2xvdHNPcihcbiAgICBjb25maWcuZmxlZXRQclNsb3RzLFxuICAgIERFRkFVTFRfRkxFRVRfUFJfU0xPVFMsXG4gICk7XG4gIHJldHVybiBwb3NpdGl2ZVNsb3RzT3IoY29uZmlnLnJlcG9Db25maWc/LltyZXBvXT8uZmxlZXRQclNsb3RzLCBnbG9iYWxWYWx1ZSk7XG59XG5cbi8qKlxuICogVGhlIGxvZ2luIHRoYXQgYXV0aG9yZWQgYW4gb3BlbiBQUiwgZm9yIHRoZSBmbGVldCBjbGFzc2lmaWNhdGlvbi5cbiAqXG4gKiB7QGxpbmsgT3BlblBSLmF1dGhvcn0gaXMgdGhlIGZsZWV0IGxvZ2luIHRoZSBQUiB3YXMgZmV0Y2hlZCB1bmRlclxuICogKGBmZXRjaE9wZW5QUnNGb3JGbGVldGApLiBBIHJvdyBmcm9tIHRoZSByZXBvLXdpZGUgbGlzdGluZ1xuICogKGBmZXRjaEFsbE9wZW5QUnNgLCB3aGljaCB0aGUgaWRsZSBjZW5zdXMgYW5kIHRoZSBjbGFpbWFibGUgYXVkaXQgcmVhZClcbiAqIGNhcnJpZXMgdGhlIGxpc3RpbmcncyBvd24gYXV0aG9yIGFzIGBhdXRob3JMb2dpbmAgaW5zdGVhZC4gRmFsbGluZyBiYWNrIHRvXG4gKiBpdCBsZXRzIHRob3NlIGNvbnN1bWVycyBjbGFzc2lmeSBleGFjdGx5IGFzIHRoZSBzY2FuIGRvZXMgKElzc3VlICMyNjYzKTtcbiAqIHdpdGggbmVpdGhlciwgdGhlIGF1dGhvciBpcyB1bmtub3duIGFuZCB0aGUgUFIgc3RheXMgZmxlZXQtb3duZWQgKHRoZVxuICogZmFpbC1zYWZlIGluIHtAbGluayBpc0h1bWFuQXV0aG9yZWRQcn0pLlxuICovXG5mdW5jdGlvbiBwckF1dGhvckZvckdhdGUocHI6IE9wZW5QUik6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGlmICh0eXBlb2YgcHIuYXV0aG9yID09PSBcInN0cmluZ1wiICYmIHByLmF1dGhvci50cmltKCkgIT09IFwiXCIpIHtcbiAgICByZXR1cm4gcHIuYXV0aG9yO1xuICB9XG4gIGNvbnN0IGxpc3RlZCA9IChwciBhcyB7IGF1dGhvckxvZ2luPzogdW5rbm93biB9KS5hdXRob3JMb2dpbjtcbiAgcmV0dXJuIHR5cGVvZiBsaXN0ZWQgPT09IFwic3RyaW5nXCIgPyBsaXN0ZWQgOiB1bmRlZmluZWQ7XG59XG5cbi8qKlxuICogVHJ1ZSB3aGVuIGBwcmAgaXMgdGhlIGZsZWV0J3MgUFIgZm9yIGlzc3VlIGBpc3N1ZU51bWJlcmA6IGl0cyB0aXRsZSBlbmRzIGluXG4gKiB0aGUgd29ya2VyJ3MgYCgjTilgIC8gYChJc3N1ZSAjTilgIHN1ZmZpeCwgb3IgaXRzIGhlYWQgYnJhbmNoIGlzIHRoZVxuICogd29ya2VyJ3MgYGlzc3VlLU5gIC8gYGlzc3VlLU4t4oCmYCBicmFuY2ggKHNvIGBpc3N1ZS0xNy3igKZgIGlzIG5vdCBpc3N1ZSAxJ3MpLlxuICovXG5mdW5jdGlvbiBpc1ByRm9ySXNzdWUocHI6IE9wZW5QUiwgaXNzdWVOdW1iZXI6IG51bWJlcik6IGJvb2xlYW4ge1xuICBjb25zdCBmcm9tVGl0bGUgPSBleHRyYWN0SXNzdWVOdW1iZXJGcm9tUHJUaXRsZShwci50aXRsZSA/PyBcIlwiKTtcbiAgaWYgKGZyb21UaXRsZS5vayAmJiBmcm9tVGl0bGUudmFsdWUgPT09IGlzc3VlTnVtYmVyKSByZXR1cm4gdHJ1ZTtcbiAgY29uc3QgaGVhZCA9IHByLmhlYWRSZWZOYW1lID8/IFwiXCI7XG4gIHJldHVybiBoZWFkID09PSBgaXNzdWUtJHtpc3N1ZU51bWJlcn1gIHx8XG4gICAgaGVhZC5zdGFydHNXaXRoKGBpc3N1ZS0ke2lzc3VlTnVtYmVyfS1gKTtcbn1cblxuLyoqIFRydWUgd2hlbiBhbiBvcGVuIFBSIGlzIG9uIGEgcmVwbydzIGRlZmF1bHQtYnJhbmNoIChub24tbWlsZXN0b25lKSBzdHJlYW0uICovXG5mdW5jdGlvbiBpc0RlZmF1bHRTdHJlYW1QcihwcjogT3BlblBSKTogYm9vbGVhbiB7XG4gIGNvbnN0IGJhc2UgPSBwci5iYXNlUmVmTmFtZSA/PyBcIlwiO1xuICBjb25zdCBoZWFkID0gcHIuaGVhZFJlZk5hbWUgPz8gXCJcIjtcbiAgaWYgKGJhc2Uuc3RhcnRzV2l0aChcIm1pbGVzdG9uZS9cIikpIHJldHVybiBmYWxzZTtcbiAgaWYgKGhlYWQuc3RhcnRzV2l0aChcIm1pbGVzdG9uZS9cIikgfHwgaGVhZC5pbmNsdWRlcyhcIm1lcmdlLW1pbGVzdG9uZVwiKSkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxuLyoqXG4gKiBDaGVjayBpZiBhIHNwZWNpZmljIGlzc3VlIGlzIGJsb2NrZWQgYnkgb3BlbiBmbGVldCBQUnMgKG1pbGVzdG9uZS1hd2FyZSkuXG4gKlxuICogLSBPbmx5ICoqZmxlZXQtYXV0aG9yZWQqKiBQUnMgY291bnQuIEEgaHVtYW4ncyBvcGVuIFBSIG5ldmVyIGRlZmVycyBhblxuICogICBpc3N1ZTogdGhlIGRldmVsb3BlciBtYW5hZ2VzIHRoZWlyIG93biBQUiwgYW5kIG9uZSB1bnJlbGF0ZWQgaHVtYW4gUFJcbiAqICAgbXVzdCBub3QgcGFyayBhIHJlcG8ncyB3aG9sZSBgd29yay1vbmAgcXVldWUgKElzc3VlICM0MTMzKS5cbiAqIC0gTWlsZXN0b25lIGlzc3VlcyBhcmUgYmxvY2tlZCBieSBhIFBSIHRhcmdldGluZyB0aGVpciBtaWxlc3RvbmUgYnJhbmNoIOKAlFxuICogICBvbmUgUFIgcGVyIG1pbGVzdG9uZSBzdHJlYW0sIHNvIG11bHRpcGxlIG1pbGVzdG9uZXMgbWVhbiBtdWx0aXBsZSBQUnMuXG4gKiAtIE5vbi1taWxlc3RvbmUgaXNzdWVzIGFyZSBibG9ja2VkIG9ubHkgd2hpbGUgdGhlIGZsZWV0J3Mgb3BlbiBQUnMgb24gdGhlXG4gKiAgIGRlZmF1bHQtYnJhbmNoIHN0cmVhbSBudW1iZXIgYXQgbGVhc3QgYGZsZWV0UHJTbG90c2Ag4oCUIG9uZSBmbGVldCBQUiBwZXJcbiAqICAgc2xvdCAoSXNzdWUgIzI2NjMpLiBNaWxlc3RvbmUtYnJhbmNoIGFuZCBtaWxlc3RvbmUtbWVyZ2UgUFJzIGFyZSBub3Qgb25cbiAqICAgdGhhdCBzdHJlYW0gYW5kIG5ldmVyIGNvdW50LlxuICpcbiAqIFRoZSByZXR1cm5lZCBpbmZvIGNhcnJpZXMgdGhlIFBSJ3MgYGF1dGhvcmAgKElzc3VlICM0MDc4KTsgYSBkZWZhdWx0LXN0cmVhbVxuICogaG9sZCBhbHNvIGNhcnJpZXMgYGZsZWV0UHJDYXBgLCB0aGUgY291bnQgYWdhaW5zdCB0aGUgY2FwLCBhbmQgbmFtZXMgdGhlXG4gKiBmaXJzdCBjb3VudGVkIFBSIG9ubHkgc28gZXhpc3RpbmcgY2FsbGVycyBrZWVwIGEgUFIgdG8gcG9pbnQgYXQuXG4gKlxuICogQHBhcmFtIHBycyAtIEFycmF5IG9mIG9wZW4gUFJzXG4gKiBAcGFyYW0gbWlsZXN0b25lVGl0bGUgLSBUaGUgaXNzdWUncyBtaWxlc3RvbmUgdGl0bGUgKGVtcHR5IGlmIG5vbmUpXG4gKiBAcGFyYW0gcHVzaENhcGFibGVBdXRob3JzIC0gVGhlIGZsZWV0J3MgcHVzaC1jYXBhYmxlIGxvZ2luc1xuICogICAoYHJlc29sdmVGbGVldE1haW50ZW5hbmNlQXV0aG9yU2V0YDogaG9zdCBsb2dpbiArIGBmbGVldF9wcl9hdXRob3JzYCDiiKpcbiAqICAgYHNlcnZpY2VfYWNjb3VudHNgKS4gUFJzIGF1dGhvcmVkIG91dHNpZGUgdGhpcyBzZXQgYXJlIGlnbm9yZWQuIFBhc3MgYFtdYFxuICogICBvbmx5IHdoZXJlIHRoZSBzZXQgaXMgZ2VudWluZWx5IHVuYXZhaWxhYmxlIOKAlCBhbiBlbXB0eSBzZXQgY2Fubm90XG4gKiAgIGNsYXNzaWZ5IGFueXRoaW5nLCBzbyBldmVyeSBQUiBjb3VudHMgKGZhaWwtc2FmZSwgc2VlXG4gKiAgIHtAbGluayBpc0h1bWFuQXV0aG9yZWRQcn0pLlxuICogQHBhcmFtIGZsZWV0UHJTbG90cyAtIFRoZSBkZWZhdWx0LWJyYW5jaCBjYXAgKHtAbGluayByZXNvbHZlRmxlZXRQclNsb3RzfSk7XG4gKiAgIGFueXRoaW5nIGJ1dCBhIHBvc2l0aXZlIGludGVnZXIgbWVhbnMge0BsaW5rIERFRkFVTFRfRkxFRVRfUFJfU0xPVFN9LlxuICogQHJldHVybnMgQmxvY2tpbmcgUFIgaW5mbywgb3IgbnVsbCBpZiBub3QgYmxvY2tlZFxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0QmxvY2tpbmdQUkZvcklzc3VlKFxuICBwcnM6IE9wZW5QUltdLFxuICBtaWxlc3RvbmVUaXRsZTogc3RyaW5nLFxuICBwdXNoQ2FwYWJsZUF1dGhvcnM6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICBmbGVldFByU2xvdHM6IG51bWJlciA9IERFRkFVTFRfRkxFRVRfUFJfU0xPVFMsXG4gIGlzc3VlTnVtYmVyPzogbnVtYmVyLFxuKTogQmxvY2tpbmdQUkluZm8gfCBudWxsIHtcbiAgaWYgKHBycy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuXG4gIC8vIElzc3VlICM0MTMzOiBzb21lb25lIGVsc2UncyBQUiBpcyBub3QgdGhlIHdvcmtlcidzIHdvcmsgc3RyZWFtLiBJc3N1ZVxuICAvLyAjNDE0NjogbmVpdGhlciBpcyB0aGUgZmxlZXQncyBvd24gRFJBRlQgZm9yIHRoaXMgaXNzdWUg4oCUIGEgdGltZWQtb3V0IHJ1blxuICAvLyBrZWVwcyBvbmUgc28gdGhlIG5leHQgcnVuIGNhbiByZXN1bWUgdGhlIGJyYW5jaCBhbmQgZmluaXNoIHRoZSBqb2IsIGFuZFxuICAvLyBob2xkaW5nIHRoZSBpc3N1ZSBvbiBpdCB3b3VsZCBzdHJhbmQgdGhlIHdvcmsgaXQgZXhpc3RzIHRvIGNvbnRpbnVlLlxuICBjb25zdCBmbGVldFBycyA9IHBycy5maWx0ZXIoXG4gICAgKHByKSA9PlxuICAgICAgIWlzSHVtYW5BdXRob3JlZFByKHByQXV0aG9yRm9yR2F0ZShwciksIHB1c2hDYXBhYmxlQXV0aG9ycykgJiZcbiAgICAgICEoaXNzdWVOdW1iZXIgIT09IHVuZGVmaW5lZCAmJiBwci5pc0RyYWZ0ID09PSB0cnVlICYmXG4gICAgICAgIGlzUHJGb3JJc3N1ZShwciwgaXNzdWVOdW1iZXIpKSxcbiAgKTtcbiAgaWYgKGZsZWV0UHJzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG5cbiAgLy8gQW4gaXNzdWUgd2hvc2Ugb3duIGZsZWV0IFBSIGlzIG9wZW4gaXMgbmV2ZXIgY2xhaW1hYmxlIGFnYWluLCBvbiBhbnlcbiAgLy8gc3RyZWFtIGFuZCB3aGF0ZXZlciB0aGUgY2FwIChJc3N1ZSAjMjY2MykuIEJlZm9yZSB0aGUgcGVyLXNsb3QgY2FwLCBhbnlcbiAgLy8gb3BlbiBmbGVldCBQUiBoZWxkIGV2ZXJ5IG5vbi1taWxlc3RvbmUgaXNzdWUsIHdoaWNoIGhpZCB0aGlzOyB3aXRoIHRoZVxuICAvLyBjYXAgYSBsb25lIFBSIGhvbGRzIG5vdGhpbmcsIGFuZCB0aGUgaXNzdWUgaXQgZGVsaXZlcnMgd2FzIHJlLWNsYWltZWRcbiAgLy8gd2hpbGUgdGhhdCBQUiB3YWl0ZWQgZm9yIENJIG9yIHJldmlldy5cbiAgaWYgKGlzc3VlTnVtYmVyICE9PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCBvd24gPSBmbGVldFBycy5maW5kKChwcikgPT4gaXNQckZvcklzc3VlKHByLCBpc3N1ZU51bWJlcikpO1xuICAgIGlmIChvd24pIHJldHVybiB0b0Jsb2NraW5nUFJJbmZvKG93bik7XG4gIH1cblxuICBpZiAobWlsZXN0b25lVGl0bGUgIT09IFwiXCIpIHtcbiAgICAvLyBNaWxlc3RvbmUgaXNzdWU6IG9ubHkgYmxvY2tlZCBieSBQUnMgdGFyZ2V0aW5nIHRoZSBzYW1lIG1pbGVzdG9uZSBicmFuY2hcbiAgICBjb25zdCBtaWxlc3RvbmVCcmFuY2ggPSBjcmVhdGVNaWxlc3RvbmVCcmFuY2hOYW1lKG1pbGVzdG9uZVRpdGxlKTtcbiAgICBjb25zdCBibG9ja2luZyA9IGZsZWV0UHJzLmZpbmQoKHByKSA9PiBwci5iYXNlUmVmTmFtZSA9PT0gbWlsZXN0b25lQnJhbmNoKTtcbiAgICByZXR1cm4gYmxvY2tpbmcgPyB0b0Jsb2NraW5nUFJJbmZvKGJsb2NraW5nKSA6IG51bGw7XG4gIH1cblxuICAvLyBOb24tbWlsZXN0b25lIGlzc3VlOiBvbmUgZmxlZXQgUFIgcGVyIHNsb3Qgb24gdGhlIGRlZmF1bHQtYnJhbmNoIHN0cmVhbS5cbiAgY29uc3QgY2FwID0gcG9zaXRpdmVTbG90c09yKGZsZWV0UHJTbG90cywgREVGQVVMVF9GTEVFVF9QUl9TTE9UUyk7XG4gIGNvbnN0IG9uU3RyZWFtID0gZmxlZXRQcnMuZmlsdGVyKGlzRGVmYXVsdFN0cmVhbVByKTtcbiAgaWYgKG9uU3RyZWFtLmxlbmd0aCA8IGNhcCkgcmV0dXJuIG51bGw7XG4gIHJldHVybiB7XG4gICAgLi4udG9CbG9ja2luZ1BSSW5mbyhvblN0cmVhbVswXSEpLFxuICAgIGZsZWV0UHJDYXA6IHsgb3Blbjogb25TdHJlYW0ubGVuZ3RoLCBjYXAgfSxcbiAgfTtcbn1cblxuLyoqXG4gKiBPbmUtbGluZSBkZXNjcmlwdGlvbiBvZiBhIGhvbGQgZm9yIHNraXAgbG9ncyAoSXNzdWUgIzI2NjMpOiB0aGUgUFIsIGFuZFxuICogZm9yIGEgZGVmYXVsdC1icmFuY2ggc2xvdCBob2xkIHRoZSBjb3VudCBhZ2FpbnN0IHRoZSBjYXAgYXMgd2VsbCDigJQgdGhlXG4gKiBjb3VudCBpcyB0aGUgZ2F0ZTsgdGhlIFBSIGlzIGtlcHQgc28gYSBsb2cgZ3JlcCBzdGlsbCBmaW5kcyBpdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlc2NyaWJlQmxvY2tpbmdQcihpbmZvOiBCbG9ja2luZ1BSSW5mbyk6IHN0cmluZyB7XG4gIGlmICghaW5mby5mbGVldFByQ2FwKSByZXR1cm4gYFBSICMke2luZm8ubnVtYmVyfWA7XG4gIGNvbnN0IHsgb3BlbiwgY2FwIH0gPSBpbmZvLmZsZWV0UHJDYXA7XG4gIHJldHVybiBgUFIgIyR7aW5mby5udW1iZXJ9ICgke29wZW59IGZsZWV0IFBSJHtvcGVuID09PSAxID8gXCJcIiA6IFwic1wifSBgICtcbiAgICBgb3BlbiBvbiB0aGUgZGVmYXVsdCBicmFuY2gsIGNhcCAke2NhcH0pYDtcbn1cblxuLyoqIFByb2plY3QgYW4gb3BlbiBQUiBvbnRvIHRoZSBibG9ja2luZy1ndWFyZCByZXN1bHQgc2hhcGUgKElzc3VlICM0MDc4KS4gKi9cbmZ1bmN0aW9uIHRvQmxvY2tpbmdQUkluZm8ocHI6IE9wZW5QUik6IEJsb2NraW5nUFJJbmZvIHtcbiAgY29uc3QgYXV0aG9yID0gcHJBdXRob3JGb3JHYXRlKHByKTtcbiAgcmV0dXJuIHtcbiAgICBudW1iZXI6IHByLm51bWJlcixcbiAgICB0aXRsZTogcHIudGl0bGUsXG4gICAgYXV0aG9yOiB0eXBlb2YgYXV0aG9yID09PSBcInN0cmluZ1wiID8gYXV0aG9yLnRyaW0oKSA6IFwiXCIsXG4gIH07XG59XG5cbi8qKlxuICogRmV0Y2ggdGhlIGN1cnJlbnQgbGFiZWxzIGZvciBhIHNpbmdsZSBpc3N1ZSwgd2l0aCBvcHRpb25hbCBjYWNoaW5nXG4gKiAoSXNzdWUgIzE3ODcpLlxuICpcbiAqIFdyYXBzIGBnaCBpc3N1ZSB2aWV3IC0tanNvbiBsYWJlbHNgIHNvIG11bHRpcGxlIHBlci1pc3N1ZSBsYWJlbFxuICogY2hlY2tzIHdpdGhpbiBvbmUgaXRlcmF0aW9uIHNoYXJlIG9uZSBuZXR3b3JrIGNhbGwuIFRoZSBjYWNoZSBrZXlcbiAqIGlzIG5hbWVzcGFjZWQgYnkgaXNzdWUgbnVtYmVyIChgaXNzdWVfbGFiZWxzXyR7bnVtfWApOyBwYWlyIHdpdGggYVxuICogc2hvcnQgVFRMIG9uIHRoZSBzdXBwbGllZCBgSXNzdWVDYWNoZWAgKDYw4oCTMzAwcyByZWNvbW1lbmRlZCkgc29cbiAqIG11dGF0aW9ucyBlbHNld2hlcmUgYXJlIHZpc2libGUgcXVpY2tseS5cbiAqXG4gKiBSZXR1cm5zIGBudWxsYCBvbiBwYXJzZS92YWxpZGF0aW9uIGZhaWx1cmUgc28gY2FsbGVycyBjYW4gYXBwbHlcbiAqIGZhaWwtc2FmZSBiZWhhdmlvdXIgbWF0Y2hpbmcgdGhlIGV4aXN0aW5nIGlubGluZSBpbXBsZW1lbnRhdGlvbnMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaElzc3VlTGFiZWxzKFxuICByZXBvOiBzdHJpbmcsXG4gIGlzc3VlTnVtYmVyOiBudW1iZXIsXG4gIGNhY2hlPzogSXNzdWVDYWNoZSxcbiAgZ2hDb21tYW5kRm46IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+ID0gcnVuR2hDb21tYW5kLFxuKTogUHJvbWlzZTxzdHJpbmdbXSB8IG51bGw+IHtcbiAgY29uc3QgY2FjaGVLZXkgPSBgaXNzdWVfbGFiZWxzXyR7aXNzdWVOdW1iZXJ9YDtcblxuICBpZiAoY2FjaGUpIHtcbiAgICBjb25zdCBjYWNoZWQgPSBhd2FpdCBjYWNoZS5yZWFkPHN0cmluZ1tdPihyZXBvLCBjYWNoZUtleSk7XG4gICAgaWYgKGNhY2hlZCkgcmV0dXJuIGNhY2hlZDtcbiAgfVxuXG4gIGxldCByYXc6IHN0cmluZztcbiAgdHJ5IHtcbiAgICByYXcgPSBhd2FpdCBnaENvbW1hbmRGbihbXG4gICAgICBcImlzc3VlXCIsXG4gICAgICBcInZpZXdcIixcbiAgICAgIFN0cmluZyhpc3N1ZU51bWJlciksXG4gICAgICBcIi0tcmVwb1wiLFxuICAgICAgcmVwbyxcbiAgICAgIFwiLS1qc29uXCIsXG4gICAgICBcImxhYmVsc1wiLFxuICAgIF0pO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIGxldCBwYXJzZWQ6IHVua25vd247XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gSlNPTi5wYXJzZShyYXcpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIGNvbnN0IHZhbGlkYXRlZCA9IHZhbGlkYXRlSXNzdWVMYWJlbHNKc29uKHBhcnNlZCk7XG4gIGlmICghdmFsaWRhdGVkLm9rKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCBsYWJlbHMgPSB2YWxpZGF0ZWQudmFsdWUubGFiZWxzLm1hcCgobCkgPT4gbC5uYW1lKTtcbiAgaWYgKGNhY2hlKSBhd2FpdCBjYWNoZS53cml0ZShyZXBvLCBjYWNoZUtleSwgbGFiZWxzKTtcbiAgcmV0dXJuIGxhYmVscztcbn1cblxuLyoqXG4gKiBDaGVjayBpZiBhbiBpc3N1ZSBoYXMgdGhlIGlnbm9yZS1vcGVuLXBycyBsYWJlbCBhZGRlZCBieSBhbiBhbGxvd2VkIGF1dGhvci5cbiAqXG4gKiBJc3N1ZSAjMTc4Nzogcm91dGVzIHRoZSBwZXItaXNzdWUgbGFiZWwgZmV0Y2ggdGhyb3VnaCB0aGUgbmV3XG4gKiBgZmV0Y2hJc3N1ZUxhYmVsc2AgaGVscGVyIHNvIGR1cGxpY2F0ZSByZWFkcyBhY3Jvc3MgdGhlIGNhbmRpZGF0ZVxuICogY29sbGVjdG9ycyAoZWFjaCBvbmUgY2FsbHMgYGhhc0lnbm9yZU9wZW5QUnNMYWJlbGAgZm9yIGJsb2NrZWRcbiAqIGlzc3VlcykgY29sbGFwc2UgdG8gb25lIGBnaCBpc3N1ZSB2aWV3YCBjYWxsIHBlciBpdGVyYXRpb24uXG4gKlxuICogQHBhcmFtIHJlcG8gLSBSZXBvc2l0b3J5IGluIFwib3duZXIvcmVwb1wiIGZvcm1hdFxuICogQHBhcmFtIGlzc3VlTnVtYmVyIC0gSXNzdWUgbnVtYmVyXG4gKiBAcGFyYW0gaWdub3JlTGFiZWwgLSBUaGUgaWdub3JlLW9wZW4tcHJzIGxhYmVsIG5hbWVcbiAqIEBwYXJhbSBhbGxvd2VkQXV0aG9ycyAtIEF1dGhvcmlzZWQgR2l0SHViIHVzZXJuYW1lc1xuICogQHBhcmFtIGdoQ29tbWFuZEZuIC0gT3B0aW9uYWwgZ2ggY29tbWFuZCBmdW5jdGlvbiBmb3IgdGVzdGluZ1xuICogQHBhcmFtIGNhY2hlIC0gT3B0aW9uYWwgdGltZWxpbmUgY2FjaGUgZm9yIHJlYWQtdGhyb3VnaCBsYWJlbC1hdXRob3IgY2hlY2tcbiAqIEBwYXJhbSBpc3N1ZUNhY2hlIC0gT3B0aW9uYWwgaXNzdWUgY2FjaGUgZm9yIHJlYWQtdGhyb3VnaCBsYWJlbCBmZXRjaFxuICogQHBhcmFtIGxpc3RlZExhYmVscyAtIFRoZSBsYWJlbHMgdGhlIHNjYW4ncyBsaXN0aW5nIGFscmVhZHkgcmV0dXJuZWQgZm9yXG4gKiAgIHRoaXMgaXNzdWUgKElzc3VlICMyNjYyKS4gV2hlbiBzdXBwbGllZCwgbm8gYGdoIGlzc3VlIHZpZXcgLS1qc29uIGxhYmVsc2BcbiAqICAgaXMgbWFkZTsgdGhlIGxhYmVsJ3MgYXV0aG9yIGlzIHN0aWxsIHZlcmlmaWVkIGFnYWluc3QgdGhlIHRpbWVsaW5lLlxuICogQHJldHVybnMgVHJ1ZSBpZiB0aGUgbGFiZWwgd2FzIGFkZGVkIGJ5IGFuIGFsbG93ZWQgYXV0aG9yXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYXNJZ25vcmVPcGVuUFJzTGFiZWwoXG4gIHJlcG86IHN0cmluZyxcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbiAgaWdub3JlTGFiZWw6IHN0cmluZyxcbiAgYWxsb3dlZEF1dGhvcnM6IHN0cmluZ1tdLFxuICBnaENvbW1hbmRGbjogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz4gPSBydW5HaENvbW1hbmQsXG4gIGNhY2hlPzogVGltZWxpbmVDYWNoZSxcbiAgaXNzdWVDYWNoZT86IElzc3VlQ2FjaGUsXG4gIGxpc3RlZExhYmVscz86IHJlYWRvbmx5IHN0cmluZ1tdLFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IGxhYmVscyA9IGxpc3RlZExhYmVscyA/PyBhd2FpdCBmZXRjaElzc3VlTGFiZWxzKFxuICAgIHJlcG8sXG4gICAgaXNzdWVOdW1iZXIsXG4gICAgaXNzdWVDYWNoZSxcbiAgICBnaENvbW1hbmRGbixcbiAgKTtcbiAgaWYgKGxhYmVscyA9PT0gbnVsbCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoIWxhYmVscy5pbmNsdWRlcyhpZ25vcmVMYWJlbCkpIHJldHVybiBmYWxzZTtcblxuICAvLyBWZXJpZnkgbGFiZWwgd2FzIGFkZGVkIGJ5IGFuIGFsbG93ZWQgYXV0aG9yXG4gIHJldHVybiBhd2FpdCB3YXNMYWJlbEFkZGVkQnlBbGxvd2VkQXV0aG9yKFxuICAgIHJlcG8sXG4gICAgaXNzdWVOdW1iZXIsXG4gICAgaWdub3JlTGFiZWwsXG4gICAgYWxsb3dlZEF1dGhvcnMsXG4gICAgZ2hDb21tYW5kRm4sXG4gICAgY2FjaGUsXG4gICk7XG59XG5cbi8qKlxuICogSW5mb3JtYXRpb24gYWJvdXQgdGhlIG1vc3QgcmVjZW50IFwibGFiZWxlZFwiIGV2ZW50IGZvciBhIGdpdmVuIGxhYmVsLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIExhYmVsTGFzdEFkZEluZm8ge1xuICAvKiogVW5peCB0aW1lc3RhbXAgKHNlY29uZHMpIHdoZW4gdGhlIGxhYmVsIHdhcyBsYXN0IGFkZGVkLiAqL1xuICBhZGRlZEF0OiBudW1iZXI7XG4gIC8qKiBHaXRIdWIgdXNlcm5hbWUgdGhhdCBhZGRlZCB0aGUgbGFiZWwuICovXG4gIGFkZGVkQnk6IHN0cmluZztcbn1cblxuLyoqXG4gKiBGZXRjaCAob3IgcmVhZCBmcm9tIGNhY2hlKSB0aGUgKipjb21wbGV0ZSoqIHBhcnNlZCB0aW1lbGluZSBmb3IgdGhlIGdpdmVuXG4gKiBpc3N1ZSwgcmV0dXJuaW5nIGBudWxsYCBpbnN0ZWFkIG9mIHRocm93aW5nIChJc3N1ZSAjMTY3MywgIzMzMjcpLlxuICpcbiAqIEV2ZXJ5IGNhbGxlciBhc2tzIGEgXCJtb3N0IHJlY2VudCBldmVudFwiIHF1ZXN0aW9uIOKAlCB0aGUgbGF0ZXN0XG4gKiBgbmVlZHMtaHVtYW5gIHJlbW92YWwgKCMxODc4KSwgdGhlIGxhdGVzdCB0cnVzdGVkIHJlLWFwcHJvdmFsLCB0aGUgbGF0ZXN0XG4gKiByZW9wZW4g4oCUIHNvIHRoZSBhbnN3ZXIgbXVzdCBjb21lIGZyb20gdGhlIHdob2xlIHRpbWVsaW5lLiBUaGlzIHVzZWQgdG8gcmVhZFxuICogYHRpbWVsaW5lP3Blcl9wYWdlPTEwMGAgYWxvbmUsIHdoaWNoIGlzIHBhZ2UgMTogdGhlICoqb2xkZXN0KiogMTAwIGV2ZW50cy5cbiAqIE9uIGEgYnVzeSBpc3N1ZSAoR1JRLUF1dG9UcmFkZXIjMjA4OSwgMTMxIGV2ZW50cykgdGhlIGRldmVsb3BlcidzIHJlbW92YWxcbiAqIHNhdCBvbiBwYWdlIDIsIHRoZSBsb29rdXAgcmV0dXJuZWQgYSByZW1vdmFsIGZyb20gZm91ciBkYXlzIGVhcmxpZXIsIGFuZCB0aGVcbiAqIGdyaWxsLW1lIHByb2Nlc3NvciByZS1hZGRlZCBgbmVlZHMtaHVtYW5gIG9uIGV2ZXJ5IHNjYW4gKElzc3VlICMzMzI3KS5cbiAqXG4gKiBEZWxlZ2F0ZXMgdG8ge0BsaW5rIGZldGNoQ29tcGxldGVUaW1lbGluZX06IGEgY29tcGxldGUgY2FjaGUgZW50cnkgaXNcbiAqIGhvbm91cmVkLCBhIHBhcnRpYWwgb25lIGlzIHJlZnVzZWQsIGFuZCB0aGUgUkVTVCB0aW1lbGluZSBpcyBwYWdpbmF0ZWQgdG9cbiAqIGV4aGF1c3Rpb24uIEVycm9ycywgdmFsaWRhdGlvbiBmYWlsdXJlcyBhbmQgdGhlIHBhZ2UgY2FwIGZhbGwgdGhyb3VnaCB0byBhXG4gKiBgbnVsbGAgcmV0dXJuIHNvIGVhY2ggY2FsbGVyIGtlZXBzIGl0cyBvd24gZmFpbC1zYWZlIGJlaGF2aW91ciDigJQgYSB0aW1lbGluZVxuICogdGhhdCBjb3VsZCBub3QgYmUgcmVhZCBpbiBmdWxsIGlzIG5ldmVyIHRyZWF0ZWQgYXMgYXV0aG9yaXRhdGl2ZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoVGltZWxpbmVXaXRoQ2FjaGUoXG4gIHJlcG86IHN0cmluZyxcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbiAgZ2hDb21tYW5kRm46IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+LFxuICBjYWNoZT86IFRpbWVsaW5lQ2FjaGUsXG4pOiBQcm9taXNlPFRpbWVsaW5lTGFiZWxFdmVudEpzb25bXSB8IG51bGw+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgZmV0Y2hDb21wbGV0ZVRpbWVsaW5lKHJlcG8sIGlzc3VlTnVtYmVyLCBnaENvbW1hbmRGbiwgY2FjaGUpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vKipcbiAqIEdldCBpbmZvcm1hdGlvbiBhYm91dCB0aGUgbW9zdCByZWNlbnQgXCJsYWJlbGVkXCIgZXZlbnQgZm9yIHRoZSBnaXZlbiBsYWJlbFxuICogb24gdGhlIGdpdmVuIGlzc3VlIChJc3N1ZSAjMTU2MSkuXG4gKlxuICogVXNlZCB0byBkZXRlY3QgcmUtYXBwcm92YWw6IGlmIGEgdHJ1c3RlZCBhdXRob3IgcmUtYWRkcyB0aGUgd29yay1vbiBsYWJlbFxuICogYWZ0ZXIgdGhlIHdvcmtlciBjYXB0dXJlZCBhIGNvbnRlbnQgc25hcHNob3QsIHRoZSBsYXRlciBsYWJlbC1hZGQgZXZlbnRcbiAqIGluZGljYXRlcyBhIGZyZXNoIGFwcHJvdmFsIGFuZCB0aGUgc3RvcmVkIHNuYXBzaG90IHNob3VsZCBiZSByZWZyZXNoZWRcbiAqIHJhdGhlciB0aGFuIHRyaWdnZXJpbmcgYSBmYWxzZSBcIklzc3VlIE1vZGlmaWVkIEFmdGVyIEFwcHJvdmFsXCIgYWxhcm0uXG4gKlxuICogSXNzdWUgIzE2NzM6IFdoZW4gYGNhY2hlYCBpcyBwcm92aWRlZCwgcmVhZHMgZnJvbSB0aGUgZmlsZS1iYWNrZWQgVFRMXG4gKiBjYWNoZSBiZWZvcmUgaXNzdWluZyBhIGBnaCBhcGkgLi4uL3RpbWVsaW5lYCBjYWxsLlxuICpcbiAqIEByZXR1cm5zIGB7IGFkZGVkQXQsIGFkZGVkQnkgfWAgd2hlbiB0aGUgdGltZWxpbmUgY29udGFpbnMgYSBcImxhYmVsZWRcIlxuICogICBldmVudCBmb3IgdGhpcyBsYWJlbCB3aXRoIGEgcGFyc2VhYmxlIHRpbWVzdGFtcCwgb3RoZXJ3aXNlIGBudWxsYC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldExhYmVsTGFzdEFkZEluZm8oXG4gIHJlcG86IHN0cmluZyxcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbiAgbGFiZWxOYW1lOiBzdHJpbmcsXG4gIGdoQ29tbWFuZEZuOiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPiA9IHJ1bkdoQ29tbWFuZCxcbiAgY2FjaGU/OiBUaW1lbGluZUNhY2hlLFxuKTogUHJvbWlzZTxMYWJlbExhc3RBZGRJbmZvIHwgbnVsbD4ge1xuICBjb25zdCB0aW1lbGluZSA9IGF3YWl0IGZldGNoVGltZWxpbmVXaXRoQ2FjaGUoXG4gICAgcmVwbyxcbiAgICBpc3N1ZU51bWJlcixcbiAgICBnaENvbW1hbmRGbixcbiAgICBjYWNoZSxcbiAgKTtcbiAgaWYgKHRpbWVsaW5lID09PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIGxhc3RBZGRJbmZvRnJvbVRpbWVsaW5lKHRpbWVsaW5lLCBsYWJlbE5hbWUpO1xufVxuXG4vKipcbiAqIEV4dHJhY3QgdGhlIG1vc3QtcmVjZW50IGBsYWJlbGVkYCBldmVudCBmb3IgYGxhYmVsTmFtZWAgZnJvbSBhbiBhbHJlYWR5XG4gKiBmZXRjaGVkIHRpbWVsaW5lLiBTaGFyZWQgYnkge0BsaW5rIGdldExhYmVsTGFzdEFkZEluZm99IChmYWlsLXNhZmUgYG51bGxgKVxuICogYW5kIHtAbGluayBnZXRMYWJlbExhc3RBZGRJbmZvQ29tcGxldGV9IChlcnJvcnMgcHJvcGFnYXRlKS5cbiAqXG4gKiBJc3N1ZSAjMTYxNzogZXhwb3J0ZWQgc28gYSBjYWxsZXIgdGhhdCBuZWVkcyAqYm90aCogdGhlIGxhc3QgYWRkIGFuZCB0aGVcbiAqIGxhc3QgcmVtb3ZlIOKAlCB0aGUgY29udGVudC1hcHByb3ZhbCBnYXRlLCB3aGljaCBjb3VudHMgYSB0cnVzdGVkXG4gKiBgbmVlZHMtaHVtYW5gIHJlbW92YWwgYXMgcmUtYXBwcm92YWwg4oCUIGNhbiBhbnN3ZXIgYm90aCBmcm9tIGEgc2luZ2xlXG4gKiB7QGxpbmsgZmV0Y2hUaW1lbGluZVdpdGhDYWNoZX0gY2FsbCByYXRoZXIgdGhhbiBmZXRjaGluZyB0aGUgdGltZWxpbmUgdHdpY2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsYXN0QWRkSW5mb0Zyb21UaW1lbGluZShcbiAgdGltZWxpbmU6IFRpbWVsaW5lTGFiZWxFdmVudEpzb25bXSxcbiAgbGFiZWxOYW1lOiBzdHJpbmcsXG4pOiBMYWJlbExhc3RBZGRJbmZvIHwgbnVsbCB7XG4gIGNvbnN0IGxhYmVsRXZlbnRzID0gdGltZWxpbmUuZmlsdGVyKFxuICAgIChlKSA9PiBlLmV2ZW50ID09PSBcImxhYmVsZWRcIiAmJiBlLmxhYmVsPy5uYW1lID09PSBsYWJlbE5hbWUsXG4gICk7XG4gIGNvbnN0IGxhc3RFdmVudCA9IGxhYmVsRXZlbnRzW2xhYmVsRXZlbnRzLmxlbmd0aCAtIDFdO1xuICBpZiAoIWxhc3RFdmVudD8uYWN0b3I/LmxvZ2luKSByZXR1cm4gbnVsbDtcbiAgaWYgKCFsYXN0RXZlbnQuY3JlYXRlZF9hdCkgcmV0dXJuIG51bGw7XG5cbiAgY29uc3QgbXMgPSBEYXRlLnBhcnNlKGxhc3RFdmVudC5jcmVhdGVkX2F0KTtcbiAgaWYgKE51bWJlci5pc05hTihtcykpIHJldHVybiBudWxsO1xuXG4gIHJldHVybiB7XG4gICAgYWRkZWRBdDogTWF0aC5mbG9vcihtcyAvIDEwMDApLFxuICAgIGFkZGVkQnk6IGxhc3RFdmVudC5hY3Rvci5sb2dpbixcbiAgfTtcbn1cblxuLyoqXG4gKiBFeGhhdXN0aXZlIHZhcmlhbnQgb2Yge0BsaW5rIGdldExhYmVsTGFzdEFkZEluZm99IGZvciBjYWxsZXJzIHRoYXQgKiptdXRhdGUqKlxuICogb24gdGhlIGFuc3dlciAoSXNzdWUgIzM3MDksIFNFQy1jNDFlOTdiNjAyMzgpLlxuICpcbiAqIEJvdGggdmFyaWFudHMgcmVhZCB0aGUgZnVsbHkgcGFnaW5hdGVkIHRpbWVsaW5lIGFuZCByZWZ1c2UgcGFydGlhbCBjYWNoZVxuICogZW50cmllcyAoSXNzdWUgIzMzMjcgYnJvdWdodCBgZ2V0TGFiZWxMYXN0QWRkSW5mb2AgdXAgdG8gdGhpcyBzb3VyY2Ugb2ZcbiAqIHRydXRoKS4gVGhleSBkaWZmZXIgb25seSBvbiBmYWlsdXJlOiBgZ2V0TGFiZWxMYXN0QWRkSW5mb2AgcmV0dXJucyBgbnVsbGAsXG4gKiB3aGlsZSB0aGlzIHZhcmlhbnQgbGV0cyBlcnJvcnMgYW5kIHBhZ2UgY2FwcyBwcm9wYWdhdGUgc28gYSBjYWxsZXIgdGhhdFxuICogcmVtb3ZlcyBhIGxhYmVsIGFuZCBuYW1lcyB0aGUgYWRkZXIgaW4gYSBwdWJsaWMgY29tbWVudFxuICogKGBzdHJpcFVudHJ1c3RlZFdvcmtPbkxhYmVsYCkgY2FuIGZhaWwgY2xvc2VkIHJhdGhlciB0aGFuIGFjdCBvbiBub3RoaW5nLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0TGFiZWxMYXN0QWRkSW5mb0NvbXBsZXRlKFxuICByZXBvOiBzdHJpbmcsXG4gIGlzc3VlTnVtYmVyOiBudW1iZXIsXG4gIGxhYmVsTmFtZTogc3RyaW5nLFxuICBnaENvbW1hbmRGbjogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz4gPSBydW5HaENvbW1hbmQsXG4gIGNhY2hlPzogVGltZWxpbmVDYWNoZSxcbik6IFByb21pc2U8TGFiZWxMYXN0QWRkSW5mbyB8IG51bGw+IHtcbiAgY29uc3QgdGltZWxpbmUgPSBhd2FpdCBmZXRjaENvbXBsZXRlVGltZWxpbmUoXG4gICAgcmVwbyxcbiAgICBpc3N1ZU51bWJlcixcbiAgICBnaENvbW1hbmRGbixcbiAgICBjYWNoZSxcbiAgKTtcbiAgaWYgKHRpbWVsaW5lID09PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIGxhc3RBZGRJbmZvRnJvbVRpbWVsaW5lKHRpbWVsaW5lLCBsYWJlbE5hbWUpO1xufVxuXG4vKipcbiAqIEluZm9ybWF0aW9uIGFib3V0IHRoZSBtb3N0IHJlY2VudCBcInVubGFiZWxlZFwiIGV2ZW50IGZvciBhIGdpdmVuIGxhYmVsLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIExhYmVsTGFzdFJlbW92ZUluZm8ge1xuICAvKiogVW5peCB0aW1lc3RhbXAgKHNlY29uZHMpIHdoZW4gdGhlIGxhYmVsIHdhcyBsYXN0IHJlbW92ZWQuICovXG4gIHJlbW92ZWRBdDogbnVtYmVyO1xuICAvKiogR2l0SHViIHVzZXJuYW1lIHRoYXQgcmVtb3ZlZCB0aGUgbGFiZWwuICovXG4gIHJlbW92ZWRCeTogc3RyaW5nO1xufVxuXG4vKipcbiAqIEdldCBpbmZvcm1hdGlvbiBhYm91dCB0aGUgbW9zdCByZWNlbnQgXCJ1bmxhYmVsZWRcIiBldmVudCBmb3IgdGhlIGdpdmVuXG4gKiBsYWJlbCBvbiB0aGUgZ2l2ZW4gaXNzdWUgKElzc3VlICMxODc4KS5cbiAqXG4gKiBVc2VkIGJ5IHRoZSBncmlsbC1tZSBwcm9jZXNzb3IgdG8gZGV0ZWN0IHdoZW4gYSBub24td29ya2VyIHVzZXIgaGFzXG4gKiBleHBsaWNpdGx5IHJlbW92ZWQgYG5lZWRzLWh1bWFuYCBhZnRlciBhIFJvdW5kIE4gY29tbWVudCB3YXMgcG9zdGVkIOKAlFxuICogdGhhdCByZW1vdmFsIGlzIHRoZSBkZXZlbG9wZXIncyBcImdvXCIgc2lnbmFsIGV2ZW4gaWYgbm8gc2VwYXJhdGUgcmVwbHlcbiAqIGNvbW1lbnQgd2FzIGF1dGhvcmVkLiBXaXRob3V0IHRoaXMgc2lnbmFsIHRoZSB3b3JrZXIga2VlcHMgcmUtYWRkaW5nXG4gKiBgbmVlZHMtaHVtYW5gIHdoZW5ldmVyIHRoZSB1c2VyIHJlbW92ZXMgaXQsIHByb2R1Y2luZyB0aGVcbiAqIFwiY29uc3RhbnRseSBsYWJlbGxpbmcgYXMgbmVlZHMtaHVtYW5cIiBsb29wIHRoZSBpc3N1ZSByZXBvcnRzLlxuICpcbiAqIE1pcnJvcnMgYGdldExhYmVsTGFzdEFkZEluZm9gIGJ1dCBpbnNwZWN0cyBgdW5sYWJlbGVkYCBldmVudHMgaW5zdGVhZFxuICogb2YgYGxhYmVsZWRgLiBXaGVuIGBjYWNoZWAgaXMgcHJvdmlkZWQsIHJlYWRzIGZyb20gdGhlIGZpbGUtYmFja2VkXG4gKiBUVEwgY2FjaGUgYmVmb3JlIGlzc3VpbmcgYSBgZ2ggYXBpIC4uLi90aW1lbGluZWAgY2FsbC5cbiAqXG4gKiBAcmV0dXJucyBgeyByZW1vdmVkQXQsIHJlbW92ZWRCeSB9YCB3aGVuIHRoZSB0aW1lbGluZSBjb250YWlucyBhblxuICogICBgdW5sYWJlbGVkYCBldmVudCBmb3IgdGhpcyBsYWJlbCB3aXRoIGEgcGFyc2VhYmxlIHRpbWVzdGFtcCxcbiAqICAgb3RoZXJ3aXNlIGBudWxsYC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldExhYmVsTGFzdFJlbW92ZUluZm8oXG4gIHJlcG86IHN0cmluZyxcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbiAgbGFiZWxOYW1lOiBzdHJpbmcsXG4gIGdoQ29tbWFuZEZuOiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPiA9IHJ1bkdoQ29tbWFuZCxcbiAgY2FjaGU/OiBUaW1lbGluZUNhY2hlLFxuKTogUHJvbWlzZTxMYWJlbExhc3RSZW1vdmVJbmZvIHwgbnVsbD4ge1xuICBjb25zdCB0aW1lbGluZSA9IGF3YWl0IGZldGNoVGltZWxpbmVXaXRoQ2FjaGUoXG4gICAgcmVwbyxcbiAgICBpc3N1ZU51bWJlcixcbiAgICBnaENvbW1hbmRGbixcbiAgICBjYWNoZSxcbiAgKTtcbiAgaWYgKHRpbWVsaW5lID09PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIGxhc3RSZW1vdmVJbmZvRnJvbVRpbWVsaW5lKHRpbWVsaW5lLCBsYWJlbE5hbWUpO1xufVxuXG4vKipcbiAqIEV4dHJhY3QgdGhlIG1vc3QtcmVjZW50IGB1bmxhYmVsZWRgIGV2ZW50IGZvciBgbGFiZWxOYW1lYCBmcm9tIGFuIGFscmVhZHlcbiAqIGZldGNoZWQgdGltZWxpbmUgKElzc3VlICMxNjE3KS5cbiAqXG4gKiBUaGUgbWlycm9yIG9mIHtAbGluayBsYXN0QWRkSW5mb0Zyb21UaW1lbGluZX0sIGV4dHJhY3RlZCBmcm9tXG4gKiB7QGxpbmsgZ2V0TGFiZWxMYXN0UmVtb3ZlSW5mb30gc28gYm90aCBxdWVzdGlvbnMgY2FuIGJlIGFuc3dlcmVkIGZyb20gb25lXG4gKiBmZXRjaGVkIHRpbWVsaW5lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbGFzdFJlbW92ZUluZm9Gcm9tVGltZWxpbmUoXG4gIHRpbWVsaW5lOiBUaW1lbGluZUxhYmVsRXZlbnRKc29uW10sXG4gIGxhYmVsTmFtZTogc3RyaW5nLFxuKTogTGFiZWxMYXN0UmVtb3ZlSW5mbyB8IG51bGwge1xuICBjb25zdCBsYWJlbEV2ZW50cyA9IHRpbWVsaW5lLmZpbHRlcihcbiAgICAoZSkgPT4gZS5ldmVudCA9PT0gXCJ1bmxhYmVsZWRcIiAmJiBlLmxhYmVsPy5uYW1lID09PSBsYWJlbE5hbWUsXG4gICk7XG4gIGNvbnN0IGxhc3RFdmVudCA9IGxhYmVsRXZlbnRzW2xhYmVsRXZlbnRzLmxlbmd0aCAtIDFdO1xuICBpZiAoIWxhc3RFdmVudD8uYWN0b3I/LmxvZ2luKSByZXR1cm4gbnVsbDtcbiAgaWYgKCFsYXN0RXZlbnQuY3JlYXRlZF9hdCkgcmV0dXJuIG51bGw7XG5cbiAgY29uc3QgbXMgPSBEYXRlLnBhcnNlKGxhc3RFdmVudC5jcmVhdGVkX2F0KTtcbiAgaWYgKE51bWJlci5pc05hTihtcykpIHJldHVybiBudWxsO1xuXG4gIHJldHVybiB7XG4gICAgcmVtb3ZlZEF0OiBNYXRoLmZsb29yKG1zIC8gMTAwMCksXG4gICAgcmVtb3ZlZEJ5OiBsYXN0RXZlbnQuYWN0b3IubG9naW4sXG4gIH07XG59XG5cbi8qKlxuICogVGhlIG1vc3QgcmVjZW50IGBhc3NpZ25lZGAgZXZlbnQgZm9yIGBsb2dpbmAgaW4gYSBjaHJvbm9sb2dpY2FsIHRpbWVsaW5lXG4gKiAob2xkZXN0IGZpcnN0KSwgb3IgbnVsbCB3aGVuIGFic2VudCAoSXNzdWUgIzM0NzYpLiBUaGUgbGFzdCBtYXRjaGluZyBldmVudFxuICogaXMgdGhlIGxhdGVzdCwgbWF0Y2hpbmcge0BsaW5rIGxhc3RSZW1vdmVJbmZvRnJvbVRpbWVsaW5lfS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxhdGVzdEFzc2lnbmVkQXRGcm9tVGltZWxpbmUoXG4gIHRpbWVsaW5lOiBUaW1lbGluZUxhYmVsRXZlbnRKc29uW10sXG4gIGxvZ2luOiBzdHJpbmcsXG4pOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgYXNzaWduZWQgPSB0aW1lbGluZS5maWx0ZXIoXG4gICAgKGUpID0+IGUuZXZlbnQgPT09IFwiYXNzaWduZWRcIiAmJiBlLmFzc2lnbmVlPy5sb2dpbiA9PT0gbG9naW4sXG4gICk7XG4gIGNvbnN0IGxhc3QgPSBhc3NpZ25lZFthc3NpZ25lZC5sZW5ndGggLSAxXTtcbiAgcmV0dXJuIGxhc3Q/LmNyZWF0ZWRfYXQgPz8gbnVsbDtcbn1cblxuLyoqXG4gKiBUaGUgbW9zdCByZWNlbnQgYHJlb3BlbmVkYCBldmVudCBpbiBhIGNocm9ub2xvZ2ljYWwgdGltZWxpbmUgKG9sZGVzdFxuICogZmlyc3QpLCBvciBudWxsIHdoZW4gYWJzZW50IChJc3N1ZSAjMzQ3NikuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsYXRlc3RSZW9wZW5lZEF0RnJvbVRpbWVsaW5lKFxuICB0aW1lbGluZTogVGltZWxpbmVMYWJlbEV2ZW50SnNvbltdLFxuKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IHJlb3BlbmVkID0gdGltZWxpbmUuZmlsdGVyKChlKSA9PiBlLmV2ZW50ID09PSBcInJlb3BlbmVkXCIpO1xuICBjb25zdCBsYXN0ID0gcmVvcGVuZWRbcmVvcGVuZWQubGVuZ3RoIC0gMV07XG4gIHJldHVybiBsYXN0Py5jcmVhdGVkX2F0ID8/IG51bGw7XG59XG5cbi8qKlxuICogUkVTVCB0aW1lbGluZSBwYWdlIHNpemUgKHRoZSBHaXRIdWIgQVBJIG1heGltdW0pIGFuZCB0aGUgaGFyZCBwYWdlIGNhcCB1c2VkXG4gKiBieSB0aGUgcGFnaW5hdGVkIHJlc2VydmVkLWxhYmVsIHRydXN0IGdhdGUgKElzc3VlICMzMjAwKS4gTWlycm9ycyB0aGVcbiAqIGNvbnN0YW50cyBpbiBgdmVyaWZ5T3BlcmF0aW9uYWxMYWJlbHNgIChJc3N1ZSAjMzE2NSk6IGEgZnVsbCBwYWdlIGF0IHRoZSBjYXBcbiAqIG1lYW5zIG1vcmUgZXZlbnRzIG1heSBleGlzdCB0aGFuIHdlIGNhbiByZWFkLCBzbyB0aGUgZ2F0ZSBmYWlscyBjbG9zZWQgcmF0aGVyXG4gKiB0aGFuIGhvbm91ciBhIHBvc3NpYmx5LXN0YWxlIHRydXN0ZWQgYWRkLlxuICovXG5jb25zdCBUSU1FTElORV9QRVJfUEFHRSA9IDEwMDtcbmNvbnN0IE1BWF9USU1FTElORV9QQUdFUyA9IDEwMDtcblxuLyoqXG4gKiBSZWFkIHRoZSBSRVNUIHRpbWVsaW5lIHRvIGV4aGF1c3Rpb24sIHdyaXRpbmcgdGhlIHJlc3VsdCB0byBgY2FjaGVgIGFzIGFcbiAqICoqY29tcGxldGUqKiBlbnRyeSAoSXNzdWUgIzMyMDAsIGV4dHJhY3RlZCBpbiBJc3N1ZSAjMzcwOSkuXG4gKlxuICogRGVsaWJlcmF0ZWx5IGRvZXMgbm90IHJlYWQgZnJvbSB0aGUgY2FjaGU6IGNhbGxlcnMgZGlmZmVyIG9uIHdoYXQgYSBjYWNoZWRcbiAqIGVudHJ5IG1heSBiZSB1c2VkIGZvciwgc28gdGhlIGNhY2hlLXJlYWQgcG9saWN5IHN0YXlzIHdpdGggdGhlbS5cbiAqXG4gKiBAcmV0dXJucyBldmVyeSB0aW1lbGluZSBldmVudCwgb3IgbnVsbCB3aGVuIGEgcGFnZSBmYWlscyB2YWxpZGF0aW9uLlxuICogQHRocm93cyB3aGVuIGBnaENvbW1hbmRGbmAgZmFpbHMsIGEgcGFnZSBpcyB1bnBhcnNlYWJsZSwgb3IgdGhlIHRpbWVsaW5lXG4gKiAgIGV4Y2VlZHMge0BsaW5rIE1BWF9USU1FTElORV9QQUdFU30g4oCUIGZhaWxpbmcgY2xvc2VkIHJhdGhlciB0aGFuIGFjdGluZyBvblxuICogICBhIHRpbWVsaW5lIHRoYXQgY291bGQgbm90IGJlIHJlYWQgaW4gZnVsbC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcGFnaW5hdGVUaW1lbGluZShcbiAgcmVwbzogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuICBnaENvbW1hbmRGbjogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz4sXG4gIGNhY2hlPzogVGltZWxpbmVDYWNoZSxcbik6IFByb21pc2U8VGltZWxpbmVMYWJlbEV2ZW50SnNvbltdIHwgbnVsbD4ge1xuICBjb25zdCB0aW1lbGluZTogVGltZWxpbmVMYWJlbEV2ZW50SnNvbltdID0gW107XG4gIGZvciAobGV0IHBhZ2UgPSAxOyBwYWdlIDw9IE1BWF9USU1FTElORV9QQUdFUzsgcGFnZSsrKSB7XG4gICAgY29uc3QgdGltZWxpbmVKc29uID0gYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgICAgXCJhcGlcIixcbiAgICAgIGByZXBvcy8ke3JlcG99L2lzc3Vlcy8ke2lzc3VlTnVtYmVyfS90aW1lbGluZT9wZXJfcGFnZT0ke1RJTUVMSU5FX1BFUl9QQUdFfSZwYWdlPSR7cGFnZX1gLFxuICAgIF0pO1xuICAgIGNvbnN0IHBhcnNlZFRpbWVsaW5lOiB1bmtub3duID0gSlNPTi5wYXJzZSh0aW1lbGluZUpzb24pO1xuICAgIGNvbnN0IHRpbWVsaW5lVmFsaWRhdGVkID0gdmFsaWRhdGVUaW1lbGluZUxhYmVsRXZlbnRzSnNvbihwYXJzZWRUaW1lbGluZSk7XG4gICAgaWYgKCF0aW1lbGluZVZhbGlkYXRlZC5vaykgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgcGFnZUV2ZW50cyA9IHRpbWVsaW5lVmFsaWRhdGVkLnZhbHVlO1xuICAgIHRpbWVsaW5lLnB1c2goLi4ucGFnZUV2ZW50cyk7XG4gICAgaWYgKHBhZ2VFdmVudHMubGVuZ3RoIDwgVElNRUxJTkVfUEVSX1BBR0UpIHtcbiAgICAgIC8vIEEgc2hvcnQgKG9yIGVtcHR5KSBwYWdlIGlzIHRoZSBsYXN0IHBhZ2Ug4oCUIHN0b3AgcGFnaW5hdGluZy5cbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBpZiAocGFnZSA9PT0gTUFYX1RJTUVMSU5FX1BBR0VTKSB7XG4gICAgICAvLyBBIGZ1bGwgcGFnZSBhdCB0aGUgY2FwIG1lYW5zIG1vcmUgZXZlbnRzIG1heSBleGlzdCBiZXlvbmQgd2hhdCB3ZSBjYW5cbiAgICAgIC8vIHJlYWQuIFRocm93IHJhdGhlciB0aGFuIGhvbm91ciBhIHBvc3NpYmx5LXN0YWxlIHRydXN0ZWQgYWRkIOKAlCB0aGVcbiAgICAgIC8vIGNhbGxlcidzIGNvbnRyYWN0IGlzIHRvIHN1cmZhY2UgKG5vdCBzd2FsbG93KSBhbiB1bnJlc29sdmFibGUgdGltZWxpbmUuXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGB0aW1lbGluZSBleGNlZWRlZCAke01BWF9USU1FTElORV9QQUdFU30gcGFnZXMg4oCUIGZhaWxpbmcgY2xvc2VkYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgLy8gUGFnaW5hdGVkIHRvIGV4aGF1c3Rpb24sIHNvIG1hcmsgdGhlIGNhY2hlZCBlbnRyeSBjb21wbGV0ZSAoSXNzdWUgIzMyOTYpLlxuICBpZiAoY2FjaGUpIGF3YWl0IGNhY2hlLndyaXRlKHJlcG8sIGlzc3VlTnVtYmVyLCB0aW1lbGluZSwgdHJ1ZSk7XG4gIHJldHVybiB0aW1lbGluZTtcbn1cblxuLyoqXG4gKiBGZXRjaCB0aGUgZnVsbCB0aW1lbGluZSBmb3IgYW4gaXNzdWUsIHByZWZlcnJpbmcgYSAqKmNvbXBsZXRlKiogY2FjaGUgZW50cnlcbiAqIChJc3N1ZSAjMzcwOSkuXG4gKlxuICogQSBwYXJ0aWFsIGNhY2hlIGVudHJ5IGlzIHJlZnVzZWQgYW5kIHRoZSBSRVNUIHRpbWVsaW5lIGlzIHBhZ2luYXRlZCB0b1xuICogZXhoYXVzdGlvbiBpbnN0ZWFkLiBFcnJvcnMgYW5kIHRoZSBwYWdlIGNhcCBwcm9wYWdhdGU7IHVzZVxuICoge0BsaW5rIGZldGNoVGltZWxpbmVXaXRoQ2FjaGV9IGZvciB0aGUgc2FtZSByZWFkIHdpdGggYSBmYWlsLXNhZmUgYG51bGxgLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hDb21wbGV0ZVRpbWVsaW5lKFxuICByZXBvOiBzdHJpbmcsXG4gIGlzc3VlTnVtYmVyOiBudW1iZXIsXG4gIGdoQ29tbWFuZEZuOiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPiA9IHJ1bkdoQ29tbWFuZCxcbiAgY2FjaGU/OiBUaW1lbGluZUNhY2hlLFxuKTogUHJvbWlzZTxUaW1lbGluZUxhYmVsRXZlbnRKc29uW10gfCBudWxsPiB7XG4gIGlmIChjYWNoZSkge1xuICAgIGNvbnN0IGNhY2hlZCA9IGF3YWl0IGNhY2hlLnJlYWRDb21wbGV0ZShyZXBvLCBpc3N1ZU51bWJlcik7XG4gICAgaWYgKGNhY2hlZCAhPT0gbnVsbCkgcmV0dXJuIGNhY2hlZDtcbiAgfVxuICByZXR1cm4gYXdhaXQgcGFnaW5hdGVUaW1lbGluZShyZXBvLCBpc3N1ZU51bWJlciwgZ2hDb21tYW5kRm4sIGNhY2hlKTtcbn1cblxuLyoqXG4gKiBDaGVjayBpZiBhIGxhYmVsIHdhcyBhZGRlZCBieSBhbiBhbGxvd2VkIGF1dGhvci5cbiAqXG4gKiBTZWN1cml0eSBjaGVjazogdmVyaWZpZXMgdGhlIGxhYmVsIHdhcyBhZGRlZCBieSBhbiBhdXRob3Jpc2VkIHVzZXJcbiAqIHRvIHByZXZlbnQgdW5hdXRob3Jpc2VkIHVzZXJzIGZyb20gZGlyZWN0aW5nIHRoZSB3b3JrZXIuXG4gKlxuICogSXNzdWUgIzE2NzM6IFdoZW4gYGNhY2hlYCBpcyBwcm92aWRlZCwgcmVhZHMgZnJvbSB0aGUgZmlsZS1iYWNrZWQgVFRMXG4gKiBjYWNoZSBiZWZvcmUgaXNzdWluZyBhIGBnaCBhcGkgLi4uL3RpbWVsaW5lYCBjYWxsLiBDYWNoZSBtaXNzZXMgZmFsbFxuICogdGhyb3VnaCB0byB0aGUgQVBJIHBhdGggYW5kIHN0b3JlIHRoZSByZXN1bHQgZm9yIHN1YnNlcXVlbnQgcmVhZHMuXG4gKlxuICogRmxlZXQtd29ya2VyIGV4Y2x1c2lvbiAoSXNzdWUgIzM0MTYpOiBpbiBhIG11bHRpLWFjY291bnQgZmxlZXQsIHNpYmxpbmdcbiAqIHdvcmtlciBsb2dpbnMgYXJlIHJlcXVpcmVkIHRvIGFwcGVhciBpbiBgYWxsb3dlZEF1dGhvcnNgICh0aGUgUFItZGVkdXBcbiAqIHJlcXVpcmVtZW50IOKAlCBzZWUgYHJlc29sdmVGbGVldEF1dGhvcnNgIC8gYGZsZWV0X3ByX2F1dGhvcnNgKS4gTGVmdFxuICogdW5jaGVja2VkLCB0aGF0IGxldHMgYSByZXNlcnZlZCBkaXNjb3ZlcnkgbGFiZWwgKGB3b3JrLW9uYCxcbiAqIGB0b3AtcHJpb3JpdHlgLCBgbG93LXByaW9yaXR5YCkgYSB3b3JrZXIgYXBwbGllZCBkaXJlY3RseSAoYnlwYXNzaW5nIHRoZVxuICogYGFkZExhYmVsVG9Jc3N1ZWAgYWxsb3dsaXN0KSBiZSBob25vdXJlZCBmbGVldC13aWRlIGluc3RlYWQgb2Ygc3RyaXBwZWQg4oCUXG4gKiBjb250cmFkaWN0aW5nIHRoZSBkb2N1bWVudGVkIGJhY2tzdG9wIGluIGB3b3JrZXJfbGFiZWxfZ3VhcmQudHNgLiBBbnlcbiAqIGxvZ2luIGluIGBmbGVldFdvcmtlckxvZ2luc2AgaXMgdGhlcmVmb3JlIHRyZWF0ZWQgYXMgdW50cnVzdGVkLCBtaXJyb3JpbmdcbiAqIGB2ZXJpZnlPcGVyYXRpb25hbExhYmVsc2AgKElzc3VlICMzMjI1KS4gRGVmYXVsdHMgdG8gYFtdYCBzbyBub24tZmxlZXRcbiAqIGNhbGxlcnMga2VlcCB0aGUgb3JpZ2luYWwgYmVoYXZpb3VyIGV4YWN0bHkuXG4gKlxuICogUGxhbm5pbmcgaGFuZC1vZmYgKElzc3VlICMyNjg4KTogdGhlIHNpbmdsZSBleGNlcHRpb24gaXMgYHBsYW5uaW5nYFxuICogYWRkZWQgYnkgYSBmbGVldCB3b3JrZXIgdG8gaGFuZCBvZmYgYSBgd29yay1vbmAgaXNzdWUgYSB0cnVzdGVkLFxuICogbm9uLXdvcmtlciBhdXRob3IgcXVldWVkIOKAlCBzZWUgYGlzV29ya2VyUGxhbm5pbmdIYW5kb2ZmYC5cbiAqXG4gKiBAcGFyYW0gcmVwbyAtIFJlcG9zaXRvcnkgaW4gXCJvd25lci9yZXBvXCIgZm9ybWF0XG4gKiBAcGFyYW0gaXNzdWVOdW1iZXIgLSBJc3N1ZSBudW1iZXJcbiAqIEBwYXJhbSBsYWJlbE5hbWUgLSBMYWJlbCB0byBjaGVja1xuICogQHBhcmFtIGFsbG93ZWRBdXRob3JzIC0gQXV0aG9yaXNlZCBHaXRIdWIgdXNlcm5hbWVzXG4gKiBAcGFyYW0gZ2hDb21tYW5kRm4gLSBPcHRpb25hbCBnaCBjb21tYW5kIGZ1bmN0aW9uIGZvciB0ZXN0aW5nXG4gKiBAcGFyYW0gY2FjaGUgLSBPcHRpb25hbCB0aW1lbGluZSBjYWNoZSBmb3IgcmVhZC10aHJvdWdoXG4gKiBAcGFyYW0gZmxlZXRXb3JrZXJMb2dpbnMgLSBGbGVldCB3b3JrZXIgbG9naW5zIChvd24gaG9zdCArIHNpYmxpbmdzKSBleGNsdWRlZCBmcm9tIGxhYmVsLWFkZGVyIHRydXN0IChJc3N1ZSAjMzQxNilcbiAqIEByZXR1cm5zIFRydWUgaWYgdGhlIGxhYmVsIHdhcyBhZGRlZCBieSBhbiBhbGxvd2VkIGF1dGhvclxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gd2FzTGFiZWxBZGRlZEJ5QWxsb3dlZEF1dGhvcihcbiAgcmVwbzogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuICBsYWJlbE5hbWU6IHN0cmluZyxcbiAgYWxsb3dlZEF1dGhvcnM6IHN0cmluZ1tdLFxuICBnaENvbW1hbmRGbjogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz4gPSBydW5HaENvbW1hbmQsXG4gIGNhY2hlPzogVGltZWxpbmVDYWNoZSxcbiAgZmxlZXRXb3JrZXJMb2dpbnM6IHN0cmluZ1tdID0gW10sXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgLy8gQSBjYWNoZSBoaXQgbWF5IG9ubHkgKmRlbnkqIHRydXN0LCBuZXZlciBncmFudCBpdCAoSXNzdWUgIzM3MDksXG4gIC8vIFNFQy1lNzBiODEzNGFmMjYpLlxuICAvL1xuICAvLyBUaGUgY2FjaGUgaXMgYSBmaWxlIHVuZGVyIFRNUERJUi4gYFRpbWVsaW5lQ2FjaGVgIG5vdyBiaW5kcyB0aGF0IGRpcmVjdG9yeVxuICAvLyB0byB0aGUgd29ya2VyJ3Mgb3duIGFjY291bnQgKHBlci11c2VyIHBhdGgsIDA3MDAsIG93bmVyc2hpcC1jaGVja2VkKSwgYnV0XG4gIC8vIGEgY2FjaGUgaXMgc3RpbGwgdGhlIHdyb25nIHNvbGUgYmFzaXMgZm9yIGEgdHJ1c3QgZGVjaXNpb246IGFueSBwYXRoIGJ5XG4gIC8vIHdoaWNoIGFuIGF0dGFja2VyLWF1dGhvcmVkIGVudHJ5IHJlYWNoZXMgdGhlIGNhY2hlIHdvdWxkIG90aGVyd2lzZSBtYWtlIGFuXG4gIC8vIGF0dGFja2VyLWFwcGxpZWQgYHdvcmstb25gIGxhYmVsIGxvb2sgdHJ1c3RlZCwgd2l0aCBubyBBUEkgY2FsbCB0b1xuICAvLyBjb250cmFkaWN0IGl0LiBEZW5pYWxzIGNhcnJ5IG5vIHN1Y2ggcmlzayDigJQgdGhlIHdvcnN0IGNhc2UgaXMgYSByZWR1bmRhbnRcbiAgLy8gbGl2ZSByZWFkIOKAlCBhbmQgZGVuaWFsIGlzIHRoZSBkb21pbmFudCBvdXRjb21lIGR1cmluZyBhIHNjYW4sIHNvIHRoaXNcbiAgLy8ga2VlcHMgdGhlIElzc3VlICMxNjczIE4rMSBjb2xsYXBzZSB3aGlsZSByZW1vdmluZyB0aGUgZXNjYWxhdGlvbiBwYXRoLlxuICAvL1xuICAvLyBJc3N1ZSAjMzI5Njogb25seSBhICpjb21wbGV0ZSogKGZ1bGx5IHBhZ2luYXRlZCkgY2FjaGVkIHRpbWVsaW5lIGlzIGV2ZW5cbiAgLy8gY29uc2lkZXJlZC4gQSBwYXJ0aWFsIHBhZ2UtMS1vbmx5IGVudHJ5IOKAlCB3cml0dGVuIGJ5XG4gIC8vIGBmZXRjaFRpbWVsaW5lV2l0aENhY2hlYCBiZWZvcmUgSXNzdWUgIzMzMjcg4oCUIGhvbGRzIHRoZSBvbGRlc3QgMTAwIGV2ZW50cywgc28gb24gYVxuICAvLyBidXN5IGlzc3VlICg+MTAwIHRpbWVsaW5lIGV2ZW50cykgaXQgY2FuIGhpZGUgdGhlIGdlbnVpbmVseSBtb3N0LXJlY2VudFxuICAvLyByZXNlcnZlZC1sYWJlbCBhZGQgYmVoaW5kIGEgc3RhbGUgb25lLlxuICBpZiAoY2FjaGUpIHtcbiAgICBjb25zdCBjYWNoZWQgPSBhd2FpdCBjYWNoZS5yZWFkQ29tcGxldGUocmVwbywgaXNzdWVOdW1iZXIpO1xuICAgIGlmIChcbiAgICAgIGNhY2hlZCAhPT0gbnVsbCAmJlxuICAgICAgIWxhYmVsTWF0Y2hlc0FsbG93ZWRBdXRob3IoXG4gICAgICAgIGNhY2hlZCxcbiAgICAgICAgbGFiZWxOYW1lLFxuICAgICAgICBhbGxvd2VkQXV0aG9ycyxcbiAgICAgICAgZmxlZXRXb3JrZXJMb2dpbnMsXG4gICAgICApXG4gICAgKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9XG5cbiAgLy8gTm8gY2FjaGUsIGEgY2FjaGUgbWlzcywgb3IgYSBjYWNoZWQgZW50cnkgdGhhdCB3b3VsZCBoYXZlIGdyYW50ZWQgdHJ1c3Qg4oCUXG4gIC8vIGNvbmZpcm0gYWdhaW5zdCB0aGUgQVBJLiBXZSBkZWxpYmVyYXRlbHkgZG8gTk9UIHVzZVxuICAvLyBgZmV0Y2hUaW1lbGluZVdpdGhDYWNoZWAgaGVyZSBiZWNhdXNlIHRoZSBoaXN0b3JpY2FsIGNvbnRyYWN0IGlzIHRvXG4gIC8vIHN1cmZhY2UgQVBJIGVycm9ycyB0byB0aGUgY2FsbGVyIChhc3NlcnRSZWplY3RzIGluIGV4aXN0aW5nIHRlc3RzKSxcbiAgLy8gd2hlcmVhcyB0aGUgY2FjaGUtdGhlbi1BUEkgaGVscGVyIHN3YWxsb3dzIHRoZW0uXG4gIC8vXG4gIC8vIGBwYWdpbmF0ZVRpbWVsaW5lYCByZWFkcyB0aGUgUkVTVCB0aW1lbGluZSB0byBleGhhdXN0aW9uIChtaXJyb3JpbmdcbiAgLy8gdmVyaWZ5T3BlcmF0aW9uYWxMYWJlbHMsIElzc3VlICMzMTY1KS4gVGhlIHRpbWVsaW5lIEFQSSByZXR1cm5zIGV2ZW50c1xuICAvLyBvbGRlc3QtZmlyc3QsIGNhcHBlZCBhdCAxMDAgcGVyIHBhZ2UgKHRoZSBBUEkgbWF4aW11bSkuIElzc3VlICMzMDg5IHJhaXNlZFxuICAvLyB0aGUgcGFnZSBzaXplIGZyb20gMzAgdG8gMTAwIGJ1dCBzdGlsbCByZWFkIG9ubHkgYSBzaW5nbGUgcGFnZSwgc28gb24gYVxuICAvLyBidXN5IGlzc3VlIHRoZSBnZW51aW5lbHkgbW9zdC1yZWNlbnQgcmVzZXJ2ZWQtbGFiZWwgYWRkICh3b3JrLW9uIC9cbiAgLy8gdG9wLXByaW9yaXR5IC8gbG93LXByaW9yaXR5KSBjb3VsZCBmYWxsIGJleW9uZCBwYWdlIDEgYW5kIGJlIG1pc3NlZCDigJRcbiAgLy8gbGVhdmluZyBvbmx5IGEgc3RhbGUgdHJ1c3RlZCBhZGQgaW5zaWRlIHRoZSB3aW5kb3cgYW5kIGJ5cGFzc2luZyB0aGlzXG4gIC8vIHRydXN0IGdhdGUgKElzc3VlICMzMjAwKS4gUmVhZGluZyBldmVyeSBwYWdlIGd1YXJhbnRlZXMgdGhlIGxhc3RcbiAgLy8gYGxhYmVsZWRgIGV2ZW50IGlzIHRoZSB0cnVlIG1vc3QtcmVjZW50IG9uZS5cbiAgY29uc3QgdGltZWxpbmUgPSBhd2FpdCBwYWdpbmF0ZVRpbWVsaW5lKFxuICAgIHJlcG8sXG4gICAgaXNzdWVOdW1iZXIsXG4gICAgZ2hDb21tYW5kRm4sXG4gICAgY2FjaGUsXG4gICk7XG4gIGlmICh0aW1lbGluZSA9PT0gbnVsbCkgcmV0dXJuIGZhbHNlO1xuXG4gIHJldHVybiBsYWJlbE1hdGNoZXNBbGxvd2VkQXV0aG9yKFxuICAgIHRpbWVsaW5lLFxuICAgIGxhYmVsTmFtZSxcbiAgICBhbGxvd2VkQXV0aG9ycyxcbiAgICBmbGVldFdvcmtlckxvZ2lucyxcbiAgKTtcbn1cblxuLyoqXG4gKiBTaGFyZWQgdGltZWxpbmUtc2VhcmNoIGxvZ2ljIHVzZWQgYnkgYm90aCB0aGUgY2FjaGVkIGFuZCB1bmNhY2hlZFxuICogcGF0aHMgb2YgYHdhc0xhYmVsQWRkZWRCeUFsbG93ZWRBdXRob3JgLlxuICovXG5mdW5jdGlvbiBsYWJlbE1hdGNoZXNBbGxvd2VkQXV0aG9yKFxuICB0aW1lbGluZTogVGltZWxpbmVMYWJlbEV2ZW50SnNvbltdLFxuICBsYWJlbE5hbWU6IHN0cmluZyxcbiAgYWxsb3dlZEF1dGhvcnM6IHN0cmluZ1tdLFxuICBmbGVldFdvcmtlckxvZ2luczogc3RyaW5nW10gPSBbXSxcbik6IGJvb2xlYW4ge1xuICBjb25zdCBsYWJlbEV2ZW50cyA9IHRpbWVsaW5lLmZpbHRlcihcbiAgICAoZSkgPT4gZS5ldmVudCA9PT0gXCJsYWJlbGVkXCIgJiYgZS5sYWJlbD8ubmFtZSA9PT0gbGFiZWxOYW1lLFxuICApO1xuICBjb25zdCBsYXN0RXZlbnQgPSBsYWJlbEV2ZW50c1tsYWJlbEV2ZW50cy5sZW5ndGggLSAxXTtcbiAgaWYgKCFsYXN0RXZlbnQ/LmFjdG9yPy5sb2dpbikgcmV0dXJuIGZhbHNlO1xuXG4gIGNvbnN0IGFkZGVyID0gbGFzdEV2ZW50LmFjdG9yLmxvZ2luLnRvTG93ZXJDYXNlKCk7XG4gIC8vIElzc3VlICMyNjg4OiB0aGUgb25lIGZsZWV0LXdvcmtlciBhZGQgaG9ub3VyZWQg4oCUIGBwbGFubmluZ2AgaGFuZGVkIG9mZlxuICAvLyBmcm9tIGEgYHdvcmstb25gIGlzc3VlIGEgdHJ1c3RlZCBodW1hbiBxdWV1ZWQuXG4gIGlmIChcbiAgICBpc1dvcmtlclBsYW5uaW5nSGFuZG9mZihcbiAgICAgIHRpbWVsaW5lLFxuICAgICAgbGFiZWxOYW1lLFxuICAgICAgYWxsb3dlZEF1dGhvcnMsXG4gICAgICBmbGVldFdvcmtlckxvZ2lucyxcbiAgICApXG4gICkgcmV0dXJuIHRydWU7XG4gIC8vIElzc3VlICMzNDE2OiBhIGZsZWV0IHdvcmtlciBsb2dpbiAob3duIGhvc3QgKyBzaWJsaW5ncykgbXVzdCBhcHBlYXIgaW5cbiAgLy8gYWxsb3dlZEF1dGhvcnMgZm9yIFBSLWRlZHVwLCBidXQgbXVzdCBuZXZlciBiZSB0cnVzdGVkIHRvIHNlbGYtYXBwbHkgYVxuICAvLyByZXNlcnZlZCBkaXNjb3ZlcnkgbGFiZWwg4oCUIHRyZWF0IGl0IGFzIHVudHJ1c3RlZCBzbyBpdCBpcyBzdHJpcHBlZCxcbiAgLy8gbWlycm9yaW5nIHRoZSBvcGVyYXRpb25hbC1sYWJlbCBiYWNrc3RvcCAodmVyaWZ5T3BlcmF0aW9uYWxMYWJlbHMsICMzMjI1KS5cbiAgaWYgKGZsZWV0V29ya2VyTG9naW5zLnNvbWUoKGEpID0+IGEudG9Mb3dlckNhc2UoKSA9PT0gYWRkZXIpKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiBhbGxvd2VkQXV0aG9ycy5zb21lKChhKSA9PiBhLnRvTG93ZXJDYXNlKCkgPT09IGFkZGVyKTtcbn1cblxuLyoqXG4gKiBUaW1lc3RhbXAgKElTTy04NjAxKSBvZiB0aGUgbW9zdCByZWNlbnQgYGxhYmVsZWRgIGV2ZW50IGZvciBgbGFiZWxOYW1lYFxuICogd2hvc2UgYWN0b3IgaXMgYSB0cnVzdGVkIGFkZGVyIOKAlCBhbiBgYWxsb3dlZEF1dGhvcnNgIGxvZ2luIHRoYXQgaXMgbm90IGFcbiAqIGZsZWV0IHdvcmtlciAoc2FtZSB0cnVzdCBydWxlIGFzIHtAbGluayB3YXNMYWJlbEFkZGVkQnlBbGxvd2VkQXV0aG9yfSkuXG4gKiBSZXR1cm5zIG51bGwgd2hlbiB0aGUgbGFzdCBhZGQgaXMgdW50cnVzdGVkIG9yIGNhcnJpZXMgbm8gdGltZXN0YW1wLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdHJ1c3RlZExhYmVsQWRkZWRBdChcbiAgdGltZWxpbmU6IFRpbWVsaW5lTGFiZWxFdmVudEpzb25bXSxcbiAgbGFiZWxOYW1lOiBzdHJpbmcsXG4gIGFsbG93ZWRBdXRob3JzOiBzdHJpbmdbXSxcbiAgZmxlZXRXb3JrZXJMb2dpbnM6IHN0cmluZ1tdID0gW10sXG4pOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKFxuICAgICFsYWJlbE1hdGNoZXNBbGxvd2VkQXV0aG9yKFxuICAgICAgdGltZWxpbmUsXG4gICAgICBsYWJlbE5hbWUsXG4gICAgICBhbGxvd2VkQXV0aG9ycyxcbiAgICAgIGZsZWV0V29ya2VyTG9naW5zLFxuICAgIClcbiAgKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgY29uc3QgbGFiZWxFdmVudHMgPSB0aW1lbGluZS5maWx0ZXIoXG4gICAgKGUpID0+IGUuZXZlbnQgPT09IFwibGFiZWxlZFwiICYmIGUubGFiZWw/Lm5hbWUgPT09IGxhYmVsTmFtZSxcbiAgKTtcbiAgY29uc3QgbGFzdCA9IGxhYmVsRXZlbnRzW2xhYmVsRXZlbnRzLmxlbmd0aCAtIDFdO1xuICByZXR1cm4gdHlwZW9mIGxhc3Q/LmNyZWF0ZWRfYXQgPT09IFwic3RyaW5nXCIgJiYgbGFzdC5jcmVhdGVkX2F0ICE9PSBcIlwiXG4gICAgPyBsYXN0LmNyZWF0ZWRfYXRcbiAgICA6IG51bGw7XG59XG5cbi8qKlxuICogVHJ1ZSB3aGVuIGBsYWJlbEFkZGVkQXRgIGlzIGEgdmFsaWQgdGltZXN0YW1wIHN0cmljdGx5IGFmdGVyIHRoZSBQUidzXG4gKiBjbG9zZS9tZXJnZSB0aW1lIOKAlCBpLmUuIGEgaHVtYW4gcmUtYXBwbGllZCB0aGUgZGlzY292ZXJ5IGxhYmVsIGFmdGVyIHRoZVxuICogZmxlZXQncyBQUiBsYW5kZWQsIHdoaWNoIHJlb3BlbnMgdGhlIGlzc3VlIGZvciB0aGUgZmxlZXQgKFZpYmVDb2RlciM0MikuXG4gKiBBIFBSIHdpdGggbm8gdXNhYmxlIGBjbG9zZWRBdGAgY2Fubm90IGJlIGNvbXBhcmVkIGFuZCBrZWVwcyBibG9ja2luZy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzUmVsYWJlbGxlZEFmdGVyQ2xvc2VkUFIoXG4gIGNsb3NlZFBSOiBQaWNrPENsb3NlZFBSLCBcImNsb3NlZEF0XCI+LFxuICBsYWJlbEFkZGVkQXQ6IHN0cmluZyB8IG51bGwsXG4pOiBib29sZWFuIHtcbiAgaWYgKGxhYmVsQWRkZWRBdCA9PT0gbnVsbCkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBjbG9zZWQgPSBEYXRlLnBhcnNlKGNsb3NlZFBSLmNsb3NlZEF0KTtcbiAgY29uc3QgYWRkZWQgPSBEYXRlLnBhcnNlKGxhYmVsQWRkZWRBdCk7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKGNsb3NlZCkgfHwgIU51bWJlci5pc0Zpbml0ZShhZGRlZCkpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGFkZGVkID4gY2xvc2VkO1xufVxuXG4vKipcbiAqIERpZCBhIHRydXN0ZWQgYXV0aG9yIHJlLWFwcGx5IGBsYWJlbE5hbWVgIHRvIHRoZSBpc3N1ZSBBRlRFUiBgY2xvc2VkUFJgXG4gKiBjbG9zZWQgb3IgbWVyZ2VkPyAoVmliZUNvZGVyIzQyKVxuICpcbiAqIFRoZSBjbG9zZWQtUFIgZ2F0ZSBtYXJrcyBhbiBpc3N1ZSB3aG9zZSBmbGVldCBQUiBtZXJnZWQgYXMgZG9uZSBmb3IgdGhlXG4gKiBmbGVldCwgcGVybWFuZW50bHkuIEl0cyBkb2N1bWVudGVkIGVzY2FwZSBoYXRjaCBpcyBcImEgaHVtYW4gcmUtb3BlbnMgdGhlXG4gKiBpc3N1ZSBvciByZS1hcHBsaWVzIHRoZSBkaXNjb3ZlcnkgbGFiZWxcIiDigJQgYnV0IHRoZSBnYXRlIG1hdGNoZWQgb24gdGhlIFBSXG4gKiB0aXRsZSBhbG9uZSBhbmQgbmV2ZXIgbG9va2VkIGF0IHRoZSB0aW1lbGluZSwgc28gYSByZS1sYWJlbCAoZS5nLlxuICogYHdvcmstb25gIOKGkiBgdG9wLXByaW9yaXR5YCBhZnRlciB0d28gcGFydGlhbCBQUnMgbGFuZGVkKSB3YXMgc2lsZW50bHlcbiAqIGlnbm9yZWQgYW5kIHRoZSBpc3N1ZSBjb3VsZCBuZXZlciBiZSBwaWNrZWQgdXAgYWdhaW4uIFRoaXMgaGVscGVyIHN1cHBsaWVzXG4gKiB0aGUgbWlzc2luZyBjb21wYXJpc29uLlxuICpcbiAqIENhY2hlIHRydXN0IGZvbGxvd3Mge0BsaW5rIHdhc0xhYmVsQWRkZWRCeUFsbG93ZWRBdXRob3J9IChJc3N1ZSAjMzcwOSk6IGFcbiAqIGNvbXBsZXRlIGNhY2hlZCB0aW1lbGluZSBtYXkgb25seSAqZGVueSogYSByZW9wZW4gKG5vIHRydXN0ZWQgYWRkIGFmdGVyXG4gKiB0aGUgUFIpLiBBIGNhY2hlZCBlbnRyeSB0aGF0IHdvdWxkIGdyYW50IGl0IGlzIHJlLWNvbmZpcm1lZCBsaXZlLCBiZWNhdXNlXG4gKiBncmFudGluZyBhIHBpY2t1cCBmcm9tIGEgZmlsZSB1bmRlciBUTVBESVIgaXMgZXhhY3RseSB0aGUgZXNjYWxhdGlvbiBwYXRoXG4gKiB0aGF0IGZpbmRpbmcgY2xvc2VkLiBEZW5pYWwgZG9taW5hdGVzIGR1cmluZyBhIHNjYW4sIHNvIHRoZSBOKzEgY29sbGFwc2VcbiAqIGlzIGtlcHQgd2hlcmUgaXQgbWF0dGVycy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHdhc0xhYmVsUmVhcHBsaWVkQWZ0ZXJDbG9zZWRQUihcbiAgcmVwbzogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuICBsYWJlbE5hbWU6IHN0cmluZyxcbiAgYWxsb3dlZEF1dGhvcnM6IHN0cmluZ1tdLFxuICBjbG9zZWRQUjogUGljazxDbG9zZWRQUiwgXCJjbG9zZWRBdFwiPixcbiAgZ2hDb21tYW5kRm46IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+ID0gcnVuR2hDb21tYW5kLFxuICBjYWNoZT86IFRpbWVsaW5lQ2FjaGUsXG4gIGZsZWV0V29ya2VyTG9naW5zOiBzdHJpbmdbXSA9IFtdLFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGlmIChjYWNoZSkge1xuICAgIGNvbnN0IGNhY2hlZCA9IGF3YWl0IGNhY2hlLnJlYWRDb21wbGV0ZShyZXBvLCBpc3N1ZU51bWJlcik7XG4gICAgaWYgKFxuICAgICAgY2FjaGVkICE9PSBudWxsICYmXG4gICAgICAhaXNSZWxhYmVsbGVkQWZ0ZXJDbG9zZWRQUihcbiAgICAgICAgY2xvc2VkUFIsXG4gICAgICAgIHRydXN0ZWRMYWJlbEFkZGVkQXQoXG4gICAgICAgICAgY2FjaGVkLFxuICAgICAgICAgIGxhYmVsTmFtZSxcbiAgICAgICAgICBhbGxvd2VkQXV0aG9ycyxcbiAgICAgICAgICBmbGVldFdvcmtlckxvZ2lucyxcbiAgICAgICAgKSxcbiAgICAgIClcbiAgICApIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cbiAgY29uc3QgdGltZWxpbmUgPSBhd2FpdCBwYWdpbmF0ZVRpbWVsaW5lKFxuICAgIHJlcG8sXG4gICAgaXNzdWVOdW1iZXIsXG4gICAgZ2hDb21tYW5kRm4sXG4gICAgY2FjaGUsXG4gICk7XG4gIGlmICh0aW1lbGluZSA9PT0gbnVsbCkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaXNSZWxhYmVsbGVkQWZ0ZXJDbG9zZWRQUihcbiAgICBjbG9zZWRQUixcbiAgICB0cnVzdGVkTGFiZWxBZGRlZEF0KHRpbWVsaW5lLCBsYWJlbE5hbWUsIGFsbG93ZWRBdXRob3JzLCBmbGVldFdvcmtlckxvZ2lucyksXG4gICk7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBSZWNlbnRseS1jbG9zZWQgUFIgYmxvY2tpbmcgKElzc3VlICMxNDI3KVxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBQYXJzZSByYXcgZ2ggcHIgbGlzdCBKU09OIGZvciBjbG9zZWQgUFJzIGludG8gQ2xvc2VkUFIgYXJyYXkuXG4gKlxuICogQHBhcmFtIGpzb25TdHIgLSBSYXcgSlNPTiBzdHJpbmcgZnJvbSBnaCBDTElcbiAqIEByZXR1cm5zIFBhcnNlZCBjbG9zZWQgUFJzXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUNsb3NlZFBSTGlzdEpzb24oanNvblN0cjogc3RyaW5nKTogQ2xvc2VkUFJbXSB7XG4gIHRyeSB7XG4gICAgY29uc3QgcmF3OiB1bmtub3duID0gSlNPTi5wYXJzZShqc29uU3RyKTtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkocmF3KSkgcmV0dXJuIFtdO1xuICAgIC8vIElubGluZSBydW50aW1lIHNoYXBlIGd1YXJkIChJc3N1ZSAjMTUzMikuXG4gICAgY29uc3QgaXRlbXM6IENsb3NlZFBSW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgcmF3KSB7XG4gICAgICBpZiAoIWlzUmVjb3JkKGl0ZW0pKSBjb250aW51ZTtcbiAgICAgIGlmICh0eXBlb2YgaXRlbS5udW1iZXIgIT09IFwibnVtYmVyXCIpIGNvbnRpbnVlO1xuICAgICAgaWYgKHR5cGVvZiBpdGVtLnRpdGxlICE9PSBcInN0cmluZ1wiKSBjb250aW51ZTtcbiAgICAgIGl0ZW1zLnB1c2goe1xuICAgICAgICBudW1iZXI6IGl0ZW0ubnVtYmVyLFxuICAgICAgICB0aXRsZTogaXRlbS50aXRsZSxcbiAgICAgICAgY2xvc2VkQXQ6IHR5cGVvZiBpdGVtLmNsb3NlZEF0ID09PSBcInN0cmluZ1wiID8gaXRlbS5jbG9zZWRBdCA6IFwiXCIsXG4gICAgICB9KTtcbiAgICB9XG4gICAgcmV0dXJuIGl0ZW1zO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gW107XG4gIH1cbn1cblxuLyoqXG4gKiBGZXRjaCBjbG9zZWQgUFJzIGJ5IGEgdXNlciAoSXNzdWUgIzE4MDkpLlxuICpcbiAqIFVzZWQgYnkgcmVwby13aWRlIGNsb3NlZC1QUiBzY2FucyAoZS5nLiBzdHVja19yZWNvdmVyeSdzXG4gKiBgZGV0ZWN0QXNzaWduZWRXaXRoQ2xvc2VkUHJgKSBzbyBwZXItaXNzdWUgdGl0bGUtc2VhcmNoIGNhbGxzXG4gKiBjb2xsYXBzZSB0byBvbmUgYGdoIHByIGxpc3RgIHBlciByZXBvLiBDYWNoZSBrZXkgaXNcbiAqIGBwcnNfY2xvc2VkXyR7dXNlcn1gLiBQYWlyIHdpdGggdGhlIGl0ZXJhdGlvbi1zY29wZWQgYElzc3VlQ2FjaGVgLlxuICpcbiAqIFRoZSByaWNoZXIgYHsgbnVtYmVyLCB0aXRsZSwgbWVyZ2VkQXQsIGNsb3NlZEF0IH1gIHNoYXBlIGlzIGFsc29cbiAqIHJlYWQgYnkgYGZldGNoUmVjZW50bHlDbG9zZWRQUnNCeVVzZXJgIChJc3N1ZSAjMTQyNykgd2hpY2ggZmlsdGVyc1xuICogbG9jYWxseSBieSBjb29sZG93biwgc28gYm90aCBoZWxwZXJzIHNoYXJlIG9uZSBuZXR3b3JrIGNhbGwuXG4gKlxuICogQHBhcmFtIHJlcG8gLSBSZXBvc2l0b3J5IGluIFwib3duZXIvcmVwb1wiIGZvcm1hdFxuICogQHBhcmFtIGdpdGh1YlVzZXIgLSBHaXRIdWIgdXNlcm5hbWVcbiAqIEBwYXJhbSBsaW1pdCAtIE1heGltdW0gUFJzIHRvIGZldGNoIChkZWZhdWx0OiAxMDApXG4gKiBAcGFyYW0gY2FjaGUgLSBPcHRpb25hbCBjYWNoZSBpbnN0YW5jZVxuICogQHBhcmFtIGdoQ29tbWFuZEZuIC0gT3B0aW9uYWwgZ2ggY29tbWFuZCBmdW5jdGlvbiBmb3IgdGVzdGluZ1xuICogQHJldHVybnMgQXJyYXkgb2YgY2xvc2VkIFBScyB3aXRoIG1lcmdlIHN0YXRlXG4gKlxuICogT3JkZXJlZCBieSB1cGRhdGUgcmVjZW5jeSwgbm90IGNyZWF0aW9uIGRhdGUsIHNvIGEgbG9uZy1saXZlZCBQUidzIGNsb3NlXG4gKiBvciBtZXJnZSBrZWVwcyBpdCBpbiB0aGUgd2luZG93IChJc3N1ZSAjMjkwMSkuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaENsb3NlZFBSc0J5VXNlcihcbiAgcmVwbzogc3RyaW5nLFxuICBnaXRodWJVc2VyOiBzdHJpbmcsXG4gIGxpbWl0ID0gMTAwLFxuICBjYWNoZT86IElzc3VlQ2FjaGUsXG4gIGdoQ29tbWFuZEZuOiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPiA9IHJ1bkdoQ29tbWFuZCxcbiAgLyoqIENsb2NrIG92ZXJyaWRlLCBlcG9jaCBzZWNvbmRzICh0ZXN0cykuICovXG4gIG5vd1NlY29uZHM6ICgpID0+IG51bWJlciA9ICgpID0+IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApLFxuKTogUHJvbWlzZTxDbG9zZWRQUldpdGhNZXJnZVtdPiB7XG4gIGNvbnN0IGNhY2hlS2V5ID0gYHByc19jbG9zZWRfJHtnaXRodWJVc2VyfWA7XG5cbiAgaWYgKGNhY2hlKSB7XG4gICAgLy8gSXNzdWUgIzI0MDk6IHNlcnZlZCB3aGlsZSBubyBvcGVuIFBSIG9mIHRoaXMgYXV0aG9yIGhhcyBnb25lLlxuICAgIGNvbnN0IGNhY2hlZCA9IGF3YWl0IHJlYWRTZXR0bGVkTGlzdGluZzxDbG9zZWRQUldpdGhNZXJnZT4oXG4gICAgICByZXBvLFxuICAgICAgZ2l0aHViVXNlcixcbiAgICAgIGNhY2hlS2V5LFxuICAgICAgY2FjaGUsXG4gICAgICBnaENvbW1hbmRGbixcbiAgICAgIG5vd1NlY29uZHMoKSxcbiAgICApO1xuICAgIGlmIChjYWNoZWQpIHJldHVybiBjYWNoZWQ7XG4gIH1cblxuICBjb25zdCBvdXRwdXQgPSBhd2FpdCBnaENvbW1hbmRGbihbXG4gICAgXCJwclwiLFxuICAgIFwibGlzdFwiLFxuICAgIFwiLS1yZXBvXCIsXG4gICAgcmVwbyxcbiAgICBcIi0tc3RhdGVcIixcbiAgICBcImNsb3NlZFwiLFxuICAgIFwiLS1hdXRob3JcIixcbiAgICBnaXRodWJVc2VyLFxuICAgIFwiLS1zZWFyY2hcIixcbiAgICBSRUNFTkNZX09SREVSX1NFQVJDSCxcbiAgICBcIi0tanNvblwiLFxuICAgIFwibnVtYmVyLHRpdGxlLG1lcmdlZEF0LGNsb3NlZEF0LGJvZHlcIixcbiAgICBcIi0tbGltaXRcIixcbiAgICBTdHJpbmcobGltaXQpLFxuICBdKTtcblxuICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICB0cnkge1xuICAgIHBhcnNlZCA9IEpTT04ucGFyc2Uob3V0cHV0LnRyaW0oKSB8fCBcIltdXCIpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gW107XG4gIH1cbiAgaWYgKCFBcnJheS5pc0FycmF5KHBhcnNlZCkpIHJldHVybiBbXTtcblxuICBjb25zdCBwcnM6IENsb3NlZFBSV2l0aE1lcmdlW10gPSBbXTtcbiAgZm9yIChjb25zdCBpdGVtIG9mIHBhcnNlZCkge1xuICAgIGlmICghaXNSZWNvcmQoaXRlbSkpIGNvbnRpbnVlO1xuICAgIGlmICh0eXBlb2YgaXRlbS5udW1iZXIgIT09IFwibnVtYmVyXCIpIGNvbnRpbnVlO1xuICAgIHBycy5wdXNoKHtcbiAgICAgIG51bWJlcjogaXRlbS5udW1iZXIsXG4gICAgICB0aXRsZTogdHlwZW9mIGl0ZW0udGl0bGUgPT09IFwic3RyaW5nXCIgPyBpdGVtLnRpdGxlIDogXCJcIixcbiAgICAgIG1lcmdlZEF0OiB0eXBlb2YgaXRlbS5tZXJnZWRBdCA9PT0gXCJzdHJpbmdcIiA/IGl0ZW0ubWVyZ2VkQXQgOiBudWxsLFxuICAgICAgY2xvc2VkQXQ6IHR5cGVvZiBpdGVtLmNsb3NlZEF0ID09PSBcInN0cmluZ1wiID8gaXRlbS5jbG9zZWRBdCA6IG51bGwsXG4gICAgICBsaWZlY3ljbGVBc3NpZ25tZW50SWQ6XG4gICAgICAgIGFzc2lnbm1lbnRJZEZyb21Cb2R5KHR5cGVvZiBpdGVtLmJvZHkgPT09IFwic3RyaW5nXCIgPyBpdGVtLmJvZHkgOiBcIlwiKSA/P1xuICAgICAgICAgIG51bGwsXG4gICAgICAvLyBJc3N1ZSAjMTUyODogd2hhdCB0aGUgYm9keSdzIGNsb3Npbmcga2V5d29yZHMgbmFtZSwgbm90IHRoZSBib2R5LlxuICAgICAgY2xvc2luZ1JlZnM6IGV4dHJhY3RDbG9zaW5nSXNzdWVOdW1iZXJzKFxuICAgICAgICB0eXBlb2YgaXRlbS5ib2R5ID09PSBcInN0cmluZ1wiID8gaXRlbS5ib2R5IDogXCJcIixcbiAgICAgICksXG4gICAgICBwYXJ0T2ZSZWZzOiBleHRyYWN0UGFydE9mSXNzdWVOdW1iZXJzKFxuICAgICAgICB0eXBlb2YgaXRlbS5ib2R5ID09PSBcInN0cmluZ1wiID8gaXRlbS5ib2R5IDogXCJcIixcbiAgICAgICksXG4gICAgICBtaXNzaW5nQ3JpdGVyaWE6IGZpbmRNaXNzaW5nQ3JpdGVyaWEoXG4gICAgICAgIHR5cGVvZiBpdGVtLmJvZHkgPT09IFwic3RyaW5nXCIgPyBpdGVtLmJvZHkgOiBcIlwiLFxuICAgICAgKSxcbiAgICB9KTtcbiAgfVxuXG4gIGlmIChjYWNoZSkge1xuICAgIGF3YWl0IHdyaXRlU2V0dGxlZExpc3RpbmcoXG4gICAgICByZXBvLFxuICAgICAgZ2l0aHViVXNlcixcbiAgICAgIGNhY2hlS2V5LFxuICAgICAgcHJzLFxuICAgICAgY2FjaGUsXG4gICAgICBnaENvbW1hbmRGbixcbiAgICAgIG5vd1NlY29uZHMoKSxcbiAgICApO1xuICB9XG4gIHJldHVybiBwcnM7XG59XG5cbi8qKlxuICogSW52YWxpZGF0ZSB0aGUgYGZldGNoQ2xvc2VkUFJzQnlVc2VyYCAvIGBmZXRjaFJlY2VudGx5Q2xvc2VkUFJzQnlVc2VyYFxuICogY2FjaGUgZW50cnkgKElzc3VlICMxODA5KS4gVXNlIGFmdGVyIGNsb3Npbmcgb3IgbWVyZ2luZyBhIFBSIGF1dGhvcmVkXG4gKiBieSBgZ2l0aHViVXNlcmAgc28gYSBmb2xsb3ctdXAgc2NhbiBpbiB0aGUgc2FtZSBpdGVyYXRpb24gc2VlcyB0aGVcbiAqIGZyZXNoIHN0YXRlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaW52YWxpZGF0ZUNsb3NlZFBSc0J5VXNlcihcbiAgcmVwbzogc3RyaW5nLFxuICBnaXRodWJVc2VyOiBzdHJpbmcsXG4gIGNhY2hlOiBJc3N1ZUNhY2hlLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IGNhY2hlLmludmFsaWRhdGUocmVwbywgYHByc19jbG9zZWRfJHtnaXRodWJVc2VyfWApO1xufVxuXG4vKipcbiAqIEZldGNoIHJlY2VudGx5LWNsb3NlZCAobm90IG1lcmdlZCkgUFJzIGJ5IGEgdXNlciB3aXRoaW4gYSBjb29sZG93biB3aW5kb3cuXG4gKlxuICogVXNlZCB0byBwcmV2ZW50IHRoZSB3b3JrZXIgZnJvbSBpbW1lZGlhdGVseSByZS1jcmVhdGluZyBhIFBSIGZvciBhbiBpc3N1ZVxuICogd2hvc2UgcHJldmlvdXMgUFIgd2FzIGp1c3QgY2xvc2VkIChJc3N1ZSAjMTQyNykuXG4gKlxuICogSXNzdWUgIzE4MDk6IHJlYWRzIHRocm91Z2ggYGZldGNoQ2xvc2VkUFJzQnlVc2VyYCBzbyB0aGlzIGhlbHBlciBhbmRcbiAqIHRoZSByZXBvLXdpZGUgY2xvc2VkLVBSIHNjYW4gaW4gYHN0dWNrX3JlY292ZXJ5LnRzYCBzaGFyZSBvbmVcbiAqIGBwcnNfY2xvc2VkXyR7dXNlcn1gIGNhY2hlIGFuZCBvbmUgbmV0d29yayBjYWxsIHBlciBpdGVyYXRpb24uXG4gKlxuICogQHBhcmFtIHJlcG8gLSBSZXBvc2l0b3J5IGluIFwib3duZXIvcmVwb1wiIGZvcm1hdFxuICogQHBhcmFtIGdpdGh1YlVzZXIgLSBHaXRIdWIgdXNlcm5hbWVcbiAqIEBwYXJhbSBjb29sZG93blNlY29uZHMgLSBPbmx5IHJldHVybiBQUnMgY2xvc2VkIHdpdGhpbiB0aGlzIG1hbnkgc2Vjb25kc1xuICogQHBhcmFtIGNhY2hlIC0gT3B0aW9uYWwgY2FjaGUgaW5zdGFuY2VcbiAqIEBwYXJhbSBnaENvbW1hbmRGbiAtIE9wdGlvbmFsIGdoIGNvbW1hbmQgZnVuY3Rpb24gZm9yIHRlc3RpbmdcbiAqIEByZXR1cm5zIEFycmF5IG9mIHJlY2VudGx5LWNsb3NlZCBQUnNcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoUmVjZW50bHlDbG9zZWRQUnNCeVVzZXIoXG4gIHJlcG86IHN0cmluZyxcbiAgZ2l0aHViVXNlcjogc3RyaW5nLFxuICBjb29sZG93blNlY29uZHM6IG51bWJlcixcbiAgY2FjaGU/OiBJc3N1ZUNhY2hlLFxuICBnaENvbW1hbmRGbjogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz4gPSBydW5HaENvbW1hbmQsXG4pOiBQcm9taXNlPENsb3NlZFBSW10+IHtcbiAgY29uc3QgYWxsID0gYXdhaXQgZmV0Y2hDbG9zZWRQUnNCeVVzZXIoXG4gICAgcmVwbyxcbiAgICBnaXRodWJVc2VyLFxuICAgIDEwMCxcbiAgICBjYWNoZSxcbiAgICBnaENvbW1hbmRGbixcbiAgKTtcblxuICAvLyBGaWx0ZXIgdG8gb25seSBpbmNsdWRlIFBScyBjbG9zZWQgd2l0aGluIHRoZSBjb29sZG93biB3aW5kb3cuXG4gIGNvbnN0IGN1dG9mZk1zID0gRGF0ZS5ub3coKSAtIChjb29sZG93blNlY29uZHMgKiAxMDAwKTtcbiAgY29uc3QgcmVjZW50OiBDbG9zZWRQUltdID0gW107XG4gIGZvciAoY29uc3QgcHIgb2YgYWxsKSB7XG4gICAgaWYgKCFwci5jbG9zZWRBdCkgY29udGludWU7XG4gICAgaWYgKG5ldyBEYXRlKHByLmNsb3NlZEF0KS5nZXRUaW1lKCkgPCBjdXRvZmZNcykgY29udGludWU7XG4gICAgcmVjZW50LnB1c2goe1xuICAgICAgbnVtYmVyOiBwci5udW1iZXIsXG4gICAgICB0aXRsZTogcHIudGl0bGUsXG4gICAgICBjbG9zZWRBdDogcHIuY2xvc2VkQXQsXG4gICAgICBtZXJnZWQ6IHByLm1lcmdlZEF0ICE9PSBudWxsICYmIHByLm1lcmdlZEF0ICE9PSBcIlwiLFxuICAgIH0pO1xuICB9XG4gIHJldHVybiByZWNlbnQ7XG59XG5cbi8qKlxuICogRmV0Y2ggdGhlIGZsZWV0LXdpZGUgc2V0IG9mIFBScyB0aGF0IHNob3VsZCBibG9jayByZS1waWNraW5nIHVwIGFuIGlzc3VlXG4gKiAoSXNzdWUgIzMxNTEpLlxuICpcbiAqIE1pcnJvcnMgYGZldGNoT3BlblBSc0ZvckZsZWV0YCBmb3IgdGhlIGNsb3NlZC9tZXJnZWQgc2lkZSBvZiB0aGVcbiAqIGR1cGxpY2F0ZS1QUiBndWFyZC4gVGhlIHNpbmdsZS1hY2NvdW50IGBmZXRjaFJlY2VudGx5Q2xvc2VkUFJzQnlVc2VyYFxuICogbWlzc2VkIGEgUFIgbWVyZ2VkIG9yIGNsb3NlZCBieSBhICoqc2libGluZyoqIGZsZWV0IGFjY291bnQsIHNvIGFmdGVyIGFcbiAqIHNpYmxpbmcgbWVyZ2VkIGEgUFIgdGhlIGlzc3VlIHdhcyByZS1waWNrZWQtdXAgYW5kIGEgc2Vjb25kIFBSIG9wZW5lZFxuICogKHRoZSBGYWlsdXJlIE1vZGUgQiBpbiAjMzEzNikuIFVuaW9ucyBhY3Jvc3MgZXZlcnkgc3VwcGxpZWQgZmxlZXQgYXV0aG9yXG4gKiAodHlwaWNhbGx5IGBbZ2l0aHViVXNlciwgLi4uYWxsb3dlZEF1dGhvcnMsIC4uLmZsZWV0UHJBdXRob3JzXWApIHR3b1xuICogY2xhc3NlcyBvZiBQUjpcbiAqXG4gKiAgIC0gKipNZXJnZWQqKiBQUnMg4oCUIGluY2x1ZGVkIHJlZ2FyZGxlc3Mgb2YgYWdlLiBPbmNlIGFueSBmbGVldCBQUiBmb3IgYW5cbiAqICAgICBpc3N1ZSBtZXJnZXMsIHRoYXQgaXNzdWUgaXMgZG9uZSBmb3IgdGhlIGZsZWV0OiByZS1waWNrdXAgcmVxdWlyZXMgYVxuICogICAgIGh1bWFuIHRvIHJlLW9wZW4gdGhlIGlzc3VlIG9yIHJlLWFwcGx5IHRoZSBkaXNjb3ZlcnkgbGFiZWwgKHRoZVxuICogICAgIGNvbGxlY3RvcnMgaG9ub3VyIGEgcmUtbGFiZWwgZGF0ZWQgYWZ0ZXIgdGhlIG1lcmdlIHZpYVxuICogICAgIHtAbGluayB3YXNMYWJlbFJlYXBwbGllZEFmdGVyQ2xvc2VkUFJ9LCBWaWJlQ29kZXIjNDIpLiBNYXJrZWRcbiAqICAgICBgbWVyZ2VkOiB0cnVlYCBzbyB0aGUgc2tpcCBpcyBvdGhlcndpc2UgKnBlcm1hbmVudCosIG5vdFxuICogICAgIGNvb2xkb3duLXdpbmRvd2VkLlxuICogICAtICoqQ2xvc2VkLXVubWVyZ2VkKiogUFJzIOKAlCBpbmNsdWRlZCBvbmx5IHdoZW4gY2xvc2VkIHdpdGhpblxuICogICAgIGBjb29sZG93blNlY29uZHNgLCBzbyB0aGUgcmV0cnkgcGF0aCBzdGF5cyBhdmFpbGFibGUgb25jZSB0aGUgd2luZG93XG4gKiAgICAgZWxhcHNlcy4gTWFya2VkIGBtZXJnZWQ6IGZhbHNlYC5cbiAqXG4gKiBgZ2ggcHIgbGlzdCAtLXN0YXRlIGNsb3NlZGAgcmV0dXJucyBib3RoIGNsb3NlZC11bm1lcmdlZCBhbmQgbWVyZ2VkIFBSc1xuICogKG1lcmdlZCBQUnMgY2FycnkgYSBub24tbnVsbCBgbWVyZ2VkQXRgKSwgc28gb25lIGBmZXRjaENsb3NlZFBSc0J5VXNlcmBcbiAqIGNhbGwgcGVyIGF1dGhvciBjb3ZlcnMgYm90aCBjbGFzc2VzIOKAlCBubyBleHRyYSBgZ2hgIGNhbGxzIGJleW9uZCB0aGVcbiAqIHBlci1hdXRob3IgY2xvc2VkLVBSIGZldGNoIHRoZSBndWFyZCBhbHJlYWR5IG1ha2VzLiBSZXN1bHRzIGFyZVxuICogZGUtZHVwbGljYXRlZCBieSBQUiBudW1iZXI7IGEgbWVyZ2VkIGNsYXNzaWZpY2F0aW9uIGFsd2F5cyB3aW5zIG92ZXIgYVxuICogY2xvc2VkLXVubWVyZ2VkIG9uZSBmb3IgdGhlIHNhbWUgbnVtYmVyLiBFbXB0eS9ibGFuayBhdXRob3JzIGFyZSBza2lwcGVkLlxuICpcbiAqIEBwYXJhbSByZXBvIC0gUmVwb3NpdG9yeSBpbiBcIm93bmVyL3JlcG9cIiBmb3JtYXRcbiAqIEBwYXJhbSBhdXRob3JzIC0gRmxlZXQgR2l0SHViIHVzZXJuYW1lcyAoZGVkdXBsaWNhdGVkIGludGVybmFsbHkpXG4gKiBAcGFyYW0gY29vbGRvd25TZWNvbmRzIC0gQ2xvc2VkLXVubWVyZ2VkIFBScyBvbGRlciB0aGFuIHRoaXMgYXJlIGV4Y2x1ZGVkO1xuICogICBtZXJnZWQgUFJzIGFyZSBhbHdheXMgaW5jbHVkZWQgcmVnYXJkbGVzc1xuICogQHBhcmFtIGNhY2hlIC0gT3B0aW9uYWwgY2FjaGUgaW5zdGFuY2VcbiAqIEBwYXJhbSBnaENvbW1hbmRGbiAtIE9wdGlvbmFsIGdoIGNvbW1hbmQgZnVuY3Rpb24gZm9yIHRlc3RpbmdcbiAqIEByZXR1cm5zIERlLWR1cGxpY2F0ZWQgY2xvc2VkL21lcmdlZCBQUnMgYWNyb3NzIGFsbCBmbGVldCBhdXRob3JzXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaFJlY2VudGx5Q2xvc2VkUFJzRm9yRmxlZXQoXG4gIHJlcG86IHN0cmluZyxcbiAgYXV0aG9yczogc3RyaW5nW10sXG4gIGNvb2xkb3duU2Vjb25kczogbnVtYmVyLFxuICBjYWNoZT86IElzc3VlQ2FjaGUsXG4gIGdoQ29tbWFuZEZuOiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPiA9IHJ1bkdoQ29tbWFuZCxcbik6IFByb21pc2U8Q2xvc2VkUFJbXT4ge1xuICBjb25zdCBkaXN0aW5jdEF1dGhvcnMgPSBbXG4gICAgLi4ubmV3IFNldChhdXRob3JzLmZpbHRlcigoYSkgPT4gYSAmJiBhLnRyaW0oKS5sZW5ndGggPiAwKSksXG4gIF07XG5cbiAgY29uc3QgY3V0b2ZmTXMgPSBEYXRlLm5vdygpIC0gKGNvb2xkb3duU2Vjb25kcyAqIDEwMDApO1xuICBjb25zdCBieU51bWJlciA9IG5ldyBNYXA8bnVtYmVyLCBDbG9zZWRQUj4oKTtcblxuICBmb3IgKGNvbnN0IGF1dGhvciBvZiBkaXN0aW5jdEF1dGhvcnMpIHtcbiAgICBjb25zdCBhbGwgPSBhd2FpdCBmZXRjaENsb3NlZFBSc0J5VXNlcihcbiAgICAgIHJlcG8sXG4gICAgICBhdXRob3IsXG4gICAgICAxMDAsXG4gICAgICBjYWNoZSxcbiAgICAgIGdoQ29tbWFuZEZuLFxuICAgICk7XG4gICAgZm9yIChjb25zdCBwciBvZiBhbGwpIHtcbiAgICAgIGNvbnN0IGlzTWVyZ2VkID0gcHIubWVyZ2VkQXQgIT09IG51bGwgJiYgcHIubWVyZ2VkQXQgIT09IFwiXCI7XG4gICAgICBpZiAoaXNNZXJnZWQpIHtcbiAgICAgICAgLy8gTWVyZ2VkIGZsZWV0IFBSIOKGkiBwZXJtYW5lbnQgc2tpcCwgcmVnYXJkbGVzcyBvZiBjb29sZG93biB3aW5kb3cuXG4gICAgICAgIGJ5TnVtYmVyLnNldChwci5udW1iZXIsIHtcbiAgICAgICAgICBudW1iZXI6IHByLm51bWJlcixcbiAgICAgICAgICB0aXRsZTogcHIudGl0bGUsXG4gICAgICAgICAgY2xvc2VkQXQ6IHByLmNsb3NlZEF0ID8/IHByLm1lcmdlZEF0ID8/IFwiXCIsXG4gICAgICAgICAgbWVyZ2VkOiB0cnVlLFxuICAgICAgICAgIC4uLihwci5jbG9zaW5nUmVmcyA/IHsgY2xvc2luZ1JlZnM6IHByLmNsb3NpbmdSZWZzIH0gOiB7fSksXG4gICAgICAgICAgLi4uKHByLnBhcnRPZlJlZnMgPyB7IHBhcnRPZlJlZnM6IHByLnBhcnRPZlJlZnMgfSA6IHt9KSxcbiAgICAgICAgICAuLi4ocHIubWlzc2luZ0NyaXRlcmlhPy5sZW5ndGhcbiAgICAgICAgICAgID8geyBtaXNzaW5nQ3JpdGVyaWE6IHByLm1pc3NpbmdDcml0ZXJpYSB9XG4gICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgLy8gQ2xvc2VkLXVubWVyZ2VkIOKGkiByZXRyeSBwYXRoOiBvbmx5IGJsb2NrIHdpdGhpbiB0aGUgY29vbGRvd24gd2luZG93LlxuICAgICAgaWYgKCFwci5jbG9zZWRBdCkgY29udGludWU7XG4gICAgICBpZiAobmV3IERhdGUocHIuY2xvc2VkQXQpLmdldFRpbWUoKSA8IGN1dG9mZk1zKSBjb250aW51ZTtcbiAgICAgIC8vIE5ldmVyIGRvd25ncmFkZSBhIFBSIGFscmVhZHkgY2xhc3NpZmllZCBhcyBtZXJnZWQgZm9yIHRoaXMgbnVtYmVyLlxuICAgICAgaWYgKGJ5TnVtYmVyLmdldChwci5udW1iZXIpPy5tZXJnZWQpIGNvbnRpbnVlO1xuICAgICAgYnlOdW1iZXIuc2V0KHByLm51bWJlciwge1xuICAgICAgICBudW1iZXI6IHByLm51bWJlcixcbiAgICAgICAgdGl0bGU6IHByLnRpdGxlLFxuICAgICAgICBjbG9zZWRBdDogcHIuY2xvc2VkQXQsXG4gICAgICAgIG1lcmdlZDogZmFsc2UsXG4gICAgICAgIC4uLihwci5jbG9zaW5nUmVmcyA/IHsgY2xvc2luZ1JlZnM6IHByLmNsb3NpbmdSZWZzIH0gOiB7fSksXG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gWy4uLmJ5TnVtYmVyLnZhbHVlcygpXTtcbn1cblxuLyoqXG4gKiBXaGV0aGVyIGEgKiptZXJnZWQqKiBQUiBwb3NpdGl2ZWx5IG5hbWVzIGBpc3N1ZU51bWJlcmAgKElzc3VlICM0NDc4KS5cbiAqXG4gKiBQb3NpdGl2ZSBpZGVudGlmaWNhdGlvbiBpcyB0aGUgUFIgYm9keSdzIGNsb3Npbmcga2V5d29yZHMgKGBjbG9zaW5nUmVmc2ApXG4gKiBvciB0aGUgY2Fub25pY2FsIGRlbGltaXRlZCB0aXRsZSBmb3JtIGAoSXNzdWUgI04pYCwgYCgjTilgLCBgWyNOXWAuIEEgYmFyZVxuICogYCNOYCBpbiBhIHRpdGxlIGlzIG9ubHkgYSBtZW50aW9uLCBlLmcuIGEgUFIgdGhhdCAqZmlsZWQqIHRoZSBpc3N1ZSwgYW5kXG4gKiBtdXN0IG5vdCBkZWNpZGUgYSBtZXJnZWQgdmVyZGljdCwgd2hpY2ggaXMgcGVybWFuZW50IChJc3N1ZSAjMzE1MSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtZXJnZWRQck5hbWVzSXNzdWUoXG4gIHByOiBDbG9zZWRQUixcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbik6IGJvb2xlYW4ge1xuICAvLyBJc3N1ZSAjMzE3NzogdGhlIGNsb3NlcnMgbGVhdmUgYW4gaXNzdWUgb3BlbiwgcXVldWVkIHRvIGZpbmlzaCwgd2hlbiB0aGVcbiAgLy8gbWVyZ2VkIFBSJ3MgY2xvc3VyZSBibG9jayBtYXJrcyBhIGNyaXRlcmlvbiBgcGFydGlhbGAgb3IgYG1pc3NpbmdgIOKAlFxuICAvLyBldmVuIHVuZGVyIGBDbG9zZXMgI05gLiBUaGUgc2NhbiBtdXN0IGFncmVlLCBvclxuICAvLyB0aGUgaXNzdWUgYW5kIGV2ZXJ5IGlzc3VlIHRoYXQgZGVwZW5kcyBvbiBpdCBhcmUgc3RyYW5kZWQgZm9yIGdvb2QuXG4gIGlmICgocHIubWlzc2luZ0NyaXRlcmlhID8/IFtdKS5sZW5ndGggPiAwKSByZXR1cm4gZmFsc2U7XG4gIGlmICgocHIuY2xvc2luZ1JlZnMgPz8gW10pLmluY2x1ZGVzKGlzc3VlTnVtYmVyKSkgcmV0dXJuIHRydWU7XG4gIC8vIElzc3VlICMzMTc3OiBhIGJvZHkgdGhhdCBzYXlzIG9ubHkgYFBhcnQgb2YgI05gIGxlZnQgdGhlIHdvcmsgdW5maW5pc2hlZFxuICAvLyBvbiBwdXJwb3NlLCBhbmQgdGhlIGNsb3NlcnMga2VlcCB0aGUgaXNzdWUgb3BlbiB0byByZXN1bWUgaXQuIFRoZSB0aXRsZVxuICAvLyBzdGlsbCBzYXlzIGAoSXNzdWUgI04pYCwgc28gbGV0dGluZyBpdCBkZWNpZGUgc3RyYW5kZWQgdGhlIGlzc3VlIGZvciBnb29kLlxuICBpZiAoKHByLnBhcnRPZlJlZnMgPz8gW10pLmluY2x1ZGVzKGlzc3VlTnVtYmVyKSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gcHJUaXRsZU1hdGNoZXNJc3N1ZShwci50aXRsZSwgaXNzdWVOdW1iZXIpO1xufVxuXG4vKipcbiAqIENoZWNrIGlmIGFuIGlzc3VlIGlzIGJsb2NrZWQgYnkgYSByZWNlbnRseS1jbG9zZWQgUFIgKElzc3VlICMxNDI3KS5cbiAqXG4gKiBBICoqbWVyZ2VkKiogUFIgYmxvY2tzIG9ubHkgb24gcG9zaXRpdmUgaWRlbnRpZmljYXRpb24gKElzc3VlICM0NDc4KSwgdmlhXG4gKiB7QGxpbmsgbWVyZ2VkUHJOYW1lc0lzc3VlfSwgYmVjYXVzZSBpdHMgdmVyZGljdCBpcyBwZXJtYW5lbnQgKElzc3VlICMzMTUxKS5cbiAqIEEgKipjbG9zZWQtdW5tZXJnZWQqKiBQUiBrZWVwcyB0aGUgb3Zlci1tYXRjaGluZ1xuICoge0BsaW5rIHByVGl0bGVSZWZlcmVuY2VzSXNzdWV9LCBzaW5jZSBpdHMgY29vbGRvd24gbGFwc2VzIGFuZCB0aGUgcmV0cnlcbiAqIHBhdGggaXMgdGhlIHNhZmVyIHNpZGUgdG8gb3Zlci1tYXRjaCBvbi5cbiAqXG4gKiBJc3N1ZSAjMzE5OiB0aGlzIHVzZWQgdG8gdGVzdCB0aGUgdGl0bGUgZm9yIGEgYmFyZSBgI05gIHdpdGggYSBgUmVnRXhwYFxuICogYnVpbHQgZnJvbSB0aGUgaXNzdWUgbnVtYmVyLCB3aGljaCBrbm93cyBub3RoaW5nIGFib3V0ICp3aGljaCogaXNzdWUgYSBQUlxuICogd2FzIGZvci4gUFIgIzIxMiDigJQgXCLigKZzdHNlcnZpY2UncyBvcGVuIFBSICMxODggZGlkIG5vdCBibG9jayBWaWJlQ29kZXJTVFxuICogY2xhaW1pbmcgTkVBVC1BSS1MYW1hcmNrIzE4NyDigKYgKElzc3VlICMyMDkpXCIg4oCUIHdhcyBhIFBSIGZvciBpc3N1ZSAjMjA5LCB5ZXRcbiAqIGl0IGJsb2NrZWQgIzE3OCwgIzE4NCwgIzE4NywgIzE4OCBhbmQgIzIwOSBhbGlrZS4gQmVjYXVzZSBhICoqbWVyZ2VkKiogUFJcbiAqIHN0YXlzIGluIHRoaXMgc2V0IHBlcm1hbmVudGx5IChJc3N1ZSAjMzE1MSksIHRob3NlIGlzc3VlcyB3ZXJlIHN0cmFuZGVkIGZvclxuICogZ29vZCwgdW5kZXIgYSBza2lwIHJlYXNvbiB0aGF0IHJlYWRzIGFzIGEgcGFzc2luZyBcImNvb2xkb3duXCIuIElzc3VlICM0NDc4XG4gKiBjbG9zZWQgdGhhdCBnYXAgZm9yIHRoZSBtZXJnZWQgdmVyZGljdDogYSBiYXJlIGAjTmAgaW4gYSBtZXJnZWQgUFIncyB0aXRsZVxuICogbm8gbG9uZ2VyIGJsb2Nrcywgc28gb25seSB7QGxpbmsgbWVyZ2VkUHJOYW1lc0lzc3VlfSBkZWNpZGVzIGl0LlxuICpcbiAqIEBwYXJhbSBjbG9zZWRQUnMgLSBBcnJheSBvZiByZWNlbnRseS1jbG9zZWQgUFJzXG4gKiBAcGFyYW0gaXNzdWVOdW1iZXIgLSBUaGUgaXNzdWUgbnVtYmVyIHRvIGNoZWNrXG4gKiBAcmV0dXJucyBUaGUgYmxvY2tpbmcgY2xvc2VkIFBSLCBvciBudWxsIGlmIG5vdCBibG9ja2VkXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0Jsb2NrZWRCeVJlY2VudGx5Q2xvc2VkUFIoXG4gIGNsb3NlZFBSczogQ2xvc2VkUFJbXSxcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbik6IENsb3NlZFBSIHwgbnVsbCB7XG4gIGlmIChjbG9zZWRQUnMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIGNsb3NlZFBScy5maW5kKChwcikgPT5cbiAgICBwci5tZXJnZWQgPT09IHRydWVcbiAgICAgID8gbWVyZ2VkUHJOYW1lc0lzc3VlKHByLCBpc3N1ZU51bWJlcilcbiAgICAgIDogcHJUaXRsZVJlZmVyZW5jZXNJc3N1ZShwci50aXRsZSwgaXNzdWVOdW1iZXIpXG4gICkgPz9cbiAgICBudWxsO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Q0FTQyxHQUVELFNBQ0Usb0JBQW9CLEVBQ3BCLDBCQUEwQixFQUMxQiw2QkFBNkIsUUFDeEIsZUFBZTtBQUN0QixTQUNFLHlCQUF5QixFQUN6QixtQkFBbUIsUUFDZCxxQ0FBcUM7QUFDNUMsU0FBUyxZQUFZLFFBQVEsY0FBYztBQUMzQyxTQUNFLG1CQUFtQixFQUNuQixzQkFBc0IsUUFDakIsMEJBQTBCO0FBQ2pDLFNBQVMscUJBQXFCLFFBQVEsNkJBQTZCO0FBQ25FLFNBQVMscUJBQXFCLFFBQVEsK0JBQStCO0FBQ3JFLDBFQUEwRTtBQUMxRSx3RUFBd0U7QUFDeEUsK0RBQStEO0FBQy9ELFNBQVMseUJBQXlCLFFBQVEsa0JBQWtCO0FBQzVELFNBQVMsaUJBQWlCLFFBQVEscUJBQXFCO0FBQ3ZELFNBQVMsbUJBQW1CLFFBQVEsd0JBQXdCO0FBQzVELFNBQVMseUJBQXlCLEdBQUc7QUFDckMsU0FBUyw2QkFBNkIsUUFBb0IsbUJBQW1CO0FBRTdFLFNBQVMsb0JBQW9CLFFBQVEsZUFBZTtBQUdwRCxTQUFTLHVCQUF1QixRQUFRLDhCQUE4QjtBQUN0RSx5RUFBeUU7QUFDekUsU0FBUyxvQkFBb0IsUUFBUSwrQkFBK0I7QUFDcEUsU0FBUyx5QkFBeUIsUUFBUSw2QkFBNkI7QUFDdkUsU0FFRSx1QkFBdUIsRUFDdkIsK0JBQStCLFFBQzFCLGtCQUFrQjtBQWdOekI7Ozs7Ozs7Q0FPQyxHQUNELE9BQU8sU0FBUyxzQkFDZCxHQUFZO0VBRVosSUFBSSxDQUFDLFNBQVMsTUFBTSxPQUFPO0VBQzNCLE1BQU0sRUFBRSxLQUFLLEVBQUUsU0FBUyxFQUFFLEdBQUc7RUFDN0IsSUFDRSxPQUFPLFVBQVUsWUFB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
// denoCacheMetadata=14730979840849660543,7048077265100889265