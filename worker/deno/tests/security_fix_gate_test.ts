/**
 * Tests for security_fix_gate.ts — security-fix patch-verification gate
 * (Issue #3540, gap G4; machine-checkable diff evidence added in Issue #3652).
 *
 * Note (business-logic change, Issue #3652): the gate now takes a required
 * `diff` input and prose alone no longer satisfies it, so the pre-existing
 * cases below supply diff evidence. Their original assertions — which prose
 * item is flagged — are unchanged.
 *
 * Australian English throughout.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildSecurityFixGateMessage,
  citedSecurityTests,
  citedTestIdentifierInDiff,
  evaluateSecurityFixGate,
  extractTestIdentifiers,
  hasSecurityLabel,
  isTestFilePath,
  matchedTestDeclarations,
  referencesFindingId,
  type SecurityFixDiffEvidence,
} from "../lib/security_fix_gate.ts";
import type { SecurityFixDiscrimination } from "../lib/security_fix_discrimination.ts";

/** The worker-executed record a discriminating test produces: red then green. */
const RED_GREEN: SecurityFixDiscrimination = {
  kind: "checked",
  test: { file: "tests/db_test.ts", name: "rejects_injection" },
  preFix: "fail",
  postFix: "pass",
};

/** A PR summary that satisfies both required evidence items. */
const GOOD_SUMMARY = `## Summary
Fixed the SQL injection by parameterising the query. Closes #100.

## Test Plan
- Added \`tests/db_test.ts::rejects_injection\` — a regression test that
  reproduces the flaw: it fails against the unfixed code and passes after the fix.

## Verification
The original attack input (\`' OR 1=1 --\`) is now rejected by the parameterised
API, and there is no trivial bypass — every user value flows through binding.`;

/** Diff evidence matching GOOD_SUMMARY: a test file adding that test. */
const GOOD_DIFF: SecurityFixDiffEvidence = {
  changedFiles: ["worker/deno/lib/db.ts", "tests/db_test.ts"],
  testDiffText: `--- a/tests/db_test.ts
+++ b/tests/db_test.ts
@@ -0,0 +1,3 @@
+Deno.test("rejects_injection", () => {
+  assertThrows(() => query("' OR 1=1 --"));
+});`,
};

// --- hasSecurityLabel -------------------------------------------------------

Deno.test("hasSecurityLabel - true when security is a whole label", () => {
  assertEquals(hasSecurityLabel("security,work-on"), true);
  assertEquals(hasSecurityLabel("work-on, security"), true);
  assertEquals(hasSecurityLabel("SECURITY"), true);
});

Deno.test("hasSecurityLabel - false for unrelated labels", () => {
  assertEquals(hasSecurityLabel("enhancement,work-on"), false);
  assertEquals(hasSecurityLabel(""), false);
  // Substring must not match — only whole labels count.
  assertEquals(hasSecurityLabel("security-review"), false);
});

// --- referencesFindingId ----------------------------------------------------

Deno.test("referencesFindingId - detects a SEC-<hex> id", () => {
  assertEquals(referencesFindingId("Closes finding SEC-a1b2c3d4e5f6."), true);
  assertEquals(referencesFindingId("no finding here"), false);
});

// --- isTestFilePath ---------------------------------------------------------

Deno.test("isTestFilePath - recognises this fleet's test file shapes", () => {
  assertEquals(isTestFilePath("worker/deno/tests/foo_test.ts"), true);
  assertEquals(isTestFilePath("src/foo.test.ts"), true);
  assertEquals(isTestFilePath("cypress/e2e/login.cy.ts"), true);
  assertEquals(isTestFilePath("tests/worker.bats"), true);
  assertEquals(isTestFilePath("api/test_auth.py"), true);
  assertEquals(isTestFilePath("src/main/FooTest.java"), true);
});

Deno.test("isTestFilePath - rejects production paths", () => {
  assertEquals(isTestFilePath("worker/deno/lib/security_fix_gate.ts"), false);
  assertEquals(
    isTestFilePath("docs/archive/pr-summaries/pr-summary-1.md"),
    false,
  );
  assertEquals(isTestFilePath("README.md"), false);
  assertEquals(isTestFilePath(""), false);
  assertEquals(isTestFilePath("   "), false);
});

