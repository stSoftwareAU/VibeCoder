/**
 * A read-only phase is no longer told to write (Issue #782).
 *
 * `buildQuestionPrompt` injects the shared `coding_guidelines` block, whose
 * Human Escalation section opens "Any time you apply the `needs-human` label —
 * **for any reason**" and whose escape hatch requires `gh issue create` plus a
 * comment. `question`'s own constraints forbid every write — "writing is not
 * permitted at all, including scratch or note files" — and twice forbid label
 * changes. A question run that cannot answer autonomously was therefore told
 * to label, comment and file, and told it may do none of those things.
 *
 * The phase-level ban is the intended behaviour: the prompt already records
 * that the **worker** adds `needs-human` once the answer is posted. The
 * injected block was the surface that did not know it, so the `question`
 * template carves those two sections out and names the answer text as the
 * sole escalation channel. The guidelines are untouched — escalation is correct for
 * every phase that can write.
 *
 * These cases assert the resolution on the **rendered** prompt, which is where
 * the contradiction lived: the template alone never carried the escalation
 * text at all.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildQuestionPrompt } from "../lib/prompt_builder.ts";
import { loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** The sentence that subordinates the injected sections to the phase. */
const CARVE_OUT =
  "Human Escalation and Escape Hatch sections do not apply to this phase";

/** The rendered question prompt: template plus injected guidelines. */
async function renderQuestion(): Promise<string> {
  const result = await buildQuestionPrompt({
    repo: "owner/repo",
    issueNumber: "782",
    issueTitle: "How does the guard work?",
    issueBody: "Asking about the claimed-issue guard.",
    issueLabels: "question",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (!result.ok) throw new Error(result.error.message);
  return `${result.value.systemPrompt}\n${result.value.prompt}`;
}

/** The `question` template text. */
async function questionText(): Promise<string> {
  const loaded = await loadPrompt("question", PROMPTS_DIR);
  assertEquals(loaded.ok, true);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value;
}

Deno.test("question - the rendered prompt carries the escalation text and its carve-out (Issue #782)", async () => {
  const rendered = await renderQuestion();

  // The injected block is still there, unchanged — escalation is right for
  // every phase that can write, so the guidelines were not touched.
  assertStringIncludes(rendered, "Human Escalation");
  assertStringIncludes(rendered, "Add the `needs-human` label to the issue");
  // The read-only ban is still there too.
  assertStringIncludes(rendered, "writing is not permitted at all");
  // And now the sentence that stops the two contradicting.
  assertStringIncludes(rendered, CARVE_OUT);
});

Deno.test("question - the carve-out is stated after the block it qualifies (Issue #782)", async () => {
  // A qualification the reader meets before the rule it qualifies reads as a
  // different rule; the guidelines arrive in the system prompt, the carve-out
  // in the template that follows it.
  const rendered = await renderQuestion();
  const escalation = rendered.indexOf("## Human Escalation");
  const carveOut = rendered.indexOf(CARVE_OUT);
  assert(escalation >= 0 && carveOut >= 0);
  assert(
    carveOut > escalation,
    "the carve-out must qualify the escalation section, not precede it",
  );
});

Deno.test("question - the answer text is named as the only escalation channel (Issue #782)", async () => {
  const text = await questionText();
  assertStringIncludes(text, "The answer text is your only escalation");
  // And the run is told who does perform the escalation, so "say it in the
  // answer" does not read as "the escalation simply does not happen".
  assertStringIncludes(text, "the worker performs for you");
});

Deno.test("question - the read-only constraints the carve-out relies on are intact (Issue #782)", async () => {
  // The carve-out is only correct while the phase really writes nothing.
  const text = await questionText();
  assertStringIncludes(text, "writing is not permitted at all");
  assertStringIncludes(text, "Do not modify labels or close the issue");
});

Deno.test("question - the guidelines keep their unconditional escalation for other phases (Issue #782)", async () => {
  // The fix is phase-side on purpose: a carve-out written into the shared
  // block would have released every phase from escalating.
  const result = await loadPrompt("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertStringIncludes(result.value, "for any reason");
  assertEquals(
    result.value.includes(CARVE_OUT),
    false,
    "the read-only carve-out belongs to the question phase, not the shared block",
  );
});
