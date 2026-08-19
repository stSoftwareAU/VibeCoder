/**
 * Tests for grill-me prompt v12 (Issue #3791).
 *
 * v12 closes the four Claude best-practice gaps the #3771 audit recorded
 * against v11 (`docs/audits/prompt-audit-interactive-3771.md`):
 *
 *   1. item 3 — worked `<example>` blocks: the `## Current Understanding`
 *      skeleton it rewrites every round, and a negative round comment that
 *      breaks the mandatory mobile-output rules.
 *   2. item 4 — the injected `{{CODING_GUIDELINES}}` block is named as the
 *      `<coding_guidelines>` element it arrives wrapped in, and the
 *      template's own rules sit under their own heading so the two are
 *      distinguishable. The wrapper itself stays in
 *      `buildCodingGuidelines()` (#3786) — v12 must not add a second one.
 *   3. item 8 (row 11) — Step 2 fetches candidate issue bodies in parallel.
 *   4. item 10 (rows 17, 19, 22) — a delegation criterion at the Step 2
 *      fan-out, a temp-file rule for the `gh issue edit` body payload, and
 *      a read-before-assert evidence rule for the Step 5b scope judgement.
 *
 * These assertions inspect the prompt template content because the
 * template IS the deliverable the worker feeds to Claude — the same
 * pattern the v9 placeholder-contract and v11 tests use.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadV12(): Promise<string> {
  const result = await loadPrompt("grill-me", "v12", PROMPTS_DIR);
  assertEquals(result.ok, true, "grill-me v12 must load");
  if (!result.ok) throw new Error("unreachable");
  return result.value;
}

Deno.test("grill-me prompt v12 - latest version is v12 or later", async () => {
  const result = await getLatestVersion("grill-me", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 12,
      true,
      `Expected grill-me prompt >= v12, got ${result.value}`,
    );
  }
});

Deno.test("grill-me prompt v12 - loads via loadPrompt", async () => {
  const body = await loadV12();
  assertEquals(body.length > 0, true);
});

// --- Placeholder contract (unchanged from v9/v10/v11) ---

const REQUIRED_PLACEHOLDERS = [
  "ROUND_NUMBER",
  "MAX_ROUNDS",
  "REPO",
  "ISSUE_NUMBER",
  "ISSUE_TITLE",
  "ISSUE_BODY",
  "COMMENT_HISTORY",
  "CODING_GUIDELINES",
  "VERBOSITY_INSTRUCTIONS",
  "BOUNDARY_INTEGRITY_INSTRUCTION",
];

Deno.test("grill-me prompt v12 - carries every required placeholder", async () => {
  const body = await loadV12();
  for (const name of REQUIRED_PLACEHOLDERS) {
    assertStringIncludes(body, `{{${name}}}`);
  }
});

// --- Gap 1 (item 3) — worked examples ---

Deno.test("grill-me prompt v12 - carries <example> blocks", async () => {
  const body = await loadV12();
  assertStringIncludes(body, "<examples>");
  assertStringIncludes(body, "</examples>");
  const opens = body.split("<example>").length - 1;
  assertEquals(
    opens >= 2,
    true,
    `Expected at least two <example> blocks, found ${opens}`,
  );
  assertEquals(
    opens,
    body.split("</example>").length - 1,
    "Every <example> must be closed",
  );
});

Deno.test("grill-me prompt v12 - example shows a complete Current Understanding block", async () => {
  const body = await loadV12();
  const start = body.indexOf("<examples>");
  const end = body.indexOf("</examples>");
  assertEquals(start >= 0 && end > start, true);
  const examples = body.slice(start, end);
  // The skeleton must show the markers and all five required parts.
  assertStringIncludes(examples, "<!-- GRILL-ME-UNDERSTANDING-START -->");
  assertStringIncludes(examples, "<!-- GRILL-ME-UNDERSTANDING-END -->");
  assertStringIncludes(examples, "## Current Understanding");
  assertStringIncludes(examples, "Accepted scope so far");
  assertStringIncludes(examples, "Open questions");
  assertStringIncludes(examples, "Assumptions");
  assertStringIncludes(examples, "Related open issues");
});

Deno.test("grill-me prompt v12 - carries a negative mobile-output example", async () => {
  const body = await loadV12();
  const start = body.indexOf("<examples>");
  const end = body.indexOf("</examples>");
  const examples = body.slice(start, end);
  // A rejected round comment: lettered prefixes, a table, over-length.
  assertStringIncludes(examples, "Do not post it");
  assertStringIncludes(examples, "table");
  assertStringIncludes(examples, "1500");
});

// --- Gap 2 (item 4) — XML structure around the injected guidelines ---

Deno.test("grill-me prompt v12 - names the coding_guidelines element without re-wrapping it", async () => {
  const body = await loadV12();
  // The template must tell Claude which element the injected document
  // arrives in, so it is distinguishable from the template's own rules.
  assertStringIncludes(body, "`<coding_guidelines>`");
  // ...but must not add a second wrapper — buildCodingGuidelines() owns it
  // (#3786). A bare opening/closing tag on its own line would double-wrap.
  for (const line of body.split("\n")) {
    assertEquals(
      line.trim() === "<coding_guidelines>" ||
        line.trim() === "</coding_guidelines>",
      false,
      `v12 must not re-wrap the guidelines: found ${line.trim()}`,
    );
  }
});

// --- Gap 3 (item 8, row 11) — parallel tool calls at the Step 2 fan-out ---

Deno.test("grill-me prompt v12 - Step 2 fetches candidate bodies in parallel", async () => {
  const body = await loadV12();
  assertStringIncludes(body, "parallel");
  const idx = body.indexOf("parallel");
  const window = body.slice(Math.max(0, idx - 900), idx + 400);
  assertStringIncludes(window, "gh issue view");
});

// --- Gap 4 (item 10) — agentic rows 17, 19, 22 ---

Deno.test("grill-me prompt v12 - row 17: carries a delegation criterion", async () => {
  const body = await loadV12();
  assertStringIncludes(body, "subagent");
});

Deno.test("grill-me prompt v12 - row 19: bounds and cleans up the body temp file", async () => {
  const body = await loadV12();
  assertStringIncludes(body, "--body-file");
  // The cleanup rule must sit with the temporary file it permits.
  const idx = body.indexOf("--body-file");
  const window = body.slice(idx, idx + 600).toLowerCase();
  assertStringIncludes(window, "delete that file");
});

Deno.test("grill-me prompt v12 - row 22: viability rationale must name what it counts", async () => {
  const body = await loadV12();
  // Read-before-assert plus a naming requirement for the scope claim.
  assertStringIncludes(body, "before asserting");
  assertStringIncludes(body, "subsystems");
  // The worked recommendation example must no longer assert an ungrounded
  // "touches N subsystems" count.
  assertEquals(
    body.includes("touches N subsystems"),
    false,
    "v12 must replace the ungrounded 'touches N subsystems' example",
  );
});

// --- Preserved v11 behaviour ---

Deno.test("grill-me prompt v12 - keeps the v11 adaptive recommendation contract", async () => {
  const body = await loadV12();
  assertEquals(body.includes("exactly two task list options"), false);
  assertEquals(body.includes("exactly the two next-phase options"), false);
  assertStringIncludes(body, "recommendation");
  assertStringIncludes(body, "rationale");
  assertStringIncludes(body, "lean");
  assertStringIncludes(body, "planning");
  assertStringIncludes(body, "GitHub");
});

Deno.test("grill-me prompt v12 - keeps the round, ready and footer contracts", async () => {
  const body = await loadV12();
  assertStringIncludes(body, "## Grill-Me Round {{ROUND_NUMBER}}");
  assertStringIncludes(body, "## Grill-Me — Ready for Next Phase");
  assertStringIncludes(body, "**⏳ Awaiting your reply.**");
  assertStringIncludes(body, "<!-- GRILL-ME-UNDERSTANDING-START -->");
  assertStringIncludes(body, "<!-- GRILL-ME-UNDERSTANDING-END -->");
  // Label policy (Issue #1344, #2040) survives.
  assertStringIncludes(body, "#1344");
  assertStringIncludes(body, "#2040");
  assertStringIncludes(body, '--remove-label "grill-me"');
  assertStringIncludes(body, '--add-label "needs-human"');
});
