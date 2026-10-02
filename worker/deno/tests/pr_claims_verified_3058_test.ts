/**
 * Issue #3058: PR bodies, docs and acceptance claims verified against the
 * final diff; standing violations the diff introduced block the PR.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

async function load(type: string): Promise<string> {
  const result = await loadPrompt(type, PROMPTS_DIR);
  assertEquals(result.ok, true, `${type} failed to load`);
  if (!result.ok) throw new Error(`${type} failed to load`);
  return result.value;
}

/** Flatten whitespace so a line wrap does not break a substring match. */
function normalise(text: string): string {
  return text.replace(/\s+/g, " ");
}

Deno.test("Issue #3058 - issue prompt blocks the PR for a violation the diff introduced", async () => {
  const body = normalise(await load("issue"));

  for (
    const required of [
      "A violation this diff introduced blocks the PR",
      "Only a departure that predates the diff",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});

Deno.test("Issue #3058 - issue prompt demands demonstrated criteria and finished deliverables", async () => {
  const body = normalise(await load("issue"));

  for (
    const required of [
      "Demonstrate a criterion; do not assert it",
      "must have been run on the final head",
      "one untested branch makes it `partial`",
      "A missing core deliverable is not a PR",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});

Deno.test("Issue #3058 - issue prompt holds docs the diff touches to the same rule", async () => {
  const body = normalise(await load("issue"));

  for (
    const required of [
      "Hold every doc the diff adds or edits to the same rule",
      "a claim whose subject the merge absorbed is dropped",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});

Deno.test("Issue #3058 - CODING-STANDARDS.md carries the matching verification rules", async () => {
  const standards = normalise(
    await Deno.readTextFile(`${REPO_ROOT}CODING-STANDARDS.md`),
  );

  for (
    const required of [
      "run on the final head",
      "names the branches its tests exercise",
      "every doc the diff adds or edits",
      "the diff itself introduced",
      "core deliverable is `missing`",
    ]
  ) {
    assertStringIncludes(standards, required);
  }
});
