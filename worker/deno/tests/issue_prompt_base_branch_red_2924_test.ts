/**
 * Tests for the base-branch red-run guardrail in the issue prompt
 * (Issue #2924).
 *
 * A fleet run once claimed a bug fix whose regression test only went red
 * against the PR's own modified fake or fixture, and passed on the unfixed
 * base branch's production code — proving nothing about the defect. Another
 * run changed production behaviour or a durable format on an unreproduced
 * diagnosis. Issue #2924 adds a guardrail: red only counts when it is
 * observed against the unfixed base-branch production code with the base
 * branch's own test doubles, speculative fixes on an unverified diagnosis are
 * forbidden, and a reproducing test must start from any logged error line the
 * issue cites.
 *
 * The assertions run against the current `issue` template, so a later edit
 * that drops the guardrail fails in CI.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadIssue(): Promise<string> {
  const result = await loadPrompt("issue", PROMPTS_DIR);
  assertEquals(result.ok, true, "issue failed to load");
  if (!result.ok) throw new Error("issue failed to load");
  return result.value;
}

/** Collapse all whitespace so hard-wrapped prose can be matched as a phrase. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ");
}

function reproductionStatusSection(text: string): string {
  const start = text.indexOf("## Reproduction Status");
  assert(start >= 0, "could not find the Reproduction Status section");
  // Skip past the fenced ```markdown example embedded in the section, which
  // itself contains a `## Reproduction` line that would be mistaken for the
  // next top-level heading.
  const fenceOpen = text.indexOf("```", start);
  assert(fenceOpen >= 0, "could not find the embedded example's opening fence");
  const fenceClose = text.indexOf("```", fenceOpen + 3);
  assert(
    fenceClose >= 0,
    "could not find the embedded example's closing fence",
  );
  const nextHeading = text.indexOf("\n## ", fenceClose);
  const end = nextHeading >= 0 ? nextHeading : text.length;
  return text.slice(start, end);
}

Deno.test("issue - TDD bullet ties red runs to base-branch production code and doubles", async () => {
  const text = flatten(await loadIssue());

  assertStringIncludes(text, "unfixed base-branch production code");
  assertStringIncludes(text, "base branch's own test doubles");
  assertStringIncludes(text, "What a red run proves");
});

Deno.test("issue - Reproduction Status section explains what a red run proves", async () => {
  const section = flatten(reproductionStatusSection(await loadIssue()));

  assertStringIncludes(section, "What a red run proves");
  assertStringIncludes(section, "base-branch production code");
  assertStringIncludes(section, "test doubles");
  assertStringIncludes(section, "proves nothing");
  assertStringIncludes(section, "git checkout origin/<base>");
  // The long-standing gate wording is untouched.
  assertStringIncludes(
    section,
    "against the unfixed code and passing after the fix",
  );
});

Deno.test("issue - forbids a speculative fix for an unreproduced fault", async () => {
  const section = flatten(reproductionStatusSection(await loadIssue()));

  assertStringIncludes(section, "`partial` or `not-run`");
  assertStringIncludes(section, "do not change production behaviour");
  assertStringIncludes(section, "durable");
  assertStringIncludes(section, "undiagnosed or already fixed");
});

Deno.test("issue - requires starting from the cited logged error line", async () => {
  const section = flatten(reproductionStatusSection(await loadIssue()));

  assertStringIncludes(section, "logged error line");
  assertStringIncludes(section, "the PR summary quotes the line");
});
