/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift
 * tests): Issue #4304.
 *
 * A PR-feedback run used to have an escape hatch: for "a product decision
 * only a human can make", or anything else it judged out of scope, the agent
 * filed a follow-up issue and asked for `needs-human` instead of answering
 * the review. The owner's rule (2026-10-25) is that the Vibe Coder never
 * passes work back to a human and files no follow-up issues for leftover
 * work, so the hatch is gone from both the `pr_feedback` prompt and the
 * coding guidelines a PR-feedback run loads. The agent decides with stated
 * assumptions, or rebuts with reasons.
 *
 * Uses Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertStringIncludes } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";
import { CODING_GUIDELINES_LAYER_BY_PHASE } from "../lib/prompt_builder.ts";
import { selectCodingGuidelinesLayer } from "../lib/coding_guidelines_overlay.ts";

/** Phrases that only the removed hatch ever used. */
const HATCH_PHRASES = [
  "## escape hatch",
  "a product decision only a human can make",
  "mentions `needs-human`",
  "hand off instead of looping",
  "apply the escape hatch",
];

async function renderedGuidelines(): Promise<string> {
  const template = await readRepoDoc("prompts/coding_guidelines/prompt.md");
  const selected = selectCodingGuidelinesLayer(
    template,
    CODING_GUIDELINES_LAYER_BY_PHASE.pr_feedback,
  );
  if (!selected.ok) {
    throw new Error(`selectCodingGuidelinesLayer failed: ${selected.error}`);
  }
  return selected.value;
}

Deno.test("pr_feedback prompt has no escape hatch: decide with stated assumptions or rebut (Issue #4304)", async () => {
  const prompt = (await readRepoDoc("prompts/pr_feedback/prompt.md"))
    .toLowerCase();
  for (const phrase of HATCH_PHRASES) {
    assert(
      !prompt.includes(phrase),
      `pr_feedback prompt still says "${phrase}"`,
    );
  }

  const rule = flat(section(
    await readRepoDoc("prompts/pr_feedback/prompt.md"),
    "Decide, Never Hand Back",
  )).toLowerCase();
  for (
    const required of [
      "state the assumption",
      "rebut it with the reasons",
      "never ask for `needs-human`",
      "never file a follow-up issue",
    ]
  ) {
    assertStringIncludes(rule, required);
  }
});

Deno.test("coding guidelines a PR-feedback run loads offer no hand-back (Issue #4304)", async () => {
  const guidelines = (await renderedGuidelines()).toLowerCase();
  for (const phrase of HATCH_PHRASES) {
    assert(
      !guidelines.includes(phrase),
      `coding guidelines for pr_feedback still say "${phrase}"`,
    );
  }
  const escalation = flat(section(
    await renderedGuidelines(),
    "Human Escalation",
  )).toLowerCase();
  assertStringIncludes(
    escalation,
    "never in an issue, pr-feedback or ci-fix run",
  );
});
