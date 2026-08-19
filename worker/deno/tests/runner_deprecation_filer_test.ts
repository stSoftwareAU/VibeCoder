/**
 * Tests for the pure helpers in
 * `worker/deno/lib/runner_deprecation_filer.ts` (Issue #3035, coverage
 * gap from the test-audit scan — anti-pattern 7).
 *
 * These are WHAT-tests: they drive `classifyRunnerDeprecationSeverity`,
 * `buildRunnerWhyItMatters`, and `buildRunnerSuggestedFix` directly on
 * representative `DeprecationFinding` inputs and assert on observable
 * output (the severity bucket and the env-file migration advice the spec
 * requires), not on implementation internals. They survive a refactor of
 * the classifier or the catalogue lookup.
 *
 * Australian English throughout (behaviour, organisation, recognised).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildRunnerSuggestedFix,
  buildRunnerWhyItMatters,
  classifyRunnerDeprecationSeverity,
} from "../lib/runner_deprecation_filer.ts";
import type { DeprecationFinding } from "../lib/runner_deprecation_scanner.ts";

/** Build a `DeprecationFinding` with sensible defaults, overridable per case. */
function makeFinding(
  overrides: Partial<DeprecationFinding> = {},
): DeprecationFinding {
  return {
    stableId: "BP-RUNNER-actions-checkout-node20",
    action: "actions/checkout",
    pinnedRef: "v3",
    reason: "node20",
    runUrl: "https://github.com/owner/repo/actions/runs/123",
    evidence: "Node.js 20 actions are deprecated.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyRunnerDeprecationSeverity
// ---------------------------------------------------------------------------

Deno.test("classifyRunnerDeprecationSeverity - set-output is low", () => {
  assertEquals(
    classifyRunnerDeprecationSeverity(makeFinding({ reason: "set-output" })),
    "low",
  );
});

Deno.test("classifyRunnerDeprecationSeverity - save-state is low", () => {
  assertEquals(
    classifyRunnerDeprecationSeverity(makeFinding({ reason: "save-state" })),
    "low",
  );
});

Deno.test("classifyRunnerDeprecationSeverity - EOL Node major is high", () => {
  // Node 16 is in EOL_RUNTIMES.eolVersions.
  assertEquals(
    classifyRunnerDeprecationSeverity(makeFinding({ reason: "node16" })),
    "high",
  );
});

Deno.test("classifyRunnerDeprecationSeverity - soon-EOL Node major is high", () => {
  // Node 20 is in EOL_RUNTIMES.eolSoonVersions.
  assertEquals(
    classifyRunnerDeprecationSeverity(makeFinding({ reason: "node20" })),
    "high",
  );
});

Deno.test("classifyRunnerDeprecationSeverity - unknown Node major is medium", () => {
  assertEquals(
    classifyRunnerDeprecationSeverity(makeFinding({ reason: "node99" })),
    "medium",
  );
});

Deno.test("classifyRunnerDeprecationSeverity - unrecognised reason is medium", () => {
  assertEquals(
    classifyRunnerDeprecationSeverity(
      makeFinding({ reason: "something-else" }),
    ),
    "medium",
  );
});

// ---------------------------------------------------------------------------
// buildRunnerWhyItMatters
// ---------------------------------------------------------------------------

Deno.test("buildRunnerWhyItMatters - save-state cites $GITHUB_STATE", () => {
  const text = buildRunnerWhyItMatters(makeFinding({ reason: "save-state" }));
  assertStringIncludes(text, "$GITHUB_STATE");
  assertStringIncludes(text, "save-state");
});

Deno.test("buildRunnerWhyItMatters - set-output cites the env files", () => {
  const text = buildRunnerWhyItMatters(makeFinding({ reason: "set-output" }));
  assertStringIncludes(text, "$GITHUB_OUTPUT");
  assertStringIncludes(text, "set-output");
});

Deno.test("buildRunnerWhyItMatters - Node finding cites the version and action", () => {
  const text = buildRunnerWhyItMatters(
    makeFinding({
      reason: "node20",
      action: "actions/checkout",
      pinnedRef: "v3",
    }),
  );
  assertStringIncludes(text, "Node.js 20");
  assertStringIncludes(text, "actions/checkout@v3");
});

Deno.test("buildRunnerWhyItMatters - unrecognised reason names the reason and action", () => {
  const text = buildRunnerWhyItMatters(
    makeFinding({ reason: "mystery", action: "foo/bar", pinnedRef: "v1" }),
  );
  assertStringIncludes(text, "mystery");
  assertStringIncludes(text, "foo/bar@v1");
});

// ---------------------------------------------------------------------------
// buildRunnerSuggestedFix
// ---------------------------------------------------------------------------

Deno.test("buildRunnerSuggestedFix - set-output advises $GITHUB_OUTPUT", () => {
  const text = buildRunnerSuggestedFix(makeFinding({ reason: "set-output" }));
  assertStringIncludes(text, "$GITHUB_OUTPUT");
});

Deno.test("buildRunnerSuggestedFix - save-state advises $GITHUB_STATE", () => {
  const text = buildRunnerSuggestedFix(makeFinding({ reason: "save-state" }));
  assertStringIncludes(text, "$GITHUB_STATE");
});

Deno.test("buildRunnerSuggestedFix - Node finding advises a major bump", () => {
  const text = buildRunnerSuggestedFix(
    makeFinding({ reason: "node20", action: "actions/checkout" }),
  );
  assertStringIncludes(text, "actions/checkout");
  assertStringIncludes(text, "current major");
});

Deno.test("buildRunnerSuggestedFix - unrecognised reason advises a major bump or migration", () => {
  const text = buildRunnerSuggestedFix(
    makeFinding({ reason: "mystery", action: "foo/bar" }),
  );
  assertStringIncludes(text, "foo/bar");
  assertStringIncludes(text, "migrate away");
});
