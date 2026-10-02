/**
 * The deterministic gate of the review-fleet-prs Claude Code skill (Issue #2675).
 * It decides which fleet PRs are worth a model review; the review itself is
 * the skill's job.
 */
import { assertEquals, assertRejects } from "@std/assert";
import {
  authorKind,
  existingTestChanges,
  isTestPath,
  noTestAdded,
  ownDiffUnchanged,
  REVIEW_MARKER,
  reviewedAtHead,
  type RollupContextNode,
  runWithTimeout,
  type SearchPr,
  sentBackAt,
  skipReason,
} from "../../../.claude/skills/review-fleet-prs/gate.ts";

const file = (
  filename: string,
  status: string,
  additions: number,
  deletions: number,
  previous_filename?: string,
) => ({
  filename,
  status,
  additions,
  deletions,
  previous_filename,
});

Deno.test("isTestPath recognises the fleet's test layouts and not source files", () => {
  for (
    const path of [
      "worker/deno/tests/foo_test.ts",
      "src/foo.test.ts",
      "pkg/foo_test.go",
      "test_foo.py",
      "ockham/tests/workflow_overlap.rs",
      "src/test/java/FooTest.java",
      "test/QualityWorkflow.ts",
    ]
  ) assertEquals(isTestPath(path), true, path);
  for (
    const path of [
      "worker/deno/lib/foo.ts",
      "src/latest.rs",
      "README.md",
      "src/contest.ts",
    ]
  ) {
    assertEquals(isTestPath(path), false, path);
  }
});

Deno.test("existingTestChanges: removed and edited existing tests are listed, new and appended ones are not", () => {
  const changes = existingTestChanges([
    file("tests/gone_test.ts", "removed", 0, 40),
    file("tests/edited_test.ts", "modified", 3, 2),
    file("tests/appended_test.ts", "modified", 20, 0),
    file("tests/new_test.ts", "added", 50, 0),
    file("tests/moved_test.ts", "renamed", 0, 0, "tests/old_test.ts"),
    file("lib/foo.ts", "modified", 5, 5),
  ]);
  assertEquals(changes, {
    removed: ["tests/gone_test.ts"],
    edited: ["tests/edited_test.ts", "tests/moved_test.ts"],
  });
});

Deno.test("noTestAdded: fleet code without a test is flagged; with a test, docs-only, or from Dependabot, it is not", () => {
  const code = file("lib/foo.ts", "modified", 10, 2);
  assertEquals(noTestAdded([code], "fleet"), true);
  assertEquals(
    noTestAdded([code, file("tests/foo_test.ts", "modified", 8, 0)], "fleet"),
    false,
  );
  assertEquals(noTestAdded([code], "dependabot"), false);
  assertEquals(
    noTestAdded([file("docs/x.md", "modified", 10, 2)], "fleet"),
    false,
  );
});

Deno.test("authorKind: Dependabot and the fleet accounts only", () => {
  const fleet = new Set(["stservice", "VibeCoderST"]);
  assertEquals(authorKind("app/dependabot", fleet), "dependabot");
  assertEquals(authorKind("VibeCoderST", fleet), "fleet");
  assertEquals(authorKind("nleck", fleet), null);
});

const searchPr = (
  overrides: Partial<SearchPr> = {},
  rollup: string | null = "SUCCESS",
  contexts?: RollupContextNode[],
): SearchPr => ({
  number: 1,
  title: "t",
  url: "https://github.com/o/r/pull/1",
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
      },
    }],
  },
  reviews: { nodes: [] },
  ...overrides,
});

Deno.test("skipReason: only a green, mergeable, unreviewed, non-draft PR is ready", async () => {
  assertEquals(await skipReason(searchPr(), "nleck"), null);
  assertEquals(
    await skipReason(searchPr({}, "PENDING"), "nleck"),
    "waiting-ci",
  );
  assertEquals(await skipReason(searchPr({}, null), "nleck"), "waiting-ci");
  assertEquals(
    await skipReason(searchPr({}, "FAILURE"), "nleck"),
    "ci-failed",
  );
  assertEquals(await skipReason(searchPr({}, "ERROR"), "nleck"), "ci-failed");
  assertEquals(
    await skipReason(searchPr({ isDraft: true }), "nleck"),
    "draft",
  );
  assertEquals(
    await skipReason(searchPr({ baseRefName: "milestone/42-x" }), "nleck"),
    "not-default-branch",
  );
  assertEquals(
    await skipReason(searchPr({ mergeable: "CONFLICTING" }), "nleck"),
    "conflicting",
  );
  assertEquals(
    await skipReason(searchPr({ mergeable: "UNKNOWN" }), "nleck"),
    null,
  );
  const approved = {
    nodes: [{
      author: { login: "nleck" },
      state: "APPROVED",
      body: "",
      commit: { oid: "head" },
    }],
  };
  assertEquals(
    await skipReason(searchPr({ reviews: approved }), "nleck"),
    "already-reviewed",
  );
});

