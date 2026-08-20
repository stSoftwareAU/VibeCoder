/**
 * Cross-scan invariant suite: the worker never writes to an uninvited PR
 * (Issue #4080).
 *
 * The #4074 regression was introduced by a fix (#4024) whose own tests all
 * passed, because no test asserted the property that actually matters:
 * *the worker never writes to a PR it was not invited to*. The per-scan
 * tests added by #4076 check each site individually, so nothing stopped a
 * sixth scan site being added later with the wrong author-set resolver —
 * which is exactly how the regression recurred.
 *
 * This suite drives **every** PR-touching entry point against one shared
 * fixture repo holding five PRs:
 *
 * | PR    | Author                          | Expectation                |
 * | ----- | ------------------------------- | -------------------------- |
 * | 701   | host login (fleet)              | fully maintained           |
 * | 702   | `fleet_pr_authors` sibling      | fully maintained           |
 * | 2312  | `allowed_authors` human         | never written to           |
 * | 2313  | `allowed_authors` human, invited | actionable (label invite)  |
 * | 5000  | unrelated third party           | never written to           |
 *
 * Every `gh` and `git` invocation goes through a recording runner, so the
 * "no write" assertions are made against what the scans actually issued,
 * not against what they claim to do. A final drift guard reads the two
 * scan modules and fails when a push-capable scan resolves the defer-to
 * author set, or when a new scan site appears that this suite does not
 * cover — so the next wrong resolver fails CI rather than shipping.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  type AutoMergeOptions,
  type CiCheckScanOptions,
  ensureAutoMergeOnOpenPrs,
  findFailedCiChecks,
  findFailedPrChecks,
  findPrCommentsToFix,
  type PrScanOptions,
} from "../lib/pr_maintenance.ts";
import {
  findPrsNeedingCiNudge,
  processCiNudgeCandidate,
} from "../lib/pr_ci_nudge_scan.ts";
import type { Logger } from "../types.ts";

// ---------------------------------------------------------------------------
// The shared fixture repo
// ---------------------------------------------------------------------------

const REPO = "org/fixture";
const DEFAULT_BRANCH = "main"; // allow-hardcoded-branch — fixture repo only
/** The host's own login. */
const HOST = "Vibecoderbot";
/** A sibling fleet host (`fleet_pr_authors`) — push-capable. */
const SIBLING = "stsvcbot";
/** A trusted human (`allowed_authors`) — may instruct, never adopted. */
const HUMAN = "courtyen";
/** An unrelated third party — in no configured list at all. */
const THIRD_PARTY = "driveby";
/** The authorised commenter whose feedback the scans would act on. */
const REVIEWER = "reviewer";
/** The issue a blocking PR parks, used by the #4078 escalation path. */
const BLOCKED_ISSUE = 9001;
/** Fixed clock so PR ages are deterministic. */
const FIXED_NOW = Date.parse("2026-06-01T00:00:00Z") / 1000;
const OLD_TIMESTAMP = "2026-05-01T00:00:00Z";

const FLEET_HOST_PR = 701;
const FLEET_SIBLING_PR = 702;
const UNINVITED_HUMAN_PR = 2312;
const INVITED_HUMAN_PR = 2313;
const THIRD_PARTY_PR = 5000;

/** One PR in the fixture repo. */
interface FixturePr {
  number: number;
  author: string;
  branch: string;
  sha: string;
  /** Labels currently on the PR. */
  labels: string[];
  /** Login the timeline reports as having applied the invite label. */
  labelAddedBy?: string;
}

const FIXTURE_PRS: readonly FixturePr[] = [
  {
    number: FLEET_HOST_PR,
    author: HOST,
    branch: "issue-801-host-fix",
    sha: "shahost",
    labels: [],
  },
  {
    number: FLEET_SIBLING_PR,
    author: SIBLING,
    branch: "issue-802-sibling-fix",
    sha: "shasibling",
    labels: [],
  },
  {
    number: UNINVITED_HUMAN_PR,
    author: HUMAN,
    branch: "courtyen/uninvited-fix",
    sha: "shauninvited",
    labels: [],
  },
  {
    number: INVITED_HUMAN_PR,
    author: HUMAN,
    branch: "courtyen/invited-fix",
    sha: "shainvited",
    labels: ["work-on"],
    labelAddedBy: HUMAN,
  },
  {
    number: THIRD_PARTY_PR,
    author: THIRD_PARTY,
    branch: "driveby/patch-1",
    sha: "shathirdparty",
    labels: [],
  },
];

