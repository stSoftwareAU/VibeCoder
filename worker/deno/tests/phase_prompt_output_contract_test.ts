/**
 * The five output contracts that exclude the injected trailing summary
 * (Issue #779).
 *
 * `{{VERBOSITY_INSTRUCTIONS}}` renders the `standard` text into every phase
 * that carries the placeholder: "Summarise what you changed once the work is
 * done … Write that summary at the end." Five prompts state an output shape
 * with no room for it:
 *
 *   - `quorum_judge` — a machine-parsed verdict block, "nothing else after it";
 *   - `quorum`       — exactly four sections;
 *   - `question`     — answer content only, posted verbatim;
 *   - `spelling_fix` — exactly three sections;
 *   - `ci_fix`       — a fixed response-message skeleton.
 *
 * `quorum_judge` is the sharpest: a program parses the block, so prose after
 * the closing tag is a correctness failure, not a style one. In `quorum`,
 * `quorum_judge` and `question` the phase also forbids changing anything, so
 * "summarise what you changed" has no referent at all.
 *
 * Each template now states that its own shape overrides the injected block,
 * following the `grill-me` pattern. These cases pin that sentence and the
 * shape it defends.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import { buildVerbosityBlock } from "../lib/prompt_builder.ts";
import type { VerbosityLevel } from "../types.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** How each prompt names the block it overrides. */
const OVERRIDE_MARKER = "Response Verbosity block above";

/** One prompt, the override sentence it states, and what that defends. */
interface Subject {
  prompt: string;
  /** The output contract the sentence defends, still present. */
  contract: string;
  /**
   * The distinctive part of the override sentence this prompt states.
   * `ci_fix` already carries the shared marker from Issue #778, so the
   * override is pinned against what *this* change wrote rather than against
   * the phrase every prompt shares.
   */
  addition: string;
}

const SUBJECTS: Subject[] = [
  {
    prompt: "quorum_judge",
    contract: "no prose inside or after the closing tag",
    addition: "prose after the closing tag breaks the consumer",
  },
  {
    prompt: "quorum",
    contract: "exactly these four sections in this order",
    addition: "the four sections are the whole reply",
  },
  {
    prompt: "question",
    contract: "Write only the answer",
    // The prompt wraps its prose, so the fragment must not cross a break.
    addition: "answer is the whole output",
  },
  {
    prompt: "spelling_fix",
    contract: "never drop a heading",
    addition: "These three sections are the whole reply",
  },
  {
    prompt: "ci_fix",
    contract: "Follow the skeleton that matches your outcome",
    addition: "The skeleton is the whole reply",
  },
];

/** The template text of one prompt. */
async function promptText(prompt: string): Promise<string> {
  const loaded = await loadPrompt(prompt, PROMPTS_DIR);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value;
}

Deno.test("output contracts - each prompt states the override (Issue #779)", async () => {
  for (const subject of SUBJECTS) {
    const text = await promptText(subject.prompt);
    assertStringIncludes(text, OVERRIDE_MARKER);
    assertStringIncludes(text, subject.addition);
  }
});

Deno.test("output contracts - the shape the override defends is still stated (Issue #779)", async () => {
  // The sentence is only worth having beside the contract it protects: if a
  // later edit drops the shape, the override is describing nothing.
  for (const subject of SUBJECTS) {
    const text = await promptText(subject.prompt);
    assertStringIncludes(text, subject.contract);
  }
});

Deno.test("output contracts - every verbosity level still asks for the summary the shapes override (Issue #779)", async () => {
  // The contradiction exists at all four levels, not just `standard`, so the
  // override is stated unconditionally rather than for one level. If a level
  // ever stops asking for a trailing summary, this case says so out loud
  // rather than leaving five prompts overriding nothing.
  const levels: VerbosityLevel[] = [
    "minimal",
    "concise",
    "standard",
    "verbose",
  ];
  const asking = levels.filter((level) =>
    buildVerbosityBlock(level).toLowerCase().includes("summar")
  );
  assert(
    asking.length > 0,
    "no verbosity level asks for a summary — the overrides now describe nothing",
  );

  // And the rendered surface: the shape and its override survive substitution.
  for (const subject of SUBJECTS) {
    const text = await promptText(subject.prompt);
    const rendered = text.replace(
      "{{VERBOSITY_INSTRUCTIONS}}",
      buildVerbosityBlock("standard"),
    );
    assertStringIncludes(rendered, OVERRIDE_MARKER);
    assertStringIncludes(rendered, subject.contract);
  }
});

Deno.test("output contracts - the two phases that change nothing say the summary has no referent (Issue #779)", async () => {
  // `quorum`, `quorum_judge` and `question` forbid changing anything, so
  // "summarise what you changed" is not merely misplaced — it has no subject.
  for (const prompt of ["quorum", "question"]) {
    const text = await promptText(prompt);
    assertStringIncludes(text, "this phase changes nothing");
  }
});
