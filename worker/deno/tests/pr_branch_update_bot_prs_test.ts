/**
 * The branch-update scan must keep bot PRs the worker pushed to current
 * (Issue #1849).
 *
 * Dependabot and Renovate stop rebasing a PR once a foreign commit lands on
 * it, so a bot PR the worker fixed drifts behind its base until the merge
 * gate skips it as "branch not fresh". `selectBranchUpdatePrs` is the
 * selection the production `listPrs` wiring runs: worker PRs by marker, plus
 * bot PRs carrying a commit by this host.
 *
 * These tests drive the real selector — only the `gh` runner is stubbed —
 * through the real `scanPrBranchUpdates`, and assert on outcomes: which PRs
 * become update actions, which `gh` calls were issued, and what was logged.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type BranchUpdateCandidate,
  fetchPrCommitAuthorLogins,
  type PrBranchUpdateDeps,
  scanPrBranchUpdates,
  selectBranchUpdatePrs,
} from "../lib/pr_branch_update.ts";
import type { Logger } from "../types.ts";

const REPO = "org/repo";
const HOST = "vibe-coder";

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

/** The un-filtered listing shape `fetchAllOpenPRs` hands the selector. */
function makeCandidate(
  overrides?: Partial<BranchUpdateCandidate>,
): BranchUpdateCandidate {
  return {
    number: 10,
    headRefName: "dependabot/npm_and_yarn/lodash-4.17.21",
    baseRefName: "main",
    body: "Bumps lodash.",
    authorLogin: "dependabot[bot]",
    isCrossRepository: false,
    ...overrides,
  };
}

interface Harness {
  /** The `gh` argument vectors the selection issued, in order. */
  ghCalls: string[][];
  logLines: string[];
  select: (prs: BranchUpdateCandidate[]) => Promise<
    Awaited<ReturnType<typeof selectBranchUpdatePrs>>
  >;
}

/**
 * A selector wired to a `gh` stub that answers the commit-author lookup.
 *
 * @param commitAuthorsByPr - Commit author logins per PR number.
 * @param failFor - PR numbers whose lookup should fail.
 */
function makeHarness(
  commitAuthorsByPr: Record<number, string[]>,
  failFor: number[] = [],
): Harness {
  const ghCalls: string[][] = [];
  const logLines: string[] = [];
  const gh = (args: string[]): Promise<string> => {
    ghCalls.push(args);
    const prNumber = Number(args[2]);
    if (failFor.includes(prNumber)) {
      return Promise.reject(new Error(`gh: HTTP 502 on PR ${prNumber}`));
    }
    return Promise.resolve(
      JSON.stringify(commitAuthorsByPr[prNumber] ?? []),
    );
  };
  return {
    ghCalls,
    logLines,
    select: (prs: BranchUpdateCandidate[]) =>
      selectBranchUpdatePrs({
        repo: REPO,
        prs,
        githubUser: HOST,
        fetchCommitAuthorLogins: (repo, prNumber) =>
          fetchPrCommitAuthorLogins(repo, prNumber, gh),
        log: (message: string) => logLines.push(message),
      }),
  };
}

