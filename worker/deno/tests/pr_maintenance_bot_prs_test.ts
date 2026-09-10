/**
 * Scan-level tests for bot-authored PR admission (Issue #1848).
 *
 * `listBotPrs` (Issue #1846) is wired into `listActionablePrs`, the one
 * admission point every PR-maintenance scan lists through. These tests
 * drive the four scans — PR feedback, spelling, CI fix and auto-merge —
 * end to end against a fake `gh`, so a bot PR that stops reaching any of
 * them fails here rather than in production.
 *
 * The counter-case is asserted in the same fixture: an **uninvited human**
 * PR, equally attractive to every scan, is still never returned. Bot
 * admission must widen the set by exactly one authorship class.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import {
  type AutoMergeOptions,
  type CiCheckScanOptions,
  ensureAutoMergeOnOpenPrs,
  findFailedCiChecks,
  findFailedPrChecks,
  findPrCommentsToFix,
  listActionablePrs,
  type PrScanOptions,
} from "../lib/pr_maintenance.ts";
import type { Logger } from "../types.ts";

const REPO = "org/repo";
/** This host's login — a fleet account with no open PR in the fixture. */
const HOST = "testbot";
/** A dependency bot: `isBotLogin` says bot, and it is not a fleet account. */
const BOT = "dependabot[bot]";
/** A second, independent dependency bot. */
const BOT2 = "renovate[bot]";
/** A trusted human who has *not* invited the worker onto their PR. */
const HUMAN = "courtyen";

