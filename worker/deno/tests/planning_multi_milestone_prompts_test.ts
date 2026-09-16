/**
 * Tests for the file-area grouping instructions the planning prompts carry
 * (Issue #2174, part of #2163).
 *
 * The draft prompt must teach the grouping rule — the housekeeping file list,
 * the merge-on-overlap rule, the foundation group and the four-milestone cap —
 * and the critique/publish prompt must teach the `## Milestones` table the
 * structural gate in `plan_milestone_groups.ts` reads back.
 *
 * The last test is the anti-drift one: every example table the publish prompt
 * teaches is fed to the real parser and validator, so a prompt that teaches a
 * shape the gate rejects fails here rather than in production.
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildPlanningCritiquePrompt,
  buildPlanningPrompt,
} from "../lib/prompt_builder.ts";
import {
  extractMilestoneGroups,
  MAX_MILESTONE_GROUPS,
  validateMilestoneGroups,
} from "../lib/plan_milestone_groups.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** The header row of every `## Milestones` table the prompts teach. */
const MILESTONES_HEADER = "| Milestone | File area | Sub-issues |";

async function buildDraft(milestoneTitle?: string): Promise<string> {
  const built = await buildPlanningPrompt({
    repo: "owner/repo",
    issueNumber: "99",
    issueTitle: "Big feature",
    issueBody: "Body",
    issueLabels: "enhancement",
    complexityContext: "Touches nine modules",
    ...(milestoneTitle ? { milestoneTitle } : {}),
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(built.ok, true);
  if (!built.ok) throw new Error("draft prompt failed to build");
  return built.value.prompt;
}

async function buildCritique(milestoneTitle?: string): Promise<string> {
  const built = await buildPlanningCritiquePrompt({
    repo: "owner/repo",
    issueNumber: "99",
    issueTitle: "Big feature",
    issueBody: "Body",
    issueLabels: "enhancement",
    ...(milestoneTitle ? { milestoneTitle } : {}),
    draftPlan: "draft",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(built.ok, true);
  if (!built.ok) throw new Error("critique prompt failed to build");
  return built.value.prompt;
}

Deno.test("planning - the draft turn groups sub-issues by file area", async () => {
  const prompt = await buildDraft("v2.0");
  assertStringIncludes(prompt, "Group sub-issues by file area");
  // Every sub-issue records the area it touches, so the groups can be checked.
  assertStringIncludes(prompt, "File area:");
});

Deno.test("planning - the draft turn is told which files are housekeeping", async () => {
  const prompt = await buildDraft();
  for (
    const housekeeping of [
      "`deno.json`",
      "`Cargo.toml`",
      "`*.lock`",
      "`CHANGELOG.md`",
      "`README.md`",
    ]
  ) {
    assertStringIncludes(prompt, housekeeping);
  }
  // One further file may be named, with a reason, in the sub-issue body.
  assertStringIncludes(prompt, "at most one further file");
});

Deno.test("planning - the draft turn merges overlapping groups and caps the plan at four milestones", async () => {
  const prompt = await buildDraft();
  assertStringIncludes(prompt, "same source or test file");
  assertStringIncludes(
    prompt.toLowerCase(),
    `at most ${MAX_MILESTONE_GROUPS} milestones`,
  );
  // Shared work becomes its own group its dependants depend on.
  assertStringIncludes(prompt, "foundation group");
  assertStringIncludes(prompt, "Depends on: <working title>");
  // A group of one sub-issue gets no milestone and does not count.
  assertStringIncludes(prompt, "does not count towards the cap");
});

Deno.test("planning - the draft turn skips grouping when the parent owns a milestone", async () => {
  const prompt = await buildDraft("v2.0");
  assertStringIncludes(prompt, "<milestone_instructions>");
  assertStringIncludes(prompt, "every sub-issue inherits it");
});

Deno.test("planning_critique - the attack list covers file overlap between groups", async () => {
  const prompt = await buildCritique("v2.0");
  assertStringIncludes(prompt, "**File overlap**");
  assertStringIncludes(prompt, "a group with no file area");
  assertStringIncludes(
    prompt,
    `more than ${MAX_MILESTONE_GROUPS} milestones`,
  );
});

Deno.test("planning_critique - the publish turn posts a Milestones table after the coverage table", async () => {
  const prompt = await buildCritique("v2.0");
  assertStringIncludes(prompt, "## Milestones");
  assertStringIncludes(prompt, MILESTONES_HEADER);
  // The summary comment carries it immediately after the coverage table.
  const coverage = prompt.indexOf("## Plan Coverage");
  assert(coverage >= 0, "the publish prompt lost its coverage table");
  assert(
    prompt.indexOf("## Milestones", coverage) > coverage,
    "the Milestones table must follow the coverage table",
  );
  // The worker owns milestone creation, so no `--milestone` for a group.
  assertStringIncludes(prompt, "The worker creates the milestones");
});

Deno.test("planning_critique - `--milestone` is still passed only when the parent owns a milestone", async () => {
  const prompt = await buildCritique();
  assertStringIncludes(
    prompt,
    "Omit `--milestone` only when no milestone instructions appear above.",
  );
});

Deno.test("planning_critique - every example Milestones table it teaches passes the real gate", async () => {
  const prompt = await buildCritique("v2.0");
  const headerOffsets = [
    ...prompt.matchAll(/\| Milestone \| File area \| Sub-issues \|/g),
  ]
    .map((m) => m.index ?? -1)
    .filter((i) => i >= 0);
  assert(
    headerOffsets.length > 0,
    "the built publish prompt teaches no `## Milestones` table",
  );

  for (const offset of headerOffsets) {
    const groups = extractMilestoneGroups(prompt.slice(offset));
    assert(groups !== null, "the gate could not read a taught table");
    assert(groups.length > 0, "a taught table has no rows");
    const published = [...new Set(groups.flatMap((g) => g.subIssueNumbers))];
    assert(published.length > 0, "a taught table names no sub-issues");
    assertEquals(validateMilestoneGroups(groups, published), []);
  }
});
