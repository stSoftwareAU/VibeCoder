/**
 * Conditional screenshot/Playwright stripping (Issue #3812).
 *
 * Four of the six gaps this file guards were found by *rendering* the prompt,
 * not by reading the code — a stripper that no longer matches its template is
 * invisible in the source. The drift tests below render against the real
 * `prompts/` tree so the next template reword fails loudly.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  PLAYWRIGHT_STRIP_RULES,
  SCREENSHOT_STRIP_RULES,
  stripPlaywrightSection,
  stripScreenshotInstructions,
} from "../lib/screenshot_strip.ts";
import {
  buildCodingGuidelines,
  buildIssuePrompt,
} from "../lib/prompt_builder.ts";
import { loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Block stripping (Gap 2)
// ---------------------------------------------------------------------------

Deno.test("screenshot strip - removes a bullet and its continuation lines", () => {
  const template = `- **UI Changes**: Capture a screenshot via Playwright MCP
  then \`browser_take_screenshot\`. Describing visual changes in words alone
  is not sufficient.
- **Performance Changes**: Include benchmarks.`;
  const result = stripScreenshotInstructions(template);
  assertEquals(result.includes("UI Changes"), false);
  assertEquals(result.includes("browser_take_screenshot"), false);
  assertEquals(result.includes("not sufficient"), false);
  assertStringIncludes(
    result,
    "- **Performance Changes**: Include benchmarks.",
  );
});

Deno.test("screenshot strip - removes a numbered item's continuation lines", () => {
  const template = `2. **Quality check loop**: Rerun the gate.
3. **Screenshot failures**: If Playwright MCP is unavailable or the page fails
   to load, document what was tested manually instead. Describe the expected
   visual result.
4. **Git conflicts**: Rebase.`;
  const result = stripScreenshotInstructions(template);
  assertEquals(result.includes("Screenshot failures"), false);
  assertEquals(result.includes("document what was tested manually"), false);
  assertEquals(result.includes("visual result"), false);
  assertStringIncludes(result, "4. **Git conflicts**: Rebase.");
});

Deno.test("screenshot strip - keeps a less-indented sibling after the block", () => {
  const template =
    `   - For UI changes: Include a screenshot (as markdown image) captured via
     Playwright MCP
   - For performance changes: Include benchmark results`;
  const result = stripScreenshotInstructions(template);
  assertEquals(result.includes("Playwright MCP"), false);
  assertStringIncludes(result, "For performance changes");
});

// ---------------------------------------------------------------------------
// Worked example keeps an evidence line (Gap 6)
// ---------------------------------------------------------------------------

Deno.test("screenshot strip - worked example keeps a non-screenshot evidence line", () => {
  const template = `## Evidence

![Screenshot of fixed buttons](docs/evidence/button-fix.png)

## Test Plan`;
  const result = stripScreenshotInstructions(template);
  assertEquals(result.includes("![Screenshot of fixed buttons]"), false);
  assertStringIncludes(result, "no web interface to screenshot");
});

// ---------------------------------------------------------------------------
// Drift guards (Gaps 1 and 3)
// ---------------------------------------------------------------------------

Deno.test("screenshot strip - every rule matches the issue template", async () => {
  const template = await loadPrompt("issue", PROMPTS_DIR);
  assertEquals(template.ok, true);
  if (!template.ok) return;
  for (const rule of SCREENSHOT_STRIP_RULES) {
    assertEquals(
      rule.matches(template.value),
      true,
      `strip rule "${rule.id}" no longer matches the issue template`,
    );
  }
});

Deno.test("screenshot strip - every rule matches the coding guidelines", async () => {
  const guidelines = await loadPrompt("coding_guidelines", PROMPTS_DIR);
  assertEquals(guidelines.ok, true);
  if (!guidelines.ok) return;
  for (const rule of PLAYWRIGHT_STRIP_RULES) {
    assertEquals(
      rule.matches(guidelines.value),
      true,
      `strip rule "${rule.id}" no longer matches the coding guidelines`,
    );
  }
});

Deno.test("screenshot strip - rendered issue prompt carries no screenshot mandate", async () => {
  const result = await buildIssuePrompt({
    repo: "owner/repo",
    issueNumber: "7",
    issueTitle: "Backend fix",
    issueBody: "No UI in this repository.",
    issueLabels: "bug",
    qualityInstructions: "",
    skipScreenshotCheck: true,
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  for (
    const mandate of [
      "Capture a screenshot via Playwright MCP",
      "Describing visual changes in words alone",
      "Include a screenshot (as markdown image)",
      "![Screenshot of fixed buttons]",
      "Screenshot failures",
    ]
  ) {
    assertEquals(
      result.value.prompt.includes(mandate),
      false,
      `screenshot mandate survived stripping: ${mandate}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Orphaned coding-guidelines references (Gap 4)
// ---------------------------------------------------------------------------

Deno.test("screenshot strip - guidelines drop the orphaned Playwright references", async () => {
  const guidelines = await loadPrompt("coding_guidelines", PROMPTS_DIR);
  assertEquals(guidelines.ok, true);
  if (!guidelines.ok) return;
  const stripped = stripPlaywrightSection(guidelines.value);

  assertEquals(stripped.includes("### Playwright MCP"), false);
  assertEquals(
    stripped.includes("Playwright MCP is the source of truth for screenshots"),
    false,
  );
  assertEquals(stripped.includes("Provenance carve-out"), false);
  assertEquals(
    stripped.includes("headless browser (Playwright MCP) when the change"),
    false,
  );
  // Issue #4070: the sandbox section's browser-tooling paragraph goes with the
  // subsection it points at; the rest of that section survives.
  assertEquals(stripped.includes("Browser work runs in the container"), false);
  assertStringIncludes(
    stripped,
    "Never ask the operator to participate in normal operation",
  );
  assertStringIncludes(stripped, "You run unattended inside a sandboxed");
  // The surrounding guidance survives.
  assertStringIncludes(
    stripped,
    "Always run Cypress with video recording disabled",
  );
  assertStringIncludes(stripped, "Untrusted Images");
  assertStringIncludes(stripped, "Prefer `gh` over raw API calls");
});

Deno.test("screenshot strip - stripped guidelines reach the system prompt", async () => {
  const result = await buildCodingGuidelines(true, PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(
    result.value.includes(
      "Playwright MCP is the source of truth for screenshots",
    ),
    false,
  );
  assertEquals(result.value.includes("Provenance carve-out"), false);
});
