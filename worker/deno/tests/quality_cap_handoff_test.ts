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
 * The cap stays; what changes is what follows it. These cases assert that on
 * the **rendered** prompt, and that the must-pass gate it now defers to is
 * still stated.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildIssuePrompt } from "../lib/prompt_builder.ts";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** The wording the retired versions used to license a PR over the cap. */
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

/** The latest `issue` text, and the version it came from. */
async function latestIssue(): Promise<{ version: string; text: string }> {
  const latest = await getLatestVersion("issue", PROMPTS_DIR);
  assertEquals(latest.ok, true);
  if (!latest.ok) throw new Error(latest.error.message);
  const loaded = await loadPrompt("issue", latest.value, PROMPTS_DIR);
  assertEquals(loaded.ok, true);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return { version: latest.value, text: loaded.value };
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

Deno.test("quality cap - the cap itself survives (Issue #785)", async () => {
  // The bound exists for a good reason; this issue is about what follows it,
  // not about letting a run loop forever.
  const { text } = await latestIssue();
  assertStringIncludes(text, "3\n   attempts");
  assertStringIncludes(text, "Do not loop indefinitely");
});

Deno.test("quality cap - exhaustion hands off instead of raising a PR (Issue #785)", async () => {
  const { text } = await latestIssue();
  assertStringIncludes(text, "do **not** create a pull request");
  // The branch is preserved, so the next run resumes rather than restarts.
  assertStringIncludes(text, "the branch is preserved");
  // The failures are reported where a human will read them.
  assertStringIncludes(text, "comment on the issue with the checks still");
  // And the issue is parked for a person.
  assertStringIncludes(text, "add the `needs-human` label");
});

Deno.test("quality cap - the must-pass gate the hand-off defers to is still stated (Issue #785)", async () => {
  // The hand-off is only coherent while the gate it protects exists — in the
  // template and in the injected guidelines that render with it.
  const rendered = await renderIssue();
  assertStringIncludes(rendered, "All checks must pass before PR creation");
  assertStringIncludes(
    rendered,
    "pass BEFORE creating a Pull Request",
  );
});

Deno.test("quality cap - the hand-off names the security stage as the reason (Issue #785)", async () => {
  // A reader who thinks the cap is about lint will treat the hand-off as
  // bureaucracy. The gate runs the same SAST ruleset as the blocking check.
  const { text } = await latestIssue();
  assertStringIncludes(text, "semgrep");
  assertStringIncludes(text, "unresolved security finding");
});

Deno.test("quality cap - v42 stays immutable (Issue #785)", async () => {
  const result = await loadPrompt("issue", "v42", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assert(
    result.value.toLowerCase().includes(OLD_LICENCE),
    "v42 carried the licence its successor removes and must keep reading as " +
      "it did",
  );
});
