/**
 * Tests for the issue prompt's reproduction method (Issue #661).
 *
 * The `## Reproduction` block defines `verified` — the regression test was
 * watched failing before the fix and passing after it — but it used never to
 * say how a run gets there, so a hard bug degraded to `not-run` with no ladder
 * to climb. Issue #661 put the same reproduction-loop discipline the CI-fix
 * prompt gained behind the status: build one red-capable command first,
 * minimise it into the regression test, and only then claim `verified`.
 *
 * The assertions run against the current `issue` template, so a later edit
 * that drops the method fails in CI.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadIssue(): Promise<string> {
  const result = await loadPrompt("issue", PROMPTS_DIR);
  assertEquals(result.ok, true, "issue failed to load");
  if (!result.ok) throw new Error("issue failed to load");
  return result.value;
}

function lower(text: string): string {
  return text.toLowerCase();
}

Deno.test("issue - keeps the placeholders and the existing gated blocks", async () => {
  const text = await loadIssue();
  for (
    const required of [
      "{{VERBOSITY_INSTRUCTIONS}}",
      "{{ISSUE_NUMBER}}",
      "{{REPO}}",
      "## Reproduction",
      "## Acceptance Criteria",
      "`verified`",
      "`partial`",
      "`not-run`",
      "vibe-already-resolved",
      "docs/archive/pr-summaries/pr-summary-{{ISSUE_NUMBER}}.md",
    ]
  ) {
    assertStringIncludes(text, required);
  }
});

Deno.test("issue - gives verified a method, not only a definition", async () => {
  const text = await loadIssue();
  const body = lower(text);

  assertStringIncludes(body, "red-capable");
  assertStringIncludes(body, "deterministic");
  assertStringIncludes(body, "unattended");
  assertStringIncludes(text, "< /dev/null");
  // Minimise the red scenario — that is what becomes the regression test.
  assertStringIncludes(body, "minimise");
});

Deno.test("issue - a loop that never went red cannot be reported verified", async () => {
  const body = lower(await loadIssue());

  // The ladder down is explicit: no red command means partial or not-run,
  // with what was tried recorded — never an inflated `verified`.
  assert(
    body.includes("never went red") || body.includes("no red command"),
    "the template must say what to report when no red command could be built",
  );
  assertStringIncludes(body, "what you tried");
  // The long-standing over-claim rule is untouched.
  assertStringIncludes(body, "never** `verified`");
});
