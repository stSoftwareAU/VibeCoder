/**
 * Cross-scan invariant suite: the worker never writes to an uninvited PR
 * (Issue #4080).
 *
 * The #4074 regression was introduced by a fix (#4024) whose own tests all
 * passed, because no test asserted the property that actually matters:
 * *the worker never writes to a PR it was not invited to*. Per-scan tests
 * check each site individually, so a sixth scan added later with the wrong
 * author-set resolver would recur the same bug.
 *
 * This suite drives **every** PR-touching entry point against one shared
 * fixture repo and asserts the invariant once, for all of them:
 *
 * - `findPrCommentsToFix`
 * - `findFailedPrChecks`
 * - `findFailedCiChecks`
 * - `ensureAutoMergeOnOpenPrs`
 * - `findPrsNeedingCiNudge` (+ `processCiNudgeCandidate`, which writes)
 *
 * Every `gh` invocation, every `git` invocation and every auto-merge call is
 * recorded, so a write is caught by the recorder rather than inferred from
 * the return value. A final drift guard reads the two scan modules and fails
 * if a push-capable scan ever resolves the defer-to author set.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
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

const REPO = "owner/repo";
/** This host's login — a fleet account. */
const HOST = "VibeCoderBot";
/** A sibling fleet host (`fleet_pr_authors`) — also a fleet account. */
const SIBLING = "stsvcbot";
/** A trusted human (`allowed_authors`) — trusted to instruct, never adopted. */
const HUMAN = "courtyen";
/** An unrelated third party — in no configured list at all. */
const STRANGER = "driveby";

/** The blocked `work-on` issue the #4078 escalation path speaks on. */
const BLOCKED_ISSUE = 700;

const PR_FLEET = 4101;
const PR_SIBLING = 4102;
const PR_UNINVITED = 4103;
const PR_INVITED = 4104;
const PR_THIRD_PARTY = 4105;

/** PRs no entry point may write to, from any path. */
const FORBIDDEN = [PR_UNINVITED, PR_THIRD_PARTY];
/** PRs every entry point must keep maintaining. */
const ACTIONABLE = [PR_FLEET, PR_SIBLING, PR_INVITED];

const ALL_PR_NUMBERS = new Set([
  PR_FLEET,
  PR_SIBLING,
  PR_UNINVITED,
  PR_INVITED,
  PR_THIRD_PARTY,
]);

/** A comment/review body, in the shape `gh pr list --json comments` returns. */
interface FixtureBody {
  author: { login: string };
  body: string;
}

/** One PR in the fixture repo. */
interface FixturePr {
  number: number;
  author: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  createdAt: string;
  updatedAt: string;
  autoMergeRequest: { mergeMethod: string } | null;
  labels: Array<{ name: string }>;
  /** Login the timeline reports as having applied each label. */
  labelAddedBy: Record<string, string>;
  comments: FixtureBody[];
  reviews: FixtureBody[];
  /** Top-level issue comments `findPrCommentsToFix` can action. */
  issueComments: Array<
    { login: string; id: number; body: string; thumbs_up: number }
  >;
  /** Failed check runs on the head branch. */
  failedChecks: Array<
    { id: number; name: string; status: string; conclusion: string }
  >;
}

function makePr(
  number: number,
  author: string,
  slug: string,
  overrides: Partial<FixturePr> = {},
): FixturePr {
  return {
    number,
    author,
    headRefName: `issue-${number}-${slug}`,
    headRefOid: `sha${number}`,
    baseRefName: "main", // allow-hardcoded-branch — fixture default branch
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    autoMergeRequest: null,
    labels: [],
    labelAddedBy: {},
    comments: [],
    reviews: [],
    issueComments: [{
      login: HUMAN,
      id: number * 100 + 1,
      body: `Please tidy this up on #${number}`,
      thumbs_up: 0,
    }],
    failedChecks: [
      {
        id: number * 10 + 1,
        name: "spelling",
        status: "completed",
        conclusion: "failure",
      },
      {
        id: number * 10 + 2,
        name: "quality",
        status: "completed",
        conclusion: "failure",
      },
    ],
    ...overrides,
  };
}

