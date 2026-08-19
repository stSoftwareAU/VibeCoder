/**
 * Tests for planning_run_aggregation.ts — one-off vs systemic aggregation of
 * observed planning-run model stats (Issue #2705).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  formatPlanningRunSummary,
  parsePlanningStatsComment,
  type PlanningRunObservation,
  summarisePlanningRuns,
} from "../lib/planning_run_aggregation.ts";

// ---------------------------------------------------------------------------
// Fixtures — real comment bodies observed on FLEET#2569 / VibeCoder#2720.
// ---------------------------------------------------------------------------

const DEGRADED_COMMENT = `## Planning Complete

Planning complete. **5 sub-issue(s)** created.

---
## Planning run model stats

- **Requested model:** \`fable\`
- **Served model(s):** \`claude-opus-4-8\`
- **Effort:** \`max\`
- **Planning invocations:** 3
- **Tokens:** input 2,744 · output 39,806 · cache write 89,342 · cache read 1,586,672
- **Turns:** 31
- **Duration:** 9m 2s
- **Degraded:** ⚠️ yes — served model \`claude-opus-4-8\` does not match expected \`fable\``;

const HEALTHY_COMMENT = `## Planning run model stats

- **Requested model:** \`fable\`
- **Served model(s):** \`claude-fable-5-20250101\`
- **Planning invocations:** 1
- **Degraded:** no`;

// ---------------------------------------------------------------------------
// parsePlanningStatsComment
// ---------------------------------------------------------------------------

Deno.test("parsePlanningStatsComment - parses a degraded fable→opus comment", () => {
  const parsed = parsePlanningStatsComment(DEGRADED_COMMENT);
  assert(parsed !== null);
  assertEquals(parsed!.requestedModel, "fable");
  assertEquals(parsed!.servedModels, ["claude-opus-4-8"]);
  assertEquals(parsed!.degraded, true);
});

Deno.test("parsePlanningStatsComment - parses a healthy (served fable) comment", () => {
  const parsed = parsePlanningStatsComment(HEALTHY_COMMENT);
  assert(parsed !== null);
  assertEquals(parsed!.requestedModel, "fable");
  assertEquals(parsed!.servedModels, ["claude-fable-5-20250101"]);
  assertEquals(parsed!.degraded, false);
});

Deno.test("parsePlanningStatsComment - splits multiple served models", () => {
  const body = `## Planning run model stats

- **Requested model:** \`fable\`
- **Served model(s):** \`claude-fable-5\`, \`claude-opus-4-8\`
- **Degraded:** ⚠️ yes — mixed`;
  const parsed = parsePlanningStatsComment(body);
  assert(parsed !== null);
  assertEquals(parsed!.servedModels, ["claude-fable-5", "claude-opus-4-8"]);
});

Deno.test("parsePlanningStatsComment - handles _none reported_ served line", () => {
  const body = `## Planning run model stats

- **Requested model:** \`fable\`
- **Served model(s):** _none reported_
- **Degraded:** no`;
  const parsed = parsePlanningStatsComment(body);
  assert(parsed !== null);
  assertEquals(parsed!.servedModels, []);
});

Deno.test("parsePlanningStatsComment - returns null when no stats block present", () => {
  assertEquals(
    parsePlanningStatsComment("## Planning Complete\n\nNo stats."),
    null,
  );
  assertEquals(parsePlanningStatsComment(""), null);
});

// ---------------------------------------------------------------------------
// summarisePlanningRuns — verdict logic
// ---------------------------------------------------------------------------

function obs(
  requestedModel: string,
  servedModels: string[],
  extra?: Partial<PlanningRunObservation>,
): PlanningRunObservation {
  return { requestedModel, servedModels, degraded: false, ...extra };
}

Deno.test("summarisePlanningRuns - none when no fable runs", () => {
  const summary = summarisePlanningRuns([
    obs("opus", ["claude-opus-4-8"]),
  ]);
  assertEquals(summary.verdict, "none");
  assertEquals(summary.fableRequested, 0);
});

Deno.test("summarisePlanningRuns - none when all fable runs served fable", () => {
  const summary = summarisePlanningRuns([
    obs("fable", ["claude-fable-5-20250101"]),
    obs("fable", ["claude-fable-5-20250101"]),
  ]);
  assertEquals(summary.verdict, "none");
  assertEquals(summary.fableServed, 2);
  assertEquals(summary.mismatched, 0);
});

Deno.test("summarisePlanningRuns - inconclusive on a single mismatch", () => {
  const summary = summarisePlanningRuns([
    obs("fable", ["claude-opus-4-8"], {
      degraded: true,
      repo: "stSoftwareAU/private-repo-1",
    }),
  ]);
  assertEquals(summary.verdict, "inconclusive");
  assertEquals(summary.mismatched, 1);
});

Deno.test("summarisePlanningRuns - systemic when fable runs consistently served opus", () => {
  const summary = summarisePlanningRuns([
    obs("fable", ["claude-opus-4-8"], {
      degraded: true,
      repo: "stSoftwareAU/private-repo-1",
      issue: 2569,
    }),
    obs("fable", ["claude-opus-4-8"], {
      degraded: true,
      repo: "stSoftwareAU/private-repo-1",
      issue: 2569,
    }),
    obs("fable", ["claude-opus-4-8"], {
      degraded: true,
      repo: "stSoftwareAU/VibeCoder",
      issue: 2720,
    }),
  ]);
  assertEquals(summary.verdict, "systemic");
  assertEquals(summary.fableRequested, 3);
  assertEquals(summary.mismatched, 3);
  assertEquals(summary.fableServed, 0);
  assertEquals(summary.byServedFamily["opus"], 3);
  assertEquals(summary.repos, [
    "stSoftwareAU/private-repo-1",
    "stSoftwareAU/VibeCoder",
  ]);
});

Deno.test("summarisePlanningRuns - one-off when mismatch is isolated", () => {
  // 1 mismatch out of 5 → 20%, below the systemic threshold but >1 so not
  // inconclusive.
  const summary = summarisePlanningRuns([
    obs("fable", ["claude-fable-5"]),
    obs("fable", ["claude-fable-5"]),
    obs("fable", ["claude-opus-4-8"], { degraded: true }),
    obs("fable", ["claude-fable-5"]),
    obs("fable", ["claude-opus-4-8"], { degraded: true }),
  ]);
  // 2 of 5 = 40% < 80% → one-off.
  assertEquals(summary.verdict, "one-off");
  assertEquals(summary.mismatched, 2);
});

Deno.test("summarisePlanningRuns - served-fable run with full id matches via family", () => {
  const summary = summarisePlanningRuns([
    obs("fable", ["claude-fable-5-20250101"]),
  ]);
  // Served fable → not a mismatch → none.
  assertEquals(summary.verdict, "none");
  assertEquals(summary.mismatched, 0);
});

// ---------------------------------------------------------------------------
// formatPlanningRunSummary
// ---------------------------------------------------------------------------

Deno.test("formatPlanningRunSummary - renders verdict, counts and repos", () => {
  const summary = summarisePlanningRuns([
    obs("fable", ["claude-opus-4-8"], {
      degraded: true,
      repo: "stSoftwareAU/private-repo-1",
    }),
    obs("fable", ["claude-opus-4-8"], {
      degraded: true,
      repo: "stSoftwareAU/private-repo-1",
    }),
    obs("fable", ["claude-opus-4-8"], {
      degraded: true,
      repo: "stSoftwareAU/VibeCoder",
    }),
  ]);
  const md = formatPlanningRunSummary(summary);
  assertStringIncludes(md, "## Planning-run mismatch aggregate");
  assertStringIncludes(md, "**Verdict:** systemic");
  assertStringIncludes(md, "`opus` ×3");
  assertStringIncludes(md, "stSoftwareAU/private-repo-1");
  assertStringIncludes(md, "stSoftwareAU/VibeCoder");
});

// ---------------------------------------------------------------------------
// End-to-end — parse observed comments then aggregate.
// ---------------------------------------------------------------------------

Deno.test("parse + summarise - the three observed runs conclude systemic", () => {
  const bodies = [DEGRADED_COMMENT, DEGRADED_COMMENT, DEGRADED_COMMENT];
  const repos = [
    "stSoftwareAU/private-repo-1",
    "stSoftwareAU/private-repo-1",
    "stSoftwareAU/VibeCoder",
  ];
  const observations: PlanningRunObservation[] = bodies.map((b, i) => {
    const parsed = parsePlanningStatsComment(b)!;
    return { ...parsed, repo: repos[i] };
  });
  const summary = summarisePlanningRuns(observations);
  assertEquals(summary.verdict, "systemic");
  assertEquals(summary.mismatched, 3);
});
