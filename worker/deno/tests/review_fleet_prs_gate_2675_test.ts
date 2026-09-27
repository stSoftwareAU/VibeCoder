/**
 * The deterministic gate of the review-fleet-prs Claude Code skill (Issue #2675).
 * It decides which fleet PRs are worth a model review; the review itself is
 * the skill's job.
 */
import { assertEquals } from "@std/assert";
import {
  ciState,
  existingTestChanges,
  isTestPath,
  missingTests,
  REVIEW_MARKER,
  reviewedAtHead,
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

Deno.test("missingTests: fleet code without a test is flagged; with a test, or from Dependabot, it is not", () => {
  const code = file("lib/foo.ts", "modified", 10, 2);
  assertEquals(missingTests([code], "fleet").length, 1);
  assertEquals(
    missingTests([code, file("tests/foo_test.ts", "modified", 8, 0)], "fleet"),
    [],
  );
  assertEquals(missingTests([code], "dependabot"), []);
  assertEquals(
    missingTests([file("docs/x.md", "modified", 10, 2)], "fleet"),
    [],
  );
});

Deno.test("ciState: green only when every check has passed or been skipped", () => {
  const run = (status: string, conclusion: string | undefined) => ({
    __typename: "CheckRun",
    name: "c",
    status,
    conclusion,
  });
  assertEquals(ciState([]).state, "pending");
  assertEquals(
    ciState([run("COMPLETED", "SUCCESS"), run("COMPLETED", "SKIPPED")]).state,
    "green",
  );
  assertEquals(
    ciState([run("COMPLETED", "SUCCESS"), run("IN_PROGRESS", undefined)]).state,
    "pending",
  );
  assertEquals(
    ciState([run("IN_PROGRESS", undefined), run("COMPLETED", "FAILURE")]).state,
    "failed",
  );
  assertEquals(
    ciState([{ __typename: "StatusContext", context: "s", state: "PENDING" }])
      .state,
    "pending",
  );
  assertEquals(
    ciState([{ __typename: "StatusContext", context: "s", state: "ERROR" }])
      .state,
    "failed",
  );
});

Deno.test("reviewedAtHead: approvals, change requests and the skill's own comment reviews count at the head commit only", () => {
  const review = (
    state: string,
    commit_id: string,
    body = "",
    login = "nleck",
  ) => ({
    user: { login },
    commit_id,
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
