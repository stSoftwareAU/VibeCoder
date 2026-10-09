import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  buildRemovedAssertionGateComment,
  findRemovedAssertions,
  findTestPlanSection,
  pathsFromRenameStatus,
  REMOVED_ASSERTION_CONTEXT_LINES,
  removedAssertionDiffArgs,
  removedAssertionRenameSidesArgs,
  testFilesFromRenameSidesList,
  validateRemovedAssertions,
} from "../lib/removed_assertion_gate.ts";

Deno.test("removedAssertionDiffArgs builds the expected git diff invocation", () => {
  assertEquals(removedAssertionDiffArgs("main"), [
    "diff",
    "--no-color",
    "--no-ext-diff",
    `--unified=${REMOVED_ASSERTION_CONTEXT_LINES}`,
    "--find-renames",
    "--diff-filter=AMRD",
    "main...HEAD",
  ]);
});

Deno.test("removedAssertionDiffArgs includes deletions in the diff filter", () => {
  assert(removedAssertionDiffArgs("main").includes("--diff-filter=AMRD"));
});

Deno.test("removedAssertionDiffArgs scopes the diff to the given test files with a pathspec", () => {
  assertEquals(
    removedAssertionDiffArgs("main", ["worker/deno/tests/foo_test.ts"]),
    [
      "diff",
      "--no-color",
      "--no-ext-diff",
      `--unified=${REMOVED_ASSERTION_CONTEXT_LINES}`,
      "--find-renames",
      "--diff-filter=AMRD",
      "main...HEAD",
      "--",
      "worker/deno/tests/foo_test.ts",
    ],
  );
});

Deno.test("removedAssertionDiffArgs omits the pathspec when no test files are given", () => {
  assertEquals(removedAssertionDiffArgs("main", []), [
    "diff",
    "--no-color",
    "--no-ext-diff",
    `--unified=${REMOVED_ASSERTION_CONTEXT_LINES}`,
    "--find-renames",
    "--diff-filter=AMRD",
    "main...HEAD",
  ]);
});

// --- Issue's verification case -------------------------------------------

const SCORE_DIFF = [
  "diff --git a/crates/api/tests/decisions.rs b/crates/api/tests/decisions.rs",
  "index abc123..def456 100644",
  "--- a/crates/api/tests/decisions.rs",
  "+++ b/crates/api/tests/decisions.rs",
  "@@ -40,1 +40,0 @@ fn scores_are_rated() {",
  '-    assert_eq!(record.score.to_string(), "-0.5");',
  "",
].join("\n");

Deno.test("findRemovedAssertions finds the removed assert_eq! statement", () => {
  const removed = findRemovedAssertions(SCORE_DIFF);
  assertEquals(removed.length, 1);
  assertEquals(removed[0]!.file, "crates/api/tests/decisions.rs");
  assertEquals(
    removed[0]!.text,
    'assert_eq!(record.score.to_string(), "-0.5");',
  );
});

Deno.test("validateRemovedAssertions blocks when the Test Plan does not name the removed assertion", () => {
  const result = validateRemovedAssertions({
    changedFiles: ["crates/api/tests/decisions.rs"],
    testDiff: SCORE_DIFF,
    prSummaryContent: "## Summary\n\nChanged scoring to a rating.\n",
  });
  assertFalse(result.valid);
  assertEquals(result.unaccounted.length, 1);
  assert(
    result.problems.some((p) =>
      p.includes("assert_eq!") && p.includes("decisions.rs")
    ),
  );
});

Deno.test("validateRemovedAssertions passes when the Test Plan names the removed assertion and its reason", () => {
  const summary = [
    "## Test Plan",
    "",
    "- Removed from `crates/api/tests/decisions.rs`: " +
    '`assert_eq!(record.score.to_string(), "-0.5")` — #2253 changes the ' +
    "score to a rating, so the old value is untrue",
    "",
  ].join("\n");
  const result = validateRemovedAssertions({
    changedFiles: ["crates/api/tests/decisions.rs"],
    testDiff: SCORE_DIFF,
    prSummaryContent: summary,
  });
  assert(result.valid);
  assertEquals(result.unaccounted.length, 0);
  assertEquals(result.problems, []);
});

