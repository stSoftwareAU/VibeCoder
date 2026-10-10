/**
 * Tests for the phantom-regression-test and contract-masking-stub rules
 * (Issue #3011).
 *
 * Worker PRs shipped a PR body and code anchors naming a regression test file
 * that did not exist (GRQ#5135) and a stub more permissive than the real
 * GRQ-validation binary it stood in for (GRQ#5137). Both defects let a PR
 * look reviewed and tested when it was not. This pins the two rules — "a
 * named test must exist" and "a stub mirrors the real callee's contract" —
 * on every surface that carries them: the human standards doc, its injected
 * twin in the coding_guidelines prompt, the issue prompt's own wording, and
 * the standards-reviewer sub-agent's prompt. A later edit that drops either
 * rule from any of these surfaces fails here.
 */

import { assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import {
  buildIssueReviewerAgents,
  STANDARDS_REVIEWER_AGENT_NAME,
} from "../lib/issue_executor_agents.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

async function load(type: string): Promise<string> {
  const result = await loadPrompt(type, PROMPTS_DIR);
  if (!result.ok) throw new Error(`${type} failed to load`);
  return result.value;
}

Deno.test("Issue #3011 - CODING-STANDARDS.md requires a named test to exist and a stub to mirror its callee", async () => {
  const body = await Deno.readTextFile(`${REPO_ROOT}CODING-STANDARDS.md`);

  for (
    const required of [
      "**A named test must exist.**",
      "named-but-absent test",
      "**A stub mirrors the real callee's contract.**",
      "more permissive than the",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});

Deno.test("Issue #3011 - coding_guidelines prompt carries the same named-test and stub-contract rules", async () => {
  const body = await load("coding_guidelines");

  for (
    const required of [
      "**A named test must exist.**",
      "named-but-absent test",
      "**A stub mirrors the real callee's contract.**",
      "more permissive than the",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});

Deno.test("Issue #3011 - issue prompt requires a named test to exist and a stub to mirror its callee", async () => {
  const body = await load("issue");

  for (
    const required of [
      "named-but-absent test",
      "git ls-files <path>",
      "more permissive than the real callee",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});

Deno.test("Issue #3011 - the standards-reviewer sub-agent prompt flags named-but-absent tests and permissive stubs", () => {
  const reviewer = buildIssueReviewerAgents(
    "sonnet",
  )[STANDARDS_REVIEWER_AGENT_NAME]!;

  for (
    const required of [
      "named-but-absent test",
      "more permissive than the real callee",
    ]
  ) {
    assertStringIncludes(reviewer.prompt, required);
  }
});
