/**
 * Tests for `lib/analysis_only.ts` — the pure detection helpers behind
 * the analysis-only / no-PR outcome (Issues #2849, #4298).
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import { hasAnalysisOnlyMarker } from "../lib/analysis_only.ts";

// -------------------------------------------------------------------------
// hasAnalysisOnlyMarker
// -------------------------------------------------------------------------

Deno.test("hasAnalysisOnlyMarker - detects canonical marker", () => {
  assert(hasAnalysisOnlyMarker("Some intro\n\n<!-- analysis-only -->\n\nrest"));
});

Deno.test("hasAnalysisOnlyMarker - detects no-pr alias", () => {
  assert(hasAnalysisOnlyMarker("<!-- no-pr -->"));
});

Deno.test("hasAnalysisOnlyMarker - case-insensitive and whitespace-tolerant", () => {
  assert(hasAnalysisOnlyMarker("<!--ANALYSIS-ONLY-->"));
  assert(hasAnalysisOnlyMarker("<!--   Analysis-Only   -->"));
});

Deno.test("hasAnalysisOnlyMarker - false for a normal body", () => {
  assertEquals(
    hasAnalysisOnlyMarker("Fix the login bug in src/auth/login.ts"),
    false,
  );
});

Deno.test("hasAnalysisOnlyMarker - false for empty body", () => {
  assertEquals(hasAnalysisOnlyMarker(""), false);
});

Deno.test("hasAnalysisOnlyMarker - prose mention does not trigger", () => {
  assertEquals(
    hasAnalysisOnlyMarker("This issue is analysis only, please advise."),
    false,
  );
});
