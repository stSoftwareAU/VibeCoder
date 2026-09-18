/**
 * Tests for the advisor/executor instructions in the `issue` prompt
 * (Issue #2343, part of #2320).
 *
 * Issue #2342 hands a split run `--agents` executor definitions; without the
 * block these tests pin, the advisor is given executors and never told to use
 * them. The block is gated on the same boolean as those definitions, so the
 * assertions cover both sides of the gate: a key-off run renders exactly the
 * prompt it renders today, and a key-on run carries every rule the split
 * depends on while the Spec and Standards reviewers are left untouched.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildIssuePrompt, type PromptParts } from "../lib/prompt_builder.ts";
import { ISSUE_EXECUTOR_AGENT_NAME } from "../lib/issue_executor_agents.ts";
import { ISSUE_EXECUTOR_SPLIT_INSTRUCTIONS } from "../lib/issue_executor_split_prompt.ts";
import { loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

function unwrap(
  result: { ok: true; value: PromptParts } | { ok: false; error: Error },
): PromptParts {
  if (!result.ok) throw result.error;
  return result.value;
}

async function issuePrompt(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  return unwrap(
    await buildIssuePrompt({
      repo: "owner/repo",
      issueNumber: "42",
      issueTitle: "Fix the parser",
      issueBody: "The date parser drops the year.",
      issueLabels: "bug",
      qualityInstructions: "Run ./quality.sh",
      promptsDir: PROMPTS_DIR,
      ...overrides,
    }),
  ).prompt;
}

/**
 * Replace this build's fence nonce, which is random per invocation, so two
 * prompts built from the same inputs compare on their text alone.
 */
function stableNonce(prompt: string): string {
  return prompt.replace(/[0-9a-f]{12}/g, "NONCE");
}

/** The named `##` section of an assembled prompt, up to the next `##`. */
function section(prompt: string, heading: string): string {
  const start = prompt.indexOf(`\n${heading}\n`);
  assert(start >= 0, `prompt carries no ${heading} section`);
  const rest = prompt.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  return end < 0 ? rest : rest.slice(0, end);
}

// ---------------------------------------------------------------------------
// Key off — the prompt is exactly what it is without the split
// ---------------------------------------------------------------------------

Deno.test("issue prompt - key off renders no executor block and no stray gap", async () => {
  const off = await issuePrompt({ issueExecutorSplit: false });

  assertEquals(
    off.includes("## Advisor and Executors"),
    false,
    "a key-off run must not carry the advisor/executor block",
  );
  // The placeholder sits between these two sections, so an empty replacement
  // has to leave their adjacency — one blank line — untouched.
  assertStringIncludes(
    off,
    "</use_parallel_tool_calls>\n\n## Long-Horizon Execution\n",
  );
  assertEquals(
    off.includes("{{EXECUTOR_SPLIT_INSTRUCTIONS}}"),
    false,
    "the placeholder must be substituted, not shipped",
  );
});

Deno.test("issue prompt - an omitted split flag renders the same prompt as an explicit false", async () => {
  const omitted = await issuePrompt();
  const explicit = await issuePrompt({ issueExecutorSplit: false });
  assertEquals(stableNonce(omitted), stableNonce(explicit));
});

// ---------------------------------------------------------------------------
// Key on — every rule the split depends on
// ---------------------------------------------------------------------------

