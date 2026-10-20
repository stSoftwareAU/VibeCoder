/**
 * Issue #3732 — fleet PRs changed one copy of a twinned rule and left the
 * other stale; these tests keep the new rule identical in its two copies and
 * pin the pr-summary-check twin sentence on all four surfaces. The rule is
 * the "Change every copy of a twinned rule" bullet, in CODING-STANDARDS.md
 * and in the injected guidelines template; the twin sentence names
 * `pr_summary_check.ts` as the twin of the completion phase's PR-summary
 * gates, on CODING-STANDARDS.md, the issue prompt, the pr_feedback prompt and
 * the ci_fix prompt.
 *
 * Australian English spelling used throughout (behaviour, recognised, etc.).
 */
import { assert, assertEquals } from "@std/assert";
import {
  assertPins,
  flat,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const BULLET_START = "**Change every copy of a twinned rule**";
const BULLET_END = "or says none was found.";

const BULLET_PINS = [
  "Change every copy of a twinned rule",
  "shared copy of",
  "make one call the other",
  "add a test that fails when they disagree",
  "The Test Plan names the copies found",
];

/** The twin sentence, single-spaced, as `flat()` renders it. */
const TWIN_SENTENCE = "`deno task pr-summary-check` " +
  "(`worker/deno/lib/pr_summary_check.ts`) is the twin of the completion " +
  "phase's PR-summary gates (`worker/deno/lib/phases/completion_phase.ts`): " +
  "a change to how the completion phase runs one of those gates, or prepares " +
  "its input, changes `pr_summary_check.ts` the same way in the same PR. A " +
  "change inside a validator both files call reaches both already.";

/** The bullet from its bold lead-in through the end of its last sentence. */
function bulletText(text: string, surface: string): string {
  const start = text.indexOf(BULLET_START);
  assert(start >= 0, `${surface} has no "${BULLET_START}" bullet`);
  const end = text.indexOf(BULLET_END, start);
  assert(end >= 0, `${surface} has no "${BULLET_END}" after the bullet`);
  return text.slice(start, end + BULLET_END.length);
}

Deno.test("#3732: the twinned-rule bullet is identical in CODING-STANDARDS.md and the injected guidelines", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Coding Principles",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "General Coding Principles",
  );
  assertPins(standards, BULLET_PINS);
  assertPins(guidelines, BULLET_PINS);
  assertEquals(
    bulletText(flat(guidelines), "prompts/coding_guidelines/prompt.md"),
    bulletText(flat(standards), "CODING-STANDARDS.md"),
    "the twinned-rule bullet differs between CODING-STANDARDS.md and " +
      "prompts/coding_guidelines/prompt.md — change both copies together",
  );
});

const TWIN_SURFACES: readonly [string, string, string][] = [
  ["CODING-STANDARDS", "CODING-STANDARDS.md", "PR Summary and Evidence"],
  [
    "issue prompt",
    "prompts/issue/prompt.md",
    "PR Summary File — docs/archive/pr-summaries/pr-summary-ISSUE.md",
  ],
  ["pr_feedback prompt", "prompts/pr_feedback/prompt.md", "Making Changes"],
  ["ci_fix prompt", "prompts/ci_fix/prompt.md", "Fixing the Failure"],
];

for (const [name, doc, title] of TWIN_SURFACES) {
  Deno.test(`#3732: ${name} declares pr_summary_check.ts the twin of the completion gates`, async () => {
    const body = flat(section(await readRepoDoc(doc), title));
    assert(
      body.includes(TWIN_SENTENCE),
      `${doc} section "${title}" is missing the pr_summary_check.ts twin ` +
        "sentence — say pr_summary_check.ts is the twin of the completion " +
        "phase's PR-summary gates, as CODING-STANDARDS.md does",
    );
  });
}
