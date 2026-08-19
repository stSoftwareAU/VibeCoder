/**
 * Tests for failure_detection_gate.ts — the deterministic presence gate on
 * published planning sub-issues (Issue #3246).
 *
 * The gate converts a missing `## Failure Detection` criterion from a silent
 * prose-rule escape into a loud, labelled planning failure. These tests cover
 * the pass case, each fail case (missing heading, empty section,
 * placeholder-only body), and the `N/A — <reason>` escape.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildParentGateFailureComment,
  buildSubIssueGateComment,
  type FailureDetectionOffender,
  runFailureDetectionGate,
  type SubIssueForGate,
  validateFailureDetectionCriteria,
} from "../lib/failure_detection_gate.ts";

// The bracketed template placeholder copied verbatim from prompts/planning/v19.md.
const PLACEHOLDER =
  `[How a failure or regression in this work is detected, and where. Prefer the earliest detection point: an automated test or a CI quality gate. Use a post-release alert only where post-release is the only surface. A console log alone never qualifies — workers run unattended and browser consoles are unseen. If this sub-issue has no runtime failure surface (docs-only or prompt-only), write "N/A — <one-line reason>".]`;

function body(failureDetection: string): string {
  return [
    "## Summary",
    "Do a thing.",
    "",
    "## Acceptance Criteria",
    "- [ ] It works",
    "",
    "## Failure Detection",
    failureDetection,
    "",
    "## Dependencies",
    "None",
    "",
    "## Context",
    "Part of #1",
  ].join("\n");
}

// --- validateFailureDetectionCriteria: pass cases ---

Deno.test("failure_detection_gate - filled section passes", () => {
  const subs: SubIssueForGate[] = [
    {
      number: 10,
      title: "Add gate",
      body: body(
        "A new test `gate_test.ts` asserts in CI that the gate fires.",
      ),
    },
  ];
  assertEquals(validateFailureDetectionCriteria(subs), []);
});

Deno.test("failure_detection_gate - N/A escape passes", () => {
  const subs: SubIssueForGate[] = [
    {
      number: 11,
      title: "Docs only",
      body: body("N/A — docs-only change, no runtime failure surface."),
    },
  ];
  assertEquals(validateFailureDetectionCriteria(subs), []);
});

Deno.test("failure_detection_gate - bolded label variant passes", () => {
  const bodyWithBold = [
    "## Summary",
    "Prompt tweak.",
    "",
    "**Failure detection:** A new prompt test asserts the section is present.",
    "",
    "## Context",
    "Part of #1",
  ].join("\n");
  const subs: SubIssueForGate[] = [
    { number: 12, title: "Bold form", body: bodyWithBold },
  ];
  assertEquals(validateFailureDetectionCriteria(subs), []);
});

Deno.test("failure_detection_gate - case-insensitive heading passes", () => {
  const subs: SubIssueForGate[] = [
    {
      number: 13,
      title: "Lower case",
      body: "## failure detection\nA CI gate covers this.\n",
    },
  ];
  assertEquals(validateFailureDetectionCriteria(subs), []);
});

Deno.test("failure_detection_gate - multi-line filled section passes", () => {
  const subs: SubIssueForGate[] = [
    {
      number: 14,
      title: "Multi-line",
      body: body(
        "A regression is caught by:\n- unit test in foo_test.ts\n- CI lint gate",
      ),
    },
  ];
  assertEquals(validateFailureDetectionCriteria(subs), []);
});

// --- validateFailureDetectionCriteria: fail cases ---

Deno.test("failure_detection_gate - missing heading is an offender", () => {
  const noSection = [
    "## Summary",
    "Do a thing.",
    "",
    "## Acceptance Criteria",
    "- [ ] It works",
    "",
    "## Context",
    "Part of #1",
  ].join("\n");
  const offenders = validateFailureDetectionCriteria([
    { number: 20, title: "No section", body: noSection },
  ]);
  assertEquals(offenders.length, 1);
  assertEquals(offenders[0]!.number, 20);
  assertStringIncludes(offenders[0]!.reason.toLowerCase(), "missing");
});

Deno.test("failure_detection_gate - empty section is an offender", () => {
  const offenders = validateFailureDetectionCriteria([
    { number: 21, title: "Empty", body: body("   ") },
  ]);
  assertEquals(offenders.length, 1);
  assertEquals(offenders[0]!.number, 21);
  assertStringIncludes(offenders[0]!.reason.toLowerCase(), "empty");
});

Deno.test("failure_detection_gate - placeholder-only body is an offender", () => {
  const offenders = validateFailureDetectionCriteria([
    { number: 22, title: "Placeholder", body: body(PLACEHOLDER) },
  ]);
  assertEquals(offenders.length, 1);
  assertEquals(offenders[0]!.number, 22);
  assertStringIncludes(offenders[0]!.reason.toLowerCase(), "placeholder");
});

Deno.test("failure_detection_gate - heading at end of body with no content is an offender", () => {
  const offenders = validateFailureDetectionCriteria([
    {
      number: 23,
      title: "Trailing heading",
      body: "## Summary\nx\n\n## Failure Detection",
    },
  ]);
  assertEquals(offenders.length, 1);
  assertStringIncludes(offenders[0]!.reason.toLowerCase(), "empty");
});

Deno.test("failure_detection_gate - reports every offender and skips the compliant one", () => {
  const subs: SubIssueForGate[] = [
    { number: 30, title: "Good", body: body("A CI gate covers this.") },
    { number: 31, title: "Placeholder", body: body(PLACEHOLDER) },
    { number: 32, title: "Missing", body: "## Summary\nx" },
  ];
  const offenders = validateFailureDetectionCriteria(subs);
  assertEquals(offenders.map((o) => o.number), [31, 32]);
});

Deno.test("failure_detection_gate - empty input yields no offenders", () => {
  assertEquals(validateFailureDetectionCriteria([]), []);
});

// --- runFailureDetectionGate: fetch + validate orchestration ---

Deno.test("runFailureDetectionGate - fetches bodies and returns offenders", async () => {
  const bodies: Record<number, { title: string; body: string }> = {
    40: { title: "Good", body: body("A CI gate covers this.") },
    41: { title: "Bad", body: body(PLACEHOLDER) },
  };
  const ghCommandFn = (args: string[]): Promise<string> => {
    // gh issue view <n> --repo <repo> --json number,title,body
    const n = Number(args[2]);
    const rec = bodies[n]!;
    return Promise.resolve(
      JSON.stringify({ number: n, title: rec.title, body: rec.body }),
    );
  };
  const offenders = await runFailureDetectionGate({
    repo: "o/r",
    subIssueNumbers: [40, 41],
    ghCommandFn,
    logger: silentLogger(),
  });
  assertEquals(offenders.map((o) => o.number), [41]);
});

Deno.test("runFailureDetectionGate - unreadable sub-issue is skipped, not failed", async () => {
  const ghCommandFn = (_args: string[]): Promise<string> => {
    return Promise.reject(new Error("network"));
  };
  const offenders = await runFailureDetectionGate({
    repo: "o/r",
    subIssueNumbers: [50],
    ghCommandFn,
    logger: silentLogger(),
  });
  // Cannot read the body → cannot assert a missing criterion → no offender.
  assertEquals(offenders, []);
});

Deno.test("runFailureDetectionGate - empty number list makes no gh calls", async () => {
  let calls = 0;
  const ghCommandFn = (_args: string[]): Promise<string> => {
    calls++;
    return Promise.resolve("[]");
  };
  const offenders = await runFailureDetectionGate({
    repo: "o/r",
    subIssueNumbers: [],
    ghCommandFn,
    logger: silentLogger(),
  });
  assertEquals(offenders, []);
  assertEquals(calls, 0);
});

// --- Comment builders ---

Deno.test("buildParentGateFailureComment - names every offending sub-issue", () => {
  const offenders: FailureDetectionOffender[] = [
    {
      number: 61,
      title: "One",
      reason: "missing `## Failure Detection` section",
    },
    {
      number: 62,
      title: "Two",
      reason: "empty `## Failure Detection` section",
    },
  ];
  const comment = buildParentGateFailureComment(offenders);
  assertStringIncludes(comment, "#61");
  assertStringIncludes(comment, "#62");
  assertStringIncludes(comment, "Failure Detection");
});

Deno.test("buildSubIssueGateComment - states the missing criterion", () => {
  const comment = buildSubIssueGateComment({
    number: 70,
    title: "X",
    reason: "empty `## Failure Detection` section",
  });
  assertStringIncludes(comment, "Failure Detection");
});

function silentLogger() {
  return {
    info() {},
    warn() {},
  };
}