Deno.test("issue prompt - key on carries the advisor/executor rules", async () => {
  const on = await issuePrompt({ issueExecutorSplit: true });
  const block = section(on, "## Advisor and Executors — You Plan, They Edit");

  // The advisor edits nothing itself.
  assertStringIncludes(block, "Make no `Edit` or `Write` call yourself.");
  // One executor per independent group of files, no concurrency cap.
  assertStringIncludes(block, "One executor per independent group of files.");
  assertStringIncludes(
    block,
    "no other executor in the same run edits any file in it",
  );
  assertStringIncludes(block, "There is no cap on how many run concurrently");
  // Executors run the tests covering their edits; the advisor runs the gate.
  assertStringIncludes(block, "the tests covering those files");
  assertStringIncludes(
    block,
    "You run the full quality gate once, at the end.",
  );
  assertStringIncludes(block, "`./quality.sh`");
  // The diff review, the two re-tasks, and what the third mismatch does.
  assertStringIncludes(block, "Read each executor's diff before that gate.");
  assertStringIncludes(block, "at most twice");
  assertStringIncludes(
    block,
    "On a\n  third mismatch, write it to the run log",
  );
  assertStringIncludes(
    block,
    "An executor that errors, or returns no result, counts as one mismatch",
  );
});

Deno.test("issue prompt - the block dispatches the agent name the executors register under", async () => {
  const on = await issuePrompt({ issueExecutorSplit: true });
  assertStringIncludes(
    on,
    `subagent_type: "${ISSUE_EXECUTOR_AGENT_NAME}"`,
  );
});

Deno.test("issue prompt - the key-on prompt is the key-off prompt plus the block", async () => {
  const off = await issuePrompt({ issueExecutorSplit: false });
  const on = await issuePrompt({ issueExecutorSplit: true });

  assertEquals(
    stableNonce(on),
    stableNonce(off).replace(
      "</use_parallel_tool_calls>\n\n## Long-Horizon Execution\n",
      `</use_parallel_tool_calls>\n\n${ISSUE_EXECUTOR_SPLIT_INSTRUCTIONS}\n\n## Long-Horizon Execution\n`,
    ),
    "the split must add the block and change nothing else",
  );
});

Deno.test("issue prompt - the independent reviewers are unchanged by the split", async () => {
  const off = await issuePrompt({ issueExecutorSplit: false });
  const on = await issuePrompt({ issueExecutorSplit: true });
  const heading =
    "## Independent Review Before the PR — Spec and Standards on Separate Axes";

  const reviewSection = section(on, heading);
  assertEquals(reviewSection, section(off, heading));
  assertStringIncludes(reviewSection, "**Spec reviewer**");
  assertStringIncludes(reviewSection, "**Standards reviewer**");
  // And the block says so, rather than leaving the advisor to guess.
  assertStringIncludes(
    section(on, "## Advisor and Executors — You Plan, They Edit"),
    "The reviewers are not executors.",
  );
});

// ---------------------------------------------------------------------------
// The delegation cap is lifted only where the block is
// ---------------------------------------------------------------------------

Deno.test("coding guidelines - the delegation cap stands, with the block as its only exception", async () => {
  const loaded = await loadPrompt("coding_guidelines", PROMPTS_DIR);
  assertEquals(loaded.ok, true, "coding_guidelines failed to load");
  if (!loaded.ok) throw loaded.error;

  // The cap itself is untouched — every phase still reads it.
  assertStringIncludes(loaded.value, "**Cap delegation.**");
  assertStringIncludes(
    loaded.value,
    "Spawn a\n  subagent only when the task genuinely needs isolated parallel exploration",
  );
  // The lift is conditional on a section only a key-on `issue` run carries.
  assertStringIncludes(
    loaded.value,
    "the one exception is a run whose\n  phase prompt carries an **Advisor and Executors** section",
  );
  // The measured-harmful 4.8-era encouragement stays out (docs/MODEL-AND-CACHING.md).
  assertEquals(loaded.value.includes("delegate readily"), false);
});

Deno.test("other phases carry no Advisor and Executors section, so the cap is not lifted for them", async () => {
  for (const phase of ["ci_fix", "pr_feedback", "planning", "question"]) {
    const loaded = await loadPrompt(phase, PROMPTS_DIR);
    assertEquals(loaded.ok, true, `${phase} failed to load`);
    if (!loaded.ok) throw loaded.error;
    assertEquals(
      loaded.value.includes("Advisor and Executors"),
      false,
      `${phase} must not lift the delegation cap`,
    );
  }
});