// --- extractTestIdentifiers -------------------------------------------------

Deno.test("extractTestIdentifiers - pulls the name from a path::name citation", () => {
  const ids = extractTestIdentifiers(
    "Added `tests/db_test.ts::rejects_injection` as the regression test.",
  );
  assertEquals(ids.includes("rejects injection"), true);
});

Deno.test("extractTestIdentifiers - pulls a quoted Deno.test name", () => {
  const ids = extractTestIdentifiers(
    'Added `Deno.test("gate - blocks bare summary")` to the suite.',
  );
  assertEquals(ids.includes("gate blocks bare summary"), true);
});

Deno.test("extractTestIdentifiers - ignores trivially short candidates", () => {
  assertEquals(extractTestIdentifiers("see foo::ab for details"), []);
  assertEquals(extractTestIdentifiers("no identifiers at all here"), []);
});

Deno.test("extractTestIdentifiers - drops generic tokens that name no test", () => {
  // Issue #1279: `tests/foo_test.ts::test` used to clear the four-character
  // floor and then match any added test line by substring.
  for (const generic of ["test", "spec", "deno", "case", "should", "it"]) {
    assertEquals(
      extractTestIdentifiers(`Added \`tests/foo_test.ts::${generic}\`.`),
      [],
      `generic token "${generic}" must not count as a cited identifier`,
    );
  }
  // A name made only of generic tokens is just as empty.
  assertEquals(extractTestIdentifiers("`tests/foo_test.ts::test_case`"), []);
});

// --- citedTestIdentifierInDiff ----------------------------------------------

Deno.test("citedTestIdentifierInDiff - matches a cited name in added lines", () => {
  assertEquals(
    citedTestIdentifierInDiff(GOOD_SUMMARY, GOOD_DIFF.testDiffText),
    true,
  );
});

Deno.test("citedTestIdentifierInDiff - ignores names only present in removed lines", () => {
  const removedOnly = `--- a/tests/db_test.ts
+++ b/tests/db_test.ts
@@ -1,3 +0,0 @@
-Deno.test("rejects_injection", () => {});`;
  assertEquals(citedTestIdentifierInDiff(GOOD_SUMMARY, removedOnly), false);
});

Deno.test("citedTestIdentifierInDiff - false when the diff is empty", () => {
  assertEquals(citedTestIdentifierInDiff(GOOD_SUMMARY, ""), false);
});

Deno.test("citedTestIdentifierInDiff - rejects the generic token test cited against an unrelated test", () => {
  // Issue #1279 regression: the whole gate was satisfiable by citing
  // `tests/anything_test.ts::test` on a branch adding any test line at all,
  // because `Deno.test(` normalises to text containing `test`.
  const fakeSummary = `## Summary
Fixed the flaw. Added \`tests/anything_test.ts::test\` — a regression test that
reproduces it: it fails against the unfixed code and passes after the fix.`;
  const unrelatedDiff = `--- a/tests/anything_test.ts
+++ b/tests/anything_test.ts
@@ -0,0 +1,3 @@
+Deno.test("unrelated name", () => {
+  assertEquals(1, 1);
+});`;
  assertEquals(citedTestIdentifierInDiff(fakeSummary, unrelatedDiff), false);
});

Deno.test("citedTestIdentifierInDiff - requires a whole-token match, not a substring", () => {
  const summary = "Added `tests/db_test.ts::inject` as the regression test.";
  assertEquals(
    citedTestIdentifierInDiff(summary, GOOD_DIFF.testDiffText),
    false,
  );
});

Deno.test("citedTestIdentifierInDiff - ignores an identifier used only in an assertion body", () => {
  const bodyOnly = `--- a/tests/db_test.ts
+++ b/tests/db_test.ts
@@ -0,0 +1,3 @@
+Deno.test("unrelated name", () => {
+  assertThrows(() => rejects_injection());
+});`;
  assertEquals(citedTestIdentifierInDiff(GOOD_SUMMARY, bodyOnly), false);
});

