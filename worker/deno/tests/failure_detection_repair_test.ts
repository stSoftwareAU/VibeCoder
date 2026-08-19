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
  buildBatchRepairPrompt,
  extractDraftedContent,
  parseBatchRepairOutput,
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

// Business-logic change (Issue #57): the repair now drafts every offender in a
// single batched Claude call, so this mixed-outcome case is expressed as one
// batched output carrying a good block and a placeholder block rather than two
// sequential per-offender calls.
Deno.test("repair - mixed batch: one repaired, one un-repairable", async () => {
  const { ghCommandFn, edits } = ghMock({
    500: bodyMissingSection(),
    501: bodyMissingSection(),
  });
  let calls = 0;
  const runClaude = () => {
    calls++;
    return Promise.resolve({
      ok: true as const,
      value: {
        output: [
          batchBlock(500, "Test `a_test.ts` covers it."),
          batchBlock(501, "[placeholder]"),
        ].join("\n"),
        timedOut: false,
      },
    });
  };

  const result = await repairFailureDetectionSections({
    repo: "o/r",
    offenders: [offender(500), offender(501)],
    runClaude,
    ghCommandFn,
    logger: silentLogger(),
  });

  assertEquals(calls, 1);
  assertEquals(result.repaired, [500]);
  assertEquals(result.stillOffending.map((o) => o.number), [501]);
  assertEquals(edits.map((e) => e.number), [500]);
  assertEquals(result.invocations.length, 1);
});

// --- (d) batched drafting: one Claude call for N offenders (Issue #57) ---

/** Render one batched-output block in the format the prompt asks Claude for. */
function batchBlock(number: number, criterion: string): string {
  return [
    `<<<SUB_ISSUE_${number}>>>`,
    "## Failure Detection",
    "",
    criterion,
    `<<<END_SUB_ISSUE_${number}>>>`,
  ].join("\n");
}

Deno.test("repair - eight offenders are drafted in a single Claude call", async () => {
  const numbers = [601, 602, 603, 604, 605, 606, 607, 608];
  const bodies: Record<number, string> = {};
  for (const n of numbers) bodies[n] = bodyMissingSection();
  const { ghCommandFn, edits } = ghMock(bodies);

  let calls = 0;
  const prompts: string[] = [];
  const runClaude = (prompt: string) => {
    calls++;
    prompts.push(prompt);
    return Promise.resolve({
      ok: true as const,
      value: {
        output: numbers
          .map((n) => batchBlock(n, `Test \`sub_${n}_test.ts\` covers it.`))
          .join("\n\n"),
        timedOut: false,
      },
    });
  };

  const result = await repairFailureDetectionSections({
    repo: "o/r",
    offenders: numbers.map(offender),
    runClaude,
    ghCommandFn,
    logger: silentLogger(),
  });

  // One invocation for eight offenders — the O(N) tail is gone.
  assertEquals(calls, 1);
  assertEquals(result.invocations.length, 1);
  assertEquals(result.repaired, numbers);
  assertEquals(result.stillOffending, []);
  assertEquals(edits.map((e) => e.number), numbers);
  // Each sub-issue got its own drafted criterion, not another's.
  for (const edit of edits) {
    assertStringIncludes(edit.body, `sub_${edit.number}_test.ts`);
    assertEquals(
      validateFailureDetectionCriteria([
        { number: edit.number, title: "Add the widget", body: edit.body },
      ]),
      [],
    );
  }
  // Every sub-issue appears in the one prompt.
  for (const n of numbers) {
    assertStringIncludes(prompts[0]!, `Sub-issue #${n}:`);
  }
});

