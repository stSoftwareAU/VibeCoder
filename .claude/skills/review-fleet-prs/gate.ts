// Deterministic pre-review gate for /review-fleet-prs (Issue #2675).
//
// Finds the open PRs by Dependabot and the fleet accounts in the repos of the
// VibeCoder .config.json that are ready for a model review: into the default
// branch, CI green, no conflict, not a draft, and not yet reviewed at their
// head commit, and not sent back awaiting a fix whose only new commits are
// base-branch merges. It never posts anything itself; a red dependency audit
// CI-fix could not clear is reported in `auditBlocked` with a ready-made
// review for post.ts (Issue #3142).
//
// One GraphQL search (about 2 points a page) covers every repo, so polling
// every few minutes stays cheap. With --watch=<seconds> the gate keeps polling
// until something is ready and only then exits, so an idle night costs no
// model tokens at all.
//
// Each pass also rewrites summary.md in the log directory (see review_log.ts).
//
// Usage: deno run --allow-run=gh --allow-read --allow-write --allow-env=HOME,XDG_STATE_HOME gate.ts
//          [--config=<path>] [--repo=<owner/name>] [--watch=<seconds>]
//          [--sleep-first]
// --sleep-first waits one interval before the first poll, so a PR whose
// review just failed is retried after the interval instead of at once.
// Output: one line of JSON, { ready: [...], auditBlocked: [...],
// skipped: { <reason>: count }, upkeep: [...] }. Unlike the review itself, each pass also does the
// Dependabot upkeep in dependabot.ts (rebase requests, arming auto-merge);
// --dry-run reports that upkeep without doing it. A failed upkeep action is
// reported in `upkeep` too, and is not retried at the same head commit.

// The skill lives at <checkout>/.claude/skills/review-fleet-prs/, next to the
// checkout's own .config.json.
const DEFAULT_CONFIG = new URL("../../../.config.json", import.meta.url);

import {
  type FableReview,
  type Finding,
  migrateLegacyStateDir,
  previousFindings,
  prKey,
  readLog,
  REVIEW_MARKER,
  sameLogin,
  stateDir,
  wasChangeRequestAt,
  writeSummary,
} from "./review_log.ts";
import { dependabotAction } from "./dependabot.ts";
import { isDependencyAuditCheck } from "../../../worker/deno/lib/dependency_audit_check.ts";
import {
  type CiFixMarkerComment,
  collectFleetCiFixMarkers,
} from "../../../worker/deno/lib/ci_fix_attempt_markers.ts";

// Every review body the skill posts ends with this marker, so a comment-only
// "held for the owner" review still counts as this commit's review.
export { REVIEW_MARKER };

const DEPENDABOT_LOGINS = new Set([
  "app/dependabot",
  "dependabot[bot]",
  "dependabot",
]);

// A watch that cannot reach GitHub for this many polls in a row exits, so the
// session hears about it instead of polling silently for ever.
const MAX_CONSECUTIVE_FAILURES = 12;

type Skip =
  | "waiting-ci" // checks still running (or none reported yet)
  | "ci-failed" // the fleet fixes it; no review
  | "ci-cancelled" // every red check is a cancelled run (Issue #2916): the fleet's CI-fix scan re-runs it once per head; no review
  | "conflicting" // the fleet resolves it; no review
  | "draft"
  | "not-default-branch" // e.g. into a milestone branch: the merge to the default branch gets the review
  | "already-reviewed" // reviewed at this exact head commit
  | "awaiting-fix"; // sent back at an earlier commit; only base-branch merges since, the PR's own diff unchanged

export interface ReadyPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  kind: "dependabot" | "fleet";
  headSha: string;
  baseRef: string;
  // Existing test files this PR removes or edits; the model review judges
  // whether the edits are meaningful. A removed test file always is.
  testChanges: { removed: string[]; edited: string[] };
  // Set when a fleet PR changes code but adds no test; the model review
  // decides whether a test was appropriate.
  noTestAdded: boolean;
  // Findings of this PR's last review when it was sent back: the re-review
  // checks each one was fixed.
  previousFindings: Finding[];
}

