// Deterministic pre-review gate for /review-fleet-prs.
//
// Lists open PRs by Dependabot and the fleet accounts across the repos in the
// VibeCoder .config.json, and classifies each one. Only PRs classified
// "ready" are worth a model review; the gate never posts anything itself.
//
// Usage: deno run --allow-run=gh --allow-read gate.ts [--config=<path>] [--repo=<owner/name>]
// Output: JSON on stdout, { reviewer, candidates: [...] }.

// The skill lives at <checkout>/.claude/skills/review-fleet-prs/, next to the
// checkout's own .config.json.
const DEFAULT_CONFIG = new URL("../../../.config.json", import.meta.url);

// Every review body the skill posts ends with this marker, so a comment-only
// "held for the owner" review still counts as this commit's review.
export const REVIEW_MARKER = "Automated review by /review-fleet-prs";
const DEPENDABOT_LOGINS = new Set([
  "app/dependabot",
  "dependabot[bot]",
  "dependabot",
]);

type State =
  | "ready" // CI green, not yet reviewed at this head: run the model review
  | "missing-tests" // CI green but a fleet PR adds code without a test: request changes
  | "waiting-ci" // checks still running: come back later
  | "ci-failed" // a check failed: the fleet fixes it; no review
  | "conflicting" // merge conflict: the fleet resolves it; no review
  | "draft"
  | "already-reviewed"; // this reviewer already reviewed this exact head commit

interface Candidate {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  kind: "dependabot" | "fleet";
  headSha: string;
  baseRef: string;
  state: State;
  reasons: string[];
  // Existing test files this PR touches; the model review judges whether the
  // edits are meaningful. A removed test file always is.
  testChanges: { removed: string[]; edited: string[] };
  files: {
    path: string;
    status: string;
    additions: number;
    deletions: number;
  }[];
}

function arg(name: string): string | undefined {
  const hit = Deno.args.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

async function gh(args: string[]): Promise<string> {
  const out = await new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `gh ${args.join(" ")}: ${new TextDecoder().decode(out.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(out.stdout);
}

async function ghJson<T>(args: string[]): Promise<T> {
  return JSON.parse(await gh(args)) as T;
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

interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  previous_filename?: string;
}

export function existingTestChanges(files: PrFile[]): Candidate["testChanges"] {
  const changes: Candidate["testChanges"] = { removed: [], edited: [] };
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
export function missingTests(
  files: PrFile[],
  kind: Candidate["kind"],
): string[] {
  if (kind === "dependabot") return [];
  const codeChanged = files.some((f) =>
    f.status !== "removed" && f.additions > 0 &&
    CODE_EXTENSIONS.test(f.filename) && !isTestPath(f.filename)
  );
  const testsAdded = files.some((f) =>
    isTestPath(f.filename) && f.status !== "removed" && f.additions > 0
  );
  return codeChanged && !testsAdded
    ? ["code changed but no test was added or extended"]
    : [];
}

interface Check {
  __typename: string;
  status?: string;
  conclusion?: string;
  state?: string;
  name?: string;
  context?: string;
}

export function ciState(
  checks: Check[],
): { state: "green" | "pending" | "failed"; failing: string[] } {
  if (checks.length === 0) return { state: "pending", failing: [] };
  const failing: string[] = [];
  let pending = false;
  for (const c of checks) {
    const name = c.name ?? c.context ?? "?";
    if (c.__typename === "StatusContext") {
      if (c.state === "PENDING" || c.state === "EXPECTED") pending = true;
      else if (c.state !== "SUCCESS") failing.push(name);
    } else if (c.status !== "COMPLETED") pending = true;
    else if (!["SUCCESS", "SKIPPED", "NEUTRAL"].includes(c.conclusion ?? "")) {
      failing.push(name);
    }
  }
  if (failing.length > 0) return { state: "failed", failing };
  return { state: pending ? "pending" : "green", failing };
}

interface Review {
  user: { login: string };
  commit_id: string;
  state: string;
  body: string;
}

// An approval or change request always counts; a comment-only review counts
// only when this skill posted it (the owner's own comments do not).
export function reviewedAtHead(
  reviews: Review[],
  reviewer: string,
  headSha: string,
): boolean {
  return reviews.some((r) =>
    r.user.login === reviewer && r.commit_id === headSha &&
    (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" ||
      (r.state === "COMMENTED" && (r.body ?? "").includes(REVIEW_MARKER)))
  );
}

interface ListedPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  mergeable: string;
  headRefOid: string;
  baseRefName: string;
  author: { login: string };
  statusCheckRollup: Check[];
}

async function main() {
  const config = JSON.parse(
    await Deno.readTextFile(arg("config") ?? DEFAULT_CONFIG),
  );
  const fleet = new Set<string>([
    ...(config.fleet_pr_authors ?? []),
    ...(config.service_accounts ?? []),
  ]);
  const repos: string[] = arg("repo") ? [arg("repo")!] : config.repos ?? [];
  const reviewer = (await gh(["api", "user", "--jq", ".login"])).trim();
  const candidates: Candidate[] = [];

  for (const repo of repos) {
    let prs: ListedPr[];
    try {
      prs = await ghJson<ListedPr[]>([
        "pr",
        "list",
        "-R",
        repo,
        "--state",
        "open",
        "-L",
        "100",
        "--json",
        "number,title,url,isDraft,mergeable,headRefOid,baseRefName,author,statusCheckRollup",
      ]);
    } catch (e) {
      console.error(`skipping ${repo}: ${(e as Error).message}`);
      continue;
    }
    for (const pr of prs) {
      const login = pr.author.login;
      const kind = DEPENDABOT_LOGINS.has(login)
        ? "dependabot"
        : fleet.has(login)
        ? "fleet"
        : null;
      if (!kind) continue;
      const c: Candidate = {
        repo,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author: login,
        kind,
        headSha: pr.headRefOid,
        baseRef: pr.baseRefName,
        state: "ready",
        reasons: [],
        testChanges: { removed: [], edited: [] },
        files: [],
      };
      candidates.push(c);
      if (pr.isDraft) {
        c.state = "draft";
        continue;
      }
      if (pr.mergeable === "CONFLICTING") {
        c.state = "conflicting";
        continue;
      }
      const ci = ciState(pr.statusCheckRollup ?? []);
      if (ci.state === "failed") {
        c.state = "ci-failed";
        c.reasons = ci.failing;
        continue;
      }
      if (ci.state === "pending") {
        c.state = "waiting-ci";
        continue;
      }

      const reviews = await ghJson<Review[]>([
        "api",
        `repos/${repo}/pulls/${pr.number}/reviews`,
        "--paginate",
      ]);
      if (reviewedAtHead(reviews, reviewer, pr.headRefOid)) {
        c.state = "already-reviewed";
        continue;
      }
      const files = await ghJson<PrFile[]>([
        "api",
        `repos/${repo}/pulls/${pr.number}/files`,
        "--paginate",
      ]);
      c.files = files.map((f) => ({
        path: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      }));
      c.testChanges = existingTestChanges(files);
      const problems = missingTests(files, kind);
      if (problems.length > 0) {
        c.state = "missing-tests";
        c.reasons = problems;
      }
    }
  }
  console.log(JSON.stringify({ reviewer, candidates }, null, 2));
}

if (import.meta.main) await main();
