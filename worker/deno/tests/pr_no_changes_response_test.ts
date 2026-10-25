/**
 * Unit tests for pr_no_changes_response.ts (Issue #1691).
 *
 * Pure helper — no I/O, no Deno permissions required.
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  buildCiNoChangesResponse,
  buildFeedbackNoChangesResponse,
  formatClassifierTrailer,
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

/**
 * Issue #4304: a no-change outcome is never handed to a human. The worker
 * re-runs the failing check and retries; the attempt cap then abandons the
 * PR and redoes its issue. No body may ask a person to act.
 */
function assertNoHandBack(body: string): void {
  assertEquals(body.includes("needs-human"), false, body);
  for (const ask of ["please re-run", "please review", "please clarify"]) {
    assertEquals(body.toLowerCase().includes(ask), false, `${ask}: ${body}`);
  }
}

Deno.test("buildCiNoChangesResponse - code-fix-required retries rather than adding needs-human (Issue #4304)", () => {
  const c = classification(
    "code-fix-required",
    "semgrep finding (blocking code rules fired)",
    ["check:semgrep", "text:blocking code rules fired"],
  );
  const res = buildCiNoChangesResponse("semgrep", c);
  assertEquals(res.addNeedsHuman, false);
  assertEquals(res.category, "code-fix-required");
  assertStringIncludes(res.body, "**semgrep**");
  assertStringIncludes(res.body, "re-runs the failing check");
  assertStringIncludes(res.body, "semgrep finding");
  assertStringIncludes(res.body, "check:semgrep");
  assertNoHandBack(res.body);
  // Must not assert transience.
  assertEquals(res.body.toLowerCase().includes("transient"), false);
});

Deno.test("buildCiNoChangesResponse - timing: the worker re-runs the check itself (Issue #4304)", () => {
  const c = classification("timing", "timing failure: timed out", [
    "check:test",
    "text:timed out",
  ]);
  const res = buildCiNoChangesResponse("test", c);
  assertEquals(res.addNeedsHuman, false);
  assertEquals(res.category, "timing");
  assertStringIncludes(res.body, "timing");
  assertStringIncludes(res.body, "re-runs the failing check");
  assertNoHandBack(res.body);
  assertEquals(res.body.toLowerCase().includes("transient"), false);
});

Deno.test("buildCiNoChangesResponse - infrastructure: the worker re-runs the check itself (Issue #4304)", () => {
  const c = classification(
    "infrastructure",
    "infrastructure failure: connect etimedout",
    ["check:deploy", "text:connect etimedout"],
  );
  const res = buildCiNoChangesResponse("deploy", c);
  assertEquals(res.addNeedsHuman, false);
  assertEquals(res.category, "infrastructure");
  assertStringIncludes(res.body, "infrastructure");
  assertStringIncludes(res.body, "re-runs the failing check");
  assertNoHandBack(res.body);
});

Deno.test("buildCiNoChangesResponse - unknown is honest, no transience claim", () => {
  const c = classification("unknown", "no recognised pattern", [
    "check:custom",
  ]);
  const res = buildCiNoChangesResponse("custom", c);
  assertEquals(res.addNeedsHuman, false);
  assertEquals(res.category, "unknown");
  assertStringIncludes(res.body, "could not determine");
  assertStringIncludes(res.body, "re-runs the failing check");
  assertNoHandBack(res.body);
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

Deno.test("buildFeedbackNoChangesResponse - no classification never asks for clarification (Issue #4304)", () => {
  // GRQ-AutoTrader#4261 got "Please clarify if a change is required." — a
  // question handed back to the reviewer instead of an answer.
  const res = buildFeedbackNoChangesResponse();
  assertEquals(res.addNeedsHuman, false);
  assertStringIncludes(res.body, "could not identify a code change");
  assertNoHandBack(res.body);
  assertEquals(res.body.toLowerCase().includes("clarify"), false);
  assertEquals(res.body.toLowerCase().includes("transient"), false);
});

Deno.test("buildFeedbackNoChangesResponse - code-fix classification retries, no needs-human (Issue #4304)", () => {
  const c = classification(
    "code-fix-required",
    "semgrep finding",
    ["check:semgrep"],
  );
  const res = buildFeedbackNoChangesResponse(c);
  assertEquals(res.addNeedsHuman, false);
  assertNoHandBack(res.body);
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

// ---------------------------------------------------------------------------
// Issue #1876 — the trailer is shared with the verbatim path
// ---------------------------------------------------------------------------

Deno.test("formatClassifierTrailer - renders the reason and bulleted signals", () => {
  const trailer = formatClassifierTrailer(
    classification("timing", "timing failure: timed out", [
      "check:test",
      "text:timed out",
    ]),
  );
  assertEquals(trailer.startsWith("\n\n**Classifier reason:**"), true);
  assertStringIncludes(trailer, "timing failure: timed out");
  assertStringIncludes(trailer, "- `check:test`");
  assertStringIncludes(trailer, "- `text:timed out`");
});

Deno.test("formatClassifierTrailer - empty signals say so rather than rendering nothing", () => {
  const trailer = formatClassifierTrailer(
    classification("unknown", "no recognised pattern", []),
  );
  assertStringIncludes(trailer, "**Signals:**");
  assertStringIncludes(trailer, "_(no specific signals)_");
});

Deno.test("formatClassifierTrailer - more than six signals are truncated with a count", () => {
  const signals = Array.from({ length: 9 }, (_, i) => `text:signal-${i}`);
  const trailer = formatClassifierTrailer(
    classification("code-fix-required", "many signals", signals),
  );
  assertStringIncludes(trailer, "- `text:signal-5`");
  assertEquals(trailer.includes("text:signal-6"), false);
  assertStringIncludes(trailer, "_(+3 more)_");
});

Deno.test("formatClassifierTrailer - the stock body ends with exactly this trailer", () => {
  // The literal text, not `formatClassifierTrailer(c)` — an expectation
  // derived from the function under test would stay green even if the
  // trailer rendered nonsense.
  const expected =
    "\n\n**Classifier reason:** no recognised pattern\n**Signals:**\n- `check:x`";
  const c = classification("unknown", "no recognised pattern", ["check:x"]);
  assertEquals(formatClassifierTrailer(c), expected);
  assertEquals(
    buildCiNoChangesResponse("custom", c).body.endsWith(expected),
    true,
  );
});

Deno.test("buildCiNoChangesResponse - human-gate returns the code-fix-required response (Issues #2726, #4304)", () => {
  // This path classifies the agent's own output, so a gate line there must not
  // let the agent dodge the retry a code-fix failure gets.
  const signals = ["check:bootstrap-applied", "text:vibe-human-gate"];
  const gate: CiFailureClassification = {
    ...classification("human-gate", "shared reason", signals),
    humanStep: "apply infra/bootstrap.yaml",
  };
  const res = buildCiNoChangesResponse("bootstrap-applied", gate);
  const expected = buildCiNoChangesResponse(
    "bootstrap-applied",
    classification("code-fix-required", "shared reason", signals),
  );
  assertEquals(res, expected);
  assertEquals(res.category, "code-fix-required");
  // Issue #4304: and that response no longer hands the PR to a human.
  assertEquals(res.addNeedsHuman, false);
  assertNoHandBack(res.body);
});