Deno.test("citedTestIdentifierInDiff - matches pytest, BATS and JUnit declarations", () => {
  const pytest = "+def test_rejects_injection():\n+    assert True";
  assertEquals(citedTestIdentifierInDiff(GOOD_SUMMARY, pytest), true);

  const bats = '+@test "rejects injection" {\n+  run query\n+}';
  assertEquals(citedTestIdentifierInDiff(GOOD_SUMMARY, bats), true);

  const junit = "+  @Test\n+  public void rejectsInjection() {\n+  }";
  const junitSummary = "Added `FooTest.java::rejectsInjection` as the test.";
  assertEquals(citedTestIdentifierInDiff(junitSummary, junit), true);
});

Deno.test("citedTestIdentifierInDiff - matches a Rust test declared under a test attribute (Issue #1680)", () => {
  const rust = `+#[test]
+fn rejects_oob_index() {
+    assert!(lookup(99).is_err());
+}`;
  const summary =
    "Added `tests/index_test.rs::rejects_oob_index` as the regression test.";
  assertEquals(citedTestIdentifierInDiff(summary, rust), true);
});

Deno.test("citedTestIdentifierInDiff - matches the async and stacked Rust attribute forms (Issue #1680)", () => {
  const summary =
    "Added `tests/index_test.rs::rejects_oob_index` as the regression test.";

  const tokio = `+    #[tokio::test(flavor = "multi_thread")]
+    async fn rejects_oob_index() {
+        assert!(lookup(99).await.is_err());
+    }`;
  assertEquals(citedTestIdentifierInDiff(summary, tokio), true);

  const rstest = `+#[rstest]
+fn rejects_oob_index(#[case] index: usize) {}`;
  assertEquals(citedTestIdentifierInDiff(summary, rstest), true);

  const proptest = `+#[proptest]
+fn rejects_oob_index(index: usize) {}`;
  assertEquals(citedTestIdentifierInDiff(summary, proptest), true);

  // Further attributes may sit between the test attribute and the function.
  const stacked = `+#[test]
+#[should_panic(expected = "out of bounds")]
+pub fn rejects_oob_index() {}`;
  assertEquals(citedTestIdentifierInDiff(summary, stacked), true);
});

Deno.test("citedTestIdentifierInDiff - a Rust fn only counts under a test attribute (Issue #1680)", () => {
  const summary =
    "Added `tests/index_test.rs::rejects_oob_index` as the regression test.";

  // A plain helper function declares no test.
  const helper = "+fn rejects_oob_index(index: usize) -> bool { true }";
  assertEquals(citedTestIdentifierInDiff(summary, helper), false);

  // `#[cfg(test)] mod tests` gates a module, not a test function.
  const moduleOnly = `+#[cfg(test)]
+mod rejects_oob_index {}`;
  assertEquals(citedTestIdentifierInDiff(summary, moduleOnly), false);

  // The name appears only inside another test's body (the Issue #1279 rule).
  const bodyOnly = `+#[test]
+fn unrelated_case() {
+    assert!(rejects_oob_index(99));
+}`;
  assertEquals(citedTestIdentifierInDiff(summary, bodyOnly), false);
});

Deno.test("citedTestIdentifierInDiff - matches a Go test function (Issue #1680)", () => {
  const go = `+func TestRejectsOob(t *testing.T) {
+\tif err := Lookup(99); err == nil {
+\t\tt.Fatal("expected an error")
+\t}
+}`;
  const summary =
    "Added `index_test.go::TestRejectsOob` as the regression test.";
  assertEquals(citedTestIdentifierInDiff(summary, go), true);

  // A non-test Go function with the name in its body does not count.
  const helper = `+func lookupHelper(t *testing.T) {
+\t_ = "TestRejectsOob"
+}`;
  assertEquals(citedTestIdentifierInDiff(summary, helper), false);
});

Deno.test("matchedTestDeclarations - reports the Rust and Go declaration lines (Issue #1680)", () => {
  const diff = `+#[test]
+fn rejects_oob_index() {
+}
+func TestRejectsOob(t *testing.T) {
+}`;
  assertEquals(matchedTestDeclarations(diff), [
    "fn rejects_oob_index() {",
    "func TestRejectsOob(t *testing.T) {",
  ]);
});