// --- Missing Test Plan heading entirely -----------------------------------

const NOOP_TEST_DIFF = [
  "diff --git a/worker/deno/tests/foo_test.ts b/worker/deno/tests/foo_test.ts",
  "index 111..222 100644",
  "--- a/worker/deno/tests/foo_test.ts",
  "+++ b/worker/deno/tests/foo_test.ts",
  "@@ -10,0 +11,1 @@",
  '+  console.log("noop");',
  "",
].join("\n");

Deno.test("validateRemovedAssertions blocks when no Test Plan heading exists even with no removed assertions", () => {
  const result = validateRemovedAssertions({
    changedFiles: ["worker/deno/tests/foo_test.ts"],
    testDiff: NOOP_TEST_DIFF,
    prSummaryContent: "## Summary\n\nTidy a log line.\n",
  });
  assertFalse(result.valid);
  assertEquals(result.removed.length, 0);
  assert(result.problems.some((p) => p.includes("Test Plan")));
});

Deno.test("validateRemovedAssertions passes when a Test Plan heading exists with no removed assertions", () => {
  const result = validateRemovedAssertions({
    changedFiles: ["worker/deno/tests/foo_test.ts"],
    testDiff: NOOP_TEST_DIFF,
    prSummaryContent: "## Test Plan\n\nNo assertions were removed.\n",
  });
  assert(result.valid);
});

// --- Applicability -----------------------------------------------------

Deno.test("validateRemovedAssertions is not applicable when no changed file is a test file", () => {
  const result = validateRemovedAssertions({
    changedFiles: ["src/lib.rs", "README.md"],
    testDiff: null,
    prSummaryContent: "",
  });
  assertFalse(result.applicable);
  assert(result.valid);
  assertEquals(result.problems, []);
});

Deno.test("validateRemovedAssertions applies (fails closed) when changedFiles is null", () => {
  const result = validateRemovedAssertions({
    changedFiles: null,
    testDiff: null,
    prSummaryContent: "## Summary\n\nNo Test Plan here.\n",
  });
  assert(result.applicable);
  assertFalse(result.changedFilesKnown);
  assertFalse(result.valid);
  assert(result.problems.some((p) => p.includes("Test Plan")));
});

Deno.test("validateRemovedAssertions passes with testDiff null when a Test Plan is present", () => {
  const result = validateRemovedAssertions({
    changedFiles: ["worker/deno/tests/foo_test.ts"],
    testDiff: null,
    prSummaryContent: "## Test Plan\n\nSomething.\n",
  });
  assert(result.valid);
  assertFalse(result.testDiffKnown);
  assertEquals(result.removed, []);
});

// --- Multi-line removed assertion -----------------------------------------

const MULTILINE_DIFF = [
  "diff --git a/worker/deno/tests/foo_test.ts b/worker/deno/tests/foo_test.ts",
  "index 111..222 100644",
  "--- a/worker/deno/tests/foo_test.ts",
  "+++ b/worker/deno/tests/foo_test.ts",
  "@@ -20,4 +20,0 @@",
  "-  assertEquals(",
  "-    a,",
  "-    b,",
  "-  );",
  "",
].join("\n");

Deno.test("findRemovedAssertions joins a multi-line removed assertEquals into one statement", () => {
  const removed = findRemovedAssertions(MULTILINE_DIFF);
  assertEquals(removed.length, 1);
  assertEquals(removed[0]!.text, "assertEquals( a, b, );");
});

Deno.test("validateRemovedAssertions accounts for a multi-line removed assertion named compactly in the Test Plan", () => {
  const result = validateRemovedAssertions({
    changedFiles: ["worker/deno/tests/foo_test.ts"],
    testDiff: MULTILINE_DIFF,
    prSummaryContent:
      "## Test Plan\n\n- Removed `assertEquals(a, b)` — no longer applicable.\n",
  });
  assert(result.valid);
  assertEquals(result.unaccounted, []);
});