/**
 * Build the fixture repo: one PR per authorship class, each of them equally
 * *attractive* to every scan — an actionable comment, a failed spelling
 * check, a failed CI check, no auto-merge armed, and idle with no CI. Only
 * the authorship (and the invitation) differs, so anything a scan does to
 * one PR but not another is attributable to the author set alone.
 */
function createFixture(): FixturePr[] {
  return [
    makePr(PR_FLEET, HOST, "fleet-fix"),
    makePr(PR_SIBLING, SIBLING, "sibling-fix"),
    makePr(PR_UNINVITED, HUMAN, "human-uninvited"),
    makePr(PR_INVITED, HUMAN, "human-invited", {
      // A trusted human handed this PR over by applying the invite label.
      labels: [{ name: "work-on" }],
      labelAddedBy: { "work-on": HUMAN },
    }),
    makePr(PR_THIRD_PARTY, STRANGER, "third-party"),
  ];
}

// ---------------------------------------------------------------------------
// Recording harness
// ---------------------------------------------------------------------------

interface Recorder {
  /** Every `gh` invocation, in order. */
  gh: string[][];
  /** Every `git` invocation, in order. */
  git: string[][];
  /** PR numbers `enableAutoMergeFn` was called for. */
  autoMerge: number[];
}

function newRecorder(): Recorder {
  return { gh: [], git: [], autoMerge: [] };
}

/** `gh <noun> <verb>` verbs that only read. */
const READ_ONLY_VERBS: Record<string, Set<string>> = {
  pr: new Set(["list", "view", "checks", "diff", "status"]),
  issue: new Set(["list", "view"]),
  run: new Set(["list", "view", "watch"]),
  label: new Set(["list"]),
};

/**
 * Whether a recorded `gh` invocation mutates anything.
 *
 * `gh api` is a read unless it carries a non-GET method or a field flag
 * (`gh api` implies POST as soon as `-f`/`-F`/`--input` is present), which
 * covers the reaction writes the worker uses to claim a comment.
 */
function isGhWrite(args: string[]): boolean {
  const [noun, verb = ""] = args;
  if (noun === undefined) return false;
  if (noun === "api") {
    const methodIndex = args.findIndex((a) => a === "-X" || a === "--method");
    const method = methodIndex >= 0
      ? (args[methodIndex + 1] ?? "").toUpperCase()
      : "GET";
    if (method !== "GET" && method !== "HEAD") return true;
    return args.some((a) =>
      a === "-f" || a === "-F" || a === "--field" || a === "--raw-field" ||
      a === "--input"
    );
  }
  const readVerbs = READ_ONLY_VERBS[noun];
  if (readVerbs !== undefined) return !readVerbs.has(verb);
  return false;
}

/**
 * The fixture PR numbers a recorded `gh` invocation targets.
 *
 * Both `gh pr <verb> <n>` and the REST paths are covered — GitHub serves a
 * PR's top-level comments from `/issues/<n>/`, so a write there is a write
 * to the PR. Fixture *issue* numbers are deliberately disjoint from the PR
 * numbers, so matching on the known PR set is unambiguous.
 */
function ghPrTargets(args: string[]): number[] {
  const targets = new Set<number>();
  const [noun] = args;
  if (noun === "pr" || noun === "issue") {
    const candidate = Number(args[2]);
    if (Number.isInteger(candidate) && ALL_PR_NUMBERS.has(candidate)) {
      targets.add(candidate);
    }
  }
  if (noun === "api") {
    for (const arg of args) {
      for (const match of arg.matchAll(/\/(?:pulls|issues)\/(\d+)/g)) {
        const candidate = Number(match[1]);
        if (ALL_PR_NUMBERS.has(candidate)) targets.add(candidate);
      }
    }
  }
  return [...targets];
}

/** The fixture PR a recorded `git push` pushed to, if any. */
function gitPushTargets(args: string[], prs: FixturePr[]): number[] {
  if (args[0] !== "push") return [];
  return prs.filter((pr) => args.includes(pr.headRefName)).map((p) => p.number);
}

/**
 * Every write the run performed against `prNumbers`, rendered for the
 * failure message so a breach names the exact command.
 */
