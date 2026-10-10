/**
 * Tests for the review-only-standards rule (Issue #3230).
 *
 * The Standards reviewer judged a `violation` only by its effect on
 * correctness, security or the stated requirements, so a rule a repository's
 * standards say only review enforces — no lint, formatter or CI check
 * catches it — fell through as `optional` and was never chased. A fleet PR
 * (GRQ-AutoTrader#2481, #2546) added a second `use` statement for a module
 * already importing from the same crate instead of merging the new names in,
 * breaching GRQ-AutoTrader's own "one `use` statement per module per file"
 * standard; `cargo fmt` sorted it without complaint and nothing in CI caught
 * it, so the breach landed and was only sent back by a human/fleet review
 * round. This pins the rule — a review-enforced standard is always a
 * `violation` when the diff breaches it, whatever its effect on correctness,
 * and the reviewer must name each review-enforced rule it checked on its
 * `clean` line — on every surface that carries it: the issue prompt's
 * independent-review bullet, the issue prompt's Instructions step 1 (which
 * now tells the agent to merge new names into a module's existing imports
 * rather than start a second import block), the standards-reviewer
 * sub-agent's prompt, and the issue-processing design doc.
 */

import { assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import {
  buildIssueReviewerAgents,
  STANDARDS_REVIEWER_AGENT_NAME,
} from "../lib/issue_executor_agents.ts";
import {
  flat,
  flatWholeFile,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function load(type: string): Promise<string> {
  const result = await loadPrompt(type, PROMPTS_DIR);
  if (!result.ok) throw new Error(`${type} failed to load`);
  return result.value;
}

Deno.test("Issue #3230 - issue prompt's independent-review bullet makes a review-enforced rule always a violation", async () => {
  const body = await load("issue");
  const text = flat(
    section(
      body,
      "Independent Review Before the PR — Spec and Standards on Separate Axes",
    ),
  );

  for (
    const required of [
      "**enforced by review**",
      "a `violation` whatever its effect on correctness",
      "each review-enforced rule it checked",
    ]
  ) {
    assertStringIncludes(text, required);
  }
});

Deno.test("Issue #3230 - issue prompt's Instructions step 1 tells the agent to extend a module's existing imports", async () => {
  const body = await load("issue");
  const text = flat(section(body, "Instructions"));

  for (
    const required of [
      "**Extend a module's existing imports.**",
      "does not merge them",
    ]
  ) {
    assertStringIncludes(text, required);
  }
});

Deno.test("Issue #3230 - the standards-reviewer sub-agent prompt names a review-enforced rule as always a violation", () => {
  const reviewer = buildIssueReviewerAgents(
    "sonnet",
  )[STANDARDS_REVIEWER_AGENT_NAME]!;
  // Text a module holds, not a section of a page: `flatWholeFile` is the
  // named exception (CODING-STANDARDS § Documentation-drift tests, cond. 1).
  const text = flatWholeFile(reviewer.prompt);

  for (
    const required of [
      "enforced by review",
      "whatever its effect on correctness",
      "never `optional`",
      "naming each review-enforced rule you checked",
    ]
  ) {
    assertStringIncludes(text, required);
  }
});

Deno.test("Issue #3230 - issue-processing.md documents the review-enforced rule for the Standards reviewer", async () => {
  const body = await readRepoDoc("docs/workflows/issue-processing.md");
  const text = flat(section(body, "Independent review on two axes"));

  assertStringIncludes(text, "**enforced by review**");
});

Deno.test("Issue #3230 - MODEL-AND-CACHING.md documents the review-enforced-rule exception", async () => {
  const body = await readRepoDoc("docs/MODEL-AND-CACHING.md");
  const text = flat(section(body, "Reviewer sub-agents (issue phase)"));

  assertStringIncludes(text, "only review enforces");
});