Deno.test("skipReason: a red rollup whose every red check is cancelled is ci-cancelled (Issue #2916)", async () => {
  const cancelled: RollupContextNode[] = [
    { __typename: "CheckRun", conclusion: "CANCELLED" },
    { __typename: "CheckRun", conclusion: "CANCELLED" },
    // A green check beside them does not matter.
    { __typename: "CheckRun", conclusion: "SUCCESS" },
  ];
  assertEquals(
    await skipReason(searchPr({}, "FAILURE", cancelled), "nleck"),
    "ci-cancelled",
  );
  assertEquals(
    await skipReason(searchPr({}, "ERROR", cancelled), "nleck"),
    "ci-cancelled",
  );
});

Deno.test("skipReason: a real failure anywhere keeps the PR ci-failed (Issue #2916)", async () => {
  const cancelledPlusFailure: RollupContextNode[] = [
    { __typename: "CheckRun", conclusion: "CANCELLED" },
    { __typename: "CheckRun", conclusion: "FAILURE" },
  ];
  assertEquals(
    await skipReason(searchPr({}, "FAILURE", cancelledPlusFailure), "nleck"),
    "ci-failed",
  );
  // A red commit-status context is a real failure too, whatever the
  // cancelled CheckRuns beside it say.
  const cancelledPlusStatus: RollupContextNode[] = [
    { __typename: "CheckRun", conclusion: "CANCELLED" },
    { __typename: "StatusContext", state: "ERROR" },
  ];
  assertEquals(
    await skipReason(searchPr({}, "FAILURE", cancelledPlusStatus), "nleck"),
    "ci-failed",
  );
});

Deno.test("skipReason: a red rollup with no contexts is ci-failed (Issue #2916)", async () => {
  // `contexts` is optional on the query result, and a FAILURE rollup from
  // an older query shape carried none.
  assertEquals(
    await skipReason(searchPr({}, "FAILURE"), "nleck"),
    "ci-failed",
  );
});

Deno.test("reviewedAtHead: approvals, change requests and the skill's own comment reviews count at the head commit only", () => {
  const review = (
    state: string,
    commit_id: string,
    body = "",
    login = "nleck",
  ) => ({
    author: { login },
    commit: { oid: commit_id },
    state,
    body,
  });
  assertEquals(
    reviewedAtHead([review("APPROVED", "head")], "nleck", "head"),
    true,
  );
  assertEquals(
    reviewedAtHead([review("CHANGES_REQUESTED", "head")], "nleck", "head"),
    true,
  );
  assertEquals(
    reviewedAtHead(
      [review("COMMENTED", "head", `Held. ${REVIEW_MARKER}`)],
      "nleck",
      "head",
    ),
    true,
  );
  assertEquals(
    reviewedAtHead(
      [review("COMMENTED", "head", "a note of my own")],
      "nleck",
      "head",
    ),
    false,
  );
  assertEquals(
    reviewedAtHead([review("DISMISSED", "head")], "nleck", "head"),
    true,
  );
  assertEquals(
    reviewedAtHead([review("APPROVED", "older")], "nleck", "head"),
    false,
  );
  assertEquals(
    reviewedAtHead(
      [review("APPROVED", "head", "", "someone-else")],
      "nleck",
      "head",
    ),
    false,
  );
});

// --- Issue #3063: awaiting-fix skip reason ---------------------------------

const review = (
  state: string,
  commit_id: string | null,
  body = "",
  login = "nleck",
) => ({
  author: { login },
  commit: commit_id === null ? null : { oid: commit_id },
  state,
  body,
});

