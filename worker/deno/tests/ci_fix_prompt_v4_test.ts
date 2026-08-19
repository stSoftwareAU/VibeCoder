/**
 * Tests for prompts/ci_fix/v4.md (Issue #1692).
 *
 * v4 surfaces the failure classification (Issue #1690) in the prompt and
 * forces Claude to write `.pr_response_message` even when no code change is
 * applied. The renderer substitutes `{{FAILURE_CLASSIFICATION}}` from a real
 * `classifyCiFailure()` call.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";
import { buildCiFixPrompt } from "../lib/prompt_builder.ts";
import type { CiAnnotation } from "../lib/ci_failure_classifier.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("ci_fix v4 - exists and loads", async () => {
  const result = await loadPrompt("ci_fix", "v4", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});

Deno.test("ci_fix v4 - is the latest version", async () => {
  const result = await getLatestVersion("ci_fix", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 4,
      true,
      `Expected ci_fix >= v4, got ${result.value}`,
    );
  }
});

Deno.test("ci_fix v4 - retains required placeholders", async () => {
  const result = await loadPrompt("ci_fix", "v4", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const validation = validatePromptTemplate("ci_fix", result.value);
    assertEquals(validation.ok, true);
  }
});

Deno.test("ci_fix v4 - renderer substitutes FAILURE_CLASSIFICATION for semgrep", async () => {
  const annotations: CiAnnotation[] = [
    {
      message: "Blocking code rules fired",
      title: "semgrep finding",
      path: "src/foo.ts",
    },
  ];
  const result = await buildCiFixPrompt({
    repo: "owner/repo",
    prNumber: "42",
    checkName: "semgrep",
    annotationDetails: "semgrep finding in src/foo.ts",
    annotations,
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    // Classification should be embedded in the rendered prompt.
    assertStringIncludes(result.value.prompt, "code-fix-required");
    assertStringIncludes(result.value.prompt, "semgrep");
    // Matched signals should be surfaced.
    assertStringIncludes(result.value.prompt, "check:semgrep");
    // The placeholder must be substituted, not retained verbatim.
    assertEquals(
      result.value.prompt.includes("{{FAILURE_CLASSIFICATION}}"),
      false,
    );
  }
});

Deno.test("ci_fix v4 - renderer substitutes FAILURE_CLASSIFICATION for timing", async () => {
  const annotations: CiAnnotation[] = [
    { message: "test timed out after 60s", title: "timeout", path: "" },
  ];
  const result = await buildCiFixPrompt({
    repo: "owner/repo",
    prNumber: "43",
    checkName: "test",
    annotationDetails: "test timed out",
    annotations,
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value.prompt, "timing");
    assertStringIncludes(result.value.prompt, "timed out");
  }
});

Deno.test("ci_fix v4 - renderer falls back to unknown when no annotations", async () => {
  const result = await buildCiFixPrompt({
    repo: "owner/repo",
    prNumber: "44",
    checkName: "build",
    annotationDetails: "no specific annotations",
    annotations: [],
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value.prompt, "unknown");
  }
});