// A PR whose dependency audit is still red after CI-fix replied at its head
// (Issue #3142): post.ts sends it back with `review`, no model run.
export interface AuditBlockedPr extends ReadyPr {
  check: string;
  review: FableReview;
}

export interface Review {
  author: { login: string } | null;
  state: string;
  body: string;
  commit: { oid: string } | null;
}

/** One check the rollup folded in; unknown `__typename`s are ignored. */
export interface RollupContextNode {
  __typename: string;
  /** Present on `CheckRun` nodes. */
  conclusion?: string | null;
  /** Present on `StatusContext` nodes. */
  state?: string | null;
  /** The check's name, on `CheckRun` nodes (Issue #3142). */
  name?: string | null;
  /** The status's name, on `StatusContext` nodes (Issue #3142). */
  context?: string | null;
}

export interface SearchPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  mergeable: string;
  // BEHIND, BLOCKED, CLEAN, DIRTY, ... (GitHub's merge state).
  mergeStateStatus?: string;
  autoMergeRequest?: { enabledAt: string } | null;
  headRefOid: string;
  baseRefName: string;
  repository: {
    nameWithOwner: string;
    defaultBranchRef: { name: string } | null;
    autoMergeAllowed?: boolean;
    squashMergeAllowed?: boolean;
    mergeCommitAllowed?: boolean;
  };
  author: { login: string } | null;
  commits: {
    nodes: {
      commit: {
        statusCheckRollup: {
          state: string;
          // Optional: absent when the query did not ask for it (or the
          // rollup carries no contexts).
          contexts?: { nodes: RollupContextNode[] };
        } | null;
      };
    }[];
  };
  reviews: { nodes: Review[] };
}

interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  previous_filename?: string;
}

// Test files across the fleet's languages: Deno/TS, JS, Python, Go, Rust
// integration tests, Java/Kotlin. Inline Rust #[cfg(test)] modules cannot be
// seen from a path; the model review checks those.
const TEST_PATH_PATTERNS: RegExp[] = [
  /(^|\/)(tests?|__tests__|spec|specs)\//,
  /(^|\/)src\/test\//,
  /[._-](test|spec)\.[cm]?[jt]sx?$/,
  /_test\.(go|py|rs|sh|ps1)$/,
  /(^|\/)test_[^/]+\.py$/,
  /\.(Tests?)\.ps1$/,
  /Test\.(java|kt)$/,
];

const CODE_EXTENSIONS =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|sh|ps1|rb|cs|php|sql)$/;

export function isTestPath(path: string): boolean {
  return TEST_PATH_PATTERNS.some((re) => re.test(path));
}

export function existingTestChanges(
  files: PrFile[],
): ReadyPr["testChanges"] {
  const changes: ReadyPr["testChanges"] = { removed: [], edited: [] };
  for (const f of files) {
    const before = f.previous_filename ?? f.filename;
    if (f.status === "added" || !isTestPath(before)) continue;
    if (f.status === "removed") changes.removed.push(f.filename);
    else if (f.status === "renamed" || f.deletions > 0) {
      changes.edited.push(f.filename);
    }
  }
  return changes;
}

// Dependabot bumps change manifests and lockfiles, not functionality.
export function noTestAdded(files: PrFile[], kind: ReadyPr["kind"]): boolean {
  if (kind === "dependabot") return false;
  const codeChanged = files.some((f) =>
    f.status !== "removed" && f.additions > 0 &&
    CODE_EXTENSIONS.test(f.filename) && !isTestPath(f.filename)
  );
  const testsAdded = files.some((f) =>
    isTestPath(f.filename) && f.status !== "removed" && f.additions > 0
  );
  return codeChanged && !testsAdded;
}