Deno.test("citedTestIdentifierInDiff - matches the Deno object-form test name", () => {
  const objectForm = `+Deno.test({
+  name: "rejects_injection",
+  fn: () => {},
+});`;
  assertEquals(citedTestIdentifierInDiff(GOOD_SUMMARY, objectForm), true);
});

Deno.test("citedTestIdentifierInDiff - matches a name that deno fmt wrapped onto the line after Deno.test( (Issue #1581)", () => {
  const wrapped = `+Deno.test(
+  "handle_no_changes_phase - an untrusted image withholds the close",
+  async () => {
+    assertEquals(1, 1);
+  },
+);`;
  const summary =
    'Added `tests/handle_no_changes_phase_test.ts::"handle_no_changes_phase - an untrusted image withholds the close"` as the regression test.';
  assertEquals(citedTestIdentifierInDiff(summary, wrapped), true);
});

Deno.test("citedTestIdentifierInDiff - matches the wrapped forms of it( / test( and of the object form's name: (Issue #1581)", () => {
  const jest = `+it(
+  "rejects_injection",
+  async () => {},
+);`;
  assertEquals(citedTestIdentifierInDiff(GOOD_SUMMARY, jest), true);

  const bareTest = `+test(
+  'rejects_injection',
+  () => {},
+);`;
  assertEquals(citedTestIdentifierInDiff(GOOD_SUMMARY, bareTest), true);

  const objectWrapped = `+Deno.test({
+  name:
+    "rejects_injection",
+  fn: () => {},
+});`;
  assertEquals(citedTestIdentifierInDiff(GOOD_SUMMARY, objectWrapped), true);
});

Deno.test("citedTestIdentifierInDiff - a string on its own line counts only directly after an opener (Issue #1581)", () => {
  // The cited name appears as a string literal line, but nothing opened a
  // test declaration on the line before it — an assertion message, say.
  const stray = `+Deno.test("unrelated name", () => {
+  assertEquals(
+    result,
+    "rejects_injection",
+  );
+});`;
  assertEquals(citedTestIdentifierInDiff(GOOD_SUMMARY, stray), false);

  // An opener followed by something other than the name is not a declaration
  // of that later string either.
  const openerThenCode = `+Deno.test(
+  makeName(),
+  () => {
+    const s = "rejects_injection";
+  },
+);`;
  assertEquals(citedTestIdentifierInDiff(GOOD_SUMMARY, openerThenCode), false);
});

// --- evaluateSecurityFixGate: inactive --------------------------------------

Deno.test("evaluateSecurityFixGate - inactive for non-security PR", () => {
  const result = evaluateSecurityFixGate({
    prSummaryContent: "## Summary\nAdded a button. Closes #1.",
    issueLabels: "enhancement,work-on",
    diff: null,
    discrimination: null,
    verification: FIXED_VERIFICATION,
  });
  assertEquals(result.isSecurityFix, false);
  assertEquals(result.ok, true);
  assertEquals(result.missing, []);
});

// --- evaluateSecurityFixGate: active + complete -----------------------------

Deno.test("evaluateSecurityFixGate - passes when prose and diff evidence agree (label)", () => {
  const result = evaluateSecurityFixGate({
    prSummaryContent: GOOD_SUMMARY,
    issueLabels: "security,work-on",
    diff: GOOD_DIFF,
    discrimination: RED_GREEN,
    verification: FIXED_VERIFICATION,
  });
  assertEquals(result.isSecurityFix, true);
  assertEquals(result.ok, true);
  assertEquals(result.missing, []);
});

Deno.test("evaluateSecurityFixGate - active via SEC id even without label", () => {
  const summary = GOOD_SUMMARY + "\n\nFinding: SEC-0123456789ab";
  const result = evaluateSecurityFixGate({
    prSummaryContent: summary,
    issueLabels: "work-on",
    diff: GOOD_DIFF,
    discrimination: RED_GREEN,
    verification: FIXED_VERIFICATION,
  });
  assertEquals(result.isSecurityFix, true);
  assertEquals(result.ok, true);
});

// --- evaluateSecurityFixGate: machine-checkable evidence (Issue #3652) ------

