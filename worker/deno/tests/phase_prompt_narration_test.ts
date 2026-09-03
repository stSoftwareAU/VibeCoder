/**
 * The narration contradiction, in the three prompts #759 did not reach
 * (Issue #778).
 *
 * Every phase prompt carries `{{VERBOSITY_INSTRUCTIONS}}` on line 1, and the
 * block substituted there says "no running commentary while you work". Three
 * prompts then asked for exactly that commentary:
 *
 *   - `ci_fix/v14.md:72`   — "narrating briefly as you go"
 *   - `pr_feedback/v13.md:8` — "Narrate briefly as you go (a short line …)"
 *   - `planning/v23.md:10`  — "Narrate briefly as you go."
 *
 * All three render the `standard` block, because `resolveVerbosity` has one
 * non-test call site (`execute_claude_phase.ts`, for `issue`) and no other
 * builder is passed a level — #798 deleted the per-phase default map that
 * claimed otherwise. So one rendered prompt both asked for and forbade
 * narration.
 *
 * These are the equivalent of `grill_me_narration_test.ts` for those three:
 * the latest version never asks for narration, the retired version keeps the
 * clause (committed versions are immutable), and the unattended framing each
 * prompt needs survives — only the narration clause goes.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";
import { buildVerbosityBlock } from "../lib/prompt_builder.ts";
import type { VerbosityLevel } from "../types.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** The clauses the retired versions carried, lower-cased for matching. */
const NARRATION_CLAUSES = [
  "narrate briefly as you go",
  "narrating briefly as you go",
];

/** The clause the `standard` verbosity block injects. */
const NO_COMMENTARY_CLAUSE = "no running commentary while you work";

/** One prompt, the version that dropped the clause, and the one before it. */
interface Subject {
  prompt: string;
  /** The lowest version that must not carry the clause. */
  minimum: number;
  /** The retired version, which must keep it. */
  retired: string;
  /** Framing the new version must not have lost with the clause. */
  keeps: string;
}

const SUBJECTS: Subject[] = [
  {
    prompt: "ci_fix",
    minimum: 15,
    retired: "v14",
    keeps: "You run unattended with no operator to consult.",
  },
  {
    prompt: "pr_feedback",
    minimum: 14,
    retired: "v13",
    keeps: "recording assumptions in your reply rather than waiting",
  },
  {
    prompt: "planning",
    minimum: 24,
    retired: "v23",
    keeps: "record an assumption in the draft and proceed",
  },
];

/** The latest text of one prompt, and the version it came from. */
async function latestText(
  prompt: string,
): Promise<{ version: string; text: string }> {
  const latest = await getLatestVersion(prompt, PROMPTS_DIR);
  assertEquals(latest.ok, true, `no latest version for ${prompt}`);
  if (!latest.ok) throw new Error(latest.error.message);
  const loaded = await loadPrompt(prompt, latest.value, PROMPTS_DIR);
  assertEquals(loaded.ok, true, `cannot load ${prompt} ${latest.value}`);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return { version: latest.value, text: loaded.value };
}

Deno.test("phase prompts - the latest version of each is the one that dropped the clause (Issue #778)", async () => {
  for (const subject of SUBJECTS) {
    const { version } = await latestText(subject.prompt);
    const number = parseInt(version.replace("v", ""), 10);
    assert(
      number >= subject.minimum,
      `Expected ${subject.prompt} >= v${subject.minimum}, got ${version}`,
    );
  }
});

Deno.test("phase prompts - no latest version asks the run to narrate (Issue #778)", async () => {
  for (const subject of SUBJECTS) {
    const { version, text } = await latestText(subject.prompt);
    const lower = text.toLowerCase();
    for (const clause of NARRATION_CLAUSES) {
      assertEquals(
        lower.includes(clause),
        false,
        `${subject.prompt} ${version} must not ask for narration while the ` +
          `rendered verbosity block forbids it`,
      );
    }
  }
});

Deno.test("phase prompts - the unattended framing survives the clause (Issue #778)", async () => {
  // Only the narration clause goes. Each prompt still has to know that no
  // operator is watching and what it does instead of asking.
  for (const subject of SUBJECTS) {
    const { text } = await latestText(subject.prompt);
    assertStringIncludes(text, subject.keeps);
    // And each defers to the block that actually governs the output.
    assertStringIncludes(text, "Response Verbosity block above governs");
  }
});

Deno.test("phase prompts - the retired versions stay immutable (Issue #778)", async () => {
  for (const subject of SUBJECTS) {
    const result = await loadPrompt(
      subject.prompt,
      subject.retired,
      PROMPTS_DIR,
    );
    assertEquals(result.ok, true);
    if (!result.ok) continue;
    const lower = result.value.toLowerCase();
    assert(
      NARRATION_CLAUSES.some((clause) => lower.includes(clause)),
      `${subject.prompt} ${subject.retired} must keep the clause its ` +
        `successor drops — committed versions never change`,
    );
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

  // And the rendered surface: the latest template plus the block these
  // phases really receive carries the ban and nothing that contradicts it.
  for (const subject of SUBJECTS) {
    const { text } = await latestText(subject.prompt);
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