// Whether a review counts towards this reviewer's verdict at all. An
// approval or change request always counts, even once dismissed: the
// worker dismisses a change request when it claims the feedback, before it
// pushes the fix, and the fix's new commit is what earns a fresh review. A
// comment-only review counts only when this skill posted it (the owner's
// own comments do not).
function countsAsReview(r: Review, reviewer: string): boolean {
  return sameLogin(r.author?.login, reviewer) &&
    (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" ||
      r.state === "DISMISSED" ||
      (r.state === "COMMENTED" && (r.body ?? "").includes(REVIEW_MARKER)));
}

export function reviewedAtHead(
  reviews: Review[],
  reviewer: string,
  headSha: string,
): boolean {
  return reviews.some((r) =>
    countsAsReview(r, reviewer) && r.commit?.oid === headSha
  );
}

// The commit this reviewer last sent the PR back at, when its latest counted
// review is a change request at a commit other than the head; else null.
// Review nodes are oldest-first, so the last counted one is the verdict that
// stands. GitHub's DISMISSED state cannot by itself tell a stale-dismissed
// approval from a change request the worker claimed (and so dismissed)
// before pushing the fix: `wasChangeRequest` is the skill's own log answering
// that question for this exact commit (Issue #3079).
export function sentBackAt(
  reviews: Review[],
  reviewer: string,
  headSha: string,
  wasChangeRequest: (oid: string) => boolean = () => false,
): string | null {
  const counted = reviews.filter((r) => countsAsReview(r, reviewer));
  const last = counted[counted.length - 1];
  if (!last) return null;
  const oid = last.commit?.oid;
  if (!oid || oid === headSha) return null;
  if (last.state === "CHANGES_REQUESTED") return oid;
  if (last.state === "DISMISSED" && wasChangeRequest(oid)) return oid;
  return null;
}

// A single line up to (and excluding) its first newline, so a multi-line gh
// error does not spill a stack trace into `upkeep` or the summary.
function firstLine(message: string): string {
  return message.split("\n")[0]!;
}

interface ComparePr {
  status: string;
  total_commits: number;
  commits: { sha: string; parents: { sha: string }[] }[];
}

interface CompareFile {
  filename: string;
  status: string;
  previous_filename?: string;
  patch?: string;
  sha?: string;
}

interface CompareFiles {
  files?: CompareFile[];
}

// GitHub omits `patch` for a binary. An added file is the same blob when
// both sides list it as added with the same sha. A modified binary, a
// missing sha, or a patch on only one side cannot be confirmed unchanged.
function sameAddedBlob(fa: CompareFile, fb: CompareFile): boolean {
  return fa.status === "added" && fb.status === "added" &&
    typeof fa.sha === "string" && fa.sha.length > 0 && fa.sha === fb.sha;
}

// A hunk header carries line numbers that shift when the base changes
// elsewhere in the same file, without changing the PR's own edits.
function normalisePatch(patch: string): string {
  return patch.replace(/^@@ [^@]* @@.*$/gm, "@@");
}

