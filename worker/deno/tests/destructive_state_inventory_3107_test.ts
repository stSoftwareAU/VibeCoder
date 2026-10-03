/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3107 — fleet PRs wrote clone swaps and `rm -rf`s that proved only the
 * state the change was about, not everything the old copy held: GRQ#5153's
 * promisor re-clone dropped other local branches, the stash and the reflogs;
 * GRQ#5152's feed-repo re-clone `rm -rf`'d a clone that held unpushed commits
 * on another branch. CODING-STANDARDS.md and the coding_guidelines prompt
 * must both carry the same "code that deletes or replaces state proves
 * everything it destroys is safe to lose" rule, inside the test-coverage
 * section, word for word once wrapping is ignored; Commit Safety must point
 * at it for code written (as distinct from commands run); and the issue
 * prompt's Test Plan step and Long-Horizon Execution bullet must both
 * restate it.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const PARAGRAPH_START =
  "**Code that deletes or replaces state proves everything it destroys is safe";

function destructiveStateParagraph(sectionText: string, what: string): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(
    start >= 0,
    `could not locate the destructive-state inventory rule in ${what}`,
  );
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = end >= 0
    ? sectionText.slice(start, end)
    : sectionText.slice(start);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "everything it destroys is safe to lose",
  "refs/heads/*",
  "the stash",
  "ignored files",
  "refuse the operation",
  "sibling destructive path",
  "asserts it survives",
  "accepted as lost",
  "deletes state it never checked",
];

Deno.test("both surfaces carry the destructive-state rule (Issue #3107)", async () => {
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
    const paragraph = destructiveStateParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the destructive-state rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    destructiveStateParagraph(standards, "CODING-STANDARDS.md"),
    destructiveStateParagraph(guidelines, "coding_guidelines"),
    "the destructive-state rule must be identical on both surfaces",
  );
});

Deno.test("Bound irreversible actions points at the destructive-state rule (Issue #3107)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/coding_guidelines/prompt.md"),
      "Commit Safety",
    ),
  );

  assert(
    text.includes("Code you write that deletes or replaces state at runtime"),
    `Commit Safety is missing the runtime-vs-command distinction: ${text}`,
  );
  assert(
    text.includes(
      "Code that deletes or replaces state proves everything it destroys is safe to lose",
    ),
    `Commit Safety is missing the back-reference to the destructive-state rule: ${text}`,
  );
});

Deno.test("issue prompt Test Plan step restates the destructive-state rule (Issue #3107)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
  );

  assert(
    text.includes(
      "Code that deletes or replaces state proves everything it destroys is safe to lose",
    ),
    `PR Summary File section is missing the destructive-state rule: ${text}`,
  );
  assert(
    text.includes(
      "a destructive operation that deletes state it never checked is a blocking self-review finding",
    ),
    `PR Summary File section is missing the destructive-state finding: ${text}`,
  );
});

Deno.test("issue prompt Bound irreversible actions points at the rule (Issue #3107)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/issue/prompt.md"),
      "Long-Horizon Execution",
    ),
  );

  assert(
    text.includes("Destructive code you *write*"),
    `Long-Horizon Execution bullet is missing the destructive-code distinction: ${text}`,
  );
});