/** The PRs a scan may act on, in the order the listings return them. */
const LISTED_PERMITTED: readonly number[] = [
  FLEET_HOST_PR,
  FLEET_SIBLING_PR,
  INVITED_HUMAN_PR,
];

/** The PRs no entry point may ever write to. */
const UNINVITED_PRS: readonly FixturePr[] = FIXTURE_PRS.filter((pr) =>
  pr.number === UNINVITED_HUMAN_PR || pr.number === THIRD_PARTY_PR
);

function prByNumber(number: number): FixturePr | undefined {
  return FIXTURE_PRS.find((pr) => pr.number === number);
}

function prByBranchOrSha(ref: string): FixturePr | undefined {
  return FIXTURE_PRS.find((pr) => pr.branch === ref || pr.sha === ref);
}

// ---------------------------------------------------------------------------
// Recording runners
// ---------------------------------------------------------------------------

/** Every side effect an entry point produced during one run. */
interface Recording {
  /** Every `gh` invocation, reads and writes alike. */
  gh: string[][];
  /** Every `git` invocation (the push path of the CI nudge). */
  git: string[][];
  /** PR numbers handed to the injected auto-merge writer. */
  autoMerges: number[];
}

function newRecording(): Recording {
  return { gh: [], git: [], autoMerges: [] };
}

function silentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

/** The value following `flag`, when the invocation carries one. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * Build the recording `gh` runner over the fixture repo.
 *
 * The stub answers as GitHub would — every listing returns the PRs that
 * author really has — so a scan querying the wrong author gets the PR back
 * and goes on to act on it. Nothing is pre-filtered on the fixture's side;
 * the invariant has to be enforced by the code under test.
 *
 * `noise` is the set of PR numbers carrying actionable work: an authorised
 * review/issue comment and a failing spelling + CI check.
 */
function makeFixtureGh(
  rec: Recording,
  noise: ReadonlySet<number>,
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    rec.gh.push(args);
    if (args[0] === "api" && args[1] === "graphql") {
      // Force the REST fallback so every check-run read is attributable to
      // one PR's branch (Issue #1806 keeps both paths alive).
      return Promise.reject(new Error("fixture: GraphQL unavailable"));
    }
    if (args[0] === "pr" && args[1] === "list") {
      return Promise.resolve(prListResponse(args));
    }
    if (args[0] === "api") {
      return Promise.resolve(apiResponse(args, noise));
    }
    return Promise.resolve("[]");
  };
}

function makeFixtureGit(rec: Recording): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    rec.git.push(args);
    return Promise.resolve("");
  };
}

/** Serve `gh pr list --author <a> --json <fields>` from the fixture. */
function prListResponse(args: readonly string[]): string {
  const author = (flagValue(args, "--author") ?? "").toLowerCase();
  const fields = (flagValue(args, "--json") ?? "")
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
  const matched = FIXTURE_PRS.filter((pr) =>
    pr.author.toLowerCase() === author
  );
  return JSON.stringify(matched.map((pr) => projectPr(pr, fields)));
}

/** Project a fixture PR onto the `--json` fields the caller asked for. */
function projectPr(
  pr: FixturePr,
  fields: readonly string[],
): Record<string, unknown> {
  const available: Record<string, unknown> = {
    number: pr.number,
    title: `Change for PR ${pr.number}`,
    headRefName: pr.branch,
    headRefOid: pr.sha,
    baseRefName: DEFAULT_BRANCH,
    autoMergeRequest: null,
    author: { login: pr.author },
    labels: pr.labels.map((name) => ({ name })),
    comments: [],
    reviews: [],
    createdAt: OLD_TIMESTAMP,
    updatedAt: OLD_TIMESTAMP,
  };
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in available) projected[field] = available[field];
  }
  return projected;
}

/** Check-run ids are derived from the PR so every read is attributable. */
function spellingCheckId(pr: FixturePr): number {
  return pr.number * 10 + 1;
}