// Whether the only commits since `since` are base-branch merges that leave
// this PR's own diff (its change against the base) unchanged, so the review
// it got at `since` still stands. Returns false (= give the PR a fresh
// review) as soon as any check fails to confirm that.
//
// SIMPLE-ON-PURPOSE: the three compare calls below are repeated each pass
// while the PR awaits its fix, fine for a handful of sent-back PRs — upgrade
// when awaiting-fix PRs exceed ~50 per pass (cache the verdict per PR, since
// and head in the state dir).
export async function ownDiffUnchanged(
  gh: (args: string[]) => Promise<string>,
  repo: string,
  base: string,
  since: string,
  head: string,
): Promise<boolean> {
  try {
    const sinceToHead: ComparePr = JSON.parse(
      await gh(["api", `repos/${repo}/compare/${since}...${head}`]),
    );
    // "ahead" means `since` is an ancestor of `head`, so no force-push moved
    // the history out from under it.
    if (sinceToHead.status !== "ahead") return false;
    if (sinceToHead.commits.length !== sinceToHead.total_commits) {
      return false;
    }
    if (sinceToHead.commits.length === 0) return false;

    const [baseToSince, baseToHead]: [CompareFiles, CompareFiles] = [
      JSON.parse(await gh(["api", `repos/${repo}/compare/${base}...${since}`])),
      JSON.parse(await gh(["api", `repos/${repo}/compare/${base}...${head}`])),
    ];
    const a = baseToSince.files ?? [];
    const b = baseToHead.files ?? [];
    if (a.length !== b.length) return false;
    if (a.length >= 300) return false;
    const sortByName = (x: CompareFile, y: CompareFile) =>
      x.filename < y.filename ? -1 : x.filename > y.filename ? 1 : 0;
    const sortedA = [...a].sort(sortByName);
    const sortedB = [...b].sort(sortByName);
    for (let i = 0; i < sortedA.length; i++) {
      const fa = sortedA[i]!;
      const fb = sortedB[i]!;
      if (
        fa.filename !== fb.filename ||
        fa.previous_filename !== fb.previous_filename
      ) {
        return false;
      }
      const aPatch = typeof fa.patch === "string";
      const bPatch = typeof fb.patch === "string";
      if (!aPatch || !bPatch) {
        if (aPatch || bPatch || !sameAddedBlob(fa, fb)) return false;
        continue;
      }
      if (
        fa.status !== fb.status ||
        normalisePatch(fa.patch!) !== normalisePatch(fb.patch!)
      ) {
        return false;
      }
    }
    return true;
  } catch (e) {
    // A sent-back commit that is gone (force-push → 404) must not wedge
    // every later pass; falling back to a fresh review is the old behaviour.
    console.error(
      `${repo}: cannot compare ${since}..${head} (${
        firstLine((e as Error).message)
      }); reviewing afresh`,
    );
    return false;
  }
}

// Sorts one searched PR: null when it is ready for review, else why not.
// GitHub's rollup already treats skipped and neutral checks as passing.
export async function skipReason(
  pr: SearchPr,
  reviewer: string,
  ownDiffUnchangedSince: (since: string) => Promise<boolean> = () =>
    Promise.resolve(false),
  wasChangeRequestSince: (oid: string) => boolean = () => false,
): Promise<Skip | null> {
  // Only a merge into the default branch needs an approval; PRs into
  // milestone branches are reviewed when the milestone merges.
  if (pr.baseRefName !== pr.repository.defaultBranchRef?.name) {
    return "not-default-branch";
  }
  if (pr.isDraft) return "draft";
  if (pr.mergeable === "CONFLICTING") return "conflicting";
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup;
  if (rollup?.state === "FAILURE" || rollup?.state === "ERROR") {
    // GitHub rolls a CANCELLED check up as FAILURE, so the contexts tell
    // the two apart (Issue #2916): when every red context is a cancelled
    // CheckRun, the PR is stuck on infrastructure the fleet's CI-fix scan
    // re-runs once per head — same treatment as ci-failed, but named so
    // the pass can say what it saw.
    return everyRedCheckCancelled(rollup.contexts?.nodes ?? [])
      ? "ci-cancelled"
      : "ci-failed";
  }
  if (rollup?.state !== "SUCCESS") return "waiting-ci";
  if (reviewedAtHead(pr.reviews.nodes, reviewer, pr.headRefOid)) {
    return "already-reviewed";
  }
  const since = sentBackAt(
    pr.reviews.nodes,
    reviewer,
    pr.headRefOid,
    wasChangeRequestSince,
  );
  if (since !== null && await ownDiffUnchangedSince(since)) {
    return "awaiting-fix";
  }
  return null;
}

