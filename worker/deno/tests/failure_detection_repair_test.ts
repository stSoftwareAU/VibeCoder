/**
 * Tests for failure_detection_repair.ts — the model-driven self-repair of
 * sub-issues missing a `## Failure Detection` section (Issue #3272).
 *
 * Covers: (a) an offender is repaired — the Claude draft is patched in and the
 * re-gate passes; (b) an un-repairable offender (draft still fails the gate)
 * stays in `stillOffending`; (c) a `gh issue edit` failure is caught and
 * reported, not thrown; plus body-construction and extraction helpers.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Result } from "../types.ts";
import {
  applyFailureDetectionSection,
  extractDraftedContent,
  type RepairClaudeResult,
  repairFailureDetectionSections,
} from "../lib/failure_detection_repair.ts";
import {
  type FailureDetectionOffender,
  validateFailureDetectionCriteria,
} from "../lib/failure_detection_gate.ts";

function silentLogger() {
  return { info() {}, warn() {} };
}

// A sub-issue body that is missing the `## Failure Detection` section entirely.
function bodyMissingSection(): string {
  return [
    "## Summary",
    "Add the widget.",
    "",
    "## Acceptance Criteria",
    "- [ ] It works",
    "",
    "## Dependencies",
    "None",
  ].join("\n");
}

// A body carrying an empty `## Failure Detection` section (an offender).
function bodyEmptySection(): string {
  return [
    "## Summary",
    "Add the widget.",
    "",
    "## Failure Detection",
    "",
    "## Dependencies",
    "None",
  ].join("\n");
}

function offender(number: number): FailureDetectionOffender {
  return {
    number,
    title: "Add the widget",
    reason: "missing `## Failure Detection` section",
  };
}

/** Build a gh command mock that serves a body on `view` and records `edit`s. */
function ghMock(bodies: Record<number, string>, opts?: {
  editThrows?: boolean;
}) {
  const edits: { number: number; body: string }[] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "view") {
      const number = Number(args[2]);
      const body = bodies[number] ?? "";
      return Promise.resolve(
        JSON.stringify({ number, title: "Add the widget", body }),
      );
    }
    if (args[0] === "issue" && args[1] === "edit") {
      if (opts?.editThrows) {
        return Promise.reject(new Error("gh edit failed: network"));
      }
      const number = Number(args[2]);
      const bodyIdx = args.indexOf("--body");
      const body = bodyIdx >= 0 ? args[bodyIdx + 1]! : "";
      edits.push({ number, body });
      // Reflect the edit so a subsequent view returns the new body.
      bodies[number] = body;
      return Promise.resolve("");
    }
    return Promise.resolve("");
  };
  return { ghCommandFn, edits };
}

/** A Claude runner returning fixed drafted output. */
function claudeReturning(
  output: string,
  extra?: Partial<RepairClaudeResult>,
): (prompt: string) => Promise<Result<RepairClaudeResult>> {
  return () =>
    Promise.resolve({
      ok: true,
      value: { output, timedOut: false, ...extra },
    });
}

// --- (a) an offender is repaired ---

Deno.test("repair - offender is repaired: draft is patched in and re-gate passes", async () => {
  const { ghCommandFn, edits } = ghMock({ 191: bodyMissingSection() });
  const draft =
    "## Failure Detection\n\nA new test `widget_test.ts` asserts the widget renders in CI.";

  const result = await repairFailureDetectionSections({
    repo: "o/r",
    offenders: [offender(191)],
    runClaude: claudeReturning(draft, {
      runStats: {
        servedModels: ["claude-fable-5-20250101"],
        effort: "high",
      } as RepairClaudeResult["runStats"],
    }),
    ghCommandFn,
    logger: silentLogger(),
  });

  assertEquals(result.repaired, [191]);
  assertEquals(result.stillOffending, []);
  // The Claude call was recorded so run stats observe a served model.
  assertEquals(result.invocations.length, 1);
  assertEquals(
    result.invocations[0]!.runStats?.servedModels,
    ["claude-fable-5-20250101"],
  );
  // The sub-issue was edited with a body that now passes the pure gate.
  assertEquals(edits.length, 1);
  assertEquals(edits[0]!.number, 191);
  assertStringIncludes(edits[0]!.body, "widget_test.ts");
  assertEquals(
    validateFailureDetectionCriteria([
      { number: 191, title: "Add the widget", body: edits[0]!.body },
    ]),
    [],
  );
});

