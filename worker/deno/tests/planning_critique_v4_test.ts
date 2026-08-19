/**
 * Tests for planning_critique v4 (Issue #3273).
 *
 * v4 adds a pre-publish prevention step to the publish turn: immediately before
 * running `gh issue create` for each sub-issue, the model must verify the final
 * body carries a filled `## Failure Detection` section — a concrete
 * test / CI gate / alert, or an explicit `N/A — <reason>` — and self-repair its
 * own draft (or block publishing that sub-issue) rather than publish a
 * non-conforming sub-issue and leave the deterministic post-publish gate
 * (`failure_detection_gate.ts`, Issue #3246) to catch it after the fact.
 *
 * The presence assertion is version-agnostic (it loads the latest
 * planning_critique prompt) so it keeps holding as the prompt evolves.
 *
 * v3 (and earlier) must remain immutable (Issue #235).
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("planning_critique v4 - loads via loadPrompt", async () => {
  const result = await loadPrompt("planning_critique", "v4", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("planning_critique v4 - is at least the latest version", async () => {
  const result = await getLatestVersion("planning_critique", PROMPTS_DIR);
  assert(result.ok);
  if (!result.ok) return;
  const num = parseInt(result.value.replace("v", ""), 10);
  assertEquals(
    num >= 4,
    true,
    `Expected planning_critique >= v4, got ${result.value}`,
  );
});

Deno.test("planning_critique v4 - satisfies the placeholder contract", async () => {
  const result = await loadPrompt("planning_critique", "v4", PROMPTS_DIR);
  assert(result.ok);
  if (!result.ok) return;
  const v = validatePromptTemplate("planning_critique", result.value);
  assertEquals(v.ok, true);
});

Deno.test(
  "latest planning_critique - publish turn verifies Failure Detection before gh issue create",
  async () => {
    // Version-agnostic: assert against whatever the latest prompt is so the
    // guarantee survives future prompt versions.
    const latest = await getLatestVersion("planning_critique", PROMPTS_DIR);
    assert(latest.ok);
    if (!latest.ok) return;
    const result = await loadPrompt(
      "planning_critique",
      latest.value,
      PROMPTS_DIR,
    );
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;

    // The publish turn (Step 3) references the section shared with the gate.
    assertStringIncludes(body, "## Failure Detection");
    // It must instruct verification immediately before publishing each
    // sub-issue with `gh issue create`.
    assertStringIncludes(body, "gh issue create");

    // The verify-before-publish instruction: the wording ties the check to the
    // moment just before creating the sub-issue and to the final body.
    const lower = body.toLowerCase();
    assert(
      lower.includes("before you publish") ||
        lower.includes("before running `gh issue create`") ||
        lower.includes("before you run `gh issue create`"),
      "latest planning_critique must instruct verification before publishing",
    );
    assert(
      lower.includes("final body") ||
        (lower.includes("final") && lower.includes("body")),
      "latest planning_critique must verify the final sub-issue body",
    );
  },
);

Deno.test(
  "latest planning_critique - self-repairs a missing/placeholder Failure Detection section",
  async () => {
    const latest = await getLatestVersion("planning_critique", PROMPTS_DIR);
    assert(latest.ok);
    if (!latest.ok) return;
    const result = await loadPrompt(
      "planning_critique",
      latest.value,
      PROMPTS_DIR,
    );
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    const lower = body.toLowerCase();

    // Self-repair rather than publish-then-fix.
    assert(
      lower.includes("repair your own draft") || lower.includes("fill in"),
      "latest planning_critique must instruct self-repair of the draft",
    );
    // The gate's accepted shapes must be mirrored so prompt and gate agree.
    assertStringIncludes(body, "N/A — <reason>");
    assert(
      lower.includes("placeholder"),
      "latest planning_critique must reject the bracketed template placeholder",
    );
    // A sub-issue with no real criterion is a blocker to publishing it.
    assert(
      lower.includes("blocker"),
      "latest planning_critique must treat an unfillable criterion as a blocker",
    );
  },
);

Deno.test(
  "planning_critique v3 - immutable: lacks the pre-publish Failure Detection check (Issue #235)",
  async () => {
    const result = await loadPrompt("planning_critique", "v3", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    // v3 predates the Issue #3273 pre-publish verification.
    assert(
      !result.value.includes("## Failure Detection"),
      "v3 must not carry the pre-publish Failure Detection verification",
    );
  },
);