// A red context is one the rollup counts against the PR. CheckRun
// conclusions GitHub reports for a failed check run; StatusContext states
// are the older commit-status values (Issue #2916).
const RED_CHECKRUN_CONCLUSIONS = new Set([
  "FAILURE",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);
const RED_STATUS_STATES = new Set(["FAILURE", "ERROR"]);

function isRedContext(node: RollupContextNode): boolean {
  if (node.__typename === "CheckRun") {
    return node.conclusion !== undefined && node.conclusion !== null &&
      RED_CHECKRUN_CONCLUSIONS.has(node.conclusion);
  }
  if (node.__typename === "StatusContext") {
    return node.state !== undefined && node.state !== null &&
      RED_STATUS_STATES.has(node.state);
  }
  return false;
}

/** Names of the red contexts that are dependency audits (Issue #3142). */
export function redAuditChecks(nodes: RollupContextNode[]): string[] {
  return nodes.filter(isRedContext)
    .map((n) => n.name ?? n.context ?? "")
    .filter((name) => name !== "" && isDependencyAuditCheck(name, ""));
}

/**
 * The red audit check CI-fix has already replied to at `head`, if any: a
 * fleet-authored `vibe-ci-fix-attempt` marker for that check at that head.
 */
export function auditCheckCiFixReplied(
  checks: readonly string[],
  comments: readonly CiFixMarkerComment[],
  fleet: readonly string[],
  head: string,
): string | undefined {
  const attempts = [
    ...collectFleetCiFixMarkers(comments, fleet).attempts.values(),
  ].flat();
  return checks.find((check) =>
    attempts.some((a) => a.checkName === check && a.head === head)
  );
}

/** The ready-made send-back for a red audit (Issue #3142). */
export function auditSendBack(check: string): FableReview {
  return {
    summary: "Sent back without a model review: this dependency audit is " +
      "still red after CI-fix replied at this head commit.",
    findings: [{
      file: check.replaceAll("`", ""),
      line: 0,
      problem: "The dependency audit is red. It must be fixed in this PR, " +
        "by upgrading or replacing the vulnerable dependency.",
      fix: "Upgrade or replace the flagged dependency in this PR. An ignore " +
        "entry for the advisory, or a workflow edit that skips or weakens " +
        "the audit, does not count as a fix.",
    }],
    testChanges: "none",
    testChangeNotes: [],
    unrelatedIssues: [],
  };
}

/** True when at least one context is red and every red one is CANCELLED. */
function everyRedCheckCancelled(nodes: RollupContextNode[]): boolean {
  let sawRed = false;
  for (const node of nodes) {
    if (!isRedContext(node)) continue;
    sawRed = true;
    if (node.__typename !== "CheckRun" || node.conclusion !== "CANCELLED") {
      return false;
    }
  }
  return sawRed;
}

export function authorKind(
  login: string,
  fleet: ReadonlySet<string>,
): ReadyPr["kind"] | null {
  if (DEPENDABOT_LOGINS.has(login)) return "dependabot";
  return fleet.has(login) ? "fleet" : null;
}

function arg(name: string): string | undefined {
  const hit = Deno.args.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

// A GitHub call that stalls mid-read can otherwise hang for many minutes (a
// 14-minute GraphQL read ended only in "connection reset by peer"), and the
// watch loop waits on it with no sign of trouble. Killed at the limit, it
// fails like any other gh error and the next pass tries again.
const GH_TIMEOUT_MS = 120_000;

export async function runWithTimeout(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  const out = await new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(timeoutMs),
  }).output();
  if (out.signal !== null) {
    throw new Error(
      `${cmd} ${args[0] ?? ""} ${
        args[1] ?? ""
      }: timed out after ${timeoutMs} ms`,
    );
  }
  if (!out.success) {
    const err = new TextDecoder().decode(out.stderr).trim();
    throw new Error(`${cmd} ${args[0] ?? ""} ${args[1] ?? ""}: ${err}`);
  }
  return new TextDecoder().decode(out.stdout);
}

const gh = (args: string[]) => runWithTimeout("gh", args, GH_TIMEOUT_MS);