Deno.test("evaluateSecurityFixGate - perfect prose alone does not pass the gate", () => {
  // The whole point of #3652: a summary written to match the published
  // phrases, with no test in the diff, must be blocked.
  const result = evaluateSecurityFixGate({
    prSummaryContent: GOOD_SUMMARY,
    issueLabels: "security",
    diff: { changedFiles: ["worker/deno/lib/db.ts"], testDiffText: "" },
    discrimination: RED_GREEN,
    verification: FIXED_VERIFICATION,
  });
  assertEquals(result.ok, false);
  assertEquals(result.missing.includes("test-file-changed"), true);
  assertEquals(result.missing.includes("test-identifier-in-diff"), true);
  // The trigger-closed statement is satisfied — only the machine checks fail.
  assertEquals(result.missing.includes("trigger-closed"), false);
});

Deno.test("evaluateSecurityFixGate - test file changed but cited test absent from diff", () => {
  const result = evaluateSecurityFixGate({
    prSummaryContent: GOOD_SUMMARY,
    issueLabels: "security",
    diff: {
      changedFiles: ["tests/db_test.ts"],
      testDiffText: '+Deno.test("some unrelated case", () => {});',
    },
    discrimination: RED_GREEN,
    verification: FIXED_VERIFICATION,
  });
  assertEquals(result.ok, false);
  assertEquals(result.missing, ["test-identifier-in-diff"]);
});

Deno.test("evaluateSecurityFixGate - blocks a summary citing the generic token test", () => {
  // Issue #1279: the one unfakeable check must not be satisfiable by a
  // four-character token plus any added test line.
  const fakeSummary = `## Summary
Fixed the flaw. Added \`tests/anything_test.ts::test\` — a regression test that
reproduces it: it fails against the unfixed code and passes after the fix. The
original trigger is now closed with no trivial bypass.`;
  const result = evaluateSecurityFixGate({
    prSummaryContent: fakeSummary,
    issueLabels: "security",
    diff: {
      changedFiles: ["tests/anything_test.ts"],
      testDiffText: '+Deno.test("unrelated name", () => {});',
    },
    discrimination: RED_GREEN,
    verification: FIXED_VERIFICATION,
  });
  assertEquals(result.ok, false);
  assertEquals(result.missing, ["test-identifier-in-diff"]);
});

Deno.test("evaluateSecurityFixGate - summary naming no test cannot pass", () => {
  const summary = `## Summary
Fixed the flaw. A regression test reproduces it: it fails against the unfixed
code and passes after the fix. The original trigger is closed with no trivial
bypass.`;
  const result = evaluateSecurityFixGate({
    prSummaryContent: summary,
    issueLabels: "security",
    diff: {
      changedFiles: ["tests/db_test.ts"],
      testDiffText: '+Deno.test("rejects_injection", () => {});',
    },
    discrimination: RED_GREEN,
    verification: FIXED_VERIFICATION,
  });
  assertEquals(result.ok, false);
  assertEquals(result.missing, ["test-identifier-in-diff"]);
});

Deno.test("evaluateSecurityFixGate - blocks when the diff could not be collected", () => {
  const result = evaluateSecurityFixGate({
    prSummaryContent: GOOD_SUMMARY,
    issueLabels: "security",
    diff: null,
    discrimination: RED_GREEN,
    verification: FIXED_VERIFICATION,
  });
  assertEquals(result.ok, false);
  assertEquals(result.missing, ["diff-unavailable"]);
});

// --- evaluateSecurityFixGate: active + missing prose ------------------------

Deno.test("evaluateSecurityFixGate - flags a missing trigger-closed statement on a bare summary", () => {
  const result = evaluateSecurityFixGate({
    prSummaryContent:
      "## Summary\nFixed the vulnerability in `tests/db_test.ts::rejects_injection`. Closes #100.",
    issueLabels: "security,work-on",
    diff: GOOD_DIFF,
    discrimination: RED_GREEN,
    verification: FIXED_VERIFICATION,
  });
  assertEquals(result.isSecurityFix, true);
  assertEquals(result.ok, false);
  assertEquals(result.missing, ["trigger-closed"]);
});