Deno.test("repair - offender absent from the batched output stays in stillOffending", async () => {
  const { ghCommandFn, edits } = ghMock({
    701: bodyMissingSection(),
    702: bodyMissingSection(),
    703: bodyMissingSection(),
  });
  let calls = 0;
  const runClaude = () => {
    calls++;
    return Promise.resolve({
      ok: true as const,
      value: {
        output: [
          batchBlock(701, "Test `a_test.ts` covers it."),
          batchBlock(703, "Test `c_test.ts` covers it."),
        ].join("\n\n"),
        timedOut: false,
      },
    });
  };

  const result = await repairFailureDetectionSections({
    repo: "o/r",
    offenders: [offender(701), offender(702), offender(703)],
    runClaude,
    ghCommandFn,
    logger: silentLogger(),
  });

  assertEquals(calls, 1);
  assertEquals(result.repaired, [701, 703]);
  assertEquals(result.stillOffending.map((o) => o.number), [702]);
  assertEquals(edits.map((e) => e.number), [701, 703]);
});

Deno.test("repair - batched draft that fails the re-gate writes no body", async () => {
  const { ghCommandFn, edits } = ghMock({
    711: bodyMissingSection(),
    712: bodyMissingSection(),
  });
  const runClaude = () =>
    Promise.resolve({
      ok: true as const,
      value: {
        output: [
          batchBlock(711, "Test `a_test.ts` covers it."),
          // Bracketed placeholder — fails the pure gate.
          batchBlock(712, "[describe how a regression is detected]"),
        ].join("\n\n"),
        timedOut: false,
      },
    });

  const result = await repairFailureDetectionSections({
    repo: "o/r",
    offenders: [offender(711), offender(712)],
    runClaude,
    ghCommandFn,
    logger: silentLogger(),
  });

  assertEquals(result.repaired, [711]);
  assertEquals(result.stillOffending.map((o) => o.number), [712]);
  // The non-conforming draft must never be written.
  assertEquals(edits.map((e) => e.number), [711]);
});

Deno.test("repair - unparseable batched output falls back to the per-offender path", async () => {
  const { ghCommandFn, edits } = ghMock({
    801: bodyMissingSection(),
    802: bodyMissingSection(),
  });
  const prompts: string[] = [];
  const runClaude = (prompt: string) => {
    prompts.push(prompt);
    const output = prompts.length === 1
      // No block markers at all — the batched output cannot be split.
      ? "Sorry, here is one section:\n\n## Failure Detection\n\nSomething."
      : "## Failure Detection\n\nTest `fallback_test.ts` covers it.";
    return Promise.resolve({ ok: true as const, value: { output } });
  };

  const result = await repairFailureDetectionSections({
    repo: "o/r",
    offenders: [offender(801), offender(802)],
    runClaude,
    ghCommandFn,
    logger: silentLogger(),
  });

  // One batched attempt, then one call per offender.
  assertEquals(prompts.length, 3);
  assertEquals(result.repaired, [801, 802]);
  assertEquals(result.stillOffending, []);
  assertEquals(edits.map((e) => e.number), [801, 802]);
  // The batched call is recorded alongside the two fallback calls.
  assertEquals(result.invocations.length, 3);
});

Deno.test("repair - a single offender uses the single-offender prompt", async () => {
  const { ghCommandFn } = ghMock({ 900: bodyMissingSection() });
  const prompts: string[] = [];
  const runClaude = (prompt: string) => {
    prompts.push(prompt);
    return Promise.resolve({
      ok: true as const,
      value: { output: "## Failure Detection\n\nTest `s_test.ts` covers it." },
    });
  };

  const result = await repairFailureDetectionSections({
    repo: "o/r",
    offenders: [offender(900)],
    runClaude,
    ghCommandFn,
    logger: silentLogger(),
  });

  assertEquals(result.repaired, [900]);
  assertEquals(prompts.length, 1);
  assertStringIncludes(prompts[0]!, "Output ONLY the markdown section");
  assertEquals(prompts[0]!.includes("<<<SUB_ISSUE_"), false);
});

