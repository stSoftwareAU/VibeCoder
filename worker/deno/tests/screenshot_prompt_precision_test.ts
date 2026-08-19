/**
 * The prompts say exactly how to capture screenshot evidence with the
 * Playwright MCP (Issue #4364, follow-up to #4355): an explicit `filename`
 * under docs/evidence, no "browser unavailable" assumption, how to render a
 * local page, and update the summary on a resumed attempt.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";
import { buildIssuePrompt } from "../lib/prompt_builder.ts";
import { validateScreenshotEvidence } from "../lib/screenshot_validation.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

function unwrapped(text: string): string {
  return text.replace(/\s+/g, " ");
}

async function load(type: string, version?: string): Promise<string> {
  const result = await loadPrompt(type, version, PROMPTS_DIR);
  assert(result.ok, `${type} ${version ?? "latest"} failed to load`);
  return result.value;
}

async function latestNumber(type: string): Promise<number> {
  const result = await getLatestVersion(type, PROMPTS_DIR);
  assert(result.ok);
  return parseInt(result.value.replace("v", ""), 10);
}

Deno.test("coding_guidelines v38 - exists, is at least the latest, satisfies the placeholder contract (Issue #4364)", async () => {
  const text = await load("coding_guidelines", "v38");
  assert(text.length > 0);
  assert((await latestNumber("coding_guidelines")) >= 38);
  assertEquals(validatePromptTemplate("coding_guidelines", text).ok, true);
});

Deno.test("latest coding_guidelines - says to pass an explicit filename under docs/evidence and that an unnamed screenshot lands outside the repository (Issue #4364)", async () => {
  const text = unwrapped(await load("coding_guidelines"));
  assertStringIncludes(text, "browser_take_screenshot");
  assertStringIncludes(text, 'filename: "docs/evidence/');
  assertStringIncludes(
    text,
    "A call **without** `filename` writes to a scratch directory outside the repository",
  );
});

Deno.test("latest coding_guidelines - explains how to render a local page and forbids assuming the browser is missing (Issue #4364)", async () => {
  const text = unwrapped(await load("coding_guidelines"));
  assertStringIncludes(text, "http://127.0.0.1:8931/");
  assertStringIncludes(text, "Never assume the browser is missing");
  assertStringIncludes(text, "quote the exact error");
});

Deno.test("latest coding_guidelines - tells a resumed attempt to update the existing summary (Issue #4364)", async () => {
  const text = unwrapped(await load("coding_guidelines"));
  assertStringIncludes(text, "On a resumed attempt");
  assertStringIncludes(
    text,
    "Update it so it references the screenshots you captured this time",
  );
});

Deno.test("latest coding_guidelines - keeps the v37 container-browser rules (Issue #4364)", async () => {
  const text = unwrapped(await load("coding_guidelines"));
  assertStringIncludes(text, "Playwright MCP");
  assertStringIncludes(text, "no host browser");
});

Deno.test("issue v32 - exists, is at least the latest, satisfies the placeholder contract; the 'browser unavailable' escape hatch is gone (Issue #4364)", async () => {
  const text = await load("issue", "v32");
  assert(text.length > 0);
  assert((await latestNumber("issue")) >= 32);
  assertEquals(validatePromptTemplate("issue", text).ok, true);
  const latest = unwrapped(await load("issue"));
  assertEquals(latest.includes("If Playwright MCP is unavailable"), false);
  assertStringIncludes(latest, "do not assume it is unavailable");
  assertStringIncludes(latest, "quote the exact error");
  assertStringIncludes(latest, 'filename: "docs/evidence/');
  assertStringIncludes(latest, "update the existing PR summary");
});

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