function writesTargeting(
  recorder: Recorder,
  prs: FixturePr[],
  prNumbers: number[],
): string[] {
  const wanted = new Set(prNumbers);
  const breaches: string[] = [];
  for (const args of recorder.gh) {
    if (!isGhWrite(args)) continue;
    if (ghPrTargets(args).some((n) => wanted.has(n))) {
      breaches.push(`gh ${args.join(" ")}`);
    }
  }
  for (const args of recorder.git) {
    if (gitPushTargets(args, prs).some((n) => wanted.has(n))) {
      breaches.push(`git ${args.join(" ")}`);
    }
  }
  for (const prNumber of recorder.autoMerge) {
    if (wanted.has(prNumber)) breaches.push(`auto-merge ${REPO}#${prNumber}`);
  }
  return breaches;
}

/** The invariant, asserted identically for every entry point. */
function assertNoUninvitedWrites(
  entryPoint: string,
  recorder: Recorder,
  prs: FixturePr[],
): void {
  const breaches = writesTargeting(recorder, prs, FORBIDDEN);
  assertEquals(
    breaches,
    [],
    `${entryPoint} wrote to an uninvited or third-party PR: ` +
      breaches.join("; "),
  );
}

/**
 * The three assertions every entry point owes, in the order that makes a
 * breach self-explanatory: the recorded write first (it names the exact
 * `gh`/`git` invocation), then the adoption, then the proof that the guard
 * is not a blanket block.
 */
function assertScanScope(
  entryPoint: string,
  actioned: number[],
  recorder: Recorder,
  prs: FixturePr[],
): void {
  assertNoUninvitedWrites(entryPoint, recorder, prs);
  const adopted = actioned.filter((n) => FORBIDDEN.includes(n));
  assertEquals(
    adopted,
    [],
    `${entryPoint} adopted uninvited/third-party PR(s): ${adopted.join(", ")}`,
  );
  assertEquals(
    [...new Set(actioned)].toSorted(),
    ACTIONABLE,
    `${entryPoint} must keep maintaining every fleet, sibling and invited PR`,
  );
}

// ---------------------------------------------------------------------------
// The fixture `gh` implementation
// ---------------------------------------------------------------------------

const TIMELINE_PAGE = /\/issues\/(\d+)\/timeline/;
const PR_COMMENTS = /\/pulls\/(\d+)\/comments/;
const PR_REVIEWS = /\/pulls\/(\d+)\/reviews/;
const ISSUE_COMMENTS = /\/issues\/(\d+)\/comments/;
const CHECK_RUNS = /\/commits\/([^/]+)\/check-runs/;

function jsonOf(value: unknown): Promise<string> {
  return Promise.resolve(JSON.stringify(value));
}

/** Read the value of a flag such as `--author` from a `gh` argument list. */
function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * A `gh` stand-in serving the fixture repo, recording every invocation.
 *
 * Reads are answered faithfully — in particular `pr list --author <login>`
 * filters server-side exactly as GitHub does, so the set of PRs a scan sees
 * is decided by the author set it resolved and nothing else. That is what
 * makes the invariant a genuine test of #4076: resolving the defer-to set
 * puts the trusted human's login on the wire and the uninvited PR comes
 * straight back.
 */
