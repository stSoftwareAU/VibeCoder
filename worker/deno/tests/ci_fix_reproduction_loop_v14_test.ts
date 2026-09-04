/**
 * Tests for the CI-fix prompt's reproduction loop (Issue #661).
 *
 * The prompt's whole diagnosis instruction used to be "read the failing test,
 * CI config, and relevant source to find the root cause" — straight to
 * hypothesis, with nothing between a plausible theory and a pushed commit.
 * Issue #661 put a reproduction loop in front of the fix: one red-capable
 * command, bounded attempts and an honest give-up path; minimisation before
 * the fix; three to five ranked falsifiable hypotheses before instrumenting;
 * and a unique `[DEBUG-…]` tag on any instrumentation so a single grep clears
 * it before the commit.
 *
 * The assertions run against the current `ci_fix` template, so a later edit
 * that quietly drops one of those rules fails in CI.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadCiFix(): Promise<string> {
  const result = await loadPrompt("ci_fix", PROMPTS_DIR);
  assertEquals(result.ok, true, "ci_fix failed to load");
  if (!result.ok) throw new Error("ci_fix failed to load");
  return result.value;
}

/** Lower-cased, so an assertion is about the rule, not its capitalisation. */
function lower(text: string): string {
  return text.toLowerCase();
}

// --- The contract that predates the reproduction loop survives ---

Deno.test("ci_fix - keeps the placeholders and the reply contract", async () => {
  const text = await loadCiFix();
  for (
    const required of [
      "{{VERBOSITY_INSTRUCTIONS}}",
      "{{PR_NUMBER}}",
      "{{FAILURE_CLASSIFICATION}}",
      "{{PR_FAILURE_ACTIONS}}",
      "{{QUALITY_INSTRUCTIONS}}",
      ".pr_response_message",
      "code-fix-required",
      "out of scope",
      "follow-up issue",
    ]
  ) {
    assertStringIncludes(text, required);
  }
});

// --- Phase 1: the reproduction gate ---

Deno.test("ci_fix - gates the fix behind one red-capable command", async () => {
  const body = lower(await loadCiFix());

  assertStringIncludes(body, "red-capable");
  // The gate is stated as a gate, not as permission.
  assertStringIncludes(body, "no red command, no hypothesis");
  // And the command must actually have been run, not merely named.
  assertStringIncludes(body, "run it");
});

Deno.test("ci_fix - names what makes a loop good", async () => {
  const text = await loadCiFix();
  const body = lower(text);
  for (const quality of ["deterministic", "seconds", "unattended", "narrow"]) {
    assertStringIncludes(body, quality);
  }
  // Unattended has a concrete meaning in this repo.
  assertStringIncludes(text, "< /dev/null");
});

Deno.test("ci_fix - bounds the attempt and keeps an honest give-up path", async () => {
  const body = lower(await loadCiFix());

  // Bounded: the source's "refuse to give up" framing would burn the run.
  assertStringIncludes(body, "bounded");
  // A loop that could not be built is reportable, not a failure to hide.
  assertStringIncludes(body, "legitimate outcome");
  assertStringIncludes(body, "which commands you ran");
});

Deno.test("ci_fix - stays cheap for a failure the tool output already names", async () => {
  const body = lower(await loadCiFix());
  // Lint, format, type and semgrep failures are reproduced by the reporting
  // tool itself — the gate costs one line there, not a diagnosis ritual.
  for (const mechanical of ["lint", "format", "type error", "semgrep"]) {
    assertStringIncludes(body, mechanical);
  }
  assertStringIncludes(body, "already reproduced by the tool that reported it");
});

// --- Phase 2: minimise ---

Deno.test("ci_fix - requires the repro to be minimised before the fix", async () => {
  const body = lower(await loadCiFix());

  assertStringIncludes(body, "one element at a time");
  assertStringIncludes(body, "turns it green");
  // The minimised scenario is what the regression test becomes.
  assertStringIncludes(body, "regression test");
});

// --- Phase 3: ranked hypotheses ---

Deno.test("ci_fix - requires three to five ranked falsifiable hypotheses", async () => {
  const body = lower(await loadCiFix());

  assertStringIncludes(body, "three to five");
  assertStringIncludes(body, "rank");
  assertStringIncludes(body, "falsifiable");
  // Each carries the prediction that makes it testable.
  assertStringIncludes(body, "prediction");
  assert(
    body.includes("before you instrument") ||
      body.includes("before you instrument the code"),
    "the template must place the hypothesis list ahead of instrumentation",
  );
});

// --- Phase 4: tagged instrumentation ---

Deno.test("ci_fix - tags temporary instrumentation and greps it out", async () => {
  const text = await loadCiFix();

  assertStringIncludes(text, "[DEBUG-");
  assertStringIncludes(lower(text), "grep");
  // The existing scratch-file rule is not replaced, it is joined.
  assertStringIncludes(lower(text), "scratch");
  assertStringIncludes(lower(text), "git status");
});

// --- The triage branch that used to say "if you can" ---

Deno.test("ci_fix - the unknown branch points at the gate, not at permission", async () => {
  const text = await loadCiFix();

  assertEquals(text.includes("reproduce locally if you can"), false);

  const unknownLine = text
    .split("\n")
    .find((line) => line.includes("**`unknown`**"));
  assert(
    unknownLine,
    "the template must still carry the unknown triage branch",
  );
  assertStringIncludes(lower(unknownLine), "reproduction loop");
});

// --- The reply carries the evidence ---

Deno.test("ci_fix - both reply skeletons report the reproduction", async () => {
  const text = await loadCiFix();

  const reproLines = text
    .split("\n")
    .filter((line) => line.startsWith("**Reproduction:**"));
  assertEquals(
    reproLines.length,
    2,
    "the changed-code and no-change skeletons each need a Reproduction line",
  );
});
