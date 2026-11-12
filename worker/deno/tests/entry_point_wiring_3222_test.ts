/**
 * Documentation regression checks. Issue #5019 replaces routine mutation-proof
 * requirements with current-change coverage review and deterministic regressions.
 * These cases retain the relevant rule, scope and twin-document guarantees.
 * Behavioural tests in this file remain unchanged.
 */

import { assert } from "@std/assert";
import {
  assertPins,
  type DocSection,
  excerpt,
  flat,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const PARAGRAPH_START =
  "**Every changed call site needs a test that goes red without it.**";

function changedCallSiteParagraph(
  sectionText: DocSection,
  what: string,
): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, `could not locate the changed-call-site rule in ${what}`);
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = excerpt(sectionText, start, end >= 0 ? end : undefined);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "CLI command",
  "HTTP route",
  "scheduled job",
  "UI control's handler",
  "default-dependencies factory",
  "registered dispatch spec",
  "invoke that action or its real handler",
  "presentation-only button move",
  "incorrect caller outcome",
];

Deno.test("both surfaces widen the changed-call-site rule to a single entry point and UI controls (Issue #3222)", async () => {
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
    const paragraph = changedCallSiteParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the changed-call-site rule: ${paragraph}`,
      );
    }
    assert(
      !paragraph.includes("more than one production caller"),
      `${surface} still limits the rule to more than one production caller: ${paragraph}`,
    );
  }
});

Deno.test("issue prompt scopes UI-handler coverage to the requirement", async () => {
  assertPins(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
    [
      "including a UI handler when the requirement is a user action",
      "existing coverage and a visual check may suffice for a presentation change",
    ],
  );
});