function createFixtureGh(
  prs: FixturePr[],
  recorder: Recorder,
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    recorder.gh.push(args);
    const [noun, verb = ""] = args;
    const path = args[1] ?? "";
    const byNumber = (n: number) => prs.find((pr) => pr.number === n);

    if (noun === "pr" && verb === "list") {
      const author = flagValue(args, "--author");
      const selected = author === undefined
        ? prs
        : prs.filter((pr) => pr.author.toLowerCase() === author.toLowerCase());
      return jsonOf(selected.map((pr) => ({
        number: pr.number,
        headRefName: pr.headRefName,
        headRefOid: pr.headRefOid,
        baseRefName: pr.baseRefName,
        autoMergeRequest: pr.autoMergeRequest,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        author: { login: pr.author },
        labels: pr.labels,
        comments: pr.comments,
        reviews: pr.reviews,
      })));
    }

    if (noun === "pr" && verb === "view") {
      const pr = byNumber(Number(args[2]));
      return jsonOf({ headRefOid: pr?.headRefOid ?? "" });
    }

    if (noun === "issue" && verb === "view") {
      return jsonOf({ labels: [], state: "OPEN", number: BLOCKED_ISSUE });
    }

    if (noun === "label" && verb === "list") return jsonOf([]);

    if (noun === "api") {
      // GraphQL batching is deliberately unavailable so the scans exercise
      // their REST fallback, which is the path that names a PR explicitly.
      if (path === "graphql") {
        return Promise.reject(new Error("graphql unavailable in fixture"));
      }

      const timeline = TIMELINE_PAGE.exec(path);
      if (timeline) {
        const pr = byNumber(Number(timeline[1]));
        return jsonOf(
          Object.entries(pr?.labelAddedBy ?? {}).map(([label, actor]) => ({
            event: "labeled",
            label: { name: label },
            actor: { login: actor },
            created_at: "2026-08-02T00:00:00Z",
          })),
        );
      }

      if (PR_COMMENTS.test(path) || PR_REVIEWS.test(path)) return jsonOf([]);

      const issueComments = ISSUE_COMMENTS.exec(path);
      if (issueComments) {
        // Only the `--jq` projection is the comment scan's read; the plain
        // and paginated forms belong to the nudge marker check and the
        // escalation dedup, which must see an empty thread.
        if (!args.includes("--jq") || path.includes("?")) return jsonOf([]);
        return jsonOf(byNumber(Number(issueComments[1]))?.issueComments ?? []);
      }

      const checkRuns = CHECK_RUNS.exec(path);
      if (checkRuns) {
        const ref = checkRuns[1] ?? "";
        const pr = prs.find((p) =>
          p.headRefName === ref || p.headRefOid === ref
        );
        // With `--jq` this is the maintenance scans' failed-check read;
        // without it, the CI-nudge "has CI started?" probe, which must
        // report no runs so the nudge path actually fires.
        if (!args.includes("--jq")) return jsonOf({ check_runs: [] });
        return jsonOf(pr?.failedChecks ?? []);
      }

      if (path.includes("/actions/runs")) return jsonOf({ workflow_runs: [] });
      if (path.includes("/annotations")) return jsonOf([]);
      return jsonOf({});
    }

    return jsonOf([]);
  };
}

