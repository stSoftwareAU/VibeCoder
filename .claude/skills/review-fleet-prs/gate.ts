// Deterministic pre-review gate for /review-fleet-prs (Issue #2675).
//
// Finds the open PRs by Dependabot and the fleet accounts in the repos of the
// VibeCoder .config.json that are ready for a model review: into the default
// branch, CI green, no conflict, not a draft, and not yet reviewed at their
// head commit. It never
// posts anything itself.
//
// One GraphQL search (about 2 points a page) covers every repo, so polling
// every few minutes stays cheap. With --watch=<seconds> the gate keeps polling
// until something is ready and only then exits, so an idle night costs no
// model tokens at all.
//
// Each pass also rewrites ~/.review-fleet-prs/summary.md (see review_log.ts).
//
// Usage: deno run --allow-run=gh --allow-read --allow-write --allow-env=HOME gate.ts
//          [--config=<path>] [--repo=<owner/name>] [--watch=<seconds>]
//          [--sleep-first]
// --sleep-first waits one interval before the first poll, so a PR whose
// review just failed is retried after the interval instead of at once.
// Output: one line of JSON, { ready: [...], skipped: { <reason>: count },
// upkeep: [...] }. Unlike the review itself, each pass also does the
// Dependabot upkeep in dependabot.ts (rebase requests, arming auto-merge);
// --dry-run reports that upkeep without doing it.

// The skill lives at <checkout>/.claude/skills/review-fleet-prs/, next to the
// checkout's own .config.json.
const DEFAULT_CONFIG = new URL("../../../.config.json", import.meta.url);

import {
  type Finding,
  previousFindings,
  prKey,
  readLog,
  REVIEW_MARKER,
  sameLogin,
  stateDir,
  writeSummary,
} from "./review_log.ts";
import { dependabotAction } from "./dependabot.ts";

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
  | "conflicting" // the fleet resolves it; no review
  | "draft"
  | "not-default-branch" // e.g. into a milestone branch: the merge to the default branch gets the review
  | "already-reviewed"; // reviewed at this exact head commit

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

export interface Review {
  author: { login: string } | null;
  state: string;
  body: string;
  commit: { oid: string } | null;
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
    nodes: { commit: { statusCheckRollup: { state: string } | null } }[];
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

// An approval or change request always counts, even once dismissed: the
// worker dismisses a change request when it claims the feedback, before it
// pushes the fix, and the fix's new commit is what earns a fresh review. A
// comment-only review counts only when this skill posted it (the owner's
// own comments do not).
export function reviewedAtHead(
  reviews: Review[],
  reviewer: string,
  headSha: string,
): boolean {
  return reviews.some((r) =>
    sameLogin(r.author?.login, reviewer) && r.commit?.oid === headSha &&
    (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" ||
      r.state === "DISMISSED" ||
      (r.state === "COMMENTED" && (r.body ?? "").includes(REVIEW_MARKER)))
  );
}

// Sorts one searched PR: null when it is ready for review, else why not.
// GitHub's rollup already treats skipped and neutral checks as passing.
export function skipReason(pr: SearchPr, reviewer: string): Skip | null {
  // Only a merge into the default branch needs an approval; PRs into
  // milestone branches are reviewed when the milestone merges.
  if (pr.baseRefName !== pr.repository.defaultBranchRef?.name) {
    return "not-default-branch";
  }
  if (pr.isDraft) return "draft";
  if (pr.mergeable === "CONFLICTING") return "conflicting";
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup?.state;
  if (rollup === "FAILURE" || rollup === "ERROR") return "ci-failed";
  if (rollup !== "SUCCESS") return "waiting-ci";
  if (reviewedAtHead(pr.reviews.nodes, reviewer, pr.headRefOid)) {
    return "already-reviewed";
  }
  return null;
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
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
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

// --dry-run reports the Dependabot upkeep it would do without doing it.
const DRY_RUN = Deno.args.includes("--dry-run");

async function readRebaseAsked(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await Deno.readTextFile(`${stateDir()}/${REBASE_FILE}`));
  } catch {
    return {};
  }
}

async function writeRebaseAsked(asked: Record<string, string>) {
  await Deno.mkdir(stateDir(), { recursive: true });
  await Deno.writeTextFile(
    `${stateDir()}/${REBASE_FILE}`,
    JSON.stringify(asked),
  );
}

async function pass(
  repos: ReadonlySet<string>,
  fleet: ReadonlySet<string>,
  reviewer: string,
) {
  const owners = [...new Set([...repos].map((r) => r.split("/")[0]!))];
  const logins = ["app/dependabot", ...fleet];
  const ready: ReadyPr[] = [];
  const skipped: Record<string, number> = {};
  const open = new Set<string>();
  const upkeep: string[] = [];
  const log = await readLog(stateDir());
  const rebaseAsked = await readRebaseAsked();
  const single = repos.size === 1;
  const active = single
    ? new Set<string>()
    : await fleetActiveRepos(owners, [...fleet]);
  for (const pr of await searchOpenPrs(owners, logins)) {
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
      if (action.kind === "rebase") {
        if (!DRY_RUN) {
          await gh([
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
      }
      if (action.kind === "auto-merge") {
        if (!DRY_RUN) {
          await gh([
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
      }
    }
    const skip = skipReason(pr, reviewer);
    if (skip) {
      skipped[skip] = (skipped[skip] ?? 0) + 1;
      continue;
    }
    const files: PrFile[] = JSON.parse(
      await gh(["api", `repos/${repo}/pulls/${pr.number}/files`, "--paginate"]),
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
  if (repos.size > 1) await writeSummary(stateDir(), open);
  await writeRebaseAsked(rebaseAsked);
  return { ready, skipped, upkeep };
}

async function main() {
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
      if (result.ready.length > 0 || watchSeconds <= 0) {
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