Deno.test("sentBackAt: the latest counted review decides the verdict", () => {
  // CHANGES_REQUESTED then APPROVED → null.
  assertEquals(
    sentBackAt(
      [review("CHANGES_REQUESTED", "X"), review("APPROVED", "head")],
      "nleck",
      "head",
    ),
    null,
  );
  // APPROVED then CHANGES_REQUESTED at X → "X".
  assertEquals(
    sentBackAt(
      [review("APPROVED", "older"), review("CHANGES_REQUESTED", "X")],
      "nleck",
      "head",
    ),
    "X",
  );
  // Change request at head → null (nothing to skip: head already counted).
  assertEquals(
    sentBackAt([review("CHANGES_REQUESTED", "head")], "nleck", "head"),
    null,
  );
  // DISMISSED latest → null: cannot tell stale-dismissed approval from a
  // claimed change request.
  assertEquals(
    sentBackAt(
      [review("CHANGES_REQUESTED", "X"), review("DISMISSED", "X")],
      "nleck",
      "head",
    ),
    null,
  );
  // Someone else's change request → null.
  assertEquals(
    sentBackAt(
      [review("CHANGES_REQUESTED", "X", "", "someone-else")],
      "nleck",
      "head",
    ),
    null,
  );
  // An owner's unmarked COMMENTED after the change request does not hide it.
  assertEquals(
    sentBackAt(
      [
        review("CHANGES_REQUESTED", "X"),
        review("COMMENTED", "Y", "a note", "owner"),
      ],
      "nleck",
      "head",
    ),
    "X",
  );
});

const compareResponse = (
  status: string,
  commits: { sha: string; parents: number }[],
) =>
  JSON.stringify({
    status,
    total_commits: commits.length,
    commits: commits.map((c) => ({
      sha: c.sha,
      parents: Array.from({ length: c.parents }, (_, i) => ({ sha: `p${i}` })),
    })),
  });

const compareFiles = (
  files: {
    filename: string;
    status?: string;
    patch?: string;
    previous_filename?: string;
  }[],
) =>
  JSON.stringify({
    files: files.map((f) => ({
      filename: f.filename,
      status: f.status ?? "modified",
      previous_filename: f.previous_filename,
      ...(f.patch !== undefined ? { patch: f.patch } : {}),
    })),
  });

