/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #2924 — a fleet run once claimed a bug fix whose regression test only
 * went red against the PR's own modified fake or fixture, and passed on the
 * unfixed base branch's production code — proving nothing about the defect.
 * Another run changed production behaviour or a durable format on an
 * unreproduced diagnosis. The issue prompt's base-branch red-run guardrail
 * must keep saying: red only counts when observed against the unfixed
 * base-branch production code with the base branch's own test doubles,
 * speculative fixes on an unverified diagnosis are forbidden, and a
 * reproducing test must start from any logged error line the issue cites.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertStringIncludes } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const issuePrompt = () => readRepoDoc("prompts/issue/prompt.md");

Deno.test("issue - TDD bullet ties red runs to base-branch production code and doubles", async () => {
  const instructions = flat(section(await issuePrompt(), "Instructions"));

  assertStringIncludes(instructions, "unfixed base-branch production code");
  assertStringIncludes(instructions, "base branch's own test doubles");
  assertStringIncludes(instructions, "What a red run proves");
});

Deno.test("issue - Reproduction Status section explains what a red run proves", async () => {
  const text = flat(section(await issuePrompt(), "Reproduction Status"));

  assertStringIncludes(text, "What a red run proves");
  assertStringIncludes(text, "base-branch production code");
  assertStringIncludes(text, "test doubles");
  assertStringIncludes(text, "proves nothing");
  assertStringIncludes(text, "git checkout origin/<base>");
  // The long-standing gate wording is untouched.
  assertStringIncludes(
    text,
    "against the unfixed code and passing after the fix",
  );
});

Deno.test("issue - forbids a speculative fix for an unreproduced fault", async () => {
  const text = flat(section(await issuePrompt(), "Reproduction Status"));

  assertStringIncludes(text, "`partial` or `not-run`");
  assertStringIncludes(text, "do not change production behaviour");
  assertStringIncludes(text, "durable");
  assertStringIncludes(text, "undiagnosed or already fixed");
});

Deno.test("issue - requires starting from the cited logged error line", async () => {
  const text = flat(section(await issuePrompt(), "Reproduction Status"));

  assertStringIncludes(text, "logged error line");
  assertStringIncludes(text, "the PR summary quotes the line");
});