const BOT_PR = 501;
const BOT_PR_2 = 502;
const HUMAN_PR = 2312;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface FixturePr {
  number: number;
  author: string;
  headRefName: string;
  autoMergeRequest?: { mergeMethod: string } | null;
  isCrossRepository?: boolean;
  /** Failed check runs on the head branch. */
  failedChecks?: Array<{ id: number; name: string }>;
  /** The Actions step that failed, per check id. */
  failedStep?: Record<number, string>;
  /** Top-level issue comments the feedback scan can action. */
  issueComments?: Array<{ login: string; id: number; body: string }>;
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

function baseOptions(overrides?: Partial<PrScanOptions>): PrScanOptions {
  return {
    githubUser: HOST,
    repos: [REPO],
    logger: makeSilentLogger(),
    isRepoAllowed: () => true,
    isAuthorisedCommenter: () => false,
    ghCommandFn: () => Promise.resolve("[]"),
    allowedAuthors: [HUMAN],
    ...overrides,
  };
}

/** Read the value of a flag such as `--author` from a `gh` argument list. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * A `gh` stand-in serving `prs` as the repository's open PRs.
 *
 * `pr list --author <login>` filters server-side exactly as GitHub does, so
 * the un-filtered listing (`fetchAllOpenPRs`, no `--author`) is the only
 * call that can surface a bot PR — which is precisely the door under test.
 * GraphQL is refused so every check-run read goes down the REST path and is
 * attributable to one PR's head branch.
 */
function makeGh(
  prs: readonly FixturePr[],
  capture?: (args: string[]) => void,
): (args: string[]) => Promise<string> {
  const byBranch = (ref: string) => prs.find((pr) => pr.headRefName === ref);
  const allChecks = prs.flatMap((pr) =>
    (pr.failedChecks ?? []).map((check) => ({ pr, check }))
  );

  return (args: string[]): Promise<string> => {
    capture?.(args);
    const json = (value: unknown) => Promise.resolve(JSON.stringify(value));
    const [noun] = args;
    const path = args[1] ?? "";

    if (noun === "pr" && args[1] === "list") {
      const author = flagValue(args, "--author");
      const selected = author === undefined
        ? prs
        : prs.filter((pr) => pr.author.toLowerCase() === author.toLowerCase());
      return json(selected.map((pr) => ({
        number: pr.number,
        title: `PR ${pr.number}`,
        baseRefName: "main", // allow-hardcoded-branch — fixture default branch
        headRefName: pr.headRefName,
        headRefOid: `sha${pr.number}`,
        body: "",
        url: `https://github.com/${REPO}/pull/${pr.number}`,
        author: { login: pr.author },
        isCrossRepository: pr.isCrossRepository ?? false,
        autoMergeRequest: pr.autoMergeRequest ?? null,
        mergeable: "MERGEABLE",
        labels: [],
        comments: [],
        reviews: [],
      })));
    }

    if (noun !== "api") return Promise.resolve("[]");
    if (path === "graphql") {
      return Promise.reject(new Error("fixture: GraphQL unavailable"));
    }

    const checkRuns = /\/commits\/(.+)\/check-runs$/.exec(path);
    if (checkRuns) {
      const pr = byBranch(decodeURIComponent(checkRuns[1] ?? ""));
      return json((pr?.failedChecks ?? []).map((check) => ({
        id: check.id,
        name: check.name,
        status: "completed",
        conclusion: "failure",
      })));
    }

    // Issue #1579: a failed check is routed on the step that failed inside
    // its Actions job, so every check run resolves to a job.
    const byId = /\/check-runs\/(\d+)$/.exec(path);
    if (byId) {
      return json({
        app: { slug: "github-actions" },
        details_url: `https://github.com/${REPO}/actions/runs/1/job/${byId[1]}`,
      });
    }
    const job = /\/actions\/jobs\/(\d+)$/.exec(path);
    if (job) {
      const id = Number(job[1]);
      const owner = allChecks.find((entry) => entry.check.id === id);
      const step = owner?.pr.failedStep?.[id] ?? "Run the suite";
      return json({
        steps: [
          { name: "Set up job", conclusion: "success" },
          { name: step, conclusion: "failure" },
        ],
      });
    }

    const issueComments = /\/issues\/(\d+)\/comments/.exec(path);
    if (issueComments) {
      if (!args.includes("--jq")) return json([]);
      const pr = prs.find((p) => p.number === Number(issueComments[1]));
      return json((pr?.issueComments ?? []).map((comment) => ({
        login: comment.login,
        id: comment.id,
        body: comment.body,
        thumbs_up: 0,
        eyes: 0,
      })));
    }

    return json([]);
  };
}

/** A bot PR carrying one red `Deno Audit` check. */
function redBotPr(overrides: Partial<FixturePr> = {}): FixturePr {
  return {
    number: BOT_PR,
    author: BOT,
    headRefName: "dependabot/deno/std-1.2.3",
    failedChecks: [{ id: 9001, name: "Deno Audit" }],
    failedStep: { 9001: "Run deno audit" },
    ...overrides,
  };
}

/** The uninvited human's PR — equally attractive to every scan. */
function redHumanPr(overrides: Partial<FixturePr> = {}): FixturePr {
  return {
    number: HUMAN_PR,
    author: HUMAN,
    headRefName: "courtyen/hand-written-fix",
    failedChecks: [{ id: 7001, name: "Deno Audit" }],
    failedStep: { 7001: "Run deno audit" },
    ...overrides,
  };
}

async function withStateDir<T>(
  fn: (stateDir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "pr_bot_scan_" });
  try {
    return await fn(`${dir}/.ci_state`);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// The admission point itself
// ---------------------------------------------------------------------------

Deno.test("listActionablePrs - unions the bot source and de-duplicates by number (Issue #1848)", async () => {
  // The first PR arrives from both the maintenance listing (its author is in
  // the scan author set) and the bot door. It must appear exactly once.
  const prs = [
    { number: BOT_PR, author: BOT, headRefName: "dependabot/deno/std" },
    { number: BOT_PR_2, author: BOT2, headRefName: "renovate/deno-std" },
  ];
  const admitted = await listActionablePrs(
    REPO,
    [BOT],
    "number,headRefName",
    baseOptions({ githubUser: HOST, ghCommandFn: makeGh(prs) }),
  );
  assertEquals(admitted.map((pr) => pr.number), [BOT_PR, BOT_PR_2]);
});

Deno.test("listActionablePrs - an uninvited human PR is admitted by no source (Issue #1848)", async () => {
  const admitted = await listActionablePrs(
    REPO,
    [HOST],
    "number,headRefName",
    baseOptions({ ghCommandFn: makeGh([redHumanPr()]) }),
  );
  assertEquals(admitted.map((pr) => pr.number), []);
});

// ---------------------------------------------------------------------------
// findFailedCiChecks — the CI-fix scan
// ---------------------------------------------------------------------------

Deno.test("findFailedCiChecks - returns a bot PR's failed check, carrying its head branch (Issue #1848)", async () => {
  await withStateDir(async (stateDir) => {
    const options: CiCheckScanOptions = {
      ...baseOptions({ ghCommandFn: makeGh([redBotPr(), redHumanPr()]) }),
      stateDir,
      maxRetries: 3,
    };
    const result = await findFailedCiChecks(options);
    assertEquals(result.ok, true);
    if (!result.ok) return;
    assertEquals(result.value?.prNumber, BOT_PR);
    assertEquals(result.value?.branchName, "dependabot/deno/std-1.2.3");
    assertEquals(result.value?.checkName, "Deno Audit");
    assertEquals(result.value?.checkId, "9001");
  });
});

Deno.test("findFailedCiChecks - an uninvited human PR with a red check is still not returned (Issue #1848)", async () => {
  await withStateDir(async (stateDir) => {
    const options: CiCheckScanOptions = {
      ...baseOptions({ ghCommandFn: makeGh([redHumanPr()]) }),
      stateDir,
      maxRetries: 3,
    };
    const result = await findFailedCiChecks(options);
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value, null);
  });
});

Deno.test("findFailedCiChecks - a fork-headed bot PR is not admitted (Issue #1848)", async () => {
  await withStateDir(async (stateDir) => {
    const options: CiCheckScanOptions = {
      ...baseOptions({
        ghCommandFn: makeGh([redBotPr({ isCrossRepository: true })]),
      }),
      stateDir,
      maxRetries: 3,
    };
    const result = await findFailedCiChecks(options);
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value, null);
  });
});

