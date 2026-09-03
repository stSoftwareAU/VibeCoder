/**
 * Tests for the grill-me narration contradiction (Issue #759).
 *
 * A grill-me round renders the level the global `.config.json` `verbosity`
 * carries, which defaults to `standard` — "no running commentary while you
 * work" — into `{{VERBOSITY_INSTRUCTIONS}}`. Up to v14 the template asked the
 * agent to "Narrate briefly as you go", so one rendered prompt both asked
 * for and forbade narration. v15 drops the narration clause, keeping the ban
 * as the single instruction on the subject.
 *
 * The tests build a real round through `buildGrillMePrompt()` with the block
 * `buildVerbosityBlock()` actually produces for the resolved level, so they
 * exercise the same path the worker renders each round rather than reading
 * files directly.
 *
 * Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";
import { buildGrillMePrompt } from "../lib/grill_me_processor.ts";
import { buildVerbosityBlock } from "../lib/prompt_builder.ts";
import { resolveVerbosity } from "../lib/verbosity.ts";
import type { VerbosityLevel } from "../types.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** The clause v14 carried and v15 drops. */
const NARRATION_CLAUSE = "Narrate briefly as you go";

/** The clause the `standard` verbosity block injects. */
const NO_COMMENTARY_CLAUSE = "no running commentary while you work";

/** Builds a round with the verbosity block the worker renders for a level. */
async function buildRound(level?: VerbosityLevel): Promise<string> {
  const result = await buildGrillMePrompt({
    roundNumber: 1,
    maxRounds: 5,
    repo: "owner/repo",
    issueNumber: 759,
    issueTitle: "Add a widget",
    issueBody: "The widget should exist.",
    commentHistory: "(none)",
    codingGuidelines: "Guidelines here.",
    verbosityInstructions: buildVerbosityBlock(level),
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

Deno.test("grill-me - the latest version is v15 or newer", async () => {
  const result = await getLatestVersion("grill-me", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const version = parseInt(result.value.replace("v", ""), 10);
  assertEquals(
    version >= 15,
    true,
    `Expected grill-me >= v15, got ${result.value}`,
  );
});

Deno.test("grill-me - the latest version never asks for narration", async () => {
  const latest = await getLatestVersion("grill-me", PROMPTS_DIR);
  assertEquals(latest.ok, true);
  if (!latest.ok) return;
  const result = await loadPrompt("grill-me", latest.value, PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(
    result.value.includes(NARRATION_CLAUSE),
    false,
    `${latest.value} must not ask for narration while the rendered ` +
      "verbosity block forbids it",
  );
});

Deno.test("grill-me - the latest version keeps the unattended framing", async () => {
  const latest = await getLatestVersion("grill-me", PROMPTS_DIR);
  assertEquals(latest.ok, true);
  if (!latest.ok) return;
  const result = await loadPrompt("grill-me", latest.value, PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  // Only the narration clause goes: the round still has to know that no
  // operator is watching and that a question is asked by posting a comment.
  assertStringIncludes(
    result.value,
    "You run unattended with no operator present",
  );
  assertStringIncludes(
    result.value,
    "You ask a question by posting a comment and waiting for the next round.",
  );
});

Deno.test("resolveVerbosity - grill-me still renders the standard block that bans commentary", () => {
  // The contradiction only exists because an unconfigured repo falls back to
  // `standard`. Pin that fallback so the rendered-round test below stays the
  // real case.
  assertEquals(resolveVerbosity(), "standard");
});

Deno.test("buildGrillMePrompt - a standard round forbids narration and never asks for it", async () => {
  const rendered = await buildRound("standard");
  // The ban the standard verbosity block injects is still there ...
  assertStringIncludes(rendered, NO_COMMENTARY_CLAUSE);
  // ... and nothing else in the rendered surface contradicts it.
  assertEquals(
    rendered.includes(NARRATION_CLAUSE),
    false,
    "The rendered round must not both ask for and forbid narration",
  );
});

Deno.test("buildGrillMePrompt - no verbosity level asks the round to narrate", async () => {
  const levels: (VerbosityLevel | undefined)[] = [
    undefined,
    "minimal",
    "concise",
    "standard",
    "verbose",
  ];
  for (const level of levels) {
    const rendered = await buildRound(level);
    assertEquals(
      rendered.includes(NARRATION_CLAUSE),
      false,
      `A ${level ?? "default"} round must not ask for narration`,
    );
  }
});

Deno.test("grill-me v14 - stays immutable", async () => {
  const result = await loadPrompt("grill-me", "v14", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  // Committed versions never change: v14 keeps the clause v15 drops.
  assertStringIncludes(result.value, NARRATION_CLAUSE);
});
