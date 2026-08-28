/**
 * The prompts say exactly how to capture screenshot evidence with the
 * Playwright MCP (Issue #4364, follow-up to #4355): an explicit `filename`
 * under docs/evidence, no "browser unavailable" assumption, how to render a
 * local page, and update the summary on a resumed attempt.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildIssuePrompt } from "../lib/prompt_builder.ts";
import { validateScreenshotEvidence } from "../lib/screenshot_validation.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("screenshot retry notice - names the explicit filename under docs/evidence and the summary update (Issue #4364)", async () => {
  const result = await buildIssuePrompt({
    repo: "owner/repo",
    issueNumber: "5",
    issueTitle: "UI fix",
    issueBody: "Fix buttons",
    issueLabels: "needs-screenshot",
    qualityInstructions: "",
    screenshotRequired: true,
    promptsDir: PROMPTS_DIR,
  });
  assert(result.ok);
  const prompt = result.value.prompt;
  assertStringIncludes(prompt, "SCREENSHOT RETRY NOTICE");
  assertStringIncludes(prompt, 'filename: "docs/evidence/issue-123-after.png"');
  assertStringIncludes(prompt, "cannot be committed");
  assertStringIncludes(prompt, "update an existing summary");
});

Deno.test("screenshot gate message - names the explicit filename and the summary update (Issue #4364)", () => {
  const result = validateScreenshotEvidence({
    prSummaryContent: "## Summary\nchart html css",
    issueLabels: "needs-screenshot",
    changedFiles: ["docs/app.js"],
    repo: "o/r",
    issueNumber: 1,
  });
  assertEquals(result.valid, false);
  assertStringIncludes(
    result.failureMessage!,
    "with an explicit `filename` under `docs/evidence/`",
  );
  assertStringIncludes(result.failureMessage!, "update an existing summary");
});