// --- Regex-escaped assertion named verbatim in the Test Plan (PR #3148
// review: canonicaliseTestPlanBody undid markdown escapes like `\.` before
// matching, but the removed assertion's own canonical keeps its backslashes
// — a regex literal copied verbatim then failed to match) ------------------

const REGEX_ESCAPE_DIFF = [
  "diff --git a/worker/deno/tests/version_test.ts b/worker/deno/tests/version_test.ts",
  "index 111..222 100644",
  "--- a/worker/deno/tests/version_test.ts",
  "+++ b/worker/deno/tests/version_test.ts",
  "@@ -5,1 +5,0 @@",
  "-  assertMatch(version, /^v\\d+\\.\\d+$/);",
  "",
].join("\n");

Deno.test("validateRemovedAssertions matches a regex-escaped assertion named verbatim in the Test Plan", () => {
  const summary = [
    "## Test Plan",
    "",
    "- Removed `assertMatch(version, /^v\\d+\\.\\d+$/);` — version format " +
    "check no longer applies",
    "",
  ].join("\n");
  const result = validateRemovedAssertions({
    changedFiles: ["worker/deno/tests/version_test.ts"],
    testDiff: REGEX_ESCAPE_DIFF,
    prSummaryContent: summary,
  });
  assert(result.valid);
  assertEquals(result.unaccounted, []);
});

// --- Assertion named past 2,000 canonical chars of the Test Plan (Issue #3438) ---

/** Realistic Test Plan filler, well past the 2,000 canonical char cap. */
function longTestPlanFiller(): string[] {
  const lines: string[] = [];
  for (let i = 0; i < 60; i++) {
    lines.push(
      `- Added \`worker/deno/tests/x${i}_test.ts\`: covers case ${i} of the ` +
        "new scoring path and checks the rating is returned",
    );
  }
  const canonicalLength = lines.join("\n").replace(/\s+/g, "").length;
  assert(
    canonicalLength > 2_000,
    `filler must exceed the 2,000 char cap, got ${canonicalLength}`,
  );
  return lines;
}

Deno.test("validateRemovedAssertions accounts for an assertion named after 2,000 canonical chars of the Test Plan", () => {
  const summary = [
    "## Test Plan",
    "",
    ...longTestPlanFiller(),
    "- Removed from `crates/api/tests/decisions.rs`: " +
    '`assert_eq!(record.score.to_string(), "-0.5")` — #2253 changes the ' +
    "score to a rating, so the old value is untrue",
    "",
  ].join("\n");
  const result = validateRemovedAssertions({
    changedFiles: ["crates/api/tests/decisions.rs"],
    testDiff: SCORE_DIFF,
    prSummaryContent: summary,
  });
  assert(result.valid);
  assertEquals(result.unaccounted, []);
  assertEquals(result.problems, []);
});

Deno.test("validateRemovedAssertions matches a regex-escaped assertion named verbatim after 2,000 canonical chars", () => {
  const summary = [
    "## Test Plan",
    "",
    ...longTestPlanFiller(),
    "- Removed `assertMatch(version, /^v\\d+\\.\\d+$/);` — version format " +
    "check no longer applies",
    "",
  ].join("\n");
  const result = validateRemovedAssertions({
    changedFiles: ["worker/deno/tests/version_test.ts"],
    testDiff: REGEX_ESCAPE_DIFF,
    prSummaryContent: summary,
  });
  assert(result.valid);
  assertEquals(result.unaccounted, []);
});

Deno.test("validateRemovedAssertions still blocks a long Test Plan that does not name the removed assertion", () => {
  const summary = [
    "## Test Plan",
    "",
    ...longTestPlanFiller(),
    "- Removed from `crates/api/tests/decisions.rs`: " +
    '`assert_eq!(record.score.to_string(), "-0.25")` — a look-alike value',
    "",
  ].join("\n");
  const result = validateRemovedAssertions({
    changedFiles: ["crates/api/tests/decisions.rs"],
    testDiff: SCORE_DIFF,
    prSummaryContent: summary,
  });
  assert(!result.valid);
  assertEquals(result.unaccounted.length, 1);
});

// --- Moved / reformatted assertion ----------------------------------------

