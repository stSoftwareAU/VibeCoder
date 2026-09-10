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
 * A fake of `gh pr view <n> --repo <r> --json commits [--jq <expr>]`.
 *
 * It models the service rather than recording the request: it answers only
 * questions `gh` itself would answer, and rejects anything else the way `gh`
 * does — an unknown JSON field or a `jq` expression that does not match the
 * modelled `commits` payload yields an error, not an empty list. A lookup
 * that asked the wrong question therefore fails here instead of quietly
 * reading as "this PR has no host commits".
 */
function makeGhFake(
  commitAuthorsByPr: Record<number, string[]>,
  failFor: number[],
  ghCalls: string[][],
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    ghCalls.push(args);
    if (args[0] !== "pr" || args[1] !== "view") {
      return Promise.reject(new Error(`gh: unknown command: ${args[0]}`));
    }
    const prNumber = Number(args[2]);
    if (
      !Number.isInteger(prNumber) || commitAuthorsByPr[prNumber] === undefined
    ) {
      if (!failFor.includes(prNumber)) {
        return Promise.reject(
          new Error(`gh: no pull request found: ${args[2]}`),
        );
      }
    }
    if (args[3] !== "--repo" || args[4] !== REPO) {
      return Promise.reject(new Error(`gh: unknown repository: ${args[4]}`));
    }
    if (failFor.includes(prNumber)) {
      return Promise.reject(new Error(`gh: HTTP 502 on PR ${prNumber}`));
    }
    if (args[5] !== "--json") {
      return Promise.reject(new Error("gh: expected --json"));
    }
    if (args[6] !== "commits") {
      return Promise.reject(new Error(`gh: unknown JSON field: ${args[6]}`));
    }
    // The modelled payload: `commits[].authors[]` is the list of a commit's
    // authors, each carrying a `login`. Only a `jq` expression that walks it
    // is answered; any other path is a `jq` error, as it would be against
    // real output.
    const commits = (commitAuthorsByPr[prNumber] ?? []).map((login) => ({
      authors: [{ login }],
    }));
    if (args[7] !== "--jq") {
      return Promise.resolve(JSON.stringify({ commits }));
    }
    if (args[8] !== "[.commits[].authors[].login]") {
      return Promise.reject(
        new Error(`jq: error: cannot index commits with ${args[8]}`),
      );
    }
    return Promise.resolve(
      JSON.stringify(commits.flatMap((c) => c.authors.map((a) => a.login))),
    );
  };
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
  const gh = makeGhFake(commitAuthorsByPr, failFor, ghCalls);
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

Deno.test("branch-update selection - a dash-leading head ref is never selected (Issue #12)", async () => {
  // The marker route refuses an argument-injection-shaped branch; the bot
  // route must too, and the refusal costs no commit lookup.
  const harness = makeHarness({ 19: ["dependabot[bot]", HOST] });
  const selected = await harness.select([
    makeCandidate({ number: 19, headRefName: "--upload-pack=touch /tmp/x" }),
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
  const mutating = ["comment", "edit", "review", "close", "merge"];
  const writes = harness.ghCalls.filter((call) =>
    mutating.includes(call[1] ?? "")
  );
  assertEquals(writes, []);
});

// ---------------------------------------------------------------------------
// Commit-author lookup
// ---------------------------------------------------------------------------

Deno.test("fetchPrCommitAuthorLogins - reads every commit author login from the PR", async () => {
  // The fake answers only the question `gh` can answer, so a lookup that
  // asked for the wrong field or walked the wrong path would reject here.
  const gh = makeGhFake({ 20: ["dependabot[bot]", HOST] }, [], []);
  const logins = await fetchPrCommitAuthorLogins(REPO, 20, gh);
  assertEquals(logins, ["dependabot[bot]", HOST]);
});

Deno.test("fetchPrCommitAuthorLogins - a PR with only bot commits yields no host login", async () => {
  const gh = makeGhFake({ 23: ["dependabot[bot]"] }, [], []);
  assertEquals(await fetchPrCommitAuthorLogins(REPO, 23, gh), [
    "dependabot[bot]",
  ]);
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
