/**
 * Tests for CI-fix prompt v14 (Issue #661).
 *
 * v13's whole diagnosis instruction was "read the failing test, CI config, and
 * relevant source to find the root cause" — straight to hypothesis, with
 * nothing between a plausible theory and a pushed commit. v14 puts a
 * reproduction loop in front of the fix: one red-capable command, bounded
 * attempts and an honest give-up path; minimisation before the fix; three to
 * five ranked falsifiable hypotheses before instrumenting; and a unique
 * `[DEBUG-…]` tag on any instrumentation so a single grep clears it before the
 * commit.
 *
 * v13 stays immutable and is the negative control — every new-rule assertion
 * checks the gap is present in v13 and closed in v14, so the suite fails
 * against the unfixed prompt tree.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadCiFix(version: string): Promise<string> {
  const result = await loadPrompt("ci_fix", version, PROMPTS_DIR);
  assertEquals(result.ok, true, `ci_fix ${version} failed to load`);
  if (!result.ok) throw new Error(`ci_fix ${version} failed to load`);
  return result.value;
}

const loadV13 = () => loadCiFix("v13");
const loadV14 = () => loadCiFix("v14");

/** Lower-cased, so an assertion is about the rule, not its capitalisation. */
function lower(text: string): string {
  return text.toLowerCase();
}

// --- Version resolution ---

Deno.test("ci_fix v14 - is the version this contract entered at", async () => {
  // Issue #778 minted v15 (the narration clause), so v14 is no longer what
  // the worker resolves. What this file pins is the contract v14 introduced,
  // and that contract must survive every later version — so the resolution
  // check is now "v14 or newer", and the contract assertions below run
  // against v14 (immutable) with `ci_fix_narration_test` holding the latest.
  const latest = await getLatestVersion("ci_fix", PROMPTS_DIR);
  assertEquals(latest.ok, true);
  if (!latest.ok) return;
  const version = parseInt(latest.value.replace("v", ""), 10);
  assertEquals(
    version >= 14,
    true,
    `Expected ci_fix >= v14, got ${latest.value}`,
  );

  const [byName, byVersion] = await Promise.all([
    loadPrompt("ci_fix", undefined, PROMPTS_DIR),
    loadPrompt("ci_fix", latest.value, PROMPTS_DIR),
  ]);
  assertEquals(byName.ok, true);
  assertEquals(byVersion.ok, true);
  if (byName.ok && byVersion.ok) {
    assertEquals(byName.value, byVersion.value);
  }
});

// --- The contract v13 already carried survives ---

Deno.test("ci_fix v14 - keeps the placeholders and the reply contract", async () => {
  const v14 = await loadV14();
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
    assertStringIncludes(v14, required);
  }
});

// --- Phase 1: the reproduction gate ---

Deno.test("ci_fix v14 - gates the fix behind one red-capable command", async () => {
  const [v13, v14] = await Promise.all([loadV13(), loadV14()]);
  const body = lower(v14);

  assertStringIncludes(body, "red-capable");
  // The gate is stated as a gate, not as permission.
  assertStringIncludes(body, "no red command, no hypothesis");
  // And the command must actually have been run, not merely named.
  assertStringIncludes(body, "run it");

  assertEquals(lower(v13).includes("red-capable"), false);
});

Deno.test("ci_fix v14 - names what makes a loop good", async () => {
  const body = lower(await loadV14());
  for (const quality of ["deterministic", "seconds", "unattended", "narrow"]) {
    assertStringIncludes(body, quality);
  }
  // Unattended has a concrete meaning in this repo.
  assertStringIncludes(await loadV14(), "< /dev/null");
});

Deno.test("ci_fix v14 - bounds the attempt and keeps an honest give-up path", async () => {
  const [v13, v14] = await Promise.all([loadV13(), loadV14()]);
  const body = lower(v14);

  // Bounded: the source's "refuse to give up" framing would burn the run.
  assertStringIncludes(body, "bounded");
  // A loop that could not be built is reportable, not a failure to hide.
  assertStringIncludes(body, "legitimate outcome");
  assertStringIncludes(body, "which commands you ran");

  assertEquals(lower(v13).includes("legitimate outcome"), false);
});

Deno.test("ci_fix v14 - stays cheap for a failure the tool output already names", async () => {
  const body = lower(await loadV14());
  // Lint, format, type and semgrep failures are reproduced by the reporting
  // tool itself — the gate costs one line there, not a diagnosis ritual.
  for (const mechanical of ["lint", "format", "type error", "semgrep"]) {
    assertStringIncludes(body, mechanical);
  }
  assertStringIncludes(body, "already reproduced by the tool that reported it");
});

// --- Phase 2: minimise ---

Deno.test("ci_fix v14 - requires the repro to be minimised before the fix", async () => {
  const [v13, v14] = await Promise.all([loadV13(), loadV14()]);
  const body = lower(v14);

  assertStringIncludes(body, "one element at a time");
  assertStringIncludes(body, "turns it green");
  // The minimised scenario is what the regression test becomes.
  assertStringIncludes(body, "regression test");

  assertEquals(lower(v13).includes("one element at a time"), false);
});

// --- Phase 3: ranked hypotheses ---

Deno.test("ci_fix v14 - requires three to five ranked falsifiable hypotheses", async () => {
  const [v13, v14] = await Promise.all([loadV13(), loadV14()]);
  const body = lower(v14);

  assertStringIncludes(body, "three to five");
  assertStringIncludes(body, "rank");
  assertStringIncludes(body, "falsifiable");
  // Each carries the prediction that makes it testable.
  assertStringIncludes(body, "prediction");
  assert(
    body.includes("before you instrument") ||
      body.includes("before you instrument the code"),
    "v14 must place the hypothesis list ahead of instrumentation",
  );

  assertEquals(lower(v13).includes("falsifiable"), false);
});

// --- Phase 4: tagged instrumentation ---

Deno.test("ci_fix v14 - tags temporary instrumentation and greps it out", async () => {
  const [v13, v14] = await Promise.all([loadV13(), loadV14()]);

  assertStringIncludes(v14, "[DEBUG-");
  assertStringIncludes(lower(v14), "grep");
  // The existing scratch-file rule is not replaced, it is joined.
  assertStringIncludes(lower(v14), "scratch");
  assertStringIncludes(lower(v14), "git status");

  assertEquals(v13.includes("[DEBUG-"), false);
});

// --- The triage branch that used to say "if you can" ---

Deno.test("ci_fix v14 - the unknown branch points at the gate, not at permission", async () => {
  const [v13, v14] = await Promise.all([loadV13(), loadV14()]);

  assertStringIncludes(v13, "reproduce locally if you can");
  assertEquals(v14.includes("reproduce locally if you can"), false);

  const unknownLine = v14
    .split("\n")
    .find((line) => line.includes("**`unknown`**"));
  assert(unknownLine, "v14 must still carry the unknown triage branch");
  assertStringIncludes(lower(unknownLine), "reproduction loop");
});

// --- The reply carries the evidence ---

Deno.test("ci_fix v14 - both reply skeletons report the reproduction", async () => {
  const [v13, v14] = await Promise.all([loadV13(), loadV14()]);

  const reproLines = v14
    .split("\n")
    .filter((line) => line.startsWith("**Reproduction:**"));
  assertEquals(
    reproLines.length,
    2,
    "the changed-code and no-change skeletons each need a Reproduction line",
  );
  assertEquals(v13.includes("**Reproduction:**"), false);
});