Deno.test("repair - batched call failure leaves every offender un-repaired, no invocation", async () => {
  const { ghCommandFn, edits } = ghMock({
    910: bodyMissingSection(),
    911: bodyMissingSection(),
  });
  let calls = 0;
  const runClaude = () => {
    calls++;
    return Promise.resolve({
      ok: false as const,
      error: new Error("rate limited"),
    });
  };

  const result = await repairFailureDetectionSections({
    repo: "o/r",
    offenders: [offender(910), offender(911)],
    runClaude,
    ghCommandFn,
    logger: silentLogger(),
  });

  assertEquals(calls, 1);
  assertEquals(result.repaired, []);
  assertEquals(result.stillOffending.map((o) => o.number), [910, 911]);
  assertEquals(result.invocations.length, 0);
  assertEquals(edits.length, 0);
});

Deno.test("repair - batched invocation records runStats, fallbackModel and preflightDegraded", async () => {
  const { ghCommandFn } = ghMock({
    920: bodyMissingSection(),
    921: bodyMissingSection(),
  });
  const runClaude = () =>
    Promise.resolve({
      ok: true as const,
      value: {
        output: [
          batchBlock(920, "Test `a_test.ts` covers it."),
          batchBlock(921, "Test `b_test.ts` covers it."),
        ].join("\n\n"),
        runStats: {
          servedModels: ["claude-fable-5-20250101"],
          effort: "high",
        } as RepairClaudeResult["runStats"],
        fallbackModel: "claude-haiku-4-5",
        preflightDegraded: true,
        preflightDegradedReason: "pre-flight reroute",
      },
    });

  const result = await repairFailureDetectionSections({
    repo: "o/r",
    offenders: [offender(920), offender(921)],
    runClaude,
    ghCommandFn,
    logger: silentLogger(),
  });

  assertEquals(result.invocations.length, 1);
  const invocation = result.invocations[0]!;
  assertEquals(invocation.phase, "planning");
  assertEquals(invocation.runStats?.servedModels, ["claude-fable-5-20250101"]);
  assertEquals(invocation.fallbackModel, "claude-haiku-4-5");
  assertEquals(invocation.preflightDegraded, true);
  assertEquals(invocation.preflightDegradedReason, "pre-flight reroute");
});

// --- (e) deadline-aware repair: defer what the budget cannot fit (#58) ---

/** A logger that records every warning message and its context. */
function recordingLogger() {
  const warnings: { message: string; context?: Record<string, unknown> }[] = [];
  const infos: string[] = [];
  return {
    warnings,
    infos,
    logger: {
      info(message: string) {
        infos.push(message);
      },
      warn(message: string, context?: Record<string, unknown>) {
        warnings.push({ message, context });
      },
    },
  };
}

Deno.test("repair - deadline already passed: zero Claude calls, every offender deferred (Issue #58)", async () => {
  const { ghCommandFn, edits } = ghMock({
    1001: bodyMissingSection(),
    1002: bodyMissingSection(),
  });
  let calls = 0;
  const runClaude = () => {
    calls++;
    return Promise.resolve({
      ok: true as const,
      value: { output: "## Failure Detection\n\nNever drafted." },
    });
  };
  const { warnings, logger } = recordingLogger();

  const result = await repairFailureDetectionSections({
    repo: "o/r",
    offenders: [offender(1001), offender(1002)],
    runClaude,
    ghCommandFn,
    logger,
    // The handler budget is already spent when the repair starts.
    deadlineMs: 5_000,
    now: () => 5_000,
    repairCostEstimateMs: 1_000,
  });

  assertEquals(calls, 0);
  assertEquals(result.repaired, []);
  assertEquals(result.stillOffending, []);
  assertEquals(result.deferred.map((o) => o.number), [1001, 1002]);
  assertEquals(result.invocations.length, 0);
  assertEquals(edits.length, 0);

  // The stop names the budget — never the "draft timed out or was empty"
  // warning, which would read as a model failure.
  const budgetWarning = warnings.find((w) => /budget/i.test(w.message));
  assert(budgetWarning !== undefined);
  assertStringIncludes(budgetWarning!.message, "Issue #58");
  assertEquals(budgetWarning!.context?.deferred, "1001,1002");
  assertEquals(
    warnings.some((w) => w.message.includes("timed out or was empty")),
    false,
  );
});

