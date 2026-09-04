/**
 * Tests for the grill-me frontier round-composition rules (Issue #658).
 *
 * `prompts/grill-me/prompt.md` carries three mechanics borrowed from the
 * mattpocock/skills grilling primitive (see `docs/REFERENCES.md`):
 *
 * 1. The design tree and its **frontier** — ask every question whose
 *    prerequisites are already settled in one round, and defer a question
 *    that depends on another still-open question to a later round.
 * 2. A **recommended answer** beside every question, expressed in our
 *    checkbox format by pre-ticking exactly one option per question.
 * 3. **Facts are yours, decisions are theirs** — never ask the user
 *    something a read of the repository, `gh`, or the filesystem answers.
 *
 * The tests load the template through the real `loadPrompt` /
 * `buildGrillMePrompt` functions rather than reading files directly, so they
 * exercise the same path the worker uses each round.
 *
 * Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import { buildGrillMePrompt } from "../lib/grill_me_processor.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Strings that state the three new mechanics. */
const FRONTIER_POLICY = [
  "design tree",
  "frontier",
  "Ask the whole frontier in one round",
  "waits for a later round",
  "Facts are yours, decisions are theirs",
  "recommended answer",
  "- [x]",
];

/** Long-standing contracts the worker still depends on. */
const INHERITED_CONTRACT = [
  "{{ROUND_NUMBER}}",
  "{{MAX_ROUNDS}}",
  "{{REPO}}",
  "{{ISSUE_NUMBER}}",
  "{{ISSUE_TITLE}}",
  "{{ISSUE_BODY}}",
  "{{COMMENT_HISTORY}}",
  "{{RUBRIC_FINDINGS}}",
  "{{CODING_GUIDELINES}}",
  "{{VERBOSITY_INSTRUCTIONS}}",
  "{{BOUNDARY_INTEGRITY_INSTRUCTION}}",
  "## Grill-Me Round {{ROUND_NUMBER}}",
  "## Grill-Me — Ready for Next Phase",
  "<!-- GRILL-ME-UNDERSTANDING-START -->",
  "<!-- GRILL-ME-UNDERSTANDING-END -->",
  "**⏳ Awaiting your reply.**",
  "- [ ] other — please describe in a reply",
  "`unquantified-adjective`",
  "`unresolved-placeholder`",
  "`unobservable-scope-item`",
  "`terminology-drift`",
  "Do not post the Ready comment while any flagged item is outstanding",
];

Deno.test("grill-me - states the frontier, recommendation and facts rules", async () => {
  const result = await loadPrompt("grill-me", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  for (const needle of FRONTIER_POLICY) {
    assertStringIncludes(result.value, needle);
  }
});

Deno.test("grill-me - no longer carries the smallest-set round rule", async () => {
  const result = await loadPrompt("grill-me", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(
    result.value.includes("smallest set of clarifying choices"),
    false,
    "the frontier rule replaced the smallest-set instruction",
  );
});

Deno.test("grill-me - resolves the frontier vs mobile-length conflict", async () => {
  const result = await loadPrompt("grill-me", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  // The frontier wins over the ~1500-character bound, with one explicit
  // numeric cap so a very wide frontier still fits a phone screen.
  assertStringIncludes(result.value, "the frontier wins");
  assertStringIncludes(result.value, "eight questions");
});

Deno.test("grill-me - defines what a pre-ticked box means", async () => {
  const result = await loadPrompt("grill-me", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  // Pre-ticking changes the meaning of a tick, so silence-as-consent must
  // be stated and every unchallenged recommendation recorded as an
  // assumption in the body a work-on reader sees.
  assertStringIncludes(result.value, "accepted by default in Round");
  assertStringIncludes(result.value, "exactly one option");
});

Deno.test("grill-me - keeps every long-standing contract", async () => {
  const result = await loadPrompt("grill-me", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  for (const needle of INHERITED_CONTRACT) {
    assertStringIncludes(result.value, needle);
  }
});

Deno.test("buildGrillMePrompt - a built round carries the frontier rules and no placeholders", async () => {
  const built = await buildGrillMePrompt({
    roundNumber: 1,
    maxRounds: 5,
    issueBody: "Export the nightly report somehow.",
    commentHistory: "(none)",
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 658,
    issueTitle: "add an export",
    codingGuidelines: "(guidelines)",
    verbosityInstructions: "(verbosity)",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(built.ok, true);
  if (!built.ok) return;

  for (const needle of FRONTIER_POLICY) {
    assertStringIncludes(built.value, needle);
  }
  // Every placeholder the builder knows about is substituted.
  assertEquals(/\{\{[A-Z_]+\}\}/.test(built.value), false);
});