// 10 PRs a page: each PR carries its last 20 review bodies, and the reviews
// this skill posts are long. 100 a page grew past what GitHub will serve
// (HTTP 502s, then "Resource limits for this query exceeded"). 30 a page took
// 9 s as a user and hit GitHub's ~10 s limit (HTTP 504) as the reviewer App,
// whose token costs more per PR; 10 takes about 9 s at worst. Paging keeps
// the total the same.
const SEARCH_QUERY = `
query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 10, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title url isDraft mergeable mergeStateStatus headRefOid baseRefName
      autoMergeRequest { enabledAt }
      repository {
        nameWithOwner defaultBranchRef { name }
        autoMergeAllowed squashMergeAllowed mergeCommitAllowed
      }
      author { login }
      commits(last: 1) { nodes { commit { statusCheckRollup { state
        contexts(first: 100) { nodes { __typename ... on CheckRun { name conclusion } ... on StatusContext { context state } } }
      } } } }
      reviews(last: 20) { nodes { author { login } state body commit { oid } } }
    } }
  }
}`;

const ACTIVE_REPOS_QUERY = `
query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { repository { nameWithOwner } } }
  }
}`;

// Repos where a fleet account has had a PR in the last `days` days. Each
// fleet host monitors its own repos and this host cannot read the others'
// configs, but every monitored repo carries fleet PRs, so this recovers the
// fleet-wide set without leaving out a repo another host looks after.
async function fleetActiveRepos(
  owners: string[],
  fleet: readonly string[],
  gh: (args: string[]) => Promise<string>,
  days = 30,
): Promise<Set<string>> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(
    0,
    10,
  );
  const q = [
    `is:pr updated:>=${since}`,
    ...owners.map((o) => `user:${o}`),
    ...fleet.map((l) => `author:${l}`),
  ].join(" ");
  const repos = new Set<string>();
  let after: string | null = null;
  do {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${ACTIVE_REPOS_QUERY}`,
      "-F",
      `q=${q}`,
    ];
    if (after) args.push("-F", `after=${after}`);
    const page = JSON.parse(await gh(args)).data.search;
    for (const n of page.nodes) {
      if (n.repository) repos.add(n.repository.nameWithOwner);
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return repos;
}

async function searchOpenPrs(
  owners: string[],
  logins: string[],
  gh: (args: string[]) => Promise<string>,
): Promise<SearchPr[]> {
  const q = [
    "is:pr is:open archived:false",
    ...owners.map((o) => `user:${o}`),
    ...logins.map((l) => `author:${l}`),
  ].join(" ");
  const prs: SearchPr[] = [];
  let after: string | null = null;
  do {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${SEARCH_QUERY}`,
      "-F",
      `q=${q}`,
    ];
    if (after) args.push("-F", `after=${after}`);
    const page = JSON.parse(await gh(args)).data.search;
    prs.push(...page.nodes.filter((n: SearchPr) => n.number !== undefined));
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return prs;
}

// Head commit a Dependabot rebase was last requested for, per PR, so the
// request is not repeated while Dependabot works on it.
const REBASE_FILE = "dependabot-rebase.json";

// Head commit an upkeep action (rebase or auto-merge) last failed at, per PR
// and action, so a failure is not retried every pass.
const FAILED_FILE = "dependabot-failed.json";

// --dry-run reports the Dependabot upkeep it would do without doing it.
const DRY_RUN = Deno.args.includes("--dry-run");

async function readMemory(
  dir: string,
  file: string,
): Promise<Record<string, string>> {
  try {
    return JSON.parse(await Deno.readTextFile(`${dir}/${file}`));
  } catch {
    return {};
  }
}

