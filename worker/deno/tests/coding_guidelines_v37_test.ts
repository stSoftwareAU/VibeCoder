/**
 * Tests for coding_guidelines v37 (Issue #4070).
 *
 * v37 makes the execution environment explicit: the worker runs unattended
 * inside a sandboxed container with no host GUI or browser, so every browser
 * task uses the container's headless browser and no step may wait on an
 * operator to click something. A prompt that assumes a host browser produces
 * agents that stall waiting for a human who is not there. v36 stays immutable.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Collapse Markdown line wrapping so phrase assertions survive rewrapping. */
function unwrapped(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** Load a coding_guidelines version, failing loudly when it is missing. */
async function loadGuidelines(version?: string): Promise<string> {
  const result = await loadPrompt("coding_guidelines", version, PROMPTS_DIR);
  assertEquals(
    result.ok,
    true,
    `coding_guidelines ${version ?? "latest"} failed to load`,
  );
  if (!result.ok) throw new Error("coding_guidelines failed to load");
  return result.value;
}

Deno.test("coding_guidelines v37 - loads via loadPrompt", async () => {
  const text = await loadGuidelines("v37");
  assertEquals(text.length > 0, true);
});

Deno.test("coding_guidelines v37 - is the latest version", async () => {
  const result = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const num = parseInt(result.value.replace("v", ""), 10);
  assertEquals(
    num >= 37,
    true,
    `Expected coding_guidelines >= v37, got ${result.value}`,
  );
});

Deno.test("coding_guidelines v37 - satisfies the placeholder contract", async () => {
  const text = await loadGuidelines("v37");
  assertEquals(validatePromptTemplate("coding_guidelines", text).ok, true);
});

Deno.test("latest coding_guidelines - names the sandboxed unattended container", async () => {
  const text = unwrapped(await loadGuidelines());
  assertStringIncludes(text, "sandboxed container");
  assertStringIncludes(text, "unattended");
  for (const os of ["macOS", "Windows", "Linux"]) {
    assertStringIncludes(text, os);
  }
  assertStringIncludes(text, "no access to the host's interactive browser");
});

Deno.test("latest coding_guidelines - mandates the container headless browser", async () => {
  const text = unwrapped(await loadGuidelines());
  assertStringIncludes(text, "Browser work runs in the container");
  for (const capability of ["Navigation", "screenshots", "DOM inspection"]) {
    assertStringIncludes(text, capability);
  }
  assertStringIncludes(text, "no host browser to fall back on");
});

Deno.test("latest coding_guidelines - forbids asking the operator to drive a browser", async () => {
  const text = unwrapped(await loadGuidelines());
  assertStringIncludes(
    text,
    "Never ask the operator to participate in normal operation",
  );
  for (
    const forbidden of [
      "open a browser",
      "click a UI",
      "complete an interactive browser login",
      "inspect the desktop",
    ]
  ) {
    assertStringIncludes(text, forbidden);
  }
});

Deno.test("latest coding_guidelines - states browser state is disposable", async () => {
  const text = unwrapped(await loadGuidelines());
  assertStringIncludes(text, "Browser profiles and state are disposable");
  assertStringIncludes(text, "design and justify");
});

Deno.test("latest coding_guidelines - describes the in-container browser, not a host one", async () => {
  const text = unwrapped(await loadGuidelines());
  assertStringIncludes(text, "### Playwright MCP");
  assertStringIncludes(
    text,
    "headless Chromium baked into the container image",
  );
  assertStringIncludes(
    text,
    "Use the container's headless browser (Playwright MCP) when the change alters",
  );
});
