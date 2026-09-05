/**
 * Exhausting the quality cap is a hand-off, not a licence to raise the PR
 * (Issue #785).
 *
 * `issue`'s Error Recovery step 2 capped `quality.sh` fix-and-rerun cycles at
 * three — sound, a run must not burn itself looping — and then said "document
 * the remaining issues in your PR summary and **commit what you have**". The
 * same file, twenty lines later, says "all checks must pass BEFORE creating a
 * Pull Request", as do `CODING-STANDARDS.md` and the injected
 * `coding_guidelines`.
 *
 * The cap is not just lint: `quality.sh` runs the same semgrep `p/default`
 * ruleset as the blocking PR check, so "commit what you have" licensed pushing
 * a branch with an unresolved SAST finding — which `ci_fix` independently
 * rules out.
 *
 * The cap stayed; what changed was what follows it. These cases assert that
 * on the **rendered** prompt.
 *
 * Issue #1138 then took the number away. Three cycles of a fifteen-minute
 * gate is forty-five minutes of a sixty-minute run budget before any work
 * happens, and 407 worker-log observations caught agents doing exactly that —
 * still inside the gate at 68 minutes, killed at the deadline, the issue back
 * in the queue. So the bound is no longer "three attempts at the full gate"
 * but "fix the check, re-run **that** check once, then hand off": the worker
 * runs the gate itself after the execute phase and CI runs it on the pull
 * request, so a third serial copy was never buying the information it cost.
 * What #785 established survives unchanged — exhausting the bound is a
 * hand-off, never a licence to raise the PR over a failure you watched.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildIssuePrompt } from "../lib/prompt_builder.ts";
import { loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/**
 * The template hard-wraps at about 75 columns, so a phrase this file pins
 * routinely straddles a newline. Collapsing whitespace lets an assertion name
 * the phrase as a reader reads it rather than as the wrap happens to break it
 * — otherwise re-flowing a paragraph fails a test that has nothing to say
 * about re-flowing paragraphs.
 *
 * @param text - The template or rendered prompt
 * @returns The same text with every whitespace run collapsed to one space
 */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** The wording the template used to license a PR over the cap. */
const OLD_LICENCE = "commit what you have";

/** The rendered issue prompt: template plus injected guidelines. */
async function renderIssue(): Promise<string> {
  const result = await buildIssuePrompt({
    repo: "owner/repo",
    issueNumber: "785",
    issueTitle: "Do the work",
    issueBody: "Body",
    issueLabels: "bug",
    qualityInstructions: "Run ./quality.sh",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (!result.ok) throw new Error(result.error.message);
  return `${result.value.systemPrompt}\n${result.value.prompt}`;
}

/** The `issue` template text. */
async function issueText(): Promise<string> {
  const loaded = await loadPrompt("issue", PROMPTS_DIR);
  assertEquals(loaded.ok, true);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value;
}

Deno.test("quality cap - no rendered passage licenses a PR over failing checks (Issue #785)", async () => {
  const rendered = await renderIssue();
  assertEquals(
    rendered.toLowerCase().includes(OLD_LICENCE),
    false,
    `the rendered prompt still tells the run to "${OLD_LICENCE}" after the ` +
      `cap, which contradicts the must-pass gate stated in the same prompt`,
  );
});

Deno.test("quality cap - the bound itself survives, without a number (Issue #1138)", async () => {
  // The bound exists for a good reason; #785 was about what follows it, not
  // about letting a run loop forever. #1138 is about its size: the bound is
  // now one re-run of the check that failed, not three runs of the gate.
  const text = await issueText();
  const flat = collapse(text);
  assertStringIncludes(flat, "Do not loop indefinitely");
  assertStringIncludes(flat, "run **that check** once more to see it go green");
  assertStringIncludes(flat, "Never re-run the full gate to confirm a fix");
  assertEquals(
    /\b(?:3|three)\s+attempts\b/i.test(text),
    false,
    "the numbered gate allowance is back: three runs of a fifteen-minute " +
      "gate is most of a sixty-minute budget before any work happens",
  );
});

Deno.test("quality cap - exhaustion hands off instead of raising a PR (Issue #785)", async () => {
  const text = await issueText();
  assertStringIncludes(text, "do **not** create a pull request");
  // The branch is preserved, so the next run resumes rather than restarts.
  assertStringIncludes(text, "the branch is preserved");
  // The failures are reported where a human will read them.
  assertStringIncludes(text, "comment on the issue with the checks still");
  // And the issue is parked for a person.
  assertStringIncludes(text, "add the `needs-human` label");
});

Deno.test("quality cap - the standard the hand-off defers to is still stated (Issue #1138)", async () => {
  // The hand-off is only coherent while the run has some stated way to know
  // its work is sound. That is no longer "the full gate passed" — it is the
  // fast checks, named in the template, with the gate left to the worker and
  // to CI.
  const rendered = collapse(await renderIssue());
  assertStringIncludes(rendered, "**fast checks**");
  assertStringIncludes(rendered, "the suites that import what you changed");
  // And the run may not push over a failure it watched happen.
  assertStringIncludes(
    rendered,
    "A check you actually ran and watched fail",
  );
});

Deno.test("quality cap - the hand-off names the security stage as the reason (Issue #785)", async () => {
  // A reader who thinks the cap is about lint will treat the hand-off as
  // bureaucracy. The gate runs the same SAST ruleset as the blocking check.
  const text = collapse(await issueText());
  assertStringIncludes(text, "semgrep");
  assertStringIncludes(text, "unresolved security finding");
});
