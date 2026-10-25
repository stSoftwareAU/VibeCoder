/**
 * The review gate and a failed GitHub Actions check suite (Issue #4347).
 *
 * A workflow that fails at startup records a COMPLETED GitHub Actions check
 * suite with conclusion STARTUP_FAILURE and no check run, so the statusCheckRollup
 * (which lists check runs and statuses only) reads green. The gate must read the
 * suites too and call such a PR `ci-failed`.
 */
import { assertEquals, assertRejects } from "@std/assert";
import {
  type CheckSuiteNode,
  type RollupContextNode,
  type SearchPr,
  skipReason,
} from "../../../.claude/skills/review-fleet-prs/scripts/gate.ts";

const suite = (
  app: string | null,
  status: string | null,
  conclusion: string | null,
  checkRunCount = 0,
): CheckSuiteNode => ({
  app: app === null ? null : { slug: app },
  status,
  conclusion,
  checkRuns: { totalCount: checkRunCount },
});

const GA = "github-actions";

const searchPr = (
  rollup: string | null,
  suites: CheckSuiteNode[],
  contexts?: RollupContextNode[],
): SearchPr => ({
  number: 4347,
  title: "t",
  url: "https://github.com/o/r/pull/4347",
  isDraft: false,
  mergeable: "MERGEABLE",
  headRefOid: "head",
  baseRefName: "main",
  repository: { nameWithOwner: "o/r", defaultBranchRef: { name: "main" } },
  author: { login: "stservice" },
  commits: {
    nodes: [{
      commit: {
        statusCheckRollup: rollup === null ? null : {
          state: rollup,
          ...(contexts ? { contexts: { nodes: contexts } } : {}),
        },
        checkSuites: { nodes: suites },
      },
    }],
  },
  reviews: { nodes: [] },
});

Deno.test("skipReason (#4347): a completed Actions suite that failed at startup is ci-failed although the rollup is green", async () => {
  const startupFailure = suite(GA, "COMPLETED", "STARTUP_FAILURE");
  assertEquals(
    await skipReason(searchPr("SUCCESS", [startupFailure]), "nleck"),
    "ci-failed",
  );
  // Control: the same green PR with no suites is ready.
  assertEquals(await skipReason(searchPr("SUCCESS", []), "nleck"), null);
});

Deno.test("skipReason (#4347): a suite from another app, or one not yet concluded, does not block review", async () => {
  // A queued suite from another app has no conclusion yet.
  assertEquals(
    await skipReason(
      searchPr("SUCCESS", [suite("review-bot", "QUEUED", null)]),
      "nleck",
    ),
    null,
  );
  // A completed FAILURE suite from another app is not an Actions suite.
  assertEquals(
    await skipReason(
      searchPr("SUCCESS", [suite("review-bot", "COMPLETED", "FAILURE")]),
      "nleck",
    ),
    null,
  );
});

Deno.test("skipReason (#4347): an Actions suite still running is not a failure yet", async () => {
  assertEquals(
    await skipReason(
      searchPr("SUCCESS", [suite(GA, "QUEUED", null)]),
      "nleck",
    ),
    null,
  );
  assertEquals(
    await skipReason(
      searchPr("SUCCESS", [suite(GA, "IN_PROGRESS", null)]),
      "nleck",
    ),
    null,
  );
  // The status decides, not a conclusion left on an unfinished suite.
  assertEquals(
    await skipReason(
      searchPr("SUCCESS", [suite(GA, "IN_PROGRESS", "FAILURE")]),
      "nleck",
    ),
    null,
  );
});

Deno.test("skipReason (#4347): completed Actions suites that passed, were skipped or neutral do not block review", async () => {
  for (const conclusion of ["SUCCESS", "SKIPPED", "NEUTRAL"]) {
    assertEquals(
      await skipReason(
        searchPr("SUCCESS", [suite(GA, "COMPLETED", conclusion)]),
        "nleck",
      ),
      null,
      conclusion,
    );
  }
});

Deno.test("skipReason (#4347): any other concluded Actions suite is ci-failed", async () => {
  for (const conclusion of ["ACTION_REQUIRED", "TIMED_OUT", "FAILURE"]) {
    assertEquals(
      await skipReason(
        searchPr("SUCCESS", [suite(GA, "COMPLETED", conclusion)]),
        "nleck",
      ),
      "ci-failed",
      conclusion,
    );
  }
});

Deno.test("skipReason (#4347): a failed Actions suite is ci-failed when the rollup is absent", async () => {
  assertEquals(
    await skipReason(
      searchPr(null, [suite(GA, "COMPLETED", "STARTUP_FAILURE")]),
      "nleck",
    ),
    "ci-failed",
  );
  // Control: no rollup and no suites is still waiting for CI.
  assertEquals(await skipReason(searchPr(null, []), "nleck"), "waiting-ci");
});

Deno.test("skipReason (#4347): a red rollup is ci-cancelled only when every red check and failed suite is cancelled", async () => {
  const cancelledRun = {
    __typename: "CheckRun",
    name: "e2e",
    conclusion: "CANCELLED",
  };
  assertEquals(
    await skipReason(
      searchPr("FAILURE", [suite(GA, "COMPLETED", "CANCELLED")], [
        cancelledRun,
      ]),
      "nleck",
    ),
    "ci-cancelled",
  );
  assertEquals(
    await skipReason(
      searchPr("FAILURE", [suite(GA, "COMPLETED", "STARTUP_FAILURE")], [
        cancelledRun,
      ]),
      "nleck",
    ),
    "ci-failed",
  );
  // Existing behaviour (Issue #2916): an all-cancelled rollup with no suites.
  assertEquals(
    await skipReason(searchPr("FAILURE", [], [cancelledRun]), "nleck"),
    "ci-cancelled",
  );
});

Deno.test("skipReason (#4347): a failed or cancelled Actions suite that has check runs does not block a green rollup", async () => {
  // The draft-era Quality suite stays completed/failure (or cancelled) beside
  // the later green run of the same workflow. It has check runs, so the
  // rollup already judged the latest run.
  for (const conclusion of ["FAILURE", "CANCELLED"]) {
    assertEquals(
      await skipReason(
        searchPr("SUCCESS", [
          suite(GA, "COMPLETED", conclusion, 2),
          suite(GA, "COMPLETED", "SUCCESS", 1),
        ]),
        "nleck",
      ),
      null,
      conclusion,
    );
  }
});

Deno.test("skipReason (#4347): a commit without a checkSuites list fails loud", async () => {
  const pr = {
    ...searchPr("SUCCESS", []),
    commits: {
      nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }],
    },
  } as unknown as SearchPr;
  await assertRejects(
    () => skipReason(pr, "nleck"),
    Error,
    "checkSuites",
  );
});