/** Run the real scan over the selector's output. */
async function scanWith(
  listPrs: PrBranchUpdateDeps["listPrs"],
): Promise<number[]> {
  const result = await scanPrBranchUpdates({
    repos: [REPO],
    logger: makeSilentLogger(),
    isRepoAllowed: () => true,
    getDefaultBranch: async () => "main",
    listPrs,
    getBehindBy: async () => 3,
    getMergeableStatus: async () => "MERGEABLE",
  });
  if (!result.ok) throw result.error;
  return result.value.actions.map((a) => a.prNumber);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

Deno.test("branch-update selection - a bot PR with a host commit reaches scanPrBranchUpdates", async () => {
  const harness = makeHarness({ 10: ["dependabot[bot]", HOST] });
  const prNumbers = await scanWith(() =>
    harness.select([makeCandidate({ number: 10 })])
  );
  assertEquals(prNumbers, [10]);
});

Deno.test("branch-update selection - a bot PR without a host commit is left alone", async () => {
  const harness = makeHarness({ 11: ["dependabot[bot]"] });
  const prNumbers = await scanWith(() =>
    harness.select([makeCandidate({ number: 11 })])
  );
  assertEquals(prNumbers, []);
});

Deno.test("branch-update selection - worker PRs still reach the scan and cost no commit lookup", async () => {
  const harness = makeHarness({});
  const prNumbers = await scanWith(() =>
    harness.select([
      makeCandidate({
        number: 12,
        headRefName: "issue-12-fix-parser",
        authorLogin: HOST,
        body: "Closes #12",
      }),
    ])
  );
  assertEquals(prNumbers, [12]);
  assertEquals(harness.ghCalls.length, 0);
});

Deno.test("branch-update selection - no commit lookup is issued for a non-bot PR", async () => {
  const harness = makeHarness({});
  const selected = await harness.select([
    makeCandidate({
      number: 13,
      headRefName: "feature/manual",
      authorLogin: "some-developer",
      body: "A developer's PR",
    }),
  ]);
  assertEquals(selected, []);
  assertEquals(harness.ghCalls.length, 0);
});

Deno.test("branch-update selection - a fork-headed bot PR costs no commit lookup", async () => {
  const harness = makeHarness({ 14: [HOST] });
  const selected = await harness.select([
    makeCandidate({ number: 14, isCrossRepository: true }),
  ]);
  assertEquals(selected, []);
  assertEquals(harness.ghCalls.length, 0);
});

Deno.test("branch-update selection - a failed commit lookup excludes the PR and is logged", async () => {
  const harness = makeHarness({}, [15]);
  const prNumbers = await scanWith(() =>
    harness.select([makeCandidate({ number: 15 })])
  );
  assertEquals(prNumbers, []);
  assertEquals(harness.logLines.length, 1);
  const line = harness.logLines[0] ?? "";
  assertStringIncludes(line, "prNumber=15");
  assertStringIncludes(line, "reason=commit-lookup-failed");
  assertStringIncludes(line, "HTTP 502");
});

Deno.test("branch-update selection - one failed lookup does not stop the other PRs", async () => {
  const harness = makeHarness({ 17: ["dependabot[bot]", HOST] }, [16]);
  const prNumbers = await scanWith(() =>
    harness.select([
      makeCandidate({ number: 16 }),
      makeCandidate({ number: 17 }),
    ])
  );
  assertEquals(prNumbers, [17]);
  assertEquals(harness.logLines.length, 1);
});

Deno.test("branch-update selection - the scan never asks the bot to rebase", async () => {
  // `@dependabot rebase` recreates the branch and discards the worker's
  // commits, so the selection may only ever *read* the PR.
  const harness = makeHarness({ 18: ["dependabot[bot]", HOST] });
  await harness.select([makeCandidate({ number: 18 })]);
  for (const call of harness.ghCalls) {
    assertEquals(call[0], "pr");
    assertEquals(call[1], "view");
  }
});

// ---------------------------------------------------------------------------
// Commit-author lookup
// ---------------------------------------------------------------------------

Deno.test("fetchPrCommitAuthorLogins - asks gh for the PR's commit author logins", async () => {
  const calls: string[][] = [];
  const logins = await fetchPrCommitAuthorLogins(REPO, 20, (args) => {
    calls.push(args);
    return Promise.resolve('["dependabot[bot]","vibe-coder"]\n');
  });
  assertEquals(logins, ["dependabot[bot]", HOST]);
  assertEquals(calls, [[
    "pr",
    "view",
    "20",
    "--repo",
    REPO,
    "--json",
    "commits",
    "--jq",
    "[.commits[].authors[].login]",
  ]]);
});

Deno.test("fetchPrCommitAuthorLogins - a non-array answer throws rather than reading as no commits", async () => {
  let message = "";
  try {
    await fetchPrCommitAuthorLogins(
      REPO,
      21,
      () => Promise.resolve('{"message":"Not Found"}'),
    );
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assertStringIncludes(message, "did not return a JSON array");
});

Deno.test("fetchPrCommitAuthorLogins - unparseable output throws", async () => {
  let message = "";
  try {
    await fetchPrCommitAuthorLogins(
      REPO,
      22,
      () => Promise.resolve("not json"),
    );
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assertStringIncludes(message, "unparseable");
});
