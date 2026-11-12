/**
 * Documentation regression checks. Issue #5019 replaces routine mutation-proof
 * requirements with current-change coverage review and deterministic regressions.
 * These cases retain the relevant rule, scope and twin-document guarantees.
 * Behavioural tests in this file remain unchanged.
 */

import { assert, assertEquals } from "@std/assert";
import {
  assertPins,
  type DocSection,
  excerpt,
  flat,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const PARAGRAPH_START =
  "**A new path to an existing outcome keeps that outcome's guards.**";

function newPathParagraph(sectionText: DocSection, what: string): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, `could not locate the new-path guard rule in ${what}`);
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = excerpt(sectionText, start, end >= 0 ? end : undefined);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "early return",
  "list every guard and side effect",
  "degraded-run guard",
  "releasing a claim",
  "state in the PR summary why it does not apply",
  "an allowed case that reaches the intended outcome",
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

Deno.test("feedback tests kept guards with allowed and refused cases", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
    [
      "guard",
      "allowed case",
    ],
  );
});
