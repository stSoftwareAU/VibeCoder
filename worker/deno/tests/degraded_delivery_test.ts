/**
 * Tests for degraded_delivery.ts — the verdict that stops a degraded
 * (fallback-model) implementation run from reading as complete delivery
 * (Issue #2562).
 *
 * On #2543 the implementation run asked for `opus`, was served Haiku after a
 * rate-limit fallback, shipped the pricing rows only, and closed the issue.
 * These tests pin the pure half of the guard: which scope an issue states
 * (including a grill-me `### Accepted scope so far` list, which the
 * acceptance-criteria gate does not read), and which of it a degraded run
 * failed to show as `met`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { extractAcceptedScope } from "../lib/acceptance_criteria_gate.ts";
import {
  assessDegradedDelivery,
  buildDegradedFollowUpIssue,
  buildDegradedPrSection,
  degradedFollowUpFindingId,
  fileDegradedFollowUp,
} from "../lib/degraded_delivery.ts";

const ISSUE_WITH_CRITERIA = `## Problem

Two things are wrong.

## Acceptance Criteria

- [ ] The router sends planning to opus.
- [ ] The docs table lists opus for planning.
- [ ] The release floor is 1.9.0.
`;

/** A grill-me issue body, shaped like #2543 and #2560. */
const GRILL_ME_ISSUE = `<!-- GRILL-ME-UNDERSTANDING-START -->
## Current Understanding

Finish the switch.

### Accepted scope so far

- Route the eight planning phases to \`opus\`. Observable: config resolves opus.
- Raise the Claude Code pin. Observable: \`claude --version\` prints it.
- Bump the release floor to 1.9.0.

### Open questions

None.

### Assumptions

- This is not a scope item.
`;

const ISSUE_WITHOUT_SCOPE = `## Problem

The parser mishandles a leap year.
`;

/** One met, one missing, one partial — in criterion order. */
const SUMMARY_PARTIAL = `## Summary

Did some of it.

## Acceptance Criteria

- **met** — the router sends planning to opus — evidence: \`lib/config_defaults.ts\` — reviewer: met
- **missing** — the docs table lists opus — reviewer: missing — reason: ran out of turns
- **partial** — the release floor — evidence: \`.release-floor\` — reviewer: partial — reason: notes not written
`;

const SUMMARY_ALL_MET = `## Summary

Did all of it.

## Acceptance Criteria

- **met** — the router — evidence: \`lib/config_defaults.ts\` — reviewer: met
- **met** — the docs — evidence: \`docs/MODEL-AND-CACHING.md\` — reviewer: met
- **met** — the floor — evidence: \`.release-floor\` — reviewer: met
`;

const MINIMAL_BODY = `## Summary\n\nCloses #2543.\n\n`;

const HAIKU_FALLBACK = [{ fallbackModel: "haiku" }];

// ---------------------------------------------------------------------------
// extractAcceptedScope
// ---------------------------------------------------------------------------

Deno.test("extractAcceptedScope - acceptance criteria are the scope when stated", () => {
  assertEquals(extractAcceptedScope(ISSUE_WITH_CRITERIA), [
    "The router sends planning to opus.",
    "The docs table lists opus for planning.",
    "The release floor is 1.9.0.",
  ]);
});

Deno.test("extractAcceptedScope - reads a grill-me 'Accepted scope so far' list and nothing after it", () => {
  const scope = extractAcceptedScope(GRILL_ME_ISSUE);
  assertEquals(scope.length, 3);
  assertStringIncludes(scope[0]!, "Route the eight planning phases");
  assertStringIncludes(scope[2]!, "Bump the release floor");
  assert(!scope.some((s) => s.includes("not a scope item")));
});

Deno.test("extractAcceptedScope - an issue stating neither yields no scope", () => {
  assertEquals(extractAcceptedScope(ISSUE_WITHOUT_SCOPE), []);
});

// ---------------------------------------------------------------------------
// assessDegradedDelivery
// ---------------------------------------------------------------------------

Deno.test("assessDegradedDelivery - a healthy run is never flagged, whatever the summary says", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: [{}],
    issueBody: ISSUE_WITH_CRITERIA,
    prBody: SUMMARY_PARTIAL,
  });
  assertEquals(verdict.degraded, false);
  assertEquals(verdict.shortfalls, []);
});

Deno.test("assessDegradedDelivery - a degraded run names each criterion short of met", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: ISSUE_WITH_CRITERIA,
    prBody: SUMMARY_PARTIAL,
  });
  assertEquals(verdict.degraded, true);
  assertStringIncludes(verdict.reason ?? "", "haiku");
  assertEquals(verdict.delivered, ["The router sends planning to opus."]);
  assertEquals(verdict.shortfalls, [
    { criterion: "The docs table lists opus for planning.", status: "missing" },
    { criterion: "The release floor is 1.9.0.", status: "partial" },
  ]);
});

Deno.test("assessDegradedDelivery - a degraded run that met every criterion has no shortfall", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: ISSUE_WITH_CRITERIA,
    prBody: SUMMARY_ALL_MET,
  });
  assertEquals(verdict.degraded, true);
  assertEquals(verdict.shortfalls, []);
  assertEquals(verdict.delivered.length, 3);
});

