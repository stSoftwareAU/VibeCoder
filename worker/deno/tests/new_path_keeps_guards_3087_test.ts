/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3087 — fleet PRs added a second route to an outcome the code
 * already reached, and the new route skipped a guard the old one applied:
 * VibeCoder#3085 ran `reportSummaryRuleBlock` before the degraded-delivery
 * guard; VibeCoder#2909 added an early return after `claimPrComment` that
 * neither replied nor released the claim; VibeCoder#3065's milestone sync
 * skipped `isConflictAttemptDue`; and GRQ-AutoTrader#2279's `publishBusy`
 * skipped the freshness tracker's ticket check. CODING-STANDARDS.md and the
 * coding_guidelines prompt must both carry the same "a new path to an
 * existing outcome keeps that outcome's guards" rule, inside the
 * test-coverage section, word for word once wrapping is ignored; the
 * "Choosing assertions" section must point back to it; and the issue prompt's
 * Test Plan step and the pr_feedback prompt must both require a new path to
 * keep the existing path's guards.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const PARAGRAPH_START =
  "**A new path to an existing outcome keeps that outcome's guards.**";

function newPathParagraph(sectionText: string, what: string): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, `could not locate the new-path guard rule in ${what}`);
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = end >= 0
    ? sectionText.slice(start, end)
    : sectionText.slice(start);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "early return",
  "list every guard and side effect",
  "degraded-run guard",
  "releasing a claim",
  "state in the PR summary why it does not apply",
  "ahead of the guard",
  "blocking self-review finding",
];

Deno.test("both surfaces carry the new-path guard rule (Issue #3087)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Test coverage expectations",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Test Coverage Expectations",
  );

  for (
    const [surface, text] of [
      ["CODING-STANDARDS.md", standards],
      ["coding_guidelines", guidelines],
    ] as const
  ) {
    const paragraph = newPathParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the new-path guard rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    newPathParagraph(standards, "CODING-STANDARDS.md"),
    newPathParagraph(guidelines, "coding_guidelines"),
    "the new-path guard rule must be identical on both surfaces",
  );
});

Deno.test("Choosing assertions points back at the new-path guard rule (Issue #3087)", async () => {
  const text = flat(
    section(await readRepoDoc("CODING-STANDARDS.md"), "Choosing assertions"),
  );

  assert(
    text.includes("keeps that path's guards"),
    `Choosing assertions is missing the back-reference: ${text}`,
  );
});

Deno.test("issue prompt Test Plan step requires a new path keep its guards (Issue #3087)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
  );

  assert(
    text.includes(
      "A new path to an existing outcome keeps that outcome's guards",
    ),
    `PR Summary File section is missing the new-path guard requirement: ${text}`,
  );
  assert(
    text.includes(
      "a new path that skips a guard with no stated reason is a blocking self-review finding",
    ),
    `PR Summary File section is missing the skipped-guard finding: ${text}`,
  );
});

Deno.test("PR-feedback prompt points at the new-path guard rule (Issue #3087)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
  );

  assert(
    text.includes(
      "A new path to an existing outcome keeps that outcome's guards",
    ),
    `Making Changes section is missing the new-path guard reference: ${text}`,
  );
  assert(
    text.includes("goes red when the new branch is moved ahead of the guard"),
    `Making Changes section is missing the red-run requirement: ${text}`,
  );
});
