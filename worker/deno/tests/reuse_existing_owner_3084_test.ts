/**
 * Tests for "call the existing owner, never copy it" (Issue #3084).
 *
 * Fleet PRs re-implemented an in-repo helper by hand instead of calling it —
 * GRQ-AutoTrader#2218 copied `buy_order`'s candidate-ordering comparator by
 * hand rather than calling it, and dropped its unrated-last rule in the
 * copy, and #2210 built the star rating by hand instead of reusing the
 * shared `StarRating` component. Neither diff was flagged, because
 * nothing in the `issue` or `pr_feedback` templates, the Spec reviewer brief,
 * or `CODING-STANDARDS.md` named an in-repo helper, component or policy
 * re-implemented by hand as a departure. These tests pin the rule the
 * templates, the shared Spec reviewer prompt constant and the coding
 * standards now carry, so a later edit that drops it fails here.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import {
  buildIssueRunAgents,
  SPEC_REVIEWER_AGENT_NAME,
} from "../lib/issue_executor_agents.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function load(type: string): Promise<string> {
  const result = await loadPrompt(type, PROMPTS_DIR);
  assertEquals(result.ok, true, `${type} failed to load`);
  if (!result.ok) throw new Error(`${type} failed to load`);
  return result.value;
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

Deno.test("issue - step 1 makes the agent call the existing owner instead of copying it", async () => {
  const body = normalise(await load("issue"));

  for (
    const required of [
      "call the existing owner",
      "formats, orders, ranks, validates or decides",
      "every component or function the issue names",
      "implementation section",
      "widen its visibility",
      "`pub(crate)` → `pub`",
      "a component the issue says to reuse is a stated requirement",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});

Deno.test("issue - the Spec reviewer brief treats a named reuse as a criterion", async () => {
  const body = normalise(await load("issue"));

  assertStringIncludes(
    body,
    "a helper or component the issue says to reuse counts as a stated criterion",
  );
});

Deno.test("pr_feedback - a fix calls the owner and replaces a flagged copy", async () => {
  const body = normalise(await load("pr_feedback"));

  for (
    const required of [
      "call the existing owner",
      "widen its visibility",
      "replace the copy with a call to the owner",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});

Deno.test("CODING-STANDARDS - the over-engineering checklist flags an in-repo helper copied by hand", async () => {
  const text = await Deno.readTextFile(
    new URL("../../../CODING-STANDARDS.md", import.meta.url),
  );
  const body = normalise(text);

  assertStringIncludes(body, "flag these four departures");
  assertStringIncludes(
    body,
    "an in-repo helper, component or policy re-implemented by hand instead of called",
  );
});

Deno.test("spec-reviewer agent - a named reuse is a stated requirement", () => {
  const agents = buildIssueRunAgents({
    executorSplit: false,
    reviewerAgents: true,
  });
  assert(agents, "the reviewer key on must build definitions");
  const prompt = normalise(agents[SPEC_REVIEWER_AGENT_NAME]!.prompt);

  assertStringIncludes(prompt, "says to reuse is a stated requirement");
  assertStringIncludes(
    prompt,
    "re-implements it by hand instead of calling it is not `met`",
  );
});
