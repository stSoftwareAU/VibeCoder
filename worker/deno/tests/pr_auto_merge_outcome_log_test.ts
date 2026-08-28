/**
 * Tests for auto-merge outcome logging (Issue #470).
 *
 * The priority 1.65 sweep discarded the `EnableAutoMergeResult` it got back
 * from `enableAutoMerge`, so a gate that refused every merge in the fleet
 * left no trace beyond the priority's name and a duration. The fleet ran
 * that way for weeks: milestone children never merged, their issues never
 * closed, and no milestone ever completed — with nothing in the log to say
 * why. Every outcome is now recorded, and a refusal names its reason.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { AutoMergeResult, logAutoMergeOutcome } from "../lib/pr_auto_merge.ts";
import type { LogContext, Logger } from "../types.ts";

interface Recorded {
  level: "info" | "warn";
  message: string;
  context?: LogContext;
}

/** Minimal Logger capturing info/warn; the rest are unused here. */
function recordingLogger(sink: Recorded[]): Logger {
  const unused = () => {};
  return {
    info: (message: string, context?: LogContext) =>
      void sink.push({ level: "info", message, context }),
    warn: (message: string, context?: LogContext) =>
      void sink.push({ level: "warn", message, context }),
    error: unused,
    debug: unused,
    security: unused,
    skipReason: unused,
    timing: unused,
    scanSummary: unused,
    workerSummary: unused,
  } as unknown as Logger;
}

Deno.test("pr_auto_merge - a deferred merge is logged with its reason", () => {
  const sink: Recorded[] = [];
  logAutoMergeOutcome(recordingLogger(sink), "acme/tools", 2399, {
    result: AutoMergeResult.Deferred,
    message:
      "PR #2399 not merged onto unprotected 'milestone/x': behind_target (Issue #4375)",
  });

  assertEquals(sink.length, 1, "the outcome must not be silently discarded");
  const entry = sink[0]!;
  assertStringIncludes(entry.message, "behind_target");
  assertEquals(entry.context?.repo, "acme/tools");
  assertEquals(entry.context?.prNumber, 2399);
  assertEquals(entry.context?.result, AutoMergeResult.Deferred);
});

Deno.test("pr_auto_merge - a successful direct merge is logged at info", () => {
  const sink: Recorded[] = [];
  logAutoMergeOutcome(recordingLogger(sink), "acme/tools", 7, {
    result: AutoMergeResult.MergedDirectly,
    message: "PR #7 merged directly onto unprotected 'milestone/x'",
  });

  assertEquals(sink.length, 1);
  assertEquals(sink[0]!.level, "info");
  assertEquals(sink[0]!.context?.result, AutoMergeResult.MergedDirectly);
});

Deno.test("pr_auto_merge - a failed attempt is logged at warn", () => {
  const sink: Recorded[] = [];
  logAutoMergeOutcome(recordingLogger(sink), "acme/tools", 9, {
    result: AutoMergeResult.Failed,
    message: "Gated direct merge of PR #9 failed: boom",
  });

  assertEquals(sink.length, 1);
  assertEquals(sink[0]!.level, "warn");
  assertStringIncludes(sink[0]!.message, "boom");
});

Deno.test("pr_auto_merge - every outcome code produces exactly one log line", () => {
  for (const result of Object.values(AutoMergeResult)) {
    const sink: Recorded[] = [];
    logAutoMergeOutcome(recordingLogger(sink), "acme/tools", 1, {
      result,
      message: `outcome ${result}`,
    });
    assertEquals(
      sink.length,
      1,
      `outcome "${result}" must be logged, not swallowed`,
    );
    assert(
      sink[0]!.level === "info" || sink[0]!.level === "warn",
      `outcome "${result}" must log at info or warn`,
    );
  }
});
