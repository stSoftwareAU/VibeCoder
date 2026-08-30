/**
 * Tests for the MVP-slice instructions added in planning v23 and
 * planning_critique v7 (Issue #522).
 *
 * The previous versions stay immutable (Issue #235) and are read straight from
 * disk as the negative control: each test asserts the instruction is absent
 * from the old template and present in the built (latest) prompt, so the test
 * fails against the unfixed templates.
 *
 * The last test is the anti-drift one: the example summary comment the publish
 * prompt tells the model to copy is fed to the real gate, so a prompt that
 * teaches a shape the gate rejects fails here rather than in production.
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildPlanningCritiquePrompt,
  buildPlanningPrompt,
} from "../lib/prompt_builder.ts";
import { judgeMvpSlice } from "../lib/mvp_slice_gate.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function buildCritique(): Promise<string> {
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
  if (!built.ok) throw new Error("critique prompt failed to build");
  return built.value.prompt;
}

async function buildDraft(): Promise<string> {
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
  if (!built.ok) throw new Error("draft prompt failed to build");
  return built.value.prompt;
}

/**
 * Pull the example summary comment out of the built publish prompt — the
 * four-backtick fenced block carrying `## Plan published`.
 *
 * Feeding the *whole* prompt to the gate would judge the instructions rather
 * than the artefact they teach, so the example block is isolated first.
 */
function exampleSummaryComment(prompt: string): string {
  const blocks = prompt.split("````");
  const example = blocks.find((block) => block.includes("## Plan published"));
  assert(example, "the publish prompt carries no example summary comment");
  return example;
}

Deno.test("planning_critique v7 - the publish turn is told to mark one MVP slice", async () => {
  const prompt = await buildCritique();
  assertStringIncludes(prompt, "**MVP slice**");
  assertStringIncludes(prompt, "No independently valuable slice");

  const v6 = await Deno.readTextFile(`${PROMPTS_DIR}/planning_critique/v6.md`);
  assertEquals(v6.includes("MVP slice"), false);
});

Deno.test("planning_critique v7 - value ordering is bounded by the dependency edges", async () => {
  const prompt = await buildCritique();
  assertStringIncludes(prompt, "must not be listed before one it `Depends on");

  const v6 = await Deno.readTextFile(`${PROMPTS_DIR}/planning_critique/v6.md`);
  assertEquals(v6.includes("MVP-first"), false);
});

Deno.test("planning v23 - the draft turn names the MVP slice or says none exists", async () => {
  const prompt = await buildDraft();
  assertStringIncludes(prompt, "MVP slice");
  assertStringIncludes(prompt, "No independently valuable slice");

  const v22 = await Deno.readTextFile(`${PROMPTS_DIR}/planning/v22.md`);
  assertEquals(v22.includes("MVP slice"), false);
});

Deno.test("planning_critique v7 - the example summary it teaches passes the real gate", async () => {
  const example = exampleSummaryComment(await buildCritique());
  const verdict = judgeMvpSlice(example);
  assert(
    verdict.listFound,
    "the example summary carries no sub-issue list the gate can read",
  );
  assertEquals(verdict.offenders, []);
  assertEquals(verdict.markerCount, 1);
  assertEquals(verdict.passed, true);
});
