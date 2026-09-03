/**
 * Tests for the Fable 5 simplification of the remaining working prompts,
 * following on from the core-prompt rewrite.
 *
 * `pr_feedback`, `ci_fix`, `planning`, `question` and `grill-me` were each
 * rewritten to state every policy once in plain language.
 *
 * These tests pin the policy strings and worker wording-contracts the
 * simplified templates must keep, confirm the required placeholders survive
 * the rewrite, and prove the escape-hatch detection contract the pr_feedback /
 * ci_fix replies depend on still fires.
 *
 * Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt, validatePromptTemplate } from "../lib/prompt_manager.ts";
import { detectEscapeHatch } from "../lib/escape_hatch.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

interface PromptCase {
  /** Prompt directory name, e.g. `pr_feedback`. */
  name: string;
  /** Template type key for placeholder validation (omit if not registered). */
  validateAs?: string;
  /** Substrings that must appear in the template. */
  requires: string[];
}

const CASES: PromptCase[] = [
  {
    name: "pr_feedback",
    validateAs: "pr_feedback",
    requires: [
      "{{PR_NUMBER}}",
      "{{VERBOSITY_INSTRUCTIONS}}",
      ".pr_response_message",
      "Automated Review Comments",
      "Change Scope",
      "out of scope",
      "follow-up issue",
    ],
  },
  {
    name: "ci_fix",
    validateAs: "ci_fix",
    requires: [
      "{{PR_NUMBER}}",
      "{{FAILURE_CLASSIFICATION}}",
      "{{PR_FAILURE_ACTIONS}}",
      ".pr_response_message",
      "out of scope",
      "follow-up issue",
    ],
  },
  {
    name: "planning",
    validateAs: "planning",
    requires: [
      "{{REPO}}",
      "{{ISSUE_NUMBER}}",
      "{{PLANNING_LABEL}}",
      "{{COMPLEXITY_CONTEXT}}",
      "{{MILESTONE_INSTRUCTIONS}}",
      "Depends on #N",
      "",
      "",
    ],
  },
  {
    name: "question",
    validateAs: "question",
    requires: [
      "{{REPO}}",
      "{{ISSUE_NUMBER}}",
      "{{QUESTION_LABEL}}",
      "Clarification Needed",
      "`needs-human`",
    ],
  },
  {
    name: "grill-me",
    requires: [
      "{{ROUND_NUMBER}}",
      "{{MAX_ROUNDS}}",
      "## Grill-Me Round {{ROUND_NUMBER}}",
      "## Grill-Me — Ready for Next Phase",
      "<!-- GRILL-ME-UNDERSTANDING-START -->",
      "<!-- GRILL-ME-UNDERSTANDING-END -->",
      "**⏳ Awaiting your reply.**",
      "",
      "",
    ],
  },
];

for (const c of CASES) {
  Deno.test(`${c.name} - exists and loads`, async () => {
    const result = await loadPrompt(c.name, PROMPTS_DIR);
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value.length > 0, true);
  });

  Deno.test(`${c.name} - keeps the required policy strings`, async () => {
    const result = await loadPrompt(c.name, PROMPTS_DIR);
    assertEquals(result.ok, true);
    if (result.ok) {
      for (const needle of c.requires) {
        assertStringIncludes(result.value, needle);
      }
    }
  });

  if (c.validateAs) {
    Deno.test(`${c.name} - retains required placeholders`, async () => {
      const result = await loadPrompt(c.name, PROMPTS_DIR);
      assertEquals(result.ok, true);
      if (result.ok) {
        const validation = validatePromptTemplate(c.validateAs!, result.value);
        assertEquals(validation.ok, true);
      }
    });
  }
}

// --- Escape-hatch detection contract ---------------------------
//
// The pr_feedback and ci_fix templates instruct the agent to write an
// escape-hatch `.pr_response_message` using the "out of scope" / "follow-up
// issue" wording plus a same-repo issue link. detectEscapeHatch() is what the
// worker uses to recognise that shape, so verify a message written to the
// prompt's instructions is detected.

Deno.test("escape-hatch - a pr_feedback/ci_fix style hand-off message is detected", () => {
  const message = [
    "This is out of scope for this PR — it needs a multi-day refactor.",
    "I have opened a follow-up issue stSoftwareAU/VibeCoder#42 capturing",
    "the analysis. Flagging needs-human so a person can triage.",
  ].join(" ");
  const detection = detectEscapeHatch(message, "stSoftwareAU/VibeCoder");
  assertEquals(detection.invoked, true);
  assertEquals(detection.issueRef, "stSoftwareAU/VibeCoder#42");
  assertEquals(detection.needsHuman, true);
});

Deno.test("escape-hatch - an ordinary fix reply does not trigger the hand-off", () => {
  const message =
    "Fixed the validation as requested; see #42 for the original context.";
  const detection = detectEscapeHatch(message, "stSoftwareAU/VibeCoder");
  assertEquals(detection.invoked, false);
});
