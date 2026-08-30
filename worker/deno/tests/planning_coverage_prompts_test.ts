/**
 * Tests for the coverage-table instructions added in planning v22 and
 * planning_critique v6 (Issue #520).
 *
 * The previous versions stay immutable (Issue #235) and are read straight from
 * disk as the negative control: each test asserts the instruction is absent
 * from the old template and present in the built (latest) prompt, so the test
 * fails against the unfixed templates.
 *
 * The last test is the anti-drift one: the example table the publish prompt
 * tells the model to copy is fed to the real gate, so a prompt that teaches a
 * shape the gate rejects fails here rather than in production.
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildPlanningCritiquePrompt,
  buildPlanningPrompt,
} from "../lib/prompt_builder.ts";
import { judgePlanCoverage } from "../lib/plan_coverage_gate.ts";

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

Deno.test("planning_critique v6 - the publish turn is told to post a coverage table", async () => {
  const prompt = await buildCritique();
  assertStringIncludes(prompt, "## Plan Coverage");
  assertStringIncludes(prompt, "| Ask | Covered by | Notes |");
  assertStringIncludes(prompt, "Out of scope");

  const v5 = await Deno.readTextFile(`${PROMPTS_DIR}/planning_critique/v5.md`);
  assertEquals(v5.includes("## Plan Coverage"), false);
});

Deno.test("planning_critique v6 - each sub-issue's Context names the ask it covers", async () => {
  const prompt = await buildCritique();
  assertStringIncludes(prompt, "Covers ask:");

  const v5 = await Deno.readTextFile(`${PROMPTS_DIR}/planning_critique/v5.md`);
  assertEquals(v5.includes("Covers ask:"), false);
});

Deno.test("planning v22 - the draft turn lists the asks and traces each sub-issue to one", async () => {
  const prompt = await buildDraft();
  assertStringIncludes(prompt, "coverage table");
  assertStringIncludes(prompt, "Covers ask:");

  const v21 = await Deno.readTextFile(`${PROMPTS_DIR}/planning/v21.md`);
  assertEquals(v21.includes("Covers ask:"), false);
});

Deno.test("planning_critique v6 - the example table it teaches passes the real gate", async () => {
  const prompt = await buildCritique();
  const verdict = judgePlanCoverage(prompt);
  assert(
    verdict.tableFound,
    "the built publish prompt carries no table the gate can read",
  );
  assertEquals(verdict.offenders, []);
  assertEquals(verdict.passed, true);
});
