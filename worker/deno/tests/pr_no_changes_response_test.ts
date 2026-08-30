/**
 * Unit tests for pr_no_changes_response.ts (Issue #1691).
 *
 * Pure helper — no I/O, no Deno permissions required.
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  buildCiNoChangesResponse,
  buildFeedbackNoChangesResponse,
} from "../lib/pr_no_changes_response.ts";
import type {
  CiFailureCategory,
  CiFailureClassification,
} from "../lib/ci_failure_classifier.ts";

function classification(
  category: CiFailureClassification["category"],
  reason: string,
  signals: string[] = [],
): CiFailureClassification {
  return { category, reason, signals };
}

Deno.test("buildCiNoChangesResponse - code-fix-required adds needs-human and quotes signals", () => {
  const c = classification(
    "code-fix-required",
    "semgrep finding (blocking code rules fired)",
    ["check:semgrep", "text:blocking code rules fired"],
  );
  const res = buildCiNoChangesResponse("semgrep", c);
  assertEquals(res.addNeedsHuman, true);
  assertEquals(res.category, "code-fix-required");
  assertStringIncludes(res.body, "**semgrep**");
  assertStringIncludes(res.body, "needs-human");
  assertStringIncludes(res.body, "semgrep finding");
  assertStringIncludes(res.body, "check:semgrep");
  // Must not assert transience.
  assertEquals(res.body.toLowerCase().includes("transient"), false);
});

Deno.test("buildCiNoChangesResponse - timing suggests re-run, no needs-human", () => {
  const c = classification("timing", "timing failure: timed out", [
    "check:test",
    "text:timed out",
  ]);
  const res = buildCiNoChangesResponse("test", c);
  assertEquals(res.addNeedsHuman, false);
  assertEquals(res.category, "timing");
  assertStringIncludes(res.body, "timing");
  assertStringIncludes(res.body, "re-run");
  assertEquals(res.body.toLowerCase().includes("transient"), false);
});

Deno.test("buildCiNoChangesResponse - infrastructure suggests re-run, no needs-human", () => {
  const c = classification(
    "infrastructure",
    "infrastructure failure: connect etimedout",
    ["check:deploy", "text:connect etimedout"],
  );
  const res = buildCiNoChangesResponse("deploy", c);
  assertEquals(res.addNeedsHuman, false);
  assertEquals(res.category, "infrastructure");
  assertStringIncludes(res.body, "infrastructure");
  assertStringIncludes(res.body, "re-run");
});

Deno.test("buildCiNoChangesResponse - unknown is honest, no transience claim", () => {
  const c = classification("unknown", "no recognised pattern", [
    "check:custom",
  ]);
  const res = buildCiNoChangesResponse("custom", c);
  assertEquals(res.addNeedsHuman, false);
  assertEquals(res.category, "unknown");
  assertStringIncludes(res.body, "could not determine");
  assertEquals(res.body.toLowerCase().includes("transient"), false);
});

Deno.test("buildCiNoChangesResponse - throws via assertNever on an out-of-union category", () => {
  // Simulate a future CiFailureCategory variant reaching the switch.
  const c = classification(
    "rate-limited" as CiFailureCategory,
    "novel category",
  );
  assertThrows(
    () => buildCiNoChangesResponse("custom", c),
    Error,
    "Unreachable",
  );
});

Deno.test("buildFeedbackNoChangesResponse - no classification yields neutral message", () => {
  const res = buildFeedbackNoChangesResponse();
  assertEquals(res.addNeedsHuman, false);
  assertStringIncludes(res.body, "could not identify a code change");
  assertEquals(res.body.toLowerCase().includes("transient"), false);
});

Deno.test("buildFeedbackNoChangesResponse - code-fix classification triggers needs-human", () => {
  const c = classification(
    "code-fix-required",
    "semgrep finding",
    ["check:semgrep"],
  );
  const res = buildFeedbackNoChangesResponse(c);
  assertEquals(res.addNeedsHuman, true);
  assertStringIncludes(res.body, "needs-human");
});

Deno.test("buildCiNoChangesResponse - a surviving secret finding points at the base branch", () => {
  // Reaching this arm means the content fix produced nothing to rebuild
  // around, so the finding is already in the base branch. "CI is failing"
  // would send a reviewer to the wrong place entirely (Issue #630).
  const response = buildCiNoChangesResponse("gitleaks", {
    category: "history-rewrite-required",
    reason: "secret scan 'gitleaks' judges the commit range",
    signals: ["check:gitleaks"],
  });

  assertEquals(response.addNeedsHuman, true);
  assertStringIncludes(response.reason ?? "", "already in the base branch");
  // Rotation comes first: the credential is compromised whatever happens to
  // the history, and a purge that takes a day is not a substitute.
  assertStringIncludes(
    response.nextStep ?? "",
    "Rotate the exposed credential",
  );
});