Deno.test("assessDegradedDelivery - #2543: a degraded run with no summary leaves every scope item unassessed", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: GRILL_ME_ISSUE,
    prBody: MINIMAL_BODY,
  });
  assertEquals(verdict.degraded, true);
  assertEquals(verdict.delivered, []);
  assertEquals(verdict.shortfalls.length, 3);
  assert(verdict.shortfalls.every((s) => s.status === "unassessed"));
});

Deno.test("assessDegradedDelivery - a pre-flight reroute counts as degraded", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: [{
      preflightDegraded: true,
      preflightDegradedReason: "pre-flight Fable reroute",
    }],
    issueBody: ISSUE_WITH_CRITERIA,
    prBody: MINIMAL_BODY,
  });
  assertEquals(verdict.degraded, true);
  assertEquals(verdict.shortfalls.length, 3);
});

Deno.test("assessDegradedDelivery - a degraded run on an issue with no stated scope still names the issue as unverified", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: ISSUE_WITHOUT_SCOPE,
    prBody: MINIMAL_BODY,
  });
  assertEquals(verdict.shortfalls.length, 1);
  assertEquals(verdict.shortfalls[0]!.status, "unassessed");
  assertStringIncludes(verdict.shortfalls[0]!.criterion, "no acceptance");
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

Deno.test("buildDegradedFollowUpIssue - names every shortfall, the parent and the dedup marker", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: ISSUE_WITH_CRITERIA,
    prBody: SUMMARY_PARTIAL,
  });
  const issue = buildDegradedFollowUpIssue({
    parentNumber: 42,
    parentTitle: "Finish the switch",
    verdict,
    runId: "vibe-test-1",
  });
  assertStringIncludes(issue.title, "#42");
  assertStringIncludes(issue.title, "Finish the switch");
  assertStringIncludes(
    issue.body,
    `<!-- finding-id: ${degradedFollowUpFindingId(42)} -->`,
  );
  assertStringIncludes(issue.body, "The docs table lists opus for planning.");
  assertStringIncludes(issue.body, "The release floor is 1.9.0.");
  assertStringIncludes(issue.body, "haiku");
  assertStringIncludes(issue.body, "vibe-test-1");
  // The follow-up must never close its parent, nor be closed by a PR naming it.
  assert(!/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#42\b/i.test(issue.body));
  // What was delivered is stated too, so the next run does not redo it.
  assertStringIncludes(issue.body, "The router sends planning to opus.");
});

Deno.test("buildDegradedPrSection - says the delivery was partial and points at the follow-up", () => {
  const verdict = assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: ISSUE_WITH_CRITERIA,
    prBody: SUMMARY_PARTIAL,
  });
  const section = buildDegradedPrSection(verdict, 77);
  assertStringIncludes(section, "Degraded run");
  assertStringIncludes(section, "#77");
  assertStringIncludes(section, "The docs table lists opus for planning.");
  assertStringIncludes(section, "missing");
  // It must not itself close the follow-up.
  assert(!/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#77\b/i.test(section));
});

// ---------------------------------------------------------------------------
// fileDegradedFollowUp
// ---------------------------------------------------------------------------

const FLEET = { fleetAuthors: ["vibe-bot"] };

function degradedVerdict() {
  return assessDegradedDelivery({
    claudeResults: HAIKU_FALLBACK,
    issueBody: ISSUE_WITH_CRITERIA,
    prBody: SUMMARY_PARTIAL,
  });
}

Deno.test("fileDegradedFollowUp - files one idle-task issue when none is open", async () => {
  const calls: string[][] = [];
  const result = await fileDegradedFollowUp({
    repo: "o/r",
    parentNumber: 42,
    parentTitle: "Finish the switch",
    verdict: degradedVerdict(),
    runId: "vibe-test-1",
    dedupAuthors: FLEET,
    gh: (args) => {
      calls.push(args);
      if (args[1] === "list") return Promise.resolve("[]");
      return Promise.resolve("https://github.com/o/r/issues/77\n");
    },
  });
  assertEquals(result, { ok: true, value: { number: 77, reused: false } });
  const create = calls.find((c) => c[0] === "issue" && c[1] === "create")!;
  assert(create, "gh issue create must run");
  assertEquals(create[create.indexOf("--label") + 1], "idle-task");
});

Deno.test("fileDegradedFollowUp - reuses the open follow-up for the same parent", async () => {
  const calls: string[][] = [];
  const existing = JSON.stringify([{
    number: 70,
    body: `<!-- finding-id: ${degradedFollowUpFindingId(42)} -->`,
    author: { login: "vibe-bot" },
  }]);
  const result = await fileDegradedFollowUp({
    repo: "o/r",
    parentNumber: 42,
    parentTitle: "Finish the switch",
    verdict: degradedVerdict(),
    runId: "vibe-test-2",
    dedupAuthors: FLEET,
    gh: (args) => {
      calls.push(args);
      return Promise.resolve(existing);
    },
  });
  assertEquals(result, { ok: true, value: { number: 70, reused: true } });
  assert(!calls.some((c) => c[1] === "create"), "must not file a second one");
});

Deno.test("fileDegradedFollowUp - a failed create is an error, not a silent pass", async () => {
  const result = await fileDegradedFollowUp({
    repo: "o/r",
    parentNumber: 42,
    parentTitle: "Finish the switch",
    verdict: degradedVerdict(),
    runId: "vibe-test-3",
    dedupAuthors: FLEET,
    gh: (args) =>
      args[1] === "list"
        ? Promise.resolve("[]")
        : Promise.reject(new Error("HTTP 502")),
  });
  assertEquals(result.ok, false);
});
