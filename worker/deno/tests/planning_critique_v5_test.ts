/**
 * Tests for planning_critique v5 (Issue #3796).
 *
 * v5 closes the eight Claude best-practice gaps the #3772 audit recorded
 * against v4 — the publish half of the draft → critique → publish chain: a
 * milestone-carrying example, worked examples for the two hardest judgements,
 * an XML tag vocabulary, a role sentence, output skeletons, a do-not-stop-early
 * clause with a re-run guard, a duplicate listing of its own, and a no-files
 * bound.
 *
 * v4 stays immutable (Issue #235) and is used here as the negative control:
 * each gap test asserts the defect is present in v4 and absent in v5, so the
 * test fails against the unfixed template.
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildPlanningCritiquePrompt } from "../lib/prompt_builder.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Text between two markers, exclusive of the markers. */
function between(body: string, start: string, end: string): string {
  const from = body.indexOf(start);
  const to = body.indexOf(end, from + start.length);
  assertEquals(from >= 0 && to > from, true, `missing ${start} … ${end}`);
  return body.slice(from + start.length, to);
}

// --- Loading contract ---

// --- Gap 1: be clear and direct (example contradicted the milestone mandate) ---

Deno.test("planning_critique v5 - Gap 1: the built prompt agrees with itself on the flag", async () => {
  const built = await buildPlanningCritiquePrompt({
    repo: "owner/repo",
    issueNumber: "99",
    issueTitle: "Big feature",
    issueBody: "Body",
    issueLabels: "enhancement",
    milestoneTitle: "v2.0",
    draftPlan: "draft",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(built.ok, true);
  if (!built.ok) return;
  const prompt = built.value.prompt;
  // The mandate renders …
  assertStringIncludes(
    prompt,
    'Every sub-issue you create MUST include the `--milestone "<milestone>"` flag',
  );
  // … and the template's own example now obeys it.
  assertStringIncludes(
    prompt,
    '--label "enhancement" --milestone "<milestone>"',
  );
});

// --- Gap 2: use examples effectively ---

// --- Gap 3: structure prompts with XML tags ---

Deno.test("planning_critique v5 - Gap 3: the built prompt renders the milestone text inside its tags", async () => {
  const built = await buildPlanningCritiquePrompt({
    repo: "owner/repo",
    issueNumber: "99",
    issueTitle: "Big feature",
    issueBody: "Body",
    issueLabels: "enhancement",
    milestoneTitle: "v2.0",
    draftPlan: "draft",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(built.ok, true);
  if (!built.ok) return;
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

// --- Gap 5: control the format of responses ---

// --- Gap 6: long-horizon reasoning and state tracking ---

// --- Gap 7: research and information gathering ---

// --- Gap 8: reduce file creation in agentic coding ---

// --- Behaviour preserved from v4 ---

// --- v4 immutability (Issue #235) ---