Deno.test("evaluateSecurityFixGate - flags missing trigger-closed only", () => {
  const summary = `## Summary
Added \`tests/db_test.ts::rejects_injection\` — a regression test that fails
against the unfixed code and passes after the fix.`;
  const result = evaluateSecurityFixGate({
    prSummaryContent: summary,
    issueLabels: "security",
    diff: GOOD_DIFF,
    discrimination: RED_GREEN,
    verification: FIXED_VERIFICATION,
  });
  assertEquals(result.ok, false);
  assertEquals(result.missing, ["trigger-closed"]);
});

// --- evaluateSecurityFixGate: executed red -> green record (Issue #3659) ----

/** Evaluate GOOD_SUMMARY and GOOD_DIFF under a given discrimination record. */
function evaluateWith(discrimination: SecurityFixDiscrimination | null) {
  return evaluateSecurityFixGate({
    prSummaryContent: GOOD_SUMMARY,
    issueLabels: "security",
    diff: GOOD_DIFF,
    discrimination,
    verification: FIXED_VERIFICATION,
  });
}

Deno.test("evaluateSecurityFixGate - a red then green record passes (Issue #3659)", () => {
  const result = evaluateWith(RED_GREEN);
  assertEquals(result.ok, true);
  assertEquals(result.missing, []);
});

Deno.test("evaluateSecurityFixGate - green then green does not discriminate (Issue #3659)", () => {
  const result = evaluateWith({
    ...RED_GREEN,
    preFix: "pass",
    postFix: "pass",
  });
  assertEquals(result.ok, false);
  assertEquals(result.missing, ["test-discriminates"]);
});

Deno.test("evaluateSecurityFixGate - red then red does not discriminate (Issue #3659)", () => {
  const result = evaluateWith({
    ...RED_GREEN,
    preFix: "fail",
    postFix: "fail",
  });
  assertEquals(result.ok, false);
  assertEquals(result.missing, ["test-discriminates"]);
});

Deno.test("evaluateSecurityFixGate - green then red does not discriminate (Issue #3659)", () => {
  const result = evaluateWith({
    ...RED_GREEN,
    preFix: "pass",
    postFix: "fail",
  });
  assertEquals(result.ok, false);
  assertEquals(result.missing, ["test-discriminates"]);
});

Deno.test("evaluateSecurityFixGate - a not_checked record blocks and is never counted as red (Issue #3659)", () => {
  const result = evaluateWith({
    kind: "not_checked",
    reason: "runner timed out",
  });
  assertEquals(result.ok, false);
  assertEquals(result.missing, ["discrimination-not-checked"]);
});

Deno.test("evaluateSecurityFixGate - a null record blocks as not checked (Issue #3659)", () => {
  const result = evaluateWith(null);
  assertEquals(result.ok, false);
  assertEquals(result.missing, ["discrimination-not-checked"]);
});

Deno.test("evaluateSecurityFixGate - a missing identifier adds no discrimination kind (Issue #3659)", () => {
  for (
    const discrimination of [
      null,
      { kind: "not_checked", reason: "x" } as const,
      { ...RED_GREEN, preFix: "pass" } as const,
    ]
  ) {
    const result = evaluateSecurityFixGate({
      prSummaryContent: GOOD_SUMMARY,
      issueLabels: "security",
      diff: {
        changedFiles: ["tests/db_test.ts"],
        testDiffText: '+Deno.test("some unrelated case", () => {});',
      },
      discrimination,
      verification: FIXED_VERIFICATION,
    });
    assertEquals(result.missing, ["test-identifier-in-diff"]);
  }
});

Deno.test("evaluateSecurityFixGate - tolerates empty content", () => {
  const result = evaluateSecurityFixGate({
    prSummaryContent: "",
    issueLabels: "security",
    diff: GOOD_DIFF,
    discrimination: RED_GREEN,
    verification: FIXED_VERIFICATION,
  });
  assertEquals(result.isSecurityFix, true);
  assertEquals(result.ok, false);
  // Empty prose cites no test identifier either.
  assertEquals(result.missing.sort(), [
    "test-identifier-in-diff",
    "trigger-closed",
  ]);
});

// --- citedSecurityTests (Issue #3659) ---------------------------------------

