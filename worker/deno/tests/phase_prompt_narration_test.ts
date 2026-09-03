/**
 * The narration contradiction, in the three prompts #759 did not reach
 * (Issue #778).
 *
 * Every phase prompt carries `{{VERBOSITY_INSTRUCTIONS}}` on line 1, and the
 * block substituted there says "no running commentary while you work". Three
 * prompts then asked for exactly that commentary:
 *
 *   - `ci_fix`      — "narrating briefly as you go"
 *   - `pr_feedback` — "Narrate briefly as you go (a short line …)"
 *   - `planning`    — "Narrate briefly as you go."
 *
 * All three render the `standard` block, because no prompt builder but the
 * `issue` phase is ever passed a level (#798). So one rendered prompt both
 * asked for and forbade narration.
 *
 * These are the equivalent of `grill_me_narration_test.ts` for those three:
 * no template asks for narration, and the unattended framing each prompt
 * needs survives — only the narration clause goes.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import { buildVerbosityBlock } from "../lib/prompt_builder.ts";
import type { VerbosityLevel } from "../types.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** The clauses the prompts used to carry, lower-cased for matching. */
const NARRATION_CLAUSES = [
  "narrate briefly as you go",
  "narrating briefly as you go",
];

/** The clause the `standard` verbosity block injects. */
const NO_COMMENTARY_CLAUSE = "no running commentary while you work";

/** One prompt, and the framing it must keep now the clause is gone. */
interface Subject {
  prompt: string;
  /** Framing the template must not have lost with the clause. */
  keeps: string;
}

const SUBJECTS: Subject[] = [
  {
    prompt: "ci_fix",
    keeps: "You run unattended with no operator to consult.",
  },
  {
    prompt: "pr_feedback",
    keeps: "recording assumptions in your reply rather than waiting",
  },
  {
    prompt: "planning",
    keeps: "record an assumption in the draft and proceed",
  },
];

/** The template text of one prompt. */
async function promptText(prompt: string): Promise<string> {
  const loaded = await loadPrompt(prompt, PROMPTS_DIR);
  assertEquals(loaded.ok, true, `cannot load ${prompt}`);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value;
}

Deno.test("phase prompts - no template asks the run to narrate (Issue #778)", async () => {
  for (const subject of SUBJECTS) {
    const lower = (await promptText(subject.prompt)).toLowerCase();
    for (const clause of NARRATION_CLAUSES) {
      assertEquals(
        lower.includes(clause),
        false,
        `${subject.prompt} must not ask for narration while the rendered ` +
          `verbosity block forbids it`,
      );
    }
  }
});

Deno.test("phase prompts - the unattended framing survives the clause (Issue #778)", async () => {
  // Only the narration clause goes. Each prompt still has to know that no
  // operator is watching and what it does instead of asking.
  for (const subject of SUBJECTS) {
    const text = await promptText(subject.prompt);
    assertStringIncludes(text, subject.keeps);
    // And each defers to the block that actually governs the output.
    assertStringIncludes(text, "Response Verbosity block above governs");
  }
});

Deno.test("phase prompts - every verbosity level bans commentary and none asks for it (Issue #778)", async () => {
  // The contradiction is between the template and the substituted block, so
  // the block is checked at every level the builder can render: `standard` is
  // what these phases actually get, and no other level asks for narration
  // either, so threading a configured level through later (#798) cannot
  // reintroduce the contradiction.
  const levels: (VerbosityLevel | undefined)[] = [
    undefined,
    "minimal",
    "concise",
    "standard",
    "verbose",
  ];
  for (const level of levels) {
    const block = buildVerbosityBlock(level).toLowerCase();
    for (const clause of NARRATION_CLAUSES) {
      assertEquals(
        block.includes(clause),
        false,
        `the ${level ?? "default"} verbosity block must not ask for narration`,
      );
    }
  }
  assertStringIncludes(
    buildVerbosityBlock("standard").toLowerCase(),
    NO_COMMENTARY_CLAUSE,
  );

  // And the rendered surface: the template plus the block these phases
  // really receive carries the ban and nothing that contradicts it.
  for (const subject of SUBJECTS) {
    const text = await promptText(subject.prompt);
    const rendered = text.replace(
      "{{VERBOSITY_INSTRUCTIONS}}",
      buildVerbosityBlock("standard"),
    ).toLowerCase();
    assertStringIncludes(rendered, NO_COMMENTARY_CLAUSE);
    for (const clause of NARRATION_CLAUSES) {
      assertEquals(rendered.includes(clause), false, subject.prompt);
    }
  }
});