const MOVED_REWRAPPED_DIFF = [
  "diff --git a/worker/deno/tests/foo_test.ts b/worker/deno/tests/foo_test.ts",
  "index 111..222 100644",
  "--- a/worker/deno/tests/foo_test.ts",
  "+++ b/worker/deno/tests/foo_test.ts",
  "@@ -5,1 +5,4 @@",
  "-  assertEquals(result.code, 0);",
  "+  assertEquals(",
  "+    result.code,",
  "+    0,",
  "+  );",
  "",
].join("\n");

Deno.test("findRemovedAssertions excludes an assertion that was only re-wrapped", () => {
  const removed = findRemovedAssertions(MOVED_REWRAPPED_DIFF);
  assertEquals(removed, []);
});

const MOVED_REINDENTED_DIFF = [
  "diff --git a/worker/deno/tests/foo_test.ts b/worker/deno/tests/foo_test.ts",
  "index 111..222 100644",
  "--- a/worker/deno/tests/foo_test.ts",
  "+++ b/worker/deno/tests/foo_test.ts",
  "@@ -5,1 +5,1 @@",
  "-  assertEquals(result.code, 0);",
  "+    assertEquals(result.code, 0);",
  "",
].join("\n");

Deno.test("findRemovedAssertions excludes an assertion that was only re-indented", () => {
  const removed = findRemovedAssertions(MOVED_REINDENTED_DIFF);
  assertEquals(removed, []);
});

// --- Commented-out / loosened assertions are removed, not moved (PR #3148
// review: the old substring-containment "moved" check let a comment prefix
// or a loosened condition "contain" the removed assertion's text) ----------

const COMMENTED_OUT_TS_DIFF = [
  "diff --git a/worker/deno/tests/foo_test.ts b/worker/deno/tests/foo_test.ts",
  "index 111..222 100644",
  "--- a/worker/deno/tests/foo_test.ts",
  "+++ b/worker/deno/tests/foo_test.ts",
  "@@ -5,1 +5,1 @@",
  "-  assertEquals(a, b);",
  "+  // assertEquals(a, b);",
  "",
].join("\n");

Deno.test("findRemovedAssertions reports a TS assertion that was only commented out", () => {
  const removed = findRemovedAssertions(COMMENTED_OUT_TS_DIFF);
  assertEquals(removed.length, 1);
  assertEquals(removed[0]!.text, "assertEquals(a, b);");
});

const COMMENTED_OUT_RUST_DIFF = [
  "diff --git a/crates/api/tests/decisions.rs b/crates/api/tests/decisions.rs",
  "index 111..222 100644",
  "--- a/crates/api/tests/decisions.rs",
  "+++ b/crates/api/tests/decisions.rs",
  "@@ -5,1 +5,1 @@",
  "-    assert_eq!(a, b);",
  "+    // assert_eq!(a, b);",
  "",
].join("\n");

Deno.test("findRemovedAssertions reports a Rust assert_eq! that was only commented out", () => {
  const removed = findRemovedAssertions(COMMENTED_OUT_RUST_DIFF);
  assertEquals(removed.length, 1);
  assertEquals(removed[0]!.text, "assert_eq!(a, b);");
});

const CONDITION_WRAPPED_DIFF = [
  "diff --git a/worker/deno/tests/foo_test.ts b/worker/deno/tests/foo_test.ts",
  "index 111..222 100644",
  "--- a/worker/deno/tests/foo_test.ts",
  "+++ b/worker/deno/tests/foo_test.ts",
  "@@ -5,1 +5,1 @@",
  "-  assertEquals(a, b);",
  "+  if (false) assertEquals(a, b);",
  "",
].join("\n");

Deno.test("findRemovedAssertions reports an assertion that was wrapped in an always-false condition", () => {
  const removed = findRemovedAssertions(CONDITION_WRAPPED_DIFF);
  assertEquals(removed.length, 1);
  assertEquals(removed[0]!.text, "assertEquals(a, b);");
});

const LOOSENED_PYTHON_OR_DIFF = [
  "diff --git a/tests/test_total.py b/tests/test_total.py",
  "index 111..222 100644",
  "--- a/tests/test_total.py",
  "+++ b/tests/test_total.py",
  "@@ -5,1 +5,1 @@",
  "-assert total == 5",
  "+assert total == 5 or total == 6",
  "",
].join("\n");

