/**
 * Tests for the "no change on a request-changes review" prompt rule
 * (Issue #3246).
 *
 * A PR-feedback run on a reviewer's `CHANGES_REQUESTED` review used to be
 * able to end with no commit and no `.pr_response_message`, and the worker
 * then posted the neutral "could not identify a code change" reply — so the
 * finding came back on the next review even though the review that raised
 * it had already been dismissed and could not be rediscovered. The
 * `pr_feedback` prompt now tells the agent explicitly that a finding naming
 * a file, a line and a fix is never left unanswered: fix and push it, or
 * rebut it by name in `.pr_response_message` with evidence, because a run
 * that does neither gets no reply of its own — the worker re-runs the agent
 * once on the same review, and escalates to `needs-human` if that also
 * produces nothing.
 *
 * The assertions run against the current template, so a later edit that
 * drops the rule fails in CI.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function load(type: string): Promise<string> {
  const result = await loadPrompt(type, PROMPTS_DIR);
  assertEquals(result.ok, true, `${type} failed to load`);
  if (!result.ok) throw new Error(`${type} failed to load`);
  return result.value;
}

function lower(text: string): string {
  return text.toLowerCase();
}

Deno.test("pr_feedback - a change request is never answered with no change (Issue #3246)", async () => {
  const body = lower(await load("pr_feedback"));

  for (
    const required of [
      '"no change" is not an answer to a change request',
      "rebut that finding by name",
      "re-runs you once",
      "it labels the pr `needs-human` instead of replying",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});
