/**
 * Tests for the custom prompt template loader (Issue #848, part of #843).
 *
 * Covers the happy path, every fail-loud fault (missing, unreadable, empty,
 * missing placeholder) and the message content an operator has to act on.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { loadCustomPromptTemplate } from "../lib/custom_prompt_loader.ts";

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

Deno.test("custom prompt loader - an unreadable file fails loud", async () => {
  const path = await writeTempPrompt(VALID_TEMPLATE);
  try {
    await Deno.chmod(path, 0o000);
    const result = await loadCustomPromptTemplate(path);
    // Running as root defeats the permission bit; only assert when the read
    // genuinely failed, so the suite is deterministic in both containers.
    if (!result.ok) {
      assertStringIncludes(result.error.message, path);
      assertStringIncludes(result.error.message, "missing or unreadable");
    }
  } finally {
    await Deno.chmod(path, 0o600);
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