Deno.test("findRemovedAssertions reports a Python assertion loosened with 'or'", () => {
  const removed = findRemovedAssertions(LOOSENED_PYTHON_OR_DIFF);
  assertEquals(removed.length, 1);
  assertEquals(removed[0]!.text, "assert total == 5");
});

const LOOSENED_PYTHON_DIGIT_DIFF = [
  "diff --git a/tests/test_total.py b/tests/test_total.py",
  "index 111..222 100644",
  "--- a/tests/test_total.py",
  "+++ b/tests/test_total.py",
  "@@ -5,1 +5,1 @@",
  "-assert total == 5",
  "+assert total == 50",
  "",
].join("\n");

Deno.test("findRemovedAssertions reports a Python assertion loosened to a number that extends the old one", () => {
  const removed = findRemovedAssertions(LOOSENED_PYTHON_DIGIT_DIFF);
  assertEquals(removed.length, 1);
  assertEquals(removed[0]!.text, "assert total == 5");
});

// --- Non-test files and non-assertion lines --------------------------------

const NON_TEST_FILE_DIFF = [
  "diff --git a/src/lib.rs b/src/lib.rs",
  "index 111..222 100644",
  "--- a/src/lib.rs",
  "+++ b/src/lib.rs",
  "@@ -5,1 +5,0 @@",
  "-    assert_eq!(x, 1);",
  "",
].join("\n");

Deno.test("findRemovedAssertions ignores a removed assertion in a non-test file", () => {
  assertEquals(findRemovedAssertions(NON_TEST_FILE_DIFF), []);
});

const EXCLUDED_FORMS_DIFF = [
  "diff --git a/worker/deno/tests/foo_test.ts b/worker/deno/tests/foo_test.ts",
  "index 111..222 100644",
  "--- a/worker/deno/tests/foo_test.ts",
  "+++ b/worker/deno/tests/foo_test.ts",
  "@@ -1,3 +0,0 @@",
  "-  debug_assert!(invariant_holds());",
  '-  let name = maybe.expect("present");',
  "-  // assertEquals(old, 1);",
  "",
].join("\n");

Deno.test("findRemovedAssertions excludes debug_assert!, .expect(), and a commented-out assertion", () => {
  assertEquals(findRemovedAssertions(EXCLUDED_FORMS_DIFF), []);
});

const CROSS_ECOSYSTEM_DIFF = [
  "diff --git a/worker/deno/tests/foo_test.ts b/worker/deno/tests/foo_test.ts",
  "index 111..222 100644",
  "--- a/worker/deno/tests/foo_test.ts",
  "+++ b/worker/deno/tests/foo_test.ts",
  "@@ -1,3 +0,0 @@",
  "-  expect(x).toBe(1);",
  "-  assert x == 1",
  "-  self.assertEqual(a, b)",
  "",
].join("\n");

Deno.test("findRemovedAssertions detects Jest expect(), Python assert, and self.assertEqual()", () => {
  const removed = findRemovedAssertions(CROSS_ECOSYSTEM_DIFF);
  assertEquals(removed.length, 3);
  const texts = removed.map((a) => a.text);
  assert(texts.includes("expect(x).toBe(1);"));
  assert(texts.includes("assert x == 1"));
  assert(texts.includes("self.assertEqual(a, b)"));
});

// --- A removed SQL comment line is not mistaken for a diff header ----------

const SQL_COMMENT_DIFF = [
  "diff --git a/worker/deno/tests/foo_test.sql.test.ts b/worker/deno/tests/foo_test.sql.test.ts",
  "index 111..222 100644",
  "--- a/worker/deno/tests/foo_test.sql.test.ts",
  "+++ b/worker/deno/tests/foo_test.sql.test.ts",
  "@@ -1,3 +0,0 @@",
  "--- this is a removed sql comment, not a diff header",
  "-  assertEquals(total, 5);",
  "",
].join("\n");

