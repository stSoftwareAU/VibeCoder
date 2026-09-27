/**
 * The deterministic gate of the review-fleet-prs Claude Code skill (Issue #2675).
 * It decides which fleet PRs are worth a model review; the review itself is
 * the skill's job.
 */
import { assertEquals } from "@std/assert";
import {
  authorKind,
  existingTestChanges,
  isTestPath,
  noTestAdded,
  REVIEW_MARKER,
  reviewedAtHead,
  type SearchPr,
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
      commit: { statusCheckRollup: rollup === null ? null : { state: rollup } },
    }],
  },
  reviews: { nodes: [] },
  ...overrides,
});

Deno.test("skipReason: only a green, mergeable, unreviewed, non-draft PR is ready", () => {
  assertEquals(skipReason(searchPr(), "nleck"), null);
  assertEquals(skipReason(searchPr({}, "PENDING"), "nleck"), "waiting-ci");
  assertEquals(skipReason(searchPr({}, null), "nleck"), "waiting-ci");
  assertEquals(skipReason(searchPr({}, "FAILURE"), "nleck"), "ci-failed");
  assertEquals(skipReason(searchPr({}, "ERROR"), "nleck"), "ci-failed");
  assertEquals(skipReason(searchPr({ isDraft: true }), "nleck"), "draft");
  assertEquals(
    skipReason(searchPr({ baseRefName: "milestone/42-x" }), "nleck"),
    "not-default-branch",
  );
  assertEquals(
    skipReason(searchPr({ mergeable: "CONFLICTING" }), "nleck"),
    "conflicting",
  );
  assertEquals(skipReason(searchPr({ mergeable: "UNKNOWN" }), "nleck"), null);
  const approved = {
    nodes: [{
      author: { login: "nleck" },
      state: "APPROVED",
      body: "",
      commit: { oid: "head" },
    }],
  };
  assertEquals(
    skipReason(searchPr({ reviews: approved }), "nleck"),
    "already-reviewed",
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