async function writeMemory(
  dir: string,
  file: string,
  memory: Record<string, string>,
) {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/${file}`, JSON.stringify(memory));
}

export async function pass(
  repos: ReadonlySet<string>,
  fleet: ReadonlySet<string>,
  reviewer: string,
  deps: { gh?: (args: string[]) => Promise<string>; dir?: string } = {},
) {
  const callGh = deps.gh ?? gh;
  const dir = deps.dir ?? stateDir();
  const owners = [...new Set([...repos].map((r) => r.split("/")[0]!))];
  const logins = ["app/dependabot", ...fleet];
  const ready: ReadyPr[] = [];
  const auditBlocked: AuditBlockedPr[] = [];
  const skipped: Record<string, number> = {};
  const open = new Set<string>();
  const upkeep: string[] = [];
  const log = await readLog(dir);
  const rebaseAsked = await readMemory(dir, REBASE_FILE);
  const failed = await readMemory(dir, FAILED_FILE);
  const single = repos.size === 1;
  const active = single
    ? new Set<string>()
    : await fleetActiveRepos(owners, [...fleet], callGh);
  for (const pr of await searchOpenPrs(owners, logins, callGh)) {
    const repo = pr.repository.nameWithOwner;
    const kind = authorKind(pr.author?.login ?? "", fleet);
    // Fleet PRs only exist in repos some host monitors; Dependabot PRs are
    // taken from this host's repos plus any repo the fleet is active in.
    if (!kind) continue;
    if (kind === "dependabot" && !repos.has(repo) && !active.has(repo)) {
      continue;
    }
    if (single && !repos.has(repo)) continue;
    open.add(prKey(repo, pr.number));
    if (
      kind === "dependabot" &&
      pr.baseRefName === pr.repository.defaultBranchRef?.name
    ) {
      const key = prKey(repo, pr.number);
      const action = dependabotAction(pr, reviewer, rebaseAsked[key]);
      const alreadyFailed = (action.kind === "rebase" ||
        action.kind === "auto-merge") &&
        failed[`${key} ${action.kind}`] === pr.headRefOid;
      if (action.kind === "rebase" && !alreadyFailed) {
        try {
          if (!DRY_RUN) {
            await callGh([
              "pr",
              "comment",
              String(pr.number),
              "-R",
              repo,
              "--body",
              "@dependabot rebase",
            ]);
            rebaseAsked[key] = pr.headRefOid;
          }
          upkeep.push(`${key} rebase requested${DRY_RUN ? " (dry run)" : ""}`);
          skipped["rebasing"] = (skipped["rebasing"] ?? 0) + 1;
          continue;
        } catch (e) {
          failed[`${key} rebase`] = pr.headRefOid;
          const line = `${key} rebase failed: ${
            firstLine((e as Error).message)
          }`;
          upkeep.push(line);
          console.error(line);
          // Falls through to the normal skipReason check below.
        }
      } else if (action.kind === "auto-merge" && !alreadyFailed) {
        try {
          if (!DRY_RUN) {
            await callGh([
              "pr",
              "merge",
              String(pr.number),
              "-R",
              repo,
              "--auto",
              `--${action.method}`,
            ]);
          }
          upkeep.push(
            `${key} auto-merge armed (${action.method})${
              DRY_RUN ? " (dry run)" : ""
            }`,
          );
        } catch (e) {
          failed[`${key} auto-merge`] = pr.headRefOid;
          const line = `${key} auto-merge failed: ${
            firstLine((e as Error).message)
          }`;
          upkeep.push(line);
          console.error(line);
          // Falls through to the normal skipReason check below.
        }
      }
    }
    const skip = await skipReason(
      pr,
      reviewer,
      (since) =>
        ownDiffUnchanged(callGh, repo, pr.baseRefName, since, pr.headRefOid),
      (oid) => wasChangeRequestAt(log, repo, pr.number, oid),
    );
    // Rule 2's one exception (Issue #3142): a red dependency audit CI-fix
    // has already replied to at this head is sent back once, never approved.
    const auditCheck = skip === "ci-failed"
      ? await auditBlockedCheck(pr, reviewer, fleet, callGh)
      : undefined;
    if (auditCheck !== undefined) {
      auditBlocked.push({
        repo,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author: pr.author!.login,
        kind,
        headSha: pr.headRefOid,
        baseRef: pr.baseRefName,
        // No file list is read: the send-back is about the audit alone.
        testChanges: { removed: [], edited: [] },
        noTestAdded: false,
        previousFindings: previousFindings(log, repo, pr.number),
        check: auditCheck,
        review: auditSendBack(auditCheck),
      });
      continue;
    }
    if (skip) {
      skipped[skip] = (skipped[skip] ?? 0) + 1;
      continue;
    }
    const files: PrFile[] = JSON.parse(
      await callGh([
        "api",
        `repos/${repo}/pulls/${pr.number}/files`,
        "--paginate",
      ]),
    );
    ready.push({
      repo,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author!.login,
      kind,
      headSha: pr.headRefOid,
      baseRef: pr.baseRefName,
      testChanges: existingTestChanges(files),
      noTestAdded: noTestAdded(files, kind),
      previousFindings: previousFindings(log, repo, pr.number),
    });
  }
  // A single --repo run sees only part of the fleet, so it leaves the
  // summary's open set alone.
  if (repos.size > 1) await writeSummary(dir, open);
  await writeMemory(dir, REBASE_FILE, rebaseAsked);
  await writeMemory(dir, FAILED_FILE, failed);
  return { ready, auditBlocked, skipped, upkeep };
}

// The red audit check to send this PR back over, or undefined to leave it
// `ci-failed`. Comments are read only for a red audit not yet reviewed at
// this head.
async function auditBlockedCheck(
  pr: SearchPr,
  reviewer: string,
  fleet: ReadonlySet<string>,
  gh: (args: string[]) => Promise<string>,
): Promise<string | undefined> {
  const checks = redAuditChecks(
    pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts?.nodes ?? [],
  );
  if (checks.length === 0) return undefined;
  if (reviewedAtHead(pr.reviews.nodes, reviewer, pr.headRefOid)) {
    return undefined;
  }
  const raw: {
    id: number;
    user: { login: string } | null;
    body: string | null;
    created_at: string;
  }[] = JSON.parse(
    await gh([
      "api",
      `repos/${pr.repository.nameWithOwner}/issues/${pr.number}/comments`,
      "--paginate",
    ]),
  );
  const comments: CiFixMarkerComment[] = raw.map((c) => ({
    id: c.id,
    author: c.user?.login ?? null,
    body: c.body,
    createdAt: c.created_at,
  }));
  return auditCheckCiFixReplied(checks, comments, [...fleet], pr.headRefOid);
}

async function main() {
  await migrateLegacyStateDir(stateDir());
  const config = JSON.parse(
    await Deno.readTextFile(arg("config") ?? DEFAULT_CONFIG),
  );
  const fleet = new Set<string>([
    ...(config.fleet_pr_authors ?? []),
    ...(config.service_accounts ?? []),
  ]);
  const repos = new Set<string>(arg("repo") ? [arg("repo")!] : config.repos);
  // A reviewer App passes its bot login: an App token cannot read /user.
  const reviewer = arg("reviewer") ??
    (await gh(["api", "user", "--jq", ".login"])).trim();
  const watchSeconds = Number(arg("watch") ?? 0);

  const sleep = () => new Promise((r) => setTimeout(r, watchSeconds * 1000));
  if (watchSeconds > 0 && Deno.args.includes("--sleep-first")) await sleep();

  let failures = 0;
  while (true) {
    try {
      const result = await pass(repos, fleet, reviewer);
      failures = 0;
      if (
        result.ready.length > 0 || result.auditBlocked.length > 0 ||
        watchSeconds <= 0
      ) {
        console.log(JSON.stringify(result));
        return;
      }
    } catch (e) {
      failures++;
      console.error((e as Error).message);
      if (watchSeconds <= 0 || failures >= MAX_CONSECUTIVE_FAILURES) {
        Deno.exit(1);
      }
    }
    await sleep();
  }
}

if (import.meta.main) await main();