Deno.test("findRemovedAssertions treats a removed `-- comment` line inside a hunk as content, not a header", () => {
  const removed = findRemovedAssertions(SQL_COMMENT_DIFF);
  assertEquals(removed.length, 1);
  assertEquals(removed[0]!.file, "worker/deno/tests/foo_test.sql.test.ts");
  assertEquals(removed[0]!.text, "assertEquals(total, 5);");
});

// --- Deleted / rewritten-rename test files still surface removed assertions
// (PR #3148 review: `--diff-filter=AMR` dropped deletions entirely, so a
// deleted test file's assertions — and the delete half of a rename
// rewritten below git's rename-similarity threshold — were invisible) -----

const DELETED_TEST_FILE_DIFF = [
  "diff --git a/tests/gone_test.rs b/tests/gone_test.rs",
  "deleted file mode 100644",
  "index abc123..000000",
  "--- a/tests/gone_test.rs",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-fn test_thing() {",
  "-    assert_eq!(1, 1);",
  "-}",
  "",
].join("\n");

Deno.test("findRemovedAssertions reports an assertion from a wholly deleted test file", () => {
  const removed = findRemovedAssertions(DELETED_TEST_FILE_DIFF);
  assertEquals(removed.length, 1);
  assertEquals(removed[0]!.file, "tests/gone_test.rs");
  assertEquals(removed[0]!.text, "assert_eq!(1, 1);");
});

const RENAME_BELOW_SIMILARITY_DIFF = [
  "diff --git a/tests/old_test.rs b/tests/old_test.rs",
  "deleted file mode 100644",
  "index abc123..000000",
  "--- a/tests/old_test.rs",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-    assert_eq!(2, 2);",
  "diff --git a/tests/new_test.rs b/tests/new_test.rs",
  "new file mode 100644",
  "index 000000..def456",
  "--- /dev/null",
  "+++ b/tests/new_test.rs",
  "@@ -0,0 +1,1 @@",
  "+    assert_eq!(3, 3);",
  "",
].join("\n");

Deno.test(
  "findRemovedAssertions reports the removed assertion when a rename rewritten below the similarity threshold is reported as delete+add",
  () => {
    const removed = findRemovedAssertions(RENAME_BELOW_SIMILARITY_DIFF);
    assertEquals(removed.length, 1);
    assertEquals(removed[0]!.file, "tests/old_test.rs");
    assertEquals(removed[0]!.text, "assert_eq!(2, 2);");
  },
);

// --- findTestPlanSection ----------------------------------------------------

Deno.test("findTestPlanSection finds the heading and stops at the next heading of equal rank", () => {
  const summary = [
    "## Summary",
    "stuff",
    "## Test Plan",
    "- Removed `foo()`.",
    "## Docs sweep",
    "n/a",
  ].join("\n");
  const section = findTestPlanSection(summary);
  assert(section.present);
  assert(section.body.includes("Removed `foo()`."));
  assertFalse(section.body.includes("Docs sweep"));
});

Deno.test("findTestPlanSection is absent when no Test Plan heading exists", () => {
  const section = findTestPlanSection("## Summary\n\nNo plan here.\n");
  assertFalse(section.present);
  assertEquals(section.body, "");
});

// --- buildRemovedAssertionGateComment ---------------------------------------

Deno.test("buildRemovedAssertionGateComment names the headline and the unaccounted assertion text", () => {
  const result = validateRemovedAssertions({
    changedFiles: ["crates/api/tests/decisions.rs"],
    testDiff: SCORE_DIFF,
    prSummaryContent: "## Summary\n\nNo plan.\n",
  });
  const comment = buildRemovedAssertionGateComment(result);
  assert(comment.includes("Removed test assertions not accounted for"));
  assert(comment.includes('assert_eq!(record.score.to_string(), "-0.5");'));
});

Deno.test("buildRemovedAssertionGateComment uses a longer fence when the content contains a backtick run", () => {
  const trickyDiff = [
    "diff --git a/worker/deno/tests/foo_test.ts b/worker/deno/tests/foo_test.ts",
    "index 111..222 100644",
    "--- a/worker/deno/tests/foo_test.ts",
    "+++ b/worker/deno/tests/foo_test.ts",
    "@@ -1,1 +0,0 @@",
    '-  assertEquals(describe("```fenced```"), 1);',
    "",
  ].join("\n");
  const result = validateRemovedAssertions({
    changedFiles: ["worker/deno/tests/foo_test.ts"],
    testDiff: trickyDiff,
    prSummaryContent: "## Summary\n\nNo plan.\n",
  });
  assertEquals(result.unaccounted.length, 1);
  const comment = buildRemovedAssertionGateComment(result);
  assert(comment.includes("````text"));
});

Deno.test("testFilesFromRenameSidesList keeps both sides of a rename and drops a non-test", () => {
  const stdout = [
    "crates/api/src/lib.rs",
    "tests/old_test.rs",
    "tests/new_test.rs",
    "",
  ].join("\0");
  assertEquals(testFilesFromRenameSidesList(stdout), [
    "tests/old_test.rs",
    "tests/new_test.rs",
  ]);
});

Deno.test("pathsFromRenameStatus includes both sides when the old path is the test file", () => {
  const parsed = pathsFromRenameStatus(
    "R100\0tests/moved_test.rs\0src/moved.rs\0",
  );
  assertEquals(parsed.pathspec, ["tests/moved_test.rs", "src/moved.rs"]);
  assertEquals(parsed.testFiles, ["tests/moved_test.rs"]);
});

Deno.test("pathsFromRenameStatus keeps an unquoted non-ASCII test path", () => {
  const parsed = pathsFromRenameStatus("M\0tests/café_test.rs\0");
  assertEquals(parsed.testFiles, ["tests/café_test.rs"]);
  assertEquals(parsed.pathspec, ["tests/café_test.rs"]);
});

Deno.test("a renamed test file that drops an assertion is still reported", async () => {
  const dir = await Deno.makeTempDir();
  const run = async (args: string[]) => {
    const proc = new Deno.Command("git", {
      args,
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    });
    const out = await proc.output();
    const stdout = new TextDecoder().decode(out.stdout);
    if (out.code !== 0) {
      const stderr = new TextDecoder().decode(out.stderr);
      throw new Error(`${args.join(" ")} failed: ${stderr}`);
    }
    return stdout;
  };
  try {
    await run(["init", "-b", "main"]);
    const body = [
      "fn keep() {",
      "    let _ = 1;",
      "    let _ = 2;",
      "    let _ = 3;",
      "    let _ = 4;",
      "    let _ = 5;",
      '    assert_eq!(rows[0].name, "BBB");',
      "    let _ = 6;",
      "    let _ = 7;",
      "    let _ = 8;",
      "}",
      "",
    ].join("\n");
    await Deno.mkdir(`${dir}/tests`);
    await Deno.writeTextFile(`${dir}/tests/old_test.rs`, body);
    await run(["add", "tests/old_test.rs"]);
    await run([
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "-m",
      "add test",
    ]);
    await run(["checkout", "-b", "feature"]);
    await run(["mv", "tests/old_test.rs", "tests/new_test.rs"]);
    await Deno.writeTextFile(
      `${dir}/tests/new_test.rs`,
      body.replace('    assert_eq!(rows[0].name, "BBB");\n', ""),
    );
    await run(["add", "-A"]);
    await run([
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "-m",
      "rename and drop the assertion",
    ]);

    const sides = await run(removedAssertionRenameSidesArgs("main"));
    const files = testFilesFromRenameSidesList(sides);
    assertEquals([...files].sort(), ["tests/new_test.rs", "tests/old_test.rs"]);

    const diff = await run(removedAssertionDiffArgs("main", files));
    const result = validateRemovedAssertions({
      changedFiles: ["tests/new_test.rs"],
      testDiff: diff,
      prSummaryContent:
        "## Test Plan\n\n- the rename is noted, not the dropped assertion\n",
    });
    assertFalse(result.valid);
    assert(result.removed.some((assertion) => assertion.text.includes("BBB")));

    const newPathOnly = await run(
      removedAssertionDiffArgs("main", ["tests/new_test.rs"]),
    );
    assertEquals(findRemovedAssertions(newPathOnly), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
