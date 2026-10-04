/**
 * Issue #3196: a Standards `violation` in the PR's own lines may not "stand".
 *
 * The gate half lives in `independent_review_gate_test.ts` and
 * `closure_verdict_test.ts`. These tests pin the instructions a run writes its
 * summary from — the issue prompt, the template both gates print, and the
 * closure-verdict recovery brief — so none of them invites the run to leave a
 * self-flagged breach standing again.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import { REVIEW_BLOCK_TEMPLATE } from "../lib/review_block_template.ts";
import { buildClosureVerdictPrompt } from "../lib/closure_verdict_recovery.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** The issue prompt, whitespace flattened so a line wrap cannot break a match. */
async function loadIssuePrompt(): Promise<string> {
  const result = await loadPrompt("issue", PROMPTS_DIR);
  assertEquals(result.ok, true, "issue prompt failed to load");
  if (!result.ok) throw new Error("issue prompt failed to load");
  return result.value.replace(/\s+/g, " ");
}

Deno.test("Issue #3196 - the issue prompt offers only fixed or filed as a violation's reason", async () => {
  const body = await loadIssuePrompt();

  assert(
    !/why it stands/i.test(body),
    "the prompt still offers 'why it stands' as a violation's reason",
  );
  assertStringIncludes(body, "reason: fixed in this diff");
  assertStringIncludes(body, "reason: pre-existing, filed #<n>");
  assertStringIncludes(
    body,
    "A breach in a line this diff adds or changes may not be deferred",
  );
});

Deno.test("Issue #3196 - the template both gates print records a fix, not a standing breach", () => {
  assert(!/why it stands/i.test(REVIEW_BLOCK_TEMPLATE));
  assertStringIncludes(REVIEW_BLOCK_TEMPLATE, "reason: fixed in this diff");
});

Deno.test("Issue #3196 - the closure-verdict brief asks for fixed or filed", () => {
  const brief = buildClosureVerdictPrompt({
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 3196,
    criteria: ["one"],
    problems: [],
  }).replace(/\s+/g, " ");

  assertStringIncludes(brief, "fixed in this diff");
  assertStringIncludes(brief, "pre-existing, filed #<n>");
});