function fakeGh(
  responses: Record<string, string>,
): { gh: (args: string[]) => Promise<string>; calls: string[] } {
  const calls: string[] = [];
  const gh = (args: string[]) => {
    const endpoint = args[1]!;
    calls.push(endpoint);
    if (endpoint in responses) return Promise.resolve(responses[endpoint]!);
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
  return { gh, calls };
}

Deno.test("skipReason: a merge-only head after a send-back is awaiting-fix (Issue #3063)", async () => {
  const pr = searchPr({
    headRefOid: "head",
    baseRefName: "main",
    reviews: { nodes: [review("CHANGES_REQUESTED", "X")] },
  });
  // GitHub's real compare/X...head also lists the single-parent base
  // commits a merge brought in, not just the 2-parent merge commit itself
  // (Issue #3079 — GRQ-AutoTrader #2213, #2210, #2218).
  const { gh } = fakeGh({
    "repos/o/r/compare/X...head": compareResponse("ahead", [
      { sha: "base1", parents: 1 },
      { sha: "m1", parents: 2 },
    ]),
    "repos/o/r/compare/main...X": compareFiles([{
      filename: "a.ts",
      patch: "@@ -1,3 +1,4 @@\n+x",
    }]),
    "repos/o/r/compare/main...head": compareFiles([{
      filename: "a.ts",
      patch: "@@ -11,3 +11,4 @@\n+x",
    }]),
  });
  assertEquals(
    await skipReason(
      pr,
      "nleck",
      (since) => ownDiffUnchanged(gh, "o/r", "main", since, "head"),
    ),
    "awaiting-fix",
  );
});

Deno.test("skipReason: a merge with conflict-resolution edits is a fresh review (Issue #3063)", async () => {
  const pr = searchPr({
    headRefOid: "head",
    baseRefName: "main",
    reviews: { nodes: [review("CHANGES_REQUESTED", "X")] },
  });
  const { gh } = fakeGh({
    "repos/o/r/compare/X...head": compareResponse("ahead", [{
      sha: "m1",
      parents: 2,
    }]),
    "repos/o/r/compare/main...X": compareFiles([{
      filename: "a.ts",
      patch: "@@ -1,3 +1,4 @@\n+x",
    }]),
    "repos/o/r/compare/main...head": compareFiles([{
      filename: "a.ts",
      patch: "@@ -1,3 +1,4 @@\n+y",
    }]),
  });
  assertEquals(
    await skipReason(
      pr,
      "nleck",
      (since) => ownDiffUnchanged(gh, "o/r", "main", since, "head"),
    ),
    null,
  );
});

Deno.test("skipReason: a fix commit changes the merge-base diff and gets a fresh review (Issue #3079)", async () => {
  const pr = searchPr({
    headRefOid: "head",
    baseRefName: "main",
    reviews: { nodes: [review("CHANGES_REQUESTED", "X")] },
  });
  // A single-parent fix commit is no longer rejected by its own parent
  // count — the merge-base diff is what proves it changed the PR.
  const { gh, calls } = fakeGh({
    "repos/o/r/compare/X...head": compareResponse("ahead", [{
      sha: "fix1",
      parents: 1,
    }]),
    "repos/o/r/compare/main...X": compareFiles([{
      filename: "a.ts",
      patch: "@@ -1,3 +1,4 @@\n+x",
    }]),
    "repos/o/r/compare/main...head": compareFiles([{
      filename: "a.ts",
      patch: "@@ -1,3 +1,4 @@\n+x\n+y",
    }]),
  });
  assertEquals(
    await skipReason(
      pr,
      "nleck",
      (since) => ownDiffUnchanged(gh, "o/r", "main", since, "head"),
    ),
    null,
  );
  assertEquals(calls, [
    "repos/o/r/compare/X...head",
    "repos/o/r/compare/main...X",
    "repos/o/r/compare/main...head",
  ]);
});

Deno.test("skipReason: an approved PR whose head moved by a base merge never calls the checker (Issue #3063)", async () => {
  const pr = searchPr({
    headRefOid: "head",
    baseRefName: "main",
    reviews: { nodes: [review("APPROVED", "X")] },
  });
  let called = false;
  assertEquals(
    await skipReason(pr, "nleck", () => {
      called = true;
      return Promise.resolve(true);
    }),
    null,
  );
  assertEquals(called, false);
});

Deno.test("ownDiffUnchanged returns false rather than throwing (Issue #3063)", async () => {
  // gh throws, e.g. a 404 for a force-pushed commit.
  const throwing = (_args: string[]): Promise<string> => {
    throw new Error("gh: 404 Not Found");
  };
  assertEquals(
    await ownDiffUnchanged(throwing, "o/r", "main", "X", "head"),
    false,
  );

  // status is "diverged" rather than "ahead".
  const { gh: divergedGh } = fakeGh({
    "repos/o/r/compare/X...head": compareResponse("diverged", [{
      sha: "m1",
      parents: 2,
    }]),
  });
  assertEquals(
    await ownDiffUnchanged(divergedGh, "o/r", "main", "X", "head"),
    false,
  );

  // A file with no patch (binary/huge) cannot be confirmed unchanged.
  const { gh: noPatchGh } = fakeGh({
    "repos/o/r/compare/X...head": compareResponse("ahead", [{
      sha: "m1",
      parents: 2,
    }]),
    "repos/o/r/compare/main...X": compareFiles([{ filename: "a.bin" }]),
    "repos/o/r/compare/main...head": compareFiles([{ filename: "a.bin" }]),
  });
  assertEquals(
    await ownDiffUnchanged(noPatchGh, "o/r", "main", "X", "head"),
    false,
  );

  // total_commits exceeds the listed commits (truncated at 250).
  const { gh: truncatedGh } = fakeGh({
    "repos/o/r/compare/X...head": JSON.stringify({
      status: "ahead",
      total_commits: 300,
      commits: [{ sha: "m1", parents: [{ sha: "p0" }, { sha: "p1" }] }],
    }),
  });
  assertEquals(
    await ownDiffUnchanged(truncatedGh, "o/r", "main", "X", "head"),
    false,
  );
});

Deno.test("runWithTimeout kills a command that hangs, so one stuck gh call cannot wedge the watch loop", async () => {
  const started = Date.now();
  await assertRejects(
    () => runWithTimeout("sleep", ["30"], 200),
    Error,
    "timed out after 200 ms",
  );
  assertEquals(Date.now() - started < 5000, true);
  assertEquals(await runWithTimeout("echo", ["ok"], 5000), "ok\n");
});