Deno.test("repair - budget for exactly one repair: one repaired, the rest deferred (Issue #58)", async () => {
  const { ghCommandFn, edits } = ghMock({
    1101: bodyMissingSection(),
    1102: bodyMissingSection(),
  });

  // Injected clock: each Claude call costs 1 000 ms of the budget. No timers.
  let nowMs = 0;
  const prompts: string[] = [];
  const runClaude = (prompt: string) => {
    prompts.push(prompt);
    nowMs += 1_000;
    // The batched output carries no block markers, so drafting falls back to
    // the per-offender path — where the budget guards each call.
    const output = prompts.length === 1
      ? "Sorry, I could not use the markers."
      : "## Failure Detection\n\nTest `budget_test.ts` covers it.";
    return Promise.resolve({ ok: true as const, value: { output } });
  };
  const { warnings, logger } = recordingLogger();

  const result = await repairFailureDetectionSections({
    repo: "o/r",
    offenders: [offender(1101), offender(1102)],
    runClaude,
    ghCommandFn,
    logger,
    // Room for the batched call plus exactly one per-offender repair.
    deadlineMs: 2_500,
    now: () => nowMs,
    repairCostEstimateMs: 1_000,
  });

  // Batched call + one per-offender call — the second never started.
  assertEquals(prompts.length, 2);
  assertEquals(result.repaired, [1101]);
  assertEquals(result.deferred.map((o) => o.number), [1102]);
  assertEquals(result.stillOffending, []);
  assertEquals(edits.map((e) => e.number), [1101]);
  assert(warnings.some((w) => /budget/i.test(w.message)));
});

Deno.test("repair - budget too small for the batched call defers every offender (Issue #58)", async () => {
  const { ghCommandFn, edits } = ghMock({
    1201: bodyMissingSection(),
    1202: bodyMissingSection(),
  });
  let calls = 0;
  const runClaude = () => {
    calls++;
    return Promise.resolve({
      ok: true as const,
      value: { output: batchBlock(1201, "Test `x_test.ts` covers it.") },
    });
  };

  const result = await repairFailureDetectionSections({
    repo: "o/r",
    offenders: [offender(1201), offender(1202)],
    runClaude,
    ghCommandFn,
    logger: silentLogger(),
    // 900 ms left, one repair estimated at 1 000 ms — not enough to start.
    deadlineMs: 900,
    now: () => 0,
    repairCostEstimateMs: 1_000,
  });

  assertEquals(calls, 0);
  assertEquals(result.repaired, []);
  assertEquals(result.deferred.map((o) => o.number), [1201, 1202]);
  assertEquals(result.stillOffending, []);
  assertEquals(edits.length, 0);
});

Deno.test("repair - no deadline supplied: unchanged behaviour, deferred is empty (Issue #58)", async () => {
  const { ghCommandFn, edits } = ghMock({
    1301: bodyMissingSection(),
    1302: bodyMissingSection(),
  });
  const runClaude = () =>
    Promise.resolve({
      ok: true as const,
      value: {
        output: [
          batchBlock(1301, "Test `a_test.ts` covers it."),
          batchBlock(1302, "Test `b_test.ts` covers it."),
        ].join("\n\n"),
      },
    });

  const result = await repairFailureDetectionSections({
    repo: "o/r",
    offenders: [offender(1301), offender(1302)],
    runClaude,
    ghCommandFn,
    logger: silentLogger(),
  });

  assertEquals(result.repaired, [1301, 1302]);
  assertEquals(result.stillOffending, []);
  assertEquals(result.deferred, []);
  assertEquals(edits.map((e) => e.number), [1301, 1302]);
});

