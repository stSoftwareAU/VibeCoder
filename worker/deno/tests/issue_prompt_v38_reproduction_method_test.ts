/**
 * Tests for issue prompt v38 (Issue #661).
 *
 * v37's `## Reproduction` block defines `verified` — the regression test was
 * watched failing before the fix and passing after it — but never says how a
 * run gets there, so a hard bug degrades to `not-run` with no ladder to climb.
 * v38 puts the same reproduction-loop discipline the CI-fix prompt gained
 * behind the status: build one red-capable command first, minimise it into the
 * regression test, and only then claim `verified`.
 *
 * v37 stays immutable and is the negative control.
 *
 * Issue #663 superseded v38 with v39, so the resolution test below now asserts
 * v38 is still loadable and no longer the resolved version — the version bump
 * is the only change to this file; every v38 content assertion is untouched.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadIssue(version: string): Promise<string> {
  const result = await loadPrompt("issue", version, PROMPTS_DIR);
  assertEquals(result.ok, true, `issue ${version} failed to load`);
  if (!result.ok) throw new Error(`issue ${version} failed to load`);
  return result.value;
}

const loadV37 = () => loadIssue("v37");
const loadV38 = () => loadIssue("v38");

function lower(text: string): string {
  return text.toLowerCase();
}

Deno.test("issue v38 - stays loadable now that a later version resolves", async () => {
  const latest = await getLatestVersion("issue", PROMPTS_DIR);
  assertEquals(latest.ok, true);
  if (!latest.ok) return;
  // Superseded by v39 (Issue #663) — v38 must still load by explicit version.
  assert(latest.value !== "v38", "v38 is no longer the resolved version");

  const [byName, byVersion] = await Promise.all([
    loadPrompt("issue", undefined, PROMPTS_DIR),
    loadPrompt("issue", "v38", PROMPTS_DIR),
  ]);
  assertEquals(byName.ok, true);
  assertEquals(byVersion.ok, true);
  if (byName.ok && byVersion.ok) {
    assert(byName.value !== byVersion.value);
  }
});

Deno.test("issue v38 - keeps the placeholders and the existing gated blocks", async () => {
  const v38 = await loadV38();
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
    assertStringIncludes(v38, required);
  }
});

Deno.test("issue v38 - gives verified a method, not only a definition", async () => {
  const [v37, v38] = await Promise.all([loadV37(), loadV38()]);
  const body = lower(v38);

  assertStringIncludes(body, "red-capable");
  assertStringIncludes(body, "deterministic");
  assertStringIncludes(body, "unattended");
  assertStringIncludes(v38, "< /dev/null");
  // Minimise the red scenario — that is what becomes the regression test.
  assertStringIncludes(body, "minimise");

  assertEquals(lower(v37).includes("red-capable"), false);
});

Deno.test("issue v38 - a loop that never went red cannot be reported verified", async () => {
  const [v37, v38] = await Promise.all([loadV37(), loadV38()]);
  const body = lower(v38);

  // The ladder down is explicit: no red command means partial or not-run,
  // with what was tried recorded — never an inflated `verified`.
  assert(
    body.includes("never went red") || body.includes("no red command"),
    "v38 must say what to report when no red command could be built",
  );
  assertStringIncludes(body, "what you tried");
  // The over-claim rule v37 already carried is untouched.
  assertStringIncludes(body, "never** `verified`");

  assertEquals(lower(v37).includes("what you tried"), false);
});
