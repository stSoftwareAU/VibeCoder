/**
 * Tests for buildClaudeFailureLog (Issue #35).
 *
 * The generic non-rate-limit failure path used to log only "exited with
 * status N" and drop the captured stderr, so a transient start-up refusal was
 * indistinguishable from a mid-run crash. The log must now carry the CLI's own
 * error surface — a bounded, secret-redacted stderr tail — plus the wall time,
 * and must name an instant empty-output exit as a start-up failure.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildClaudeFailureLog } from "../lib/claude_runner.ts";
import { REDACTION_PLACEHOLDER } from "../lib/secret_redaction.ts";

Deno.test("buildClaudeFailureLog - an instant empty-output exit reads as a start-up failure", () => {
  const log = buildClaudeFailureLog({
    exitCode: 1,
    stderr: "Error: another claude session holds the lock",
    output: "",
    wallClockMs: 300,
  });
  assertStringIncludes(log, "start-up failure");
  assertStringIncludes(log, "0.3s after spawn");
  assertStringIncludes(log, "never reached a model call");
  // The captured stderr is surfaced, not discarded.
  assertStringIncludes(log, "another claude session holds the lock");
});

Deno.test("buildClaudeFailureLog - a mid-run failure is NOT called a start-up failure", () => {
  const log = buildClaudeFailureLog({
    exitCode: 1,
    stderr: "boom",
    output: "…lots of tool output…",
    wallClockMs: 120_000,
  });
  assertEquals(log.includes("start-up failure"), false);
  assertStringIncludes(log, "exited with status 1 after 120s");
});

Deno.test("buildClaudeFailureLog - empty output but a long run is not a start-up failure", () => {
  // Only an INSTANT empty-output exit is start-up; a long empty run is a crash.
  const log = buildClaudeFailureLog({
    exitCode: 1,
    stderr: "",
    output: "",
    wallClockMs: 60_000,
  });
  assertEquals(log.includes("start-up failure"), false);
  assertStringIncludes(log, "(stderr empty)");
});

Deno.test("buildClaudeFailureLog - keeps only the last 5 stderr lines", () => {
  const stderr = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join(
    "\n",
  );
  const log = buildClaudeFailureLog({
    exitCode: 2,
    stderr,
    output: "x",
    wallClockMs: 5_000,
  });
  assertStringIncludes(log, "line20");
  assertStringIncludes(log, "line16");
  assert(!log.includes("line15"), "older stderr lines are trimmed");
});

Deno.test("buildClaudeFailureLog - redacts secrets in the stderr tail", () => {
  const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
  const log = buildClaudeFailureLog({
    exitCode: 1,
    stderr: `fatal: auth failed with ${token}`,
    output: "",
    wallClockMs: 100,
  });
  assertEquals(log.includes(token), false, "the raw token must not be logged");
  assertStringIncludes(log, REDACTION_PLACEHOLDER);
});

Deno.test("buildClaudeFailureLog - notes stderr empty when there is none", () => {
  const log = buildClaudeFailureLog({
    exitCode: 3,
    stderr: "",
    output: "worked then died",
    wallClockMs: 9_000,
  });
  assertStringIncludes(log, "(stderr empty)");
});