Deno.test("repair - an unreadable offender stays stillOffending while others defer (Issue #58)", async () => {
  // #1402's body cannot be read; each read costs 600 ms of the budget, so the
  // budget then stops the repair before any draft is attempted.
  let nowMs = 0;
  const ghCommandFn = (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "view") {
      nowMs += 600;
      if (Number(args[2]) === 1402) return Promise.reject(new Error("gh view"));
      return Promise.resolve(
        JSON.stringify({
          number: Number(args[2]),
          title: "Add the widget",
          body: bodyMissingSection(),
        }),
      );
    }
    return Promise.resolve("");
  };

  let claudeCalls = 0;
  const result = await repairFailureDetectionSections({
    repo: "o/r",
    offenders: [offender(1401), offender(1402), offender(1403)],
    runClaude: () => {
      claudeCalls++;
      return Promise.resolve({ ok: true as const, value: { output: "" } });
    },
    ghCommandFn,
    logger: silentLogger(),
    // Enough to enter, not enough to draft once the reads are done.
    deadlineMs: 1_000,
    now: () => nowMs,
    repairCostEstimateMs: 1_000,
  });

  assertEquals(claudeCalls, 0);

  assertEquals(result.repaired, []);
  // "we never tried" (budget) is distinct from "the read failed".
  assertEquals(result.stillOffending.map((o) => o.number), [1402]);
  assertEquals(result.deferred.map((o) => o.number), [1401, 1403]);
});

// --- batched prompt and parser unit tests ---

Deno.test("buildBatchRepairPrompt - names every sub-issue and asks for one block each", () => {
  const prompt = buildBatchRepairPrompt([
    { number: 11, title: "Add A", body: "Body A" },
    { number: 12, title: "Add B", body: "Body B" },
  ]);
  assertStringIncludes(prompt, "Sub-issue #11: Add A");
  assertStringIncludes(prompt, "Sub-issue #12: Add B");
  assertStringIncludes(prompt, "<<<SUB_ISSUE_11>>>");
  assertStringIncludes(prompt, "<<<END_SUB_ISSUE_11>>>");
  assertStringIncludes(prompt, "<<<SUB_ISSUE_12>>>");
  assertStringIncludes(prompt, "## Failure Detection");
});

Deno.test("parseBatchRepairOutput - maps each block to its sub-issue number", () => {
  const parsed = parseBatchRepairOutput(
    [
      batchBlock(11, "Test `a_test.ts` covers it."),
      batchBlock(12, "N/A — docs-only."),
    ].join("\n\n"),
  );
  assertEquals(parsed.size, 2);
  assertStringIncludes(parsed.get(11)!, "a_test.ts");
  assertStringIncludes(parsed.get(12)!, "docs-only");
});

Deno.test("parseBatchRepairOutput - tolerates a missing end marker", () => {
  const parsed = parseBatchRepairOutput(
    [
      "<<<SUB_ISSUE_11>>>",
      "## Failure Detection",
      "",
      "Test `a_test.ts` covers it.",
      "<<<SUB_ISSUE_12>>>",
      "## Failure Detection",
      "",
      "N/A — docs-only.",
    ].join("\n"),
  );
  assertEquals(parsed.size, 2);
  assertStringIncludes(parsed.get(11)!, "a_test.ts");
  assertEquals(parsed.get(11)!.includes("SUB_ISSUE_12"), false);
});

Deno.test("parseBatchRepairOutput - unmarked or empty output yields no entries", () => {
  assertEquals(
    parseBatchRepairOutput("## Failure Detection\n\nSomething").size,
    0,
  );
  assertEquals(parseBatchRepairOutput("").size, 0);
  assertEquals(
    parseBatchRepairOutput("<<<SUB_ISSUE_11>>>\n\n<<<END_SUB_ISSUE_11>>>").size,
    0,
  );
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