function ciCheckId(pr: FixturePr): number {
  return pr.number * 10 + 2;
}

/** Serve the `gh api` reads the scans issue. */
function apiResponse(
  args: readonly string[],
  noise: ReadonlySet<number>,
): string {
  const path = args[1] ?? "";
  const prefix = `repos/${REPO}/`;
  if (!path.startsWith(prefix)) return "[]";
  const rest = path.slice(prefix.length);

  // Branch names contain slashes, so the ref is matched greedily.
  const checkRuns = /^commits\/(.+)\/check-runs/.exec(rest);
  if (checkRuns) {
    const pr = prByBranchOrSha(checkRuns[1] ?? "");
    // Without `--jq` this is the CI-start probe: no runs means CI never
    // started, so the PR becomes a nudge candidate.
    if (!args.includes("--jq")) return JSON.stringify({ check_runs: [] });
    if (!pr || !noise.has(pr.number)) return "[]";
    return JSON.stringify([
      {
        id: spellingCheckId(pr),
        name: "Spell Check",
        status: "completed",
        conclusion: "failure",
      },
      {
        id: ciCheckId(pr),
        name: "Quality Checks",
        status: "completed",
        conclusion: "failure",
      },
    ]);
  }

  if (/^actions\/runs/.test(rest)) {
    return JSON.stringify({ workflow_runs: [] });
  }

  const comments = /^(?:issues|pulls)\/(\d+)\/comments/.exec(rest);
  if (comments) {
    const pr = prByNumber(Number(comments[1]));
    if (!pr || !noise.has(pr.number)) return "[]";
    return JSON.stringify([
      {
        login: REVIEWER,
        id: pr.number * 100 + 1,
        body: "Please fix the failing quality gate",
        thumbs_up: 0,
      },
    ]);
  }

  const timeline = /^issues\/(\d+)\/timeline/.exec(rest);
  if (timeline) {
    const pr = prByNumber(Number(timeline[1]));
    if (!pr?.labelAddedBy) return "[]";
    return JSON.stringify(
      pr.labels.map((name) => ({
        event: "labeled",
        label: { name },
        actor: { login: pr.labelAddedBy },
        created_at: OLD_TIMESTAMP,
      })),
    );
  }

  return "[]";
}

// ---------------------------------------------------------------------------
// Write detection
// ---------------------------------------------------------------------------

/**
 * Whether a `gh` invocation only reads.
 *
 * The allowlist is deliberate: an invocation this function does not
 * recognise counts as a **write**, so a new `gh` verb cannot slip past the
 * invariant by being unclassified (fail loud, Issue #3234).
 */
export function isReadOnlyGhCall(args: readonly string[]): boolean {
  const verb = args[0];
  const sub = args[1] ?? "";
  if (verb === "api") {
    if (sub === "graphql") {
      const query = args.find((arg) => arg.startsWith("query=")) ?? "";
      return !/\bmutation\b/i.test(query);
    }
    const method = flagValue(args, "--method") ?? flagValue(args, "-X") ??
      "GET";
    if (method.toUpperCase() !== "GET") return false;
    // A request body means a POST/PATCH in `gh api`'s shorthand form.
    const bodyFlags = ["-f", "-F", "--field", "--raw-field", "--input"];
    return !args.some((arg) => bodyFlags.includes(arg));
  }
  if (verb === "pr") {
    return ["list", "view", "checks", "diff", "status"].includes(sub);
  }
  if (verb === "issue") return ["list", "view"].includes(sub);
  if (verb === "run") return ["list", "view"].includes(sub);
  if (verb === "label") return sub === "list";
  if (verb === "repo") return sub === "view";
  return false;
}

/**
 * The tokens of a `gh` invocation that identify **what it acts on**.
 *
 * Flag values are excluded, so a comment body that merely *names* a PR
 * (the #4078 escalation names the blocking PR on the blocked issue) is not
 * mistaken for a write against it. `-f` payloads are kept because that is
 * where a GraphQL query — and its PR aliases — travels.
 */