Deno.test("citedSecurityTests - returns the file and raw name per cited declaration", () => {
  const diff = `--- a/tests/other_test.ts
+++ b/tests/other_test.ts
@@ -0,0 +1 @@
+Deno.test("unrelated name", () => {});
--- a/tests/db_test.ts
+++ b/tests/db_test.ts
@@ -0,0 +1,3 @@
+Deno.test("rejects_injection", () => {
+  assertThrows(() => query("' OR 1=1 --"));
+});`;
  assertEquals(citedSecurityTests(GOOD_SUMMARY, diff), [
    { file: "tests/db_test.ts", name: "rejects_injection" },
  ]);
});

Deno.test("citedSecurityTests - keeps the same name declared in two files apart", () => {
  const diff = `+++ b/tests/a_test.ts
+Deno.test("rejects_injection", () => {});
+++ b/tests/b_test.ts
+Deno.test("rejects_injection", () => {});
+Deno.test("rejects_injection", () => {});`;
  assertEquals(citedSecurityTests(GOOD_SUMMARY, diff), [
    { file: "tests/a_test.ts", name: "rejects_injection" },
    { file: "tests/b_test.ts", name: "rejects_injection" },
  ]);
});

Deno.test("citedSecurityTests - reads a name deno fmt wrapped onto the next line", () => {
  const diff = `+++ b/tests/db_test.ts
+Deno.test(
+  "rejects_injection",
+  async () => {},
+);`;
  assertEquals(citedSecurityTests(GOOD_SUMMARY, diff), [
    { file: "tests/db_test.ts", name: "rejects_injection" },
  ]);
});

Deno.test("citedSecurityTests - a Rust test fn has no string name and yields nothing", () => {
  const summary =
    "Added `tests/index_test.rs::rejects_oob_index` as the regression test.";
  const diff = `+++ b/tests/index_test.rs
+#[test]
+fn rejects_oob_index() {}`;
  assertEquals(citedSecurityTests(summary, diff), []);
});

Deno.test("citedSecurityTests - a name present only in an assertion body yields nothing", () => {
  const diff = `+++ b/tests/db_test.ts
+Deno.test("unrelated name", () => {
+  assertThrows(() => rejects_injection());
+});`;
  assertEquals(citedSecurityTests(GOOD_SUMMARY, diff), []);
});

Deno.test("citedSecurityTests - a deleted file section is skipped", () => {
  const diff = `+++ /dev/null
+Deno.test("rejects_injection", () => {});`;
  assertEquals(citedSecurityTests(GOOD_SUMMARY, diff), []);
});

Deno.test("citedSecurityTests - caps the number of cited tests", () => {
  const names = Array.from({ length: 15 }, (_, i) => `rejects_injection_${i}`);
  const summary = "`tests/db_test.ts::rejects_injection`";
  const lines = names.map((n) =>
    `+Deno.test("rejects_injection ${n}", () => {});`
  );
  const diff = `+++ b/tests/db_test.ts\n${lines.join("\n")}`;
  assertEquals(citedSecurityTests(summary, diff).length, 10);
});

// --- buildSecurityFixGateMessage --------------------------------------------

Deno.test("buildSecurityFixGateMessage - names each missing item", () => {
  const message = buildSecurityFixGateMessage(
    [
      "test-file-changed",
      "test-identifier-in-diff",
      "test-discriminates",
      "trigger-closed",
    ],
    [],
    null,
  );
  assertStringIncludes(message, "must FAIL against the base branch");
  assertStringIncludes(message, "ORIGINAL TRIGGER");
  assertStringIncludes(message, "TEST FILE");
  assertStringIncludes(message, "TEST IDENTIFIER");
  assertStringIncludes(message, "fail loud");
});

Deno.test("buildSecurityFixGateMessage - explains an uncollectable diff", () => {
  const message = buildSecurityFixGateMessage(["diff-unavailable"], [], null);
  assertStringIncludes(message, "git fetch origin");
  assertStringIncludes(message, "blocked rather than assumed good");
});

Deno.test("buildSecurityFixGateMessage - shows the recorded runs for a checked record (Issue #3659)", () => {
  const message = buildSecurityFixGateMessage(
    ["test-discriminates"],
    [],
    { ...RED_GREEN, preFix: "pass", postFix: "pass" },
  );
  assertStringIncludes(message, "Recorded discrimination runs");
  assertStringIncludes(message, "tests/db_test.ts::rejects_injection");
  assertStringIncludes(message, "base production files: pass (expected fail)");
  assertStringIncludes(message, "head: pass (expected pass)");
});

