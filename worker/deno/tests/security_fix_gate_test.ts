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
  citedTestIdentifierInDiff,
  evaluateSecurityFixGate,
  extractTestIdentifiers,
  hasSecurityLabel,
  isTestFilePath,
  matchedTestDeclarations,
  referencesFindingId,
  type SecurityFixDiffEvidence,
} from "../lib/security_fix_gate.ts";

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
  });
  assertEquals(result.ok, false);
  assertEquals(result.missing.includes("test-file-changed"), true);
  assertEquals(result.missing.includes("test-identifier-in-diff"), true);
  // The prose items are satisfied — only the machine checks fail.
  assertEquals(result.missing.includes("regression-test"), false);
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
  });
  assertEquals(result.ok, false);
  assertEquals(result.missing, ["test-identifier-in-diff"]);
});

Deno.test("evaluateSecurityFixGate - blocks when the diff could not be collected", () => {
  const result = evaluateSecurityFixGate({
    prSummaryContent: GOOD_SUMMARY,
    issueLabels: "security",
    diff: null,
  });
  assertEquals(result.ok, false);
  assertEquals(result.missing, ["diff-unavailable"]);
});

// --- evaluateSecurityFixGate: active + missing prose ------------------------

Deno.test("evaluateSecurityFixGate - flags both missing prose items on a bare summary", () => {
  const result = evaluateSecurityFixGate({
    prSummaryContent:
      "## Summary\nFixed the vulnerability in `tests/db_test.ts::rejects_injection`. Closes #100.",
    issueLabels: "security,work-on",
    diff: GOOD_DIFF,
  });
  assertEquals(result.isSecurityFix, true);
  assertEquals(result.ok, false);
  assertEquals(result.missing.sort(), ["regression-test", "trigger-closed"]);
});

Deno.test("evaluateSecurityFixGate - flags missing regression test only", () => {
  const summary = `## Summary
Fixed the flaw in \`tests/db_test.ts::rejects_injection\`. The original attack
input is now rejected and there is no trivial bypass.`;
  const result = evaluateSecurityFixGate({
    prSummaryContent: summary,
    issueLabels: "security",
    diff: GOOD_DIFF,
  });
  assertEquals(result.ok, false);
  assertEquals(result.missing, ["regression-test"]);
});

Deno.test("evaluateSecurityFixGate - flags missing trigger-closed only", () => {
  const summary = `## Summary
Added \`tests/db_test.ts::rejects_injection\` — a regression test that fails
against the unfixed code and passes after the fix.`;
  const result = evaluateSecurityFixGate({
    prSummaryContent: summary,
    issueLabels: "security",
    diff: GOOD_DIFF,
  });
  assertEquals(result.ok, false);
  assertEquals(result.missing, ["trigger-closed"]);
});

Deno.test("evaluateSecurityFixGate - regression test needs before/after linkage, not just a test mention", () => {
  const summary = `## Summary
Added a test in \`tests/db_test.ts::rejects_injection\`. The original trigger is
now closed with no bypass.`;
  const result = evaluateSecurityFixGate({
    prSummaryContent: summary,
    issueLabels: "security",
    diff: GOOD_DIFF,
  });
  // "test" without regression/reproduction wording or fail-before/pass-after
  // linkage must not satisfy the regression-test requirement.
  assertEquals(result.missing, ["regression-test"]);
});

Deno.test("evaluateSecurityFixGate - tolerates empty content", () => {
  const result = evaluateSecurityFixGate({
    prSummaryContent: "",
    issueLabels: "security",
    diff: GOOD_DIFF,
  });
  assertEquals(result.isSecurityFix, true);
  assertEquals(result.ok, false);
  // Empty prose cites no test identifier either.
  assertEquals(result.missing.sort(), [
    "regression-test",
    "test-identifier-in-diff",
    "trigger-closed",
  ]);
});

// --- buildSecurityFixGateMessage --------------------------------------------

Deno.test("buildSecurityFixGateMessage - names each missing item", () => {
  const message = buildSecurityFixGateMessage([
    "test-file-changed",
    "test-identifier-in-diff",
    "regression-test",
    "trigger-closed",
  ]);
  assertStringIncludes(message, "regression test");
  assertStringIncludes(message, "ORIGINAL TRIGGER");
  assertStringIncludes(message, "TEST FILE");
  assertStringIncludes(message, "TEST IDENTIFIER");
  assertStringIncludes(message, "fail loud");
});

Deno.test("buildSecurityFixGateMessage - explains an uncollectable diff", () => {
  const message = buildSecurityFixGateMessage(["diff-unavailable"]);
  assertStringIncludes(message, "git fetch origin");
  assertStringIncludes(message, "blocked rather than assumed good");
});