function targetingTokens(args: readonly string[]): string[] {
  const fieldFlags = ["-f", "-F", "--field", "--raw-field"];
  const tokens: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (fieldFlags.includes(arg)) {
      const value = args[i + 1];
      if (value !== undefined) tokens.push(value);
      i++;
      continue;
    }
    if (arg.startsWith("-")) {
      i++; // Skip the flag and its value.
      continue;
    }
    tokens.push(arg);
  }
  return tokens;
}

/** Whether a `gh` invocation acts on a specific fixture PR. */
function ghCallTargets(args: readonly string[], pr: FixturePr): boolean {
  const number = String(pr.number);
  return targetingTokens(args).some((token) =>
    token === number || token.includes(`/${number}/`) ||
    token.includes(number) && /^repos\//.test(token) ||
    token.includes(pr.branch) || token.includes(pr.sha)
  );
}

/** Whether a `git` invocation acts on a specific fixture PR's branch. */
function gitCallTargets(args: readonly string[], pr: FixturePr): boolean {
  return args.some((arg) => arg.includes(pr.branch));
}

/** Render captured invocations for a readable assertion failure. */
function render(calls: readonly string[][]): string[] {
  return calls.map((call) => call.join(" "));
}

/**
 * The core invariant: no write of any kind — `pr comment`, `pr edit`,
 * `pr merge`, `pr review`, `issue comment`, a reaction POST, an auto-merge
 * arming, or a branch push — reaches an uninvited or third-party PR.
 */