Deno.test("repair - empty existing section is replaced, not duplicated", async () => {
  const { ghCommandFn, edits } = ghMock({ 200: bodyEmptySection() });
  const draft = "## Failure Detection\n\nN/A — docs-only change.";

  const result = await repairFailureDetectionSections({
    repo: "o/r",
    offenders: [offender(200)],
    runClaude: claudeReturning(draft),
    ghCommandFn,
    logger: silentLogger(),
  });

  assertEquals(result.repaired, [200]);
  // Exactly one `## Failure Detection` heading in the patched body.
  const headings = edits[0]!.body.match(/^##\s+Failure Detection/gim) ?? [];
  assertEquals(headings.length, 1);
  assertEquals(
    validateFailureDetectionCriteria([
      { number: 200, title: "Add the widget", body: edits[0]!.body },
    ]),
    [],
  );
});

// --- (b) an un-repairable offender stays in stillOffending ---

Deno.test("repair - un-repairable draft (still empty) stays in stillOffending, no edit", async () => {
  const { ghCommandFn, edits } = ghMock({ 300: bodyMissingSection() });
  // Claude returns only the heading with no criterion → gate still fails.
  const draft = "## Failure Detection\n\n";

  const result = await repairFailureDetectionSections({
    repo: "o/r",
    offenders: [offender(300)],
    runClaude: claudeReturning(draft),
    ghCommandFn,
    logger: silentLogger(),
  });

  assertEquals(result.repaired, []);
  assertEquals(result.stillOffending.map((o) => o.number), [300]);
  // The still-failing draft must not overwrite the sub-issue body.
  assertEquals(edits.length, 0);
  // The invocation is still recorded (the model was called).
  assertEquals(result.invocations.length, 1);
});

Deno.test("repair - Claude failure leaves offender un-repaired, no invocation recorded", async () => {
  const { ghCommandFn } = ghMock({ 310: bodyMissingSection() });
  const runClaude = () =>
    Promise.resolve({ ok: false as const, error: new Error("rate limited") });

  const result = await repairFailureDetectionSections({
    repo: "o/r",
    offenders: [offender(310)],
    runClaude,
    ghCommandFn,
    logger: silentLogger(),
  });

  assertEquals(result.repaired, []);
  assertEquals(result.stillOffending.map((o) => o.number), [310]);
  assertEquals(result.invocations.length, 0);
});

// --- (c) a gh edit failure is caught and reported, not thrown ---

Deno.test("repair - gh issue edit failure is caught, offender stays in stillOffending", async () => {
  const { ghCommandFn } = ghMock({ 400: bodyMissingSection() }, {
    editThrows: true,
  });
  const draft =
    "## Failure Detection\n\nA CI gate `quality.sh` blocks the regression.";

  // Must not throw.
  const result = await repairFailureDetectionSections({
    repo: "o/r",
    offenders: [offender(400)],
    runClaude: claudeReturning(draft),
    ghCommandFn,
    logger: silentLogger(),
  });

  assertEquals(result.repaired, []);
  assertEquals(result.stillOffending.map((o) => o.number), [400]);
  // The Claude call happened, so the invocation is recorded.
  assertEquals(result.invocations.length, 1);
});

Deno.test("repair - mixed batch: one repaired, one un-repairable", async () => {
  const { ghCommandFn, edits } = ghMock({
    500: bodyMissingSection(),
    501: bodyMissingSection(),
  });
  let call = 0;
  const runClaude = () => {
    call++;
    // First offender gets a real criterion; second gets an empty draft.
    const output = call === 1
      ? "## Failure Detection\n\nTest `a_test.ts` covers it."
      : "## Failure Detection\n\n[placeholder]";
    return Promise.resolve({
      ok: true as const,
      value: { output, timedOut: false },
    });
  };

  const result = await repairFailureDetectionSections({
    repo: "o/r",
    offenders: [offender(500), offender(501)],
    runClaude,
    ghCommandFn,
    logger: silentLogger(),
  });

  assertEquals(result.repaired, [500]);
  assertEquals(result.stillOffending.map((o) => o.number), [501]);
  assertEquals(edits.map((e) => e.number), [500]);
  assertEquals(result.invocations.length, 2);
});

// --- helper unit tests ---

Deno.test("extractDraftedContent - strips heading and returns criterion", () => {
  const content = extractDraftedContent(
    "## Failure Detection\n\nA new test `x_test.ts` asserts it.",
  );
  assertEquals(content, "A new test `x_test.ts` asserts it.");
});

Deno.test("extractDraftedContent - unwraps a code fence", () => {
  const content = extractDraftedContent(
    "```markdown\n## Failure Detection\n\nN/A — docs-only.\n```",
  );
  assertEquals(content, "N/A — docs-only.");
});

Deno.test("extractDraftedContent - no heading returns whole trimmed output", () => {
  const content = extractDraftedContent("  N/A — prompt-only change.  ");
  assertEquals(content, "N/A — prompt-only change.");
});

Deno.test("applyFailureDetectionSection - appends when no section present", () => {
  const out = applyFailureDetectionSection(
    bodyMissingSection(),
    "Test `y_test.ts` covers it.",
  );
  assert(out.includes("## Failure Detection"));
  assertEquals(
    validateFailureDetectionCriteria([{ number: 1, title: "t", body: out }]),
    [],
  );
});

Deno.test("applyFailureDetectionSection - replaces an existing empty section", () => {
  const out = applyFailureDetectionSection(
    bodyEmptySection(),
    "A CI gate detects it.",
  );
  const headings = out.match(/^##\s+Failure Detection/gim) ?? [];
  assertEquals(headings.length, 1);
  // The `## Dependencies` section after the original empty one is preserved.
  assertStringIncludes(out, "## Dependencies");
  assertStringIncludes(out, "A CI gate detects it.");
});
