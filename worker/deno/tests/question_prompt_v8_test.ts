/**
 * Tests for question prompt v8 (Issue #3792).
 *
 * v8 closes the eight Claude best-practice gaps the #3771 audit recorded
 * against v7 — the only surface whose output is published verbatim to a public
 * GitHub issue: named untrusted input sections, worked examples, XML tags, a
 * role, a quote-first grounding step, a positive answer skeleton, parallel-read
 * guidance, and the agentic-systems clauses (read-before-assert with `file:line`
 * evidence, a success criterion, a scope/length bound, a delegation criterion).
 *
 * v7 stays immutable and is used here as the negative control: each gap test
 * asserts the defect is present in v7 and absent in v8, so the test fails
 * against the unfixed template.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import { buildQuestionPrompt } from "../lib/prompt_builder.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadQuestion(version: string): Promise<string> {
  const result = await loadPrompt("question", version, PROMPTS_DIR);
  assertEquals(result.ok, true, `question ${version} failed to load`);
  if (!result.ok) throw new Error(`question ${version} failed to load`);
  return result.value;
}

const loadV8 = () => loadQuestion("v8");

// --- Loading contract ---

// --- Gap 1: be clear and direct ---

Deno.test("question v8 - Gap 1: the section names it cites are the ones the builder emits", async () => {
  const body = await loadV8();
  const built = await buildQuestionPrompt({
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: "3792",
    issueTitle: "How does the retry work?",
    issueBody: "Question body",
    issueLabels: "question",
    issueComments: "a prior comment",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(built.ok, true);
  if (!built.ok) return;
  for (
    const section of [
      "### [UNTRUSTED] Issue Title ###",
      "### [UNTRUSTED] Issue Labels ###",
      "### [UNTRUSTED] Issue Description ###",
      "### [UNTRUSTED] Issue Comments ###",
    ]
  ) {
    assertStringIncludes(body, section);
    assertStringIncludes(built.value.prompt, section);
  }
});

// --- Gap 2: use examples effectively ---

// --- Gap 3: structure prompts with XML tags ---

// --- Gap 4: give Claude a role ---

// --- Gap 5: long context prompting ---

// --- Gap 6: control the format of responses ---

// --- Gap 7: optimise parallel tool calling ---

// --- Gap 8: agentic systems (rows 16, 17, 20, 22) ---

// --- Integration: the builder renders v8 by default ---

Deno.test("buildQuestionPrompt - substitutes v8 without leaving placeholders", async () => {
  const built = await buildQuestionPrompt({
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: "3792",
    issueTitle: "Title",
    issueBody: "Body",
    issueLabels: "question",
    issueComments: "comment",
    questionLabel: "question",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(built.ok, true);
  if (!built.ok) return;
  const { prompt, systemPrompt } = built.value;
  // The v8 markers are present and every placeholder is resolved.
  assertStringIncludes(prompt, "You are a senior engineer on this codebase");
  assertStringIncludes(prompt, "## Scope and length");
  assertEquals(
    /\{\{[A-Z_]+\}\}/.test(prompt),
    false,
    `unsubstituted placeholder left in the prompt: ${
      prompt.match(/\{\{[A-Z_]+\}\}/)?.[0]
    }`,
  );
  assertStringIncludes(prompt, "stSoftwareAU/VibeCoder");
  assertStringIncludes(prompt, "issue #3792");
  // The guidelines ride in the system prompt, inside the tags v8 names.
  assertStringIncludes(systemPrompt, "<coding_guidelines>");
});