function assertNoWritesToUninvitedPrs(rec: Recording, site: string): void {
  for (const pr of UNINVITED_PRS) {
    assertEquals(
      render(
        rec.gh.filter((call) =>
          !isReadOnlyGhCall(call) && ghCallTargets(call, pr)
        ),
      ),
      [],
      `${site}: gh write targeting uninvited PR #${pr.number}`,
    );
    assertEquals(
      render(rec.git.filter((call) => gitCallTargets(call, pr))),
      [],
      `${site}: git write targeting uninvited PR #${pr.number}`,
    );
    assertEquals(
      rec.autoMerges.filter((number) => number === pr.number),
      [],
      `${site}: auto-merge armed on uninvited PR #${pr.number}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The entry points under test
// ---------------------------------------------------------------------------

/** What one entry point did during a single run. */
interface ScanRun {
  /** PR numbers the entry point acted on. */
  actedOn: number[];
  recording: Recording;
}

/**
 * One PR-touching entry point.
 *
 * `drivenBy` says what decides the acted-on set: a `noise` site returns the
 * first PR carrying actionable work, a `listing` site acts on every PR its
 * listing returned.
 */
interface ScanSite {
  /** The exported function's name — matched by the drift guard below. */
  name: string;
  drivenBy: "noise" | "listing";
  run: (noise: ReadonlySet<number>) => Promise<ScanRun>;
}

function baseScanOptions(
  rec: Recording,
  noise: ReadonlySet<number>,
): PrScanOptions {
  return {
    githubUser: HOST,
    repos: [REPO],
    logger: silentLogger(),
    isRepoAllowed: () => true,
    isAuthorisedCommenter: (author: string) => author === REVIEWER,
    ghCommandFn: makeFixtureGh(rec, noise),
    prAuthors: [SIBLING],
    allowedAuthors: [HUMAN],
  };
}

const SITES: readonly ScanSite[] = [
  {
    name: "findPrCommentsToFix",
    drivenBy: "noise",
    run: async (noise) => {
      const rec = newRecording();
      const result = await findPrCommentsToFix(baseScanOptions(rec, noise));
      assert(result.ok);
      return {
        actedOn: result.value ? [result.value.prNumber] : [],
        recording: rec,
      };
    },
  },
  {
    name: "findFailedPrChecks",
    drivenBy: "noise",
    run: async (noise) => {
      const rec = newRecording();
      const result = await findFailedPrChecks(baseScanOptions(rec, noise));
      assert(result.ok);
      return {
        actedOn: result.value ? [result.value.prNumber] : [],
        recording: rec,
      };
    },
  },
  {
    name: "findFailedCiChecks",
    drivenBy: "noise",
    run: async (noise) => {
      const rec = newRecording();
      const stateDir = await Deno.makeTempDir();
      try {
        const options: CiCheckScanOptions = {
          ...baseScanOptions(rec, noise),
          stateDir: `${stateDir}/.ci_check_state`,
        };
        const result = await findFailedCiChecks(options);
        assert(result.ok);
        return {
          actedOn: result.value ? [result.value.prNumber] : [],
          recording: rec,
        };
      } finally {
        await Deno.remove(stateDir, { recursive: true });
      }
    },
  },
  {
    name: "ensureAutoMergeOnOpenPrs",
    drivenBy: "listing",
    run: async (noise) => {
      const rec = newRecording();
      const options: AutoMergeOptions = {
        ...baseScanOptions(rec, noise),
        getRepoConfig: () => "",
        enableAutoMergeFn: (_repo: string, prNumber: number) => {
          rec.autoMerges.push(prNumber);
          return Promise.resolve({ result: "enabled", message: "ok" });
        },
      };
      const result = await ensureAutoMergeOnOpenPrs(options);
      assert(result.ok);
      return { actedOn: [...rec.autoMerges], recording: rec };
    },
  },
  {
    name: "findPrsNeedingCiNudge",
    drivenBy: "listing",
    run: async (noise) => {
      const rec = newRecording();
      const ghCommandFn = makeFixtureGh(rec, noise);
      const gitCommandFn = makeFixtureGit(rec);
      const result = await findPrsNeedingCiNudge({
        githubUser: HOST,
        allowedAuthors: [HUMAN],
        fleetPrAuthors: [SIBLING],
        repos: [REPO],
        ghCommandFn,
        nowSeconds: () => FIXED_NOW,
      });
      assert(result.ok);
      const actedOn: number[] = [];
      for (const candidate of result.value) {
        actedOn.push(candidate.prNumber);
        // The scan only detects; the nudge itself is the write, so drive it
        // too — that is what puts a `pr comment` and a branch push on the
        // record for the invariant to check.
        await processCiNudgeCandidate(candidate, {
          ghCommandFn,
          gitCommandFn,
        });
      }
      return { actedOn, recording: rec };
    },
  },
];

/** The fixture configurations every entry point is driven through. */
const CASES: ReadonlyArray<{ name: string; noise: readonly number[] }> = [
  {
    name: "every PR carries actionable work",
    noise: FIXTURE_PRS.map((pr) => pr.number),
  },
  {
    name: "only the fleet PRs carry work",
    noise: [FLEET_HOST_PR, FLEET_SIBLING_PR],
  },
  { name: "only the sibling fleet PR carries work", noise: [FLEET_SIBLING_PR] },
  {
    name: "only the uninvited and third-party PRs carry work",
    noise: [UNINVITED_HUMAN_PR, THIRD_PARTY_PR],
  },
  { name: "only the invited human PR carries work", noise: [INVITED_HUMAN_PR] },
];

/** The PRs a site is expected to act on for a given fixture configuration. */
function expectedActedOn(
  site: ScanSite,
  noise: ReadonlySet<number>,
): number[] {
  if (site.drivenBy === "listing") return [...LISTED_PERMITTED];
  const noisy = LISTED_PERMITTED.filter((number) => noise.has(number));
  return noisy.length > 0 ? [noisy[0]!] : [];
}

for (const site of SITES) {
  for (const testCase of CASES) {
    Deno.test(
      `${site.name} - ${testCase.name}: acts only where invited (Issue #4080)`,
      async () => {
        const noise = new Set(testCase.noise);
        const { actedOn, recording } = await site.run(noise);
        // The invariant first, so a breach names the offending write rather
        // than being masked by the acted-on comparison below.
        assertNoWritesToUninvitedPrs(recording, site.name);
        assertEquals(
          actedOn,
          expectedActedOn(site, noise),
          `${site.name}: acted on the wrong PRs`,
        );
      },
    );
  }
}

// ---------------------------------------------------------------------------
// The uninvited PRs are not merely unwritten — they are never touched
// ---------------------------------------------------------------------------

for (const site of SITES) {
  Deno.test(
    `${site.name} - issues no call at all against an uninvited PR (Issue #4080)`,
    async () => {
      const noise = new Set(FIXTURE_PRS.map((pr) => pr.number));
      const { recording } = await site.run(noise);
      for (const pr of UNINVITED_PRS) {
        assertEquals(
          render(recording.gh.filter((call) => ghCallTargets(call, pr))),
          [],
          `${site.name}: gh call reached uninvited PR #${pr.number}`,
        );
      }
    },
  );
}

// ---------------------------------------------------------------------------
// The suite can detect a write — it does not pass by observing nothing
// ---------------------------------------------------------------------------

Deno.test("the recorder observes real writes on the PRs the fleet may act on (Issue #4080)", async () => {
  const noise = new Set(FIXTURE_PRS.map((pr) => pr.number));
  const nudge = SITES.find((site) => site.name === "findPrsNeedingCiNudge")!;
  const { recording } = await nudge.run(noise);
  const hostPr = prByNumber(FLEET_HOST_PR)!;
  const writes = recording.gh.filter((call) =>
    !isReadOnlyGhCall(call) && ghCallTargets(call, hostPr)
  );
  assert(
    writes.length > 0,
    "expected the CI nudge to write to the fleet's own PR — a suite that " +
      "sees no writes anywhere would pass vacuously",
  );
  assert(
    recording.git.some((call) => gitCallTargets(call, hostPr)),
    "expected the CI nudge to push to the fleet PR's branch",
  );
});

Deno.test("write classification treats an unrecognised gh verb as a write (Issue #4080)", () => {
  assertEquals(isReadOnlyGhCall(["pr", "list", "--repo", REPO]), true);
  assertEquals(
    isReadOnlyGhCall(["api", `repos/${REPO}/pulls/1/comments`]),
    true,
  );
  assertEquals(isReadOnlyGhCall(["pr", "comment", "1", "--body", "hi"]), false);
  assertEquals(isReadOnlyGhCall(["pr", "merge", "1"]), false);
  assertEquals(isReadOnlyGhCall(["pr", "review", "1", "--approve"]), false);
  assertEquals(
    isReadOnlyGhCall(["issue", "comment", "1", "--body", "hi"]),
    false,
  );
  assertEquals(
    isReadOnlyGhCall([
      "api",
      `repos/${REPO}/issues/comments/5/reactions`,
      "-f",
      "content=+1",
    ]),
    false,
  );
  assertEquals(
    isReadOnlyGhCall(["api", `repos/${REPO}/pulls/1`, "--method", "PATCH"]),
    false,
  );
  assertEquals(isReadOnlyGhCall(["pr", "brand-new-verb", "1"]), false);
});

Deno.test("targeting ignores a PR merely named in a comment body (Issue #4080)", () => {
  const uninvited = prByNumber(UNINVITED_HUMAN_PR)!;
  assertEquals(
    ghCallTargets([
      "issue",
      "comment",
      String(BLOCKED_ISSUE),
      "--repo",
      REPO,
      "--body",
      `blocked by open PR #${UNINVITED_HUMAN_PR}`,
    ], uninvited),
    false,
  );
  assertEquals(
    ghCallTargets(
      ["pr", "comment", String(UNINVITED_HUMAN_PR), "--repo", REPO],
      uninvited,
    ),
    true,
  );
});

// ---------------------------------------------------------------------------
// Drift guard — a scan wired to the wrong resolver fails CI
// ---------------------------------------------------------------------------

/** The modules holding every push-capable PR scan. */
const SCAN_MODULES = ["pr_maintenance.ts", "pr_ci_nudge_scan.ts"] as const;

/** Helpers whose use makes a function a PR-listing scan site. */
const LISTING_HELPERS = [
  "listActionablePrs",
  "listOpenPrs",
  "listInvitedHumanPrs",
] as const;

/** The defer-to (fleet-owned) resolver — never correct in a scan module. */
const DEFER_TO_RESOLVER = "resolveFleetPrAuthorSet";
/** The push-capable resolver every scan site must use. */
const MAINTENANCE_RESOLVER = "resolveFleetMaintenanceAuthorSet";

function readScanModule(name: string): string {
  return Deno.readTextFileSync(new URL(`../lib/${name}`, import.meta.url));
}

/**
 * Blank out comments and string literals so an identifier search sees code
 * only — the modules discuss both resolvers at length in their doc blocks.
 */
function stripCommentsAndStrings(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    const next = source[i + 1];
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (
        i < source.length && !(source[i] === "*" && source[i + 1] === "/")
      ) {
        i++;
      }
      i += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      i++;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === char) {
          i++;
          break;
        }
        i++;
      }
      out += " ";
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

