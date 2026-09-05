/**
 * Tests for the custom prompt template loader (Issue #848, part of #843).
 *
 * Covers the happy path, every fail-loud fault (missing, unreadable, empty,
 * missing placeholder) and the message content an operator has to act on.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  customPromptTemplateType,
  loadCustomPromptTemplate,
} from "../lib/custom_prompt_loader.ts";

/** A template carrying both required `issue` placeholders. */
const VALID_TEMPLATE =
  "Work issue #{{ISSUE_NUMBER}} in the private way.\n\n{{QUALITY_INSTRUCTIONS}}\n";

/** Write `content` to a fresh temp file and return its path. */
async function writeTempPrompt(content: string): Promise<string> {
  const path = await Deno.makeTempFile({ suffix: ".md" });
  await Deno.writeTextFile(path, content);
  return path;
}

Deno.test("custom prompt loader - returns the operator's template verbatim", async () => {
  const path = await writeTempPrompt(VALID_TEMPLATE);
  try {
    const result = await loadCustomPromptTemplate(path);
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value, VALID_TEMPLATE);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("custom prompt loader - a missing file fails loud naming path and label", async () => {
  const path = await writeTempPrompt(VALID_TEMPLATE);
  await Deno.remove(path);

  const result = await loadCustomPromptTemplate(path, "my-custom-label");
  assertEquals(result.ok, false);
  assert(!result.ok);
  assertStringIncludes(result.error.message, path);
  assertStringIncludes(result.error.message, "my-custom-label");
  assertStringIncludes(result.error.message, "missing or unreadable");
});

Deno.test("custom prompt loader - a path that is not a readable file fails loud", async () => {
  // A directory, not a permission bit: running as root defeats `chmod 000`,
  // and a test that asserts nothing under root is not a test.
  const path = await Deno.makeTempDir();
  try {
    const result = await loadCustomPromptTemplate(path, "my-custom-label");
    assertEquals(result.ok, false);
    assert(!result.ok);
    assertStringIncludes(result.error.message, path);
    assertStringIncludes(result.error.message, "missing or unreadable");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("custom prompt loader - an empty file fails loud", async () => {
  const path = await writeTempPrompt("   \n\t\n");
  try {
    const result = await loadCustomPromptTemplate(path, "my-custom-label");
    assertEquals(result.ok, false);
    assert(!result.ok);
    assertStringIncludes(result.error.message, path);
    assertStringIncludes(result.error.message, "is empty");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("custom prompt loader - a missing required placeholder is rejected by name", async () => {
  const path = await writeTempPrompt("Work the issue.\n{{ISSUE_NUMBER}}\n");
  try {
    const result = await loadCustomPromptTemplate(path, "my-custom-label");
    assertEquals(result.ok, false);
    assert(!result.ok);
    assertStringIncludes(result.error.message, path);
    assertStringIncludes(result.error.message, "QUALITY_INSTRUCTIONS");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("custom prompt loader - both missing placeholders are named", async () => {
  const path = await writeTempPrompt("No placeholders at all.\n");
  try {
    const result = await loadCustomPromptTemplate(path);
    assertEquals(result.ok, false);
    assert(!result.ok);
    assertStringIncludes(result.error.message, "ISSUE_NUMBER");
    assertStringIncludes(result.error.message, "QUALITY_INSTRUCTIONS");
  } finally {
    await Deno.remove(path);
  }
});

// ---------------------------------------------------------------------------
// Per-phase template validation (Issue #1008, part of #938)
// ---------------------------------------------------------------------------

/** A template carrying both required `pr_feedback` placeholders. */
const VALID_PR_TEMPLATE =
  "Review PR #{{PR_NUMBER}} in the private way.\n\n{{QUALITY_INSTRUCTIONS}}\n";

Deno.test("custom prompt loader - a pr-phase template loads against the pr_feedback contract", async () => {
  const path = await writeTempPrompt(VALID_PR_TEMPLATE);
  try {
    const result = await loadCustomPromptTemplate(
      path,
      "secret-squirrel",
      customPromptTemplateType("pr"),
    );
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value, VALID_PR_TEMPLATE);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("custom prompt loader - an issue template on a pr mapping names the phase and template type", async () => {
  const path = await writeTempPrompt(VALID_TEMPLATE);
  try {
    const result = await loadCustomPromptTemplate(
      path,
      "secret-squirrel",
      customPromptTemplateType("pr"),
    );
    assertEquals(result.ok, false);
    assert(!result.ok);
    assertStringIncludes(result.error.message, "secret-squirrel");
    assertStringIncludes(result.error.message, path);
    assertStringIncludes(result.error.message, "'pr'");
    assertStringIncludes(result.error.message, "pr_feedback");
    assertStringIncludes(result.error.message, "PR_NUMBER");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("custom prompt loader - a pr template on an issue mapping names the phase and template type", async () => {
  const path = await writeTempPrompt(VALID_PR_TEMPLATE);
  try {
    const result = await loadCustomPromptTemplate(
      path,
      "my-custom-label",
      customPromptTemplateType("issue"),
    );
    assertEquals(result.ok, false);
    assert(!result.ok);
    assertStringIncludes(result.error.message, "'issue'");
    assertStringIncludes(result.error.message, "Template 'issue'");
    assertStringIncludes(result.error.message, "ISSUE_NUMBER");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("custom prompt loader - the phase to template-type map is exactly issue and pr", () => {
  assertEquals(customPromptTemplateType("issue"), "issue");
  assertEquals(customPromptTemplateType("pr"), "pr_feedback");
});