Deno.test("findFailedCiChecks - two red bot PRs are independent candidates, keyed by check id (Issue #1848)", async () => {
  await withStateDir(async (stateDir) => {
    // The first bot PR's check has spent its budget; the second must still
    // be a candidate, because the counter is keyed by check id, not by repo.
    await Deno.mkdir(stateDir, { recursive: true });
    await Deno.writeTextFile(`${stateDir}/org_repo_9001.retries`, "3");

    const second = redBotPr({
      number: BOT_PR_2,
      author: BOT2,
      headRefName: "renovate/deno-std",
      failedChecks: [{ id: 9002, name: "Deno Audit" }],
      failedStep: { 9002: "Run deno audit" },
    });
    const options: CiCheckScanOptions = {
      ...baseOptions({ ghCommandFn: makeGh([redBotPr(), second]) }),
      stateDir,
      maxRetries: 3,
    };
    const result = await findFailedCiChecks(options);
    assertEquals(result.ok, true);
    if (!result.ok) return;
    assertEquals(result.value?.prNumber, BOT_PR_2);
    assertEquals(result.value?.checkId, "9002");
  });
});

// ---------------------------------------------------------------------------
// findFailedPrChecks — the spelling scan
// ---------------------------------------------------------------------------

Deno.test("findFailedPrChecks - a bot PR's red spelling check reaches the spelling scan (Issue #1848)", async () => {
  const bot = redBotPr({
    failedChecks: [{ id: 9100, name: "Scripts & spelling" }],
    failedStep: { 9100: "Run codespell" },
  });
  const human = redHumanPr({
    failedChecks: [{ id: 7100, name: "Scripts & spelling" }],
    failedStep: { 7100: "Run codespell" },
  });

  const result = await findFailedPrChecks(
    baseOptions({ ghCommandFn: makeGh([bot, human]) }),
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value?.prNumber, BOT_PR);
  assertEquals(result.value?.branchName, "dependabot/deno/std-1.2.3");

  const humanOnly = await findFailedPrChecks(
    baseOptions({ ghCommandFn: makeGh([human]) }),
  );
  assertEquals(humanOnly.ok, true);
  if (humanOnly.ok) assertEquals(humanOnly.value, null);
});