/** A top-level function declaration, split into its signature and body. */
interface ModuleFunction {
  name: string;
  exported: boolean;
  /** The declared parameter list. */
  params: string;
  /** Everything from the closing parenthesis onwards. */
  body: string;
}

/**
 * Enumerate the top-level function declarations in a `deno fmt`-formatted
 * module: the declaration starts at column 0 and its body closes on a `}`
 * at column 0.
 */
function topLevelFunctions(code: string): ModuleFunction[] {
  const lines = code.split("\n");
  const functions: ModuleFunction[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^(export )?(?:async )?function ([A-Za-z0-9_]+)/.exec(
      lines[i]!,
    );
    if (!match) continue;
    let end = i + 1;
    while (end < lines.length && lines[end] !== "}") end++;
    const source = lines.slice(i, end + 1).join("\n");
    const open = source.indexOf("(");
    const close = matchParenthesis(source, open);
    functions.push({
      name: match[2]!,
      exported: match[1] !== undefined,
      params: source.slice(open + 1, close),
      body: source.slice(close),
    });
    i = end;
  }
  return functions;
}

/** Index of the `)` closing the `(` at `open`. */
function matchParenthesis(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return source.length;
}

/**
 * The exported functions that decide, for themselves, which author set a PR
 * listing is scoped to.
 *
 * A function that *receives* the author set as a parameter is exempt: the
 * resolver choice belongs to its caller, which this guard checks instead.
 */