function makeSilentLogger(): Logger {
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

function scanOptions(
  prs: FixturePr[],
  recorder: Recorder,
): PrScanOptions {
  return {
    githubUser: HOST,
    repos: [REPO],
    logger: makeSilentLogger(),
    isRepoAllowed: () => true,
    // The trusted human may instruct the worker — that is precisely why a
    // blanket "ignore the human" would pass a weaker suite than this one.
    isAuthorisedCommenter: (author: string) => author === HUMAN,
    ghCommandFn: createFixtureGh(prs, recorder),
    allowedAuthors: [HUMAN, SIBLING],
    prAuthors: [SIBLING],
  };
}

/** Bound every drain loop so a non-converging scan fails rather than wedges. */
const MAX_DRAIN_PASSES = 20;

// ---------------------------------------------------------------------------
// findPrCommentsToFix
// ---------------------------------------------------------------------------

Deno.test(
  "findPrCommentsToFix - never actions an uninvited or third-party PR (Issue #4080)",
  async () => {
    const prs = createFixture();
    const recorder = newRecorder();
    const options = scanOptions(prs, recorder);
    const actioned: number[] = [];

    // The scan returns the first actionable comment and stops, so drain it:
    // consume each comment it hands back and rescan until nothing is left.
    // Only then does the actioned set describe every PR the scan reaches.
    for (let pass = 0; pass < MAX_DRAIN_PASSES; pass++) {
      const result = await findPrCommentsToFix(options);
      assert(result.ok);
      const found = result.value;
      if (found === null) break;
      actioned.push(found.prNumber);
      const pr = prs.find((p) => p.number === found.prNumber);
      assert(pr !== undefined, `scan returned unknown PR #${found.prNumber}`);
      pr.issueComments = pr.issueComments.filter(
        (c) => String(c.id) !== found.commentId,
      );
    }

    assertEquals(actioned.length < MAX_DRAIN_PASSES, true, "drain did not end");
    assertScanScope("findPrCommentsToFix", actioned, recorder, prs);
  },
);

// ---------------------------------------------------------------------------
// findFailedPrChecks
// ---------------------------------------------------------------------------

Deno.test(
  "findFailedPrChecks - never actions an uninvited or third-party PR (Issue #4080)",
  async () => {
    const prs = createFixture();
    const recorder = newRecorder();
    const options = scanOptions(prs, recorder);
    const actioned: number[] = [];

    for (let pass = 0; pass < MAX_DRAIN_PASSES; pass++) {
      const result = await findFailedPrChecks(options);
      assert(result.ok);
      const found = result.value;
      if (found === null) break;
      actioned.push(found.prNumber);
      const pr = prs.find((p) => p.number === found.prNumber);
      assert(pr !== undefined, `scan returned unknown PR #${found.prNumber}`);
      pr.failedChecks = pr.failedChecks.filter(
        (c) => String(c.id) !== found.checkId,
      );
    }

    assertEquals(actioned.length < MAX_DRAIN_PASSES, true, "drain did not end");
    assertScanScope("findFailedPrChecks", actioned, recorder, prs);
  },
);

// ---------------------------------------------------------------------------
// findFailedCiChecks
// ---------------------------------------------------------------------------

Deno.test(
  "findFailedCiChecks - never actions an uninvited or third-party PR (Issue #4080)",
  async () => {
    const prs = createFixture();
    const recorder = newRecorder();
    const stateDir = await Deno.makeTempDir({ prefix: "pr-uninvited-ci-" });
    const options = {
      ...scanOptions(prs, recorder),
      stateDir,
      getDefaultBranch: () => Promise.resolve("main"), // allow-hardcoded-branch
    };
    const actioned: number[] = [];

    try {
      for (let pass = 0; pass < MAX_DRAIN_PASSES; pass++) {
        const result = await findFailedCiChecks(options);
        assert(result.ok);
        const found = result.value;
        if (found === null) break;
        actioned.push(found.prNumber);
        const pr = prs.find((p) => p.number === found.prNumber);
        assert(pr !== undefined, `scan returned unknown PR #${found.prNumber}`);
        pr.failedChecks = pr.failedChecks.filter(
          (c) => String(c.id) !== found.checkId,
        );
      }
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }

    assertEquals(actioned.length < MAX_DRAIN_PASSES, true, "drain did not end");
    assertScanScope("findFailedCiChecks", actioned, recorder, prs);
  },
);

// ---------------------------------------------------------------------------
// ensureAutoMergeOnOpenPrs
// ---------------------------------------------------------------------------

Deno.test(
  "ensureAutoMergeOnOpenPrs - never merges an uninvited or third-party PR (Issue #4080)",
  async () => {
    const prs = createFixture();
    const recorder = newRecorder();
    const result = await ensureAutoMergeOnOpenPrs({
      ...scanOptions(prs, recorder),
      getRepoConfig: () => "",
      enableAutoMergeFn: (_repo: string, prNumber: number) => {
        recorder.autoMerge.push(prNumber);
        return Promise.resolve({ result: "enabled", message: "" });
      },
    });

    assert(result.ok);
    assertScanScope(
      "ensureAutoMergeOnOpenPrs",
      recorder.autoMerge,
      recorder,
      prs,
    );
    assertEquals(result.value.enabledCount, ACTIONABLE.length);
  },
);

// ---------------------------------------------------------------------------
// findPrsNeedingCiNudge (+ the write half, processCiNudgeCandidate)
// ---------------------------------------------------------------------------

Deno.test(
  "findPrsNeedingCiNudge - never nudges or pushes to an uninvited or third-party PR (Issue #4080)",
  async () => {
    const prs = createFixture();
    const recorder = newRecorder();
    const ghCommandFn = createFixtureGh(prs, recorder);
    const gitCommandFn = (args: string[]) => {
      recorder.git.push(args);
      return Promise.resolve("");
    };

    const found = await findPrsNeedingCiNudge({
      githubUser: HOST,
      allowedAuthors: [HUMAN, SIBLING],
      fleetPrAuthors: [SIBLING],
      repos: [REPO],
      ghCommandFn,
      nowSeconds: () => Math.floor(Date.parse("2026-08-14T00:00:00Z") / 1000),
    });
    assert(found.ok);
    const candidates = found.value.map((c) => c.prNumber);

    // The finder only reads — drive the write half too, because that is
    // where the audit comment and the empty-commit push actually happen.
    for (const candidate of found.value) {
      const outcome = await processCiNudgeCandidate(candidate, {
        ghCommandFn,
        gitCommandFn,
      });
      assert(outcome.ok, `nudge failed for #${candidate.prNumber}`);
    }

    assertScanScope("findPrsNeedingCiNudge", candidates, recorder, prs);

    // The two writes the nudge actually performs, checked by their own
    // recorders so neither can go missing behind the shared invariant.
    const commented = recorder.gh
      .filter((args) => args[0] === "pr" && args[1] === "comment")
      .flatMap(ghPrTargets);
    assertEquals(commented.toSorted(), ACTIONABLE);

    const pushed = recorder.git.flatMap((args) => gitPushTargets(args, prs));
    assertEquals(pushed.toSorted(), ACTIONABLE);
  },
);

// ---------------------------------------------------------------------------
// Drift guard — a new scan wired to the wrong resolver fails CI
// ---------------------------------------------------------------------------

/** The two modules whose scans push to, comment on, or merge the PRs they list. */
const PUSH_CAPABLE_SCAN_MODULES = [
  "pr_maintenance.ts",
  "pr_ci_nudge_scan.ts",
] as const;

/**
 * Helpers in those modules that take an already-resolved author set as a
 * parameter. They list PRs without resolving anything, so requiring a
 * resolver call inside them would be wrong.
 */
const AUTHOR_SET_PARAMETER_HELPERS = new Set([
  "listOpenPrs",
  "listActionablePrs",
  "listOpenPrsForAuthor",
  "listMergedPrs",
]);

/**
 * Strip block comments and whole-line comments.
 *
 * Deliberately conservative: a trailing `// …` on a code line is left
 * alone, which can only ever make the guard stricter, never laxer.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

/** Split module source into top-level `function name(...) { … }` chunks. */
function topLevelFunctions(source: string): Array<[string, string]> {
  const boundary = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/gm;
  const starts: Array<{ name: string; index: number }> = [];
  for (const match of source.matchAll(boundary)) {
    starts.push({ name: match[1]!, index: match.index });
  }
  return starts.map((start, i) => [
    start.name,
    source.slice(start.index, starts[i + 1]?.index ?? source.length),
  ]);
}

async function readScanModule(fileName: string): Promise<string> {
  const url = new URL(`../lib/${fileName}`, import.meta.url);
  return stripComments(await Deno.readTextFile(url));
}

Deno.test(
  "drift guard - no push-capable scan resolves the defer-to author set (Issue #4080)",
  async () => {
    for (const fileName of PUSH_CAPABLE_SCAN_MODULES) {
      const source = await readScanModule(fileName);
      const offenders = topLevelFunctions(source)
        .filter(([, body]) => body.includes("resolveFleetPrAuthorSet("))
        .map(([name]) => name);
      assertEquals(
        offenders,
        [],
        `${fileName}: ${offenders.join(", ")} resolves the defer-to set ` +
          `(resolveFleetPrAuthorSet). A scan that writes to the PRs it lists ` +
          `must resolve resolveFleetMaintenanceAuthorSet — see Issue #4074.`,
      );
    }
  },
);

Deno.test(
  "drift guard - every PR-listing scan resolves the push-capable set (Issue #4080)",
  async () => {
    let scansChecked = 0;
    for (const fileName of PUSH_CAPABLE_SCAN_MODULES) {
      const source = await readScanModule(fileName);
      for (const [name, body] of topLevelFunctions(source)) {
        if (AUTHOR_SET_PARAMETER_HELPERS.has(name)) continue;
        const listsPrs = body.includes("listActionablePrs(") ||
          body.includes("listOpenPrs(");
        if (!listsPrs) continue;
        scansChecked++;
        assertEquals(
          body.includes("resolveFleetMaintenanceAuthorSet("),
          true,
          `${fileName}: ${name} lists open PRs without resolving ` +
            `resolveFleetMaintenanceAuthorSet — a new scan wired to the ` +
            `wrong author set (Issue #4074).`,
        );
      }
    }
    // The five scan sites #4076 converted. Fewer than five means a scan was
    // renamed or moved and this guard silently stopped covering it — a
    // vacuous guard is how #4074 shipped in the first place.
    assertEquals(
      scansChecked >= 5,
      true,
      `only ${scansChecked} PR-listing scan sites found — expected at ` +
        `least the five #4076 converted; the guard has lost coverage`,
    );
  },
);
