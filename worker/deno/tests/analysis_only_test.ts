/**
 * Tests for `lib/analysis_only.ts` — the pure detection helpers behind
 * the analysis-only / no-PR hand-off + loop guard (Issue #2849).
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  ANALYSIS_ONLY_HANDOFF_MARKER_PREFIX,
  buildAnalysisHandoffMarker,
  hasAnalysisOnlyMarker,
  hasPriorAnalysisHandoff,
} from "../lib/analysis_only.ts";
import type { GitHubComment } from "../types.ts";

function makeComment(body: string): GitHubComment {
  return {
    id: 1,
    body,
    author: "someone",
    createdAt: "2026-06-16T00:00:00Z",
    reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
  };
}

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

// -------------------------------------------------------------------------
// buildAnalysisHandoffMarker
// -------------------------------------------------------------------------

Deno.test("buildAnalysisHandoffMarker - embeds the issue number", () => {
  const marker = buildAnalysisHandoffMarker(2834);
  assert(marker.startsWith(ANALYSIS_ONLY_HANDOFF_MARKER_PREFIX));
  assert(marker.includes("2834"));
  assert(marker.endsWith("-->"));
});

// -------------------------------------------------------------------------
// hasPriorAnalysisHandoff (loop guard)
// -------------------------------------------------------------------------

Deno.test("hasPriorAnalysisHandoff - true when a prior hand-off comment exists", () => {
  const comments = [
    makeComment("just chatter"),
    makeComment(`## Analysis only\n\n${buildAnalysisHandoffMarker(42)}`),
  ];
  assert(hasPriorAnalysisHandoff(comments, 42));
});

Deno.test("hasPriorAnalysisHandoff - false when no hand-off comment exists", () => {
  const comments = [
    makeComment("nothing relevant"),
    makeComment("more chatter"),
  ];
  assertEquals(hasPriorAnalysisHandoff(comments, 42), false);
});

Deno.test("hasPriorAnalysisHandoff - marker for a different issue does not match", () => {
  const comments = [makeComment(buildAnalysisHandoffMarker(99))];
  assertEquals(hasPriorAnalysisHandoff(comments, 42), false);
});

Deno.test("hasPriorAnalysisHandoff - empty comment list is false", () => {
  assertEquals(hasPriorAnalysisHandoff([], 42), false);
});