function governedScanSites(): Map<string, ModuleFunction[]> {
  const byModule = new Map<string, ModuleFunction[]>();
  for (const module of SCAN_MODULES) {
    const code = stripCommentsAndStrings(readScanModule(module));
    const governed = topLevelFunctions(code).filter((fn) => {
      if (!fn.exported) return false;
      if (!LISTING_HELPERS.some((helper) => fn.body.includes(`${helper}(`))) {
        return false;
      }
      return !/authors?\s*:/i.test(fn.params);
    });
    byModule.set(module, governed);
  }
  return byModule;
}

Deno.test("drift guard - no push-capable scan resolves the defer-to author set (Issue #4080)", () => {
  for (const module of SCAN_MODULES) {
    const code = stripCommentsAndStrings(readScanModule(module));
    assert(
      code.includes(MAINTENANCE_RESOLVER),
      `${module} resolves no maintenance author set at all — absence of the ` +
        `wrong resolver is not proof of the right one`,
    );
    assertEquals(
      code.includes(DEFER_TO_RESOLVER),
      false,
      `${module} references ${DEFER_TO_RESOLVER}: a push-capable scan must ` +
        `never resolve the defer-to (fleet-owned) set — that is the #4074 ` +
        `regression shape`,
    );
  }
});

Deno.test("drift guard - every scan site resolves the push-capable author set (Issue #4080)", () => {
  let checked = 0;
  for (const [module, functions] of governedScanSites()) {
    for (const fn of functions) {
      checked++;
      assert(
        fn.body.includes(`${MAINTENANCE_RESOLVER}(`),
        `${module}#${fn.name} lists PRs without resolving the push-capable ` +
          `maintenance set`,
      );
      assertEquals(
        fn.body.includes(`${DEFER_TO_RESOLVER}(`),
        false,
        `${module}#${fn.name} resolves the defer-to author set`,
      );
    }
  }
  assert(
    checked >= SITES.length,
    `expected at least ${SITES.length} scan sites, found ${checked} — the ` +
      `guard parsed nothing and would pass vacuously`,
  );
});

Deno.test("drift guard - every scan site is covered by this suite (Issue #4080)", () => {
  const found: string[] = [];
  for (const functions of governedScanSites().values()) {
    for (const fn of functions) found.push(fn.name);
  }
  assertEquals(
    found.sort(),
    SITES.map((site) => site.name).sort(),
    "a PR-listing scan site was added or renamed without being wired into " +
      "the cross-scan invariant suite — add it to SITES so the no-write " +
      "invariant covers it too",
  );
});