// ---------------------------------------------------------------------------
// findPrCommentsToFix — the PR-feedback scan
// ---------------------------------------------------------------------------

Deno.test("findPrCommentsToFix - an authorised human's comment on a bot PR is actionable (Issue #1848)", async () => {
  const bot = redBotPr({
    issueComments: [{ login: "reviewer", id: 991, body: "Please bump again" }],
  });
  const result = await findPrCommentsToFix(baseOptions({
    ghCommandFn: makeGh([bot]),
    isAuthorisedCommenter: (author: string) => author === "reviewer",
  }));
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value?.prNumber, BOT_PR);
  assertEquals(result.value?.commentId, "991");
});

Deno.test("findPrCommentsToFix - the bot's own comment on its PR is not actionable (Issue #1848)", async () => {
  const bot = redBotPr({
    issueComments: [{ login: BOT, id: 992, body: "Superseded by #503" }],
  });
  const result = await findPrCommentsToFix(baseOptions({
    ghCommandFn: makeGh([bot]),
    isAuthorisedCommenter: (author: string) => author === "reviewer",
  }));
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, null);
});

Deno.test("findPrCommentsToFix - an authorised comment on an uninvited human PR is still ignored (Issue #1848)", async () => {
  const human = redHumanPr({
    issueComments: [{ login: "reviewer", id: 993, body: "Please fix CI" }],
  });
  const result = await findPrCommentsToFix(baseOptions({
    ghCommandFn: makeGh([human]),
    isAuthorisedCommenter: (author: string) => author === "reviewer",
  }));
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, null);
});

// ---------------------------------------------------------------------------
// ensureAutoMergeOnOpenPrs — the auto-merge scan
// ---------------------------------------------------------------------------

function autoMergeOptions(
  prs: readonly FixturePr[],
  enabled: number[],
  skipAutoMerge = "",
): AutoMergeOptions {
  return {
    ...baseOptions({ ghCommandFn: makeGh(prs) }),
    getRepoConfig: (_repo: string, key: string) =>
      key === "skip_auto_merge" ? skipAutoMerge : "",
    enableAutoMergeFn: (_repo: string, prNumber: number) => {
      enabled.push(prNumber);
      return Promise.resolve({ result: "enabled", message: "OK" });
    },
  };
}

Deno.test("ensureAutoMergeOnOpenPrs - arms auto-merge on a green bot PR (Issue #1848)", async () => {
  const enabled: number[] = [];
  const green = redBotPr({ failedChecks: [], failedStep: {} });
  const result = await ensureAutoMergeOnOpenPrs(
    autoMergeOptions([green, redHumanPr()], enabled),
  );
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.enabledCount, 1);
  assertEquals(enabled, [BOT_PR]);
});

Deno.test("ensureAutoMergeOnOpenPrs - a bot PR the repo already armed is skipped (Issue #1848)", async () => {
  const enabled: number[] = [];
  const armed = redBotPr({
    failedChecks: [],
    autoMergeRequest: { mergeMethod: "SQUASH" },
  });
  const result = await ensureAutoMergeOnOpenPrs(
    autoMergeOptions([armed], enabled),
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.enabledCount, 0);
    assertEquals(result.value.skippedCount, 1);
  }
  assertEquals(enabled, []);
});

Deno.test("ensureAutoMergeOnOpenPrs - skip_auto_merge still governs bot PRs (Issue #1848)", async () => {
  const enabled: number[] = [];
  const green = redBotPr({ failedChecks: [] });
  const result = await ensureAutoMergeOnOpenPrs(
    autoMergeOptions([green], enabled, "true"),
  );
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.enabledCount, 0);
  assertEquals(enabled, []);
});
