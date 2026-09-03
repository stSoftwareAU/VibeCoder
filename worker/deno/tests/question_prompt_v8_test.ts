/**
 * Tests for the question prompt (Issue #3792).
 *
 * The template closes the eight Claude best-practice gaps the #3771 audit
 * recorded against the question phase — the only surface whose output is
 * published verbatim to a public GitHub issue: named untrusted input sections,
 * worked examples, XML tags, a role, a quote-first grounding step, a positive
 * answer skeleton, parallel-read guidance, and the agentic-systems clauses
 * (read-before-assert with `file:line` evidence, a success criterion, a
 * scope/length bound, a delegation criterion).
 *
 * These cases pin the surface the builder actually renders: the untrusted
 * section names the template cites are the ones the builder emits, and every
 * placeholder is substituted.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import { buildQuestionPrompt } from "../lib/prompt_builder.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadQuestion(): Promise<string> {
  const result = await loadPrompt("question", PROMPTS_DIR);
  assertEquals(result.ok, true, "question failed to load");
  if (!result.ok) throw new Error("question failed to load");
  return result.value;
}

// --- Loading contract ---

// --- Gap 1: be clear and direct ---

Deno.test("question - Gap 1: the section names it cites are the ones the builder emits", async () => {
  const body = await loadQuestion();
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

// --- Integration: the builder renders the template ---

Deno.test("buildQuestionPrompt - substitutes the template without leaving placeholders", async () => {
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
  // The template's markers are present and every placeholder is resolved.
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