Deno.test("buildSecurityFixGateMessage - shows the reason for a not_checked record (Issue #3659)", () => {
  const message = buildSecurityFixGateMessage(
    ["discrimination-not-checked"],
    [],
    { kind: "not_checked", reason: "base ref origin/main did not resolve" },
  );
  assertStringIncludes(message, "Recorded discrimination runs");
  assertStringIncludes(message, "base ref origin/main did not resolve");
});

Deno.test("buildSecurityFixGateMessage - omits the recorded runs when discrimination is not at fault", () => {
  const message = buildSecurityFixGateMessage(
    ["trigger-closed"],
    [],
    RED_GREEN,
  );
  assertEquals(message.includes("Recorded discrimination runs"), false);
});

Deno.test("buildSecurityFixGateMessage - describes who runs each check, not that no execution is required (Issue #3659)", () => {
  const message = buildSecurityFixGateMessage(["trigger-closed"], [], null);
  assertEquals(message.includes("No execution is required"), false);
  assertStringIncludes(message, "executed by the worker");
});

// --- citedSecurityTests: hunk-aware file sections (Issue #3659) -------------

const INJECTION_SUMMARY = GOOD_SUMMARY;

Deno.test("citedSecurityTests - an added line reading '++ b/…' cannot re-attribute the file", () => {
  const diff = [
    "diff --git a/tests/a_test.ts b/tests/a_test.ts",
    "--- a/tests/a_test.ts",
    "+++ b/tests/a_test.ts",
    "@@ -0,0 +1,2 @@",
    "+++ b/tests/evil_test.ts",
    '+Deno.test("rejects_injection", () => {});',
  ].join("\n");
  assertEquals(citedSecurityTests(INJECTION_SUMMARY, diff), [
    { file: "tests/a_test.ts", name: "rejects_injection" },
  ]);
});

Deno.test("citedSecurityTests - a removed '-- a/x' line plus an added '++ b/…' line cannot re-attribute the file", () => {
  const diff = [
    "--- a/tests/a_test.ts",
    "+++ b/tests/a_test.ts",
    "@@ -1,1 +1,2 @@",
    "--- a/x",
    "+++ b/tests/evil_test.ts",
    '+Deno.test("rejects_injection", () => {});',
  ].join("\n");
  assertEquals(citedSecurityTests(INJECTION_SUMMARY, diff), [
    { file: "tests/a_test.ts", name: "rejects_injection" },
  ]);
});

Deno.test("citedSecurityTests - real headers after hunks still start new file sections", () => {
  const diff = [
    "diff --git a/tests/a_test.ts b/tests/a_test.ts",
    "--- a/tests/a_test.ts",
    "+++ b/tests/a_test.ts",
    "@@ -1,2 +1,3 @@",
    " context",
    '+Deno.test("rejects_injection", () => {});',
    " more",
    "diff --git a/tests/b_test.ts b/tests/b_test.ts",
    "--- a/tests/b_test.ts",
    "+++ b/tests/b_test.ts",
    "@@ -0,0 +1 @@",
    '+Deno.test("rejects_injection", () => {});',
  ].join("\n");
  assertEquals(citedSecurityTests(INJECTION_SUMMARY, diff), [
    { file: "tests/a_test.ts", name: "rejects_injection" },
    { file: "tests/b_test.ts", name: "rejects_injection" },
  ]);
});

Deno.test("citedSecurityTests - a hunk header with omitted counts defaults each to one", () => {
  const diff = [
    "--- /dev/null",
    "+++ b/tests/a_test.ts",
    "@@ -0,0 +1 @@",
    '+Deno.test("rejects_injection", () => {});',
    "+++ b/tests/b_test.ts",
    '+Deno.test("rejects_injection", () => {});',
  ].join("\n");
  assertEquals(citedSecurityTests(INJECTION_SUMMARY, diff), [
    { file: "tests/a_test.ts", name: "rejects_injection" },
    { file: "tests/b_test.ts", name: "rejects_injection" },
  ]);
});
