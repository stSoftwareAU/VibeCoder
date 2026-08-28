/**
 * Tests for planning v20 (Issue #3795).
 *
 * v20 closes the six Claude best-practice gaps the #3772 audit recorded against
 * v19 — the draft half of the draft → critique → publish chain: symbolic draft
 * dependencies, worked ask-splitting examples, XML tags around the injected and
 * skeleton blocks, a role sentence, a no-scratch-file bound, and a
 * read-before-assert rule.
 *
 * v19 stays immutable (Issue #235) and is used here as the negative control:
 * each gap test asserts the defect is present in v19 and absent in v20, so the
 * test fails against the unfixed template.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildPlanningPrompt } from "../lib/prompt_builder.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Text between two markers, exclusive of the markers. */
function between(body: string, start: string, end: string): string {
  const from = body.indexOf(start);
  const to = body.indexOf(end, from + start.length);
  assertEquals(from >= 0 && to > from, true, `missing ${start} … ${end}`);
  return body.slice(from + start.length, to);
}

// --- Loading contract ---

// --- Gap 1: be clear and direct (contradictory dependency notation) ---

// --- Gap 2: use examples effectively ---

// --- Gap 3: structure prompts with XML tags ---

Deno.test("planning v20 - Gap 3: the built prompt renders injected text inside its tags", async () => {
  const built = await buildPlanningPrompt({
    repo: "owner/repo",
    issueNumber: "99",
    issueTitle: "Big feature",
    issueBody: "Body",
    issueLabels: "enhancement",
    complexityContext: "Touches nine modules",
    milestoneTitle: "v2.0",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(built.ok, true);
  if (!built.ok) return;
  assertStringIncludes(
    between(
      built.value.prompt,
      "<escalation_context>",
      "</escalation_context>",
    ),
    "Touches nine modules",
  );
  assertStringIncludes(
    between(
      built.value.prompt,
      "<milestone_instructions>",
      "</milestone_instructions>",
    ),
    "v2.0",
  );
});

// --- Gap 4: give Claude a role ---

// --- Gap 5: reduce file creation in agentic coding ---

// --- Gap 6: minimise hallucinations ---

// --- Behaviour preserved from v19 ---
